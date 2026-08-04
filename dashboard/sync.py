"""Refresh the base from the source files WITHOUT dropping it.

    python dashboard/sync.py [--dry-run] [--limit N]

`setup_v2.py` is the destructive path: it recreates the base and is the only way
to change the schema. This is the everyday path. It reads the same files, forms
the same clusters, resolves the same lead codes, and then reconciles against what
is already in NocoDB:

    new code      -> INSERT
    known code    -> PATCH, but only the fields whose values actually changed
    absent code   -> LEFT ALONE. Never deleted.

That last rule is deliberate. A lead vanishing from an export means the export
changed, not that the business closed — and someone may have spent a week working
it. Removal is a decision a human makes with the 🚫 button, which bans the phone
number; it is not something a nightly refresh should infer.

Fields the team owns — Status, Owner, Favorite, Notes — are never written here.
They live in the registry and in the base, and a file has no opinion about them.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from setup_and_import import api, collect                      # noqa: E402
from setup_v2 import (cluster, keysets_for, merge_cluster, phone_key)  # noqa: E402
import registry as reg                                          # noqa: E402

# Facts a source file is allowed to correct. Status/Owner/Favorite/Notes are the
# team's, and Removed is the blocklist's — none of them appear here.
CO_FIELDS = ("Company", "Category", "Industry", "Employees", "Revenue", "Certs",
             "City", "State", "Phone", "Email", "Website", "Date Added",
             "Source", "Source File", "Phone Key")
PE_FIELDS = ("Name", "Title", "Company", "Email", "Phone", "Category",
             "Industry", "Employees", "Revenue", "City", "State", "Date Added",
             "Source", "Source File", "Phone Key")
JB_FIELDS = ("Job Title", "Company", "Contact", "Contact Title", "Email",
             "Industry", "Employees", "City", "State", "Job URL", "Posted",
             "Source File", "Phone Key")

CATS = ("Restoration", "Independent Adjuster", "Public Adjuster", "Insurance",
        "Vendor")


def discover():
    for b in api("GET", "/api/v2/meta/bases").get("list", []):
        if b["title"] == "Karma Leads":
            tabs = api("GET", f"/api/v2/meta/bases/{b['id']}/tables")["list"]
            return b["id"], {t["title"]: t["id"] for t in tabs}
    raise SystemExit("no 'Karma Leads' base — run setup_v2.py first")


def read_all(tid, fields):
    out, offset = {}, 0
    want = ",".join(("Id", "Lead Code") + tuple(fields))
    while True:
        res = api("GET", f"/api/v2/tables/{tid}/records?limit=1000&offset={offset}"
                          f"&fields={requests_quote(want)}")
        batch = res.get("list", [])
        for rec in batch:
            code = reg.normalize_code(rec.get("Lead Code"))
            if code:
                out[code] = rec
        if len(batch) < 1000:
            return out
        offset += 1000


def requests_quote(s):
    import requests
    return requests.utils.quote(s)


def co_row(r):
    return {"Company": r["Company"] or r["Lead"],
            "Category": r["Category"] if r["Category"] in CATS else "Other",
            "Industry": r["Industry"], "Employees": r["Employees"],
            "Revenue": r["Revenue"], "Certs": r["Certs"], "City": r["City"],
            "State": r["State"], "Phone": r["Phone"], "Email": r["Email"],
            "Website": r["Website"], "Date Added": r["Date Added"],
            "Source": r["Source"], "Source File": r["Source File"],
            "Phone Key": phone_key(r.get("Phone"))}


def pe_row(r):
    return {"Name": r["Lead"], "Title": r["Title"], "Company": r["Company"],
            "Email": r["Email"], "Phone": r["Phone"],
            "Category": r["Category"] if r["Category"] in CATS else "Other",
            "Industry": r["Industry"], "Employees": r["Employees"],
            "Revenue": r["Revenue"], "City": r["City"], "State": r["State"],
            "Date Added": r["Date Added"], "Source": r["Source"],
            "Source File": r["Source File"],
            "Phone Key": phone_key(r.get("Phone"))}


def jb_row(r):
    return {"Job Title": r["Job Title"], "Company": r["Company"],
            "Contact": r["Lead"] if r["Lead"] != r["Company"] else None,
            "Contact Title": r["Title"], "Email": r["Email"],
            "Industry": r["Industry"], "Employees": r["Employees"],
            "City": r["City"], "State": r["State"], "Job URL": r["Job URL"],
            "Posted": r["Date Added"], "Source File": r["Source File"],
            "Phone Key": phone_key(r.get("Phone"))}


def changed(existing, fresh, fields):
    """Only the fields a file may correct, and only where the value really moved.

    A blank in the file never blanks a populated cell — enrichment is additive, so
    a thinner export cannot strip detail an earlier one supplied.
    """
    diff = {}
    for f in fields:
        new = fresh.get(f)
        if new in (None, ""):
            continue
        old = existing.get(f)
        if isinstance(new, (int, float)) and isinstance(old, (int, float)):
            if float(old) != float(new):
                diff[f] = new
        elif str(old or "").strip() != str(new).strip():
            diff[f] = new
    return diff


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would change and write nothing")
    ap.add_argument("--limit", type=int, default=0,
                    help="cap the number of writes, for a cautious first run")
    args = ap.parse_args()

    base_id, tables = discover()
    print(f"Base {base_id}")

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

    con = reg.connect()
    bak = reg.backup()
    if bak:
        print(f"Registry backed up to {bak.name}")

    plan = []
    for title, src, name_field, etype, build, fields in (
            ("Companies", companies, "Company", "company", co_row, CO_FIELDS),
            ("People", people, "Lead", "person", pe_row, PE_FIELDS),
            ("Job Board", jobs, "Company", "job", jb_row, JB_FIELDS)):
        tid = tables.get(title)
        if not tid:
            print(f"  {title}: missing from the base, skipped")
            continue
        groups, info = cluster(src, name_field)
        codes, st = reg.resolve(con, keysets_for(groups, info, src, name_field),
                                etype)
        print(f"  {title}: {len(groups)} clusters — reused {st['reused']}, "
              f"new {st['minted']}, merged {st['merged']}")

        existing = read_all(tid, fields)
        inserts, patches = [], []
        for members, code in zip(groups, codes):
            r = merge_cluster(src, members, name_field)
            if r is None:
                continue
            fresh = build(r)
            cur = existing.get(code)
            if cur is None:
                fresh["Lead Code"] = code
                fresh.setdefault("Status", "New")
                inserts.append(fresh)
            else:
                d = changed(cur, fresh, fields)
                if d:
                    d["Id"] = cur["Id"]
                    patches.append(d)
        gone = len(existing) - (len(codes) - len(inserts))
        plan.append((title, tid, inserts, patches, gone))

    print("\nPlan:")
    for title, _, ins, pat, gone in plan:
        print(f"  {title:<11} insert {len(ins):>6}   update {len(pat):>6}"
              f"   untouched-in-base {max(gone, 0):>6}")
    if args.dry_run:
        for title, _, ins, pat, _ in plan:
            for p in pat[:3]:
                print(f"    {title} #{p['Id']}: "
                      + ", ".join(f"{k}={v!r}" for k, v in p.items() if k != "Id"))
        print("\n--dry-run: nothing written")
        return

    budget = args.limit or float("inf")
    for title, tid, ins, pat, _ in plan:
        for i in range(0, len(ins), 100):
            if budget <= 0:
                break
            chunk = ins[i:i + 100][:int(budget)]
            api("POST", f"/api/v2/tables/{tid}/records", json=chunk)
            budget -= len(chunk)
            print(f"  {title} inserted {i + len(chunk)}/{len(ins)}", end="\r")
        for i in range(0, len(pat), 100):
            if budget <= 0:
                break
            chunk = pat[i:i + 100][:int(budget)]
            api("PATCH", f"/api/v2/tables/{tid}/records", json=chunk)
            budget -= len(chunk)
            print(f"  {title} updated {i + len(chunk)}/{len(pat)}  ", end="\r")
        print()
    print("Done — no rows were deleted.")


if __name__ == "__main__":
    main()
