"""
Karma Leads dashboard — NocoDB setup + import.

Creates the 'Karma Leads' base with a consolidated Leads table, imports every
lead file in this repo (normalized + deduped), and creates the dashboard views.

Re-runnable: if the base already exists it is deleted and rebuilt from the files.

Usage:  python dashboard/setup_and_import.py
Requires NocoDB running on http://localhost:8080 and api_token.json beside it.

The raw lead exports are not in this repo — see DATA below.
"""
import json
import math
import os
import re
import sys
from datetime import datetime, date
from pathlib import Path

import pandas as pd
import requests

BASE_URL = "http://localhost:8080"

# APP is the repo, which is also the folder the server runs from — api_token.json
# and dashboard/ live here. DATA is deliberately somewhere else: the raw exports
# are real names, phones and emails, so they stay out of git and keep their
# OneDrive backup. Set KARMA_LEADS_DATA if they move, or on another machine.
APP = Path(__file__).resolve().parents[1]
DATA = Path(os.environ.get(
    "KARMA_LEADS_DATA",
    r"C:\Users\David\OneDrive\Documents\GitHub\KarmaLeads",
))
TOKEN_FILE = APP / "api_token.json"

token = json.loads(TOKEN_FILE.read_text(encoding="utf-8-sig"))["token"]
H = {"xc-token": token}


def api(method, path, **kw):
    r = requests.request(method, BASE_URL + path, headers=H, **kw)
    if not r.ok:
        raise RuntimeError(f"{method} {path} -> {r.status_code}: {r.text[:500]}")
    return r.json() if r.text else None


# ---------------------------------------------------------------- helpers
def clean(v):
    if v is None:
        return None
    if isinstance(v, float) and math.isnan(v):
        return None
    s = str(v).strip().strip("'").strip()
    if s in ("", "nan", "None", "NaN"):
        return None
    return s


def clean_place(v):
    """City/state fields that are Bitrix numeric IDs are useless -> None."""
    s = clean(v)
    if s and re.fullmatch(r"\d{3,}", s):
        return None
    return s


def clean_phone(v):
    s = clean(v)
    if not s:
        return None
    s = s.lstrip("'").strip()
    return s or None


def phone_digits(s):
    if not s:
        return None
    d = re.sub(r"\D", "", s)
    if len(d) < 7:
        return None
    return d[-10:]


def full_name(first, last):
    parts = [p for p in (clean(first), clean(last)) if p]
    return " ".join(parts) or None


def file_date(path):
    """Date from the MMDD token in the filename (e.g. 'Apollo Export 0428').

    OneDrive refreshes mtimes, so filenames are the only reliable signal for
    the old exports. Jan-Jul -> 2025, Aug-Dec -> 2024 (matches the verified
    timestamps inside the files). No token -> None (unknown, not 'recent').
    """
    m = re.search(r"\b(0[1-9]|1[0-2])([0-3]\d)\b", Path(path).stem)
    if not m:
        return None
    month, day = int(m.group(1)), int(m.group(2))
    year = 2025 if month <= 7 else 2024
    try:
        return date(year, month, day).isoformat()
    except ValueError:
        return None


def read_csv(path):
    try:
        return pd.read_csv(path, dtype=str, encoding="utf-8-sig", on_bad_lines="skip")
    except UnicodeDecodeError:
        return pd.read_csv(path, dtype=str, encoding="latin-1", on_bad_lines="skip")


def to_int(v):
    s = clean(v)
    if not s:
        return None
    s = re.sub(r"[^\d.]", "", s)
    try:
        return int(float(s))
    except ValueError:
        return None


CODE_LIKE = re.compile(r"^[A-Z0-9\-/ ]{1,7}$")


def trade_label(*values):
    """Turn a license class/specialty into a readable trade, or None.

    The master DB mixes real trades ('MOLD REMEDIATION CONTRACTOR LICENSE
    (SH126)') with bare licence codes ('B', 'HIC', 'A - Bc-A Residential ; A').
    Only the readable ones are worth showing on a card.
    """
    for v in values:
        s = clean(v)
        if not s or ";" in s:
            continue
        s = re.sub(r"\([^)]*\)", "", s).strip()          # drop "(SH126)"
        s = re.sub(r"^\d{4,}\s*-\s*", "", s)              # drop NAICS prefix
        s = re.sub(r"(\s+(LICENSE|CERTIFICATE)S?)+$", "", s, flags=re.I).strip()
        if len(s) < 8 or CODE_LIKE.match(s):
            continue
        return s
    return None


def cert_count(v):
    s = clean(v)
    if not s:
        return None
    n = len([p for p in s.split(";") if p.strip()])
    return n or None


def lead(**kw):
    base = {
        "Lead": None, "Company": None, "Title": None, "Email": None,
        "Phone": None, "City": None, "State": None, "Country": None,
        "Website": None, "Source": None, "Category": None, "Status": "New",
        "Owner": None, "Notes": None, "Job Title": None, "Job URL": None,
        "Employees": None, "Revenue": None, "Industry": None, "Certs": None,
        "Date Added": None, "Source File": None,
    }
    base.update(kw)
    if not base["Lead"]:
        base["Lead"] = base["Company"]
    return base


# ---------------------------------------------------------------- extractors
APOLLO_PHONE_PREF = ["Mobile Phone", "Work Direct Phone", "Corporate Phone",
                     "Company Phone", "Other Phone", "Home Phone"]


def parse_apollo(path, category):
    df = read_csv(path)
    out = []
    for _, r in df.iterrows():
        phone = None
        for c in APOLLO_PHONE_PREF:
            if c in df.columns:
                phone = clean_phone(r.get(c))
                if phone:
                    break
        out.append(lead(
            Lead=full_name(r.get("First Name"), r.get("Last Name")),
            Company=clean(r.get("Company")),
            Title=clean(r.get("Title")),
            Email=clean(r.get("Email")),
            Phone=phone,
            City=clean_place(r.get("City") or r.get("Company City")),
            State=clean_place(r.get("State") or r.get("Company State")),
            Country=clean(r.get("Country") or r.get("Company Country")),
            Website=clean(r.get("Website")),
            Source="Apollo export",
            Category=category,
            Owner=clean(r.get("Contact Owner")),
            Employees=to_int(r.get("# Employees")),
            Revenue=to_int(r.get("Annual Revenue")),
            Industry=clean(r.get("Industry")),
            **{"Date Added": file_date(path), "Source File": path.name},
        ))
    return out


def parse_company_list(path, category):
    df = read_csv(path)
    out = []
    for _, r in df.iterrows():
        out.append(lead(
            Company=clean(r.get("Company")),
            Email=clean(r.get("Email")),
            Phone=clean_phone(r.get("Company Phone")),
            City=clean_place(r.get("Company City")),
            State=clean_place(r.get("Company State")),
            Country=clean(r.get("Company Country")),
            Website=clean(r.get("Website")),
            Source="Excel import",
            Category=category,
            Employees=to_int(r.get("# Employees")),
            Revenue=to_int(r.get("Annual Revenue")),
            Industry=clean(r.get("Industry")),
            **{"Date Added": file_date(path), "Source File": path.name},
        ))
    return out


def parse_bitrix(path):
    df = read_csv(path)
    out = []
    for _, r in df.iterrows():
        out.append(lead(
            Lead=full_name(r.get("First Name"), r.get("Last Name")),
            Company=clean(r.get("Company Name")),
            Email=clean(r.get("Email")),
            Phone=clean_phone(r.get("PhoneNumber") or r.get("Phone Number")
                              or r.get("Work Phone")),
            City=clean_place(r.get("City")),
            State=clean_place(r.get("State") or r.get("State/Region")),
            Website=clean(r.get("Website")),
            Source="Bitrix CRM",
            Category="Vendor",
            Industry=clean_place(r.get("Industry Group")),  # numeric ids -> None
            **{"Date Added": file_date(path), "Source File": path.name},
        ))
    return out


def parse_vendor_xlsx(path, sheet=0):
    df = pd.read_excel(path, sheet_name=sheet, dtype=str)
    out = []
    for _, r in df.iterrows():
        website = clean(r.get("Website")) or clean(r.get("Domain Name"))
        out.append(lead(
            Company=clean(r.get("Company Name")),
            Email=clean(r.get("Email")),
            Phone=clean_phone(r.get("Phone Number") or r.get("PhoneNumber")),
            City=clean_place(r.get("City")),
            State=clean_place(r.get("State")),
            Country=clean(r.get("Country")),
            Website=website,
            Source="Excel import",
            Category="Vendor",
            **{"Date Added": file_date(path), "Source File": path.name},
        ))
    return out


def parse_master(path):
    out = []
    for sheet in ("Master", "Review Queue"):
        df = pd.read_excel(path, sheet_name=sheet, dtype=str)
        for _, r in df.iterrows():
            first_seen = clean(r.get("first_seen"))
            added = None
            if first_seen:
                try:
                    added = pd.to_datetime(first_seen).date().isoformat()
                except Exception:
                    pass
            out.append(lead(
                Company=clean(r.get("name")),
                Email=clean(r.get("email")),
                Phone=clean_phone(r.get("phone")),
                City=clean_place(r.get("city")),
                State=clean_place(r.get("state")),
                Country="United States",
                Website=clean(r.get("website")),
                Source="Master DB",
                Category="Restoration",
                Industry=trade_label(r.get("license_specialty"),
                                     r.get("license_class")),
                Certs=cert_count(r.get("certifications")),
                Notes=None,
                **{"Date Added": added or file_date(path),
                   "Source File": f"{path.name} [{sheet}]"},
            ))
    return out


def parse_jobs(path):
    df = read_csv(path)
    out = []
    for _, r in df.iterrows():
        person = clean(r.get("recruiter_name")) or clean(r.get("ai_hiring_manager_name"))
        title = clean(r.get("recruiter_title"))
        posted = clean(r.get("date_posted"))
        added = None
        if posted:
            try:
                added = pd.to_datetime(posted).date().isoformat()
            except Exception:
                pass
        city = clean(r.get("cities_derived/0")) or clean_place(r.get("cities_derived"))
        state = clean(r.get("regions_derived/0")) or clean_place(r.get("regions_derived"))
        out.append(lead(
            Lead=person,
            Company=clean(r.get("organization")),
            Title=title,
            Email=clean(r.get("ai_hiring_manager_email_address")),
            Phone=None,
            City=city, State=state,
            Website=clean(r.get("org_linkedin_website")),
            Source="Job board",
            Category="Job posting",
            Employees=to_int(r.get("org_linkedin_headcount")),
            Industry=clean(r.get("org_linkedin_industry")),
            **{"Job Title": clean(r.get("title")),
               "Job URL": clean(r.get("url")),
               "Date Added": added or file_date(path),
               "Source File": path.name},
        ))
    return out


# ---------------------------------------------------------------- collect
def collect():
    old = DATA / "old leads"
    rows = []
    plan = [
        (parse_apollo, old / "apollo- mobile contacts-export 0328 1.csv", "Restoration"),
        (parse_apollo, old / "Apollo Mobile Export 0428 2.csv", "Restoration"),
        (parse_apollo, old / "apollo-contacts-export Pema 0502.csv", "Restoration"),
        (parse_apollo, old / "Apollo Mobile Export 0528.csv", "Restoration"),
        (parse_apollo, old / "Apollo Mobile Export 0626 1.csv", "Restoration"),
        (parse_apollo, old / "IA-Licenced States 0528.csv", "Independent Adjuster"),
        (parse_apollo, old / "IA-No Licence States 0528.csv", "Independent Adjuster"),
        (parse_apollo, old / "Insurance companies 0620.csv", "Insurance"),
        (parse_company_list, old / "Independent Adjusters.csv", "Independent Adjuster"),
        (parse_company_list, old / "Public Adjusters.csv", "Public Adjuster"),
    ]
    for fn, path, cat in plan:
        got = fn(path, cat)
        rows += got
        print(f"  {path.name}: {len(got)}")

    for path in [old / "Bitrix Vendor Leads 1007(3366 after merge).csv",
                 old / "Vendor Leads 1024(2246 after merge) 1.csv",
                 old / "Vendor Leads 1216.csv"]:
        got = parse_bitrix(path)
        rows += got
        print(f"  {path.name}: {len(got)}")

    got = parse_vendor_xlsx(old / "Vendor Leads 0806.xlsx")
    rows += got
    print(f"  Vendor Leads 0806.xlsx: {len(got)}")
    got = parse_vendor_xlsx(old / "Vendor Leads 1007 1.xlsx", sheet="Data")
    rows += got
    print(f"  Vendor Leads 1007 1.xlsx: {len(got)}")

    got = parse_master(DATA / "master_leads" / "master_us_restoration_netnew.xlsx")
    rows += got
    print(f"  master_us_restoration_netnew.xlsx: {len(got)}")

    for path in sorted((DATA / "New_job_search").glob("*.csv")):
        got = parse_jobs(path)
        rows += got
        print(f"  {path.name}: {len(got)}")

    return rows


def dedupe(rows):
    seen = {}
    order = []
    for r in rows:
        if not r["Lead"] and not r["Company"]:
            continue
        email = (r["Email"] or "").lower() or None
        ph = phone_digits(r["Phone"])
        if email:
            key = ("e", email)
        elif ph:
            key = ("p", ph)
        else:
            key = ("c", (r["Company"] or r["Lead"]).lower(),
                   (r["City"] or "").lower())
        if key in seen:
            kept = seen[key]
            for f, v in r.items():
                if v and not kept.get(f):
                    kept[f] = v
        else:
            seen[key] = r
            order.append(r)
    return order


# ---------------------------------------------------------------- nocodb
SOURCES = "'Excel import','Apollo export','Bitrix CRM','Master DB','Job board'"
CATEGORIES = ("'Restoration','Independent Adjuster','Public Adjuster',"
              "'Insurance','Vendor','Job posting','Other'")
STATUSES = "'New','Contacted','Responded','Qualified','Not interested'"

COLUMNS = [
    {"column_name": "lead", "title": "Lead", "uidt": "SingleLineText", "pv": True},
    {"column_name": "company", "title": "Company", "uidt": "SingleLineText"},
    {"column_name": "job_role", "title": "Title", "uidt": "SingleLineText"},
    {"column_name": "email", "title": "Email", "uidt": "Email"},
    {"column_name": "phone", "title": "Phone", "uidt": "SingleLineText"},
    {"column_name": "city", "title": "City", "uidt": "SingleLineText"},
    {"column_name": "state", "title": "State", "uidt": "SingleLineText"},
    {"column_name": "country", "title": "Country", "uidt": "SingleLineText"},
    {"column_name": "website", "title": "Website", "uidt": "URL"},
    {"column_name": "source", "title": "Source", "uidt": "SingleSelect", "dtxp": SOURCES},
    {"column_name": "category", "title": "Category", "uidt": "SingleSelect", "dtxp": CATEGORIES},
    {"column_name": "status", "title": "Status", "uidt": "SingleSelect", "dtxp": STATUSES, "cdf": "'New'"},
    {"column_name": "owner", "title": "Owner", "uidt": "SingleLineText"},
    {"column_name": "notes", "title": "Notes", "uidt": "LongText"},
    {"column_name": "job_title", "title": "Job Title", "uidt": "SingleLineText"},
    {"column_name": "job_url", "title": "Job URL", "uidt": "URL"},
    {"column_name": "date_added", "title": "Date Added", "uidt": "Date"},
    {"column_name": "source_file", "title": "Source File", "uidt": "SingleLineText"},
]


def main():
    # -------- base (recreate if exists)
    bases = api("GET", "/api/v2/meta/bases").get("list", [])
    for b in bases:
        if b["title"] == "Karma Leads":
            print(f"Deleting existing base {b['id']}")
            api("DELETE", f"/api/v2/meta/bases/{b['id']}")
    base = api("POST", "/api/v2/meta/bases", json={"title": "Karma Leads"})
    base_id = base["id"]
    print("Base:", base_id)

    table = api("POST", f"/api/v2/meta/bases/{base_id}/tables", json={
        "table_name": "leads", "title": "Leads", "columns": COLUMNS,
    })
    table_id = table["id"]
    cols = {c["title"]: c["id"] for c in table["columns"]}
    print("Table:", table_id)

    # -------- data
    print("Parsing files:")
    rows = collect()
    print(f"Parsed total: {len(rows)}")
    rows = dedupe(rows)
    print(f"After dedupe: {len(rows)}")

    for i in range(0, len(rows), 100):
        batch = rows[i:i + 100]
        api("POST", f"/api/v2/tables/{table_id}/records", json=batch)
        print(f"  inserted {min(i + 100, len(rows))}/{len(rows)}", end="\r")
    print()

    # -------- views
    def grid(title):
        v = api("POST", f"/api/v2/meta/tables/{table_id}/grids", json={"title": title})
        return v["id"]

    def add_filter(view_id, col, op, value=None, sub_op=None):
        body = {"fk_column_id": cols[col], "comparison_op": op}
        if value is not None:
            body["value"] = value
        if sub_op:
            body["comparison_sub_op"] = sub_op
        api("POST", f"/api/v2/meta/views/{view_id}/filters", json=body)

    v = grid("Recent leads")
    add_filter(v, "Date Added", "isWithin", 30, "pastNumberOfDays")

    v = grid("Job board leads")
    add_filter(v, "Source", "eq", "Job board")

    v = grid("Excel imports")
    add_filter(v, "Source", "neq", "Job board")

    v = grid("Uncontacted")
    add_filter(v, "Status", "eq", "New")

    kb = api("POST", f"/api/v2/meta/tables/{table_id}/kanbans", json={
        "title": "Pipeline by status", "fk_grp_col_id": cols["Status"],
    })
    print("Views created (Recent, Job board, Excel imports, Uncontacted, Kanban)")

    cfg = {"base_id": base_id, "table_id": table_id, "columns": cols}
    (APP / "dashboard" / "nocodb_ids.json").write_text(json.dumps(cfg, indent=2))
    print("Done. Open http://localhost:8080")


if __name__ == "__main__":
    main()
