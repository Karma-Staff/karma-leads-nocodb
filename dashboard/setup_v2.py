"""
Karma Leads dashboard v2 — split structure.

Rebuilds the 'Karma Leads' base as:
  - Companies  (company-level leads: Bitrix, vendor lists, master DB, adjuster lists)
  - People     (person-level leads: Apollo exports, Bitrix rows with names)
  - Job Board  (LinkedIn job postings)
  - Segments   (Category x State groups -> "similar companies" on click)

Links: Companies->People (contacts at the company), Companies->Segment,
Companies->Job postings. People/jobs are matched to companies by
normalized name.

DESTRUCTIVE: drops and recreates the whole base (statuses/notes reset).

Usage:  python dashboard/setup_v2.py
"""
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from setup_and_import import (api, collect, phone_digits, APP)  # noqa: E402

BASE_URL = "http://localhost:8080"

STATUSES = "'New','Contacted','Responded','Qualified','Not interested'"
CATEGORIES = ("'Restoration','Independent Adjuster','Public Adjuster',"
              "'Insurance','Vendor','Other'")

SUFFIXES = {"llc", "inc", "co", "corp", "ltd", "llp", "pc", "pa", "the",
            "company", "corporation", "incorporated"}


def norm_co(name):
    if not name:
        return None
    s = re.sub(r"[^a-z0-9 ]+", " ", name.lower())
    words = [w for w in s.split() if w not in SUFFIXES]
    return " ".join(words) or None


def dedupe(rows, name_field):
    seen, order = {}, []
    for r in rows:
        email = (r.get("Email") or "").lower() or None
        ph = phone_digits(r.get("Phone"))
        name = r.get(name_field)
        if not name and not email and not ph:
            continue
        if email:
            key = ("e", email)
        elif ph:
            key = ("p", ph)
        else:
            key = ("n", name.lower(), (r.get("City") or "").lower())
        if key in seen:
            kept = seen[key]
            for f, v in r.items():
                if v and not kept.get(f):
                    kept[f] = v
        else:
            seen[key] = r
            order.append(r)
    return order


def insert(table_id, rows):
    """Bulk insert, returns record Ids aligned with rows."""
    ids = []
    for i in range(0, len(rows), 100):
        res = api("POST", f"/api/v2/tables/{table_id}/records",
                  json=rows[i:i + 100])
        ids += [r["Id"] for r in res]
        print(f"    {min(i + 100, len(rows))}/{len(rows)}", end="\r")
    print()
    return ids


def link(table_id, link_field_id, record_id, target_ids):
    for i in range(0, len(target_ids), 100):
        api("POST",
            f"/api/v2/tables/{table_id}/links/{link_field_id}/records/{record_id}",
            json=[{"Id": t} for t in target_ids[i:i + 100]])


def hide_columns(view_id, col_ids_to_hide):
    vcols = api("GET", f"/api/v2/meta/views/{view_id}/columns")["list"]
    for vc in vcols:
        if vc["fk_column_id"] in col_ids_to_hide and vc.get("show"):
            api("PATCH", f"/api/v2/meta/grid-columns/{vc['id']}",
                json={"show": False})


def main():
    # ---------------- gather + split
    print("Parsing files:")
    rows = collect()
    jobs, people, companies = [], [], []
    for r in rows:
        if r["Source"] == "Job board":
            jobs.append(r)
        elif r["Lead"] and r["Company"] and \
                r["Lead"].strip().lower() != r["Company"].strip().lower():
            people.append(r)
        else:
            companies.append(r)

    companies = dedupe(companies, "Company")
    people = dedupe(people, "Lead")
    print(f"Split: {len(companies)} companies, {len(people)} people, "
          f"{len(jobs)} job postings")

    # ---------------- base + tables
    # the blocklist is user-entered, so carry it across the rebuild
    carried = []
    for b in api("GET", "/api/v2/meta/bases").get("list", []):
        if b["title"] != "Karma Leads":
            continue
        for t in api("GET", f"/api/v2/meta/bases/{b['id']}/tables").get("list", []):
            if t["title"] != "Blocklist":
                continue
            res = api("GET", f"/api/v2/tables/{t['id']}/records?limit=1000")
            carried = [{k: v for k, v in rec.items()
                        if k in ("Phone", "Phone Key", "Company", "Reason",
                                 "Added By", "Date Added")}
                       for rec in res.get("list", [])]
            print(f"Carrying over {len(carried)} blocklist entries")
        print("Deleting existing base", b["id"])
        api("DELETE", f"/api/v2/meta/bases/{b['id']}")
    base_id = api("POST", "/api/v2/meta/bases", json={"title": "Karma Leads"})["id"]

    def make_table(title, columns):
        t = api("POST", f"/api/v2/meta/bases/{base_id}/tables",
                json={"table_name": title.lower().replace(" ", "_"),
                      "title": title, "columns": columns})
        return t["id"], {c["title"]: c["id"] for c in t["columns"]}

    def C(title, uidt, **kw):
        d = {"column_name": re.sub(r"\W+", "_", title.lower()).strip("_"),
             "title": title, "uidt": uidt}
        d.update(kw)
        return d

    seg_tid, seg_cols = make_table("Segments", [
        C("Segment", "SingleLineText", pv=True),
        C("Category", "SingleLineText"),
        C("State", "SingleLineText"),
    ])

    # numbers we are banned from calling; any lead sharing a Phone Key is removed
    bl_tid, bl_cols = make_table("Blocklist", [
        C("Phone", "SingleLineText", pv=True),
        C("Phone Key", "SingleLineText"),
        C("Company", "SingleLineText"),
        C("Reason", "SingleLineText"),
        C("Added By", "SingleLineText"),
        C("Date Added", "Date"),
    ])

    co_tid, co_cols = make_table("Companies", [
        C("Company", "SingleLineText", pv=True),
        C("Favorite", "Checkbox"),
        C("Removed", "Checkbox"),
        C("Phone Key", "SingleLineText"),
        C("Category", "SingleSelect", dtxp=CATEGORIES),
        C("Industry", "SingleLineText"),
        C("Employees", "Number"),
        C("Revenue", "Number"),
        C("Certs", "Number"),
        C("City", "SingleLineText"),
        C("State", "SingleLineText"),
        C("Phone", "SingleLineText"),
        C("Email", "Email"),
        C("Website", "URL"),
        C("Status", "SingleSelect", dtxp=STATUSES, cdf="'New'"),
        C("Owner", "SingleLineText"),
        C("Notes", "LongText"),
        C("Date Added", "Date"),
        C("Source", "SingleLineText"),
        C("Source File", "SingleLineText"),
    ])

    pe_tid, pe_cols = make_table("People", [
        C("Name", "SingleLineText", pv=True),
        C("Favorite", "Checkbox"),
        C("Removed", "Checkbox"),
        C("Phone Key", "SingleLineText"),
        C("Title", "SingleLineText"),
        C("Company", "SingleLineText"),
        C("Email", "Email"),
        C("Phone", "SingleLineText"),
        C("Status", "SingleSelect", dtxp=STATUSES, cdf="'New'"),
        C("Owner", "SingleLineText"),
        C("Category", "SingleSelect", dtxp=CATEGORIES),
        C("Industry", "SingleLineText"),
        C("Employees", "Number"),
        C("Revenue", "Number"),
        C("City", "SingleLineText"),
        C("State", "SingleLineText"),
        C("Notes", "LongText"),
        C("Date Added", "Date"),
        C("Source", "SingleLineText"),
        C("Source File", "SingleLineText"),
    ])

    jb_tid, jb_cols = make_table("Job Board", [
        C("Job Title", "SingleLineText", pv=True),
        C("Favorite", "Checkbox"),
        C("Removed", "Checkbox"),
        C("Phone Key", "SingleLineText"),
        C("Company", "SingleLineText"),
        C("Contact", "SingleLineText"),
        C("Contact Title", "SingleLineText"),
        C("Email", "Email"),
        C("Industry", "SingleLineText"),
        C("Employees", "Number"),
        C("City", "SingleLineText"),
        C("State", "SingleLineText"),
        C("Job URL", "URL"),
        C("Status", "SingleSelect", dtxp=STATUSES, cdf="'New'"),
        C("Owner", "SingleLineText"),
        C("Notes", "LongText"),
        C("Posted", "Date"),
        C("Source File", "SingleLineText"),
    ])

    # link fields (created on the parent side; child gets the mirror field)
    def link_col(parent_tid, child_tid, title):
        api("POST", f"/api/v2/meta/tables/{parent_tid}/columns", json={
            "uidt": "Links", "title": title,
            "column_name": re.sub(r"\W+", "_", title.lower()).strip("_"),
            "parentId": parent_tid, "childId": child_tid, "type": "hm",
        })
        for c in api("GET", f"/api/v2/meta/tables/{parent_tid}")["columns"]:
            if c["title"] == title:
                return c["id"]
        raise RuntimeError(f"link column {title} not found")

    co_people_link = link_col(co_tid, pe_tid, "People here")
    co_jobs_link = link_col(co_tid, jb_tid, "Job postings")
    seg_co_link = link_col(seg_tid, co_tid, "Companies")

    # rename the auto-created mirror fields (uidt is LinkToAnotherRecord)
    LINK_TYPES = ("Links", "LinkToAnotherRecord")
    for tid, old, want in ((pe_tid, "Companies", "Company record"),
                           (jb_tid, "Companies", "Company record"),
                           (co_tid, "Segments", "Similar companies")):
        for c in api("GET", f"/api/v2/meta/tables/{tid}")["columns"]:
            if c["uidt"] in LINK_TYPES and c["title"] == old:
                api("PATCH", f"/api/v2/meta/columns/{c['id']}",
                    json={"title": want})

    # ---------------- insert records
    # blocklist survives rebuilds: dashboard/blocklist.json is the source of truth
    bl_file = APP / "dashboard" / "blocklist.json"
    seed = json.loads(bl_file.read_text()) if bl_file.exists() else []
    blocklist = list(carried)
    seen_pk = {b.get("Phone Key") for b in blocklist}
    for b in seed:                       # file entries top up the live table
        if b.get("Phone Key") not in seen_pk:
            blocklist.append(b)
            seen_pk.add(b.get("Phone Key"))
    banned = {b["Phone Key"] for b in blocklist if b.get("Phone Key")}
    print(f"Blocklist: {len(banned)} banned numbers")

    def pk(r):
        """Bannable phone key, or None.

        The Bitrix exports are full of placeholders ('+119000000000') shared by
        dozens of unrelated companies — keying on those would let one ban wipe
        out 46 good leads, so they get no key at all.
        """
        d = re.sub(r"\D", "", (r.get("Phone") or ""))
        if len(d) > 10:
            d = d[-10:]
        if len(d) != 10:
            return None
        if d[0] in "01":                 # invalid NANP area code
            return None
        if len(set(d)) <= 2 or d[3:] == "0" * 7:   # 9000000000-style filler
            return None
        return d

    def co_row(r):
        return {"Company": r["Company"] or r["Lead"],
                "Category": r["Category"] if r["Category"] in
                ("Restoration", "Independent Adjuster", "Public Adjuster",
                 "Insurance", "Vendor") else "Other",
                "Industry": r["Industry"], "Employees": r["Employees"],
                "Revenue": r["Revenue"], "Certs": r["Certs"],
                "City": r["City"], "State": r["State"], "Phone": r["Phone"],
                "Email": r["Email"], "Website": r["Website"],
                "Status": r["Status"], "Owner": r["Owner"],
                "Date Added": r["Date Added"], "Source": r["Source"],
                "Source File": r["Source File"],
                "Phone Key": pk(r), "Removed": pk(r) in banned}

    def pe_row(r):
        return {"Name": r["Lead"], "Title": r["Title"], "Company": r["Company"],
                "Email": r["Email"], "Phone": r["Phone"],
                "Status": r["Status"], "Owner": r["Owner"],
                "Category": r["Category"] if r["Category"] in
                ("Restoration", "Independent Adjuster", "Public Adjuster",
                 "Insurance", "Vendor") else "Other",
                "Industry": r["Industry"], "Employees": r["Employees"],
                "Revenue": r["Revenue"],
                "City": r["City"], "State": r["State"],
                "Date Added": r["Date Added"], "Source": r["Source"],
                "Source File": r["Source File"],
                "Phone Key": pk(r), "Removed": pk(r) in banned}

    def jb_row(r):
        return {"Job Title": r["Job Title"], "Company": r["Company"],
                "Contact": r["Lead"] if r["Lead"] != r["Company"] else None,
                "Contact Title": r["Title"], "Email": r["Email"],
                "Industry": r["Industry"], "Employees": r["Employees"],
                "City": r["City"], "State": r["State"],
                "Job URL": r["Job URL"], "Status": r["Status"],
                "Posted": r["Date Added"], "Source File": r["Source File"],
                "Phone Key": pk(r), "Removed": pk(r) in banned}

    print("Inserting companies:")
    co_ids = insert(co_tid, [co_row(r) for r in companies])
    print("Inserting people:")
    pe_ids = insert(pe_tid, [pe_row(r) for r in people])
    print("Inserting job postings:")
    jb_ids = insert(jb_tid, [jb_row(r) for r in jobs])
    if blocklist:
        print("Restoring blocklist:")
        insert(bl_tid, blocklist)

    # ---------------- links
    by_name = {}
    for r, rid in zip(companies, co_ids):
        n = norm_co(r["Company"] or r["Lead"])
        if n and n not in by_name:
            by_name[n] = rid

    def match_links(rows, ids):
        m = defaultdict(list)
        for r, rid in zip(rows, ids):
            n = norm_co(r.get("Company"))
            if n and n in by_name:
                m[by_name[n]].append(rid)
        return m

    people_by_co = match_links(people, pe_ids)
    print(f"Linking {sum(map(len, people_by_co.values()))} people "
          f"to {len(people_by_co)} companies")
    for co_id, ids in people_by_co.items():
        link(co_tid, co_people_link, co_id, ids)

    jobs_by_co = match_links(jobs, jb_ids)
    print(f"Linking {sum(map(len, jobs_by_co.values()))} job postings "
          f"to {len(jobs_by_co)} companies")
    for co_id, ids in jobs_by_co.items():
        link(co_tid, co_jobs_link, co_id, ids)

    # segments
    seg_members = defaultdict(list)
    for r, rid in zip(companies, co_ids):
        cat = r["Category"] if r["Category"] in \
            ("Restoration", "Independent Adjuster", "Public Adjuster",
             "Insurance", "Vendor") else "Other"
        seg_members[(cat, r["State"] or "Unknown")].append(rid)
    seg_rows = [{"Segment": f"{c} · {s}", "Category": c, "State": s}
                for (c, s) in seg_members]
    print(f"Creating {len(seg_rows)} segments and linking companies")
    seg_ids = insert(seg_tid, seg_rows)
    for (key, members), sid in zip(seg_members.items(), seg_ids):
        link(seg_tid, seg_co_link, sid, members)

    # ---------------- views
    def grid(tid, title):
        return api("POST", f"/api/v2/meta/tables/{tid}/grids",
                   json={"title": title})["id"]

    def add_filter(view_id, col_id, op, value=None, sub_op=None):
        body = {"fk_column_id": col_id, "comparison_op": op}
        if value is not None:
            body["value"] = value
        if sub_op:
            body["comparison_sub_op"] = sub_op
        api("POST", f"/api/v2/meta/views/{view_id}/filters", json=body)

    CO_HIDE = [co_cols[t] for t in ("Notes", "Source", "Source File",
                                    "Phone Key")]
    PE_HIDE = [pe_cols[t] for t in ("Notes", "Source", "Source File",
                                    "City", "State", "Revenue", "Phone Key")]
    JB_HIDE = [jb_cols[t] for t in ("Notes", "Source File", "Phone Key")]

    # default views get renamed + decluttered
    def default_view(tid):
        return api("GET", f"/api/v2/meta/tables/{tid}/views")["list"][0]["id"]

    for tid, title, hide in ((co_tid, "Company list", CO_HIDE),
                             (pe_tid, "People list", PE_HIDE),
                             (jb_tid, "Job board", JB_HIDE)):
        v = default_view(tid)
        api("PATCH", f"/api/v2/meta/views/{v}", json={"title": title})
        hide_columns(v, hide)

    for tid, cols, hide in ((co_tid, co_cols, CO_HIDE),
                            (pe_tid, pe_cols, PE_HIDE)):
        v = grid(tid, "Recent")
        add_filter(v, cols["Date Added"], "isWithin", 30, "pastNumberOfDays")
        hide_columns(v, hide)
        v = grid(tid, "⭐ Favorites")
        add_filter(v, cols["Favorite"], "checked")
        hide_columns(v, hide)

    v = grid(jb_tid, "⭐ Favorites")
    add_filter(v, jb_cols["Favorite"], "checked")
    hide_columns(v, JB_HIDE)

    for tid, cols, hide in ((co_tid, co_cols, CO_HIDE),
                            (pe_tid, pe_cols, PE_HIDE),
                            (jb_tid, jb_cols, JB_HIDE)):
        v = grid(tid, "🚫 Removed")
        add_filter(v, cols["Removed"], "checked")
        hide_columns(v, hide)

    cfg = {"base_id": base_id,
           "tables": {"Companies": co_tid, "People": pe_tid,
                      "Job Board": jb_tid, "Segments": seg_tid,
                      "Blocklist": bl_tid},
           "columns": {"Companies": co_cols, "People": pe_cols,
                       "Job Board": jb_cols, "Segments": seg_cols,
                       "Blocklist": bl_cols}}
    (APP / "dashboard" / "nocodb_ids.json").write_text(json.dumps(cfg, indent=2))
    print("Done. Open http://localhost:8080")


if __name__ == "__main__":
    main()
