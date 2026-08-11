"""Refresh the leads system from the source files WITHOUT dropping anything.

    python dashboard/sync.py [--dry-run] [--limit N]

This is the everyday path. It reads the same files as ever, forms the same
clusters, resolves the same lead codes against the registry, and then hands
the result to the domain API as one import job:

    new code      -> INSERT
    known code    -> UPDATE, but only fields whose values actually moved
                     (the server skips no-op rows and never lets a blank
                     overwrite a populated cell)
    absent code   -> LEFT ALONE. Never deleted.

That last rule is deliberate. A lead vanishing from an export means the export
changed, not that the business closed — and someone may have spent a week
working it. Removal is a decision a human makes with the 🚫 button.

Fields the team owns — status, owner, favorite, notes — are never written here.
A file has no opinion about them.

The old direct-to-NocoDB path is gone: writes go through the import-job
endpoints with a scoped service token (see domain_api.py for the environment
variables), the same way in dev and production. Schema changes are migrations
now (`node server/migrate.js`) — there is no destructive rebuild any more.
"""
import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from setup_and_import import collect                            # noqa: E402
from setup_v2 import (cluster, keysets_for, merge_cluster, phone_key)  # noqa: E402
import domain_api                                                # noqa: E402
import registry as reg                                           # noqa: E402

CATS = ("Restoration", "Independent Adjuster", "Public Adjuster", "Insurance",
        "Vendor")


def _cat(r):
    return r["Category"] if r["Category"] in CATS else "Other"


# The parsed row dicts still use the historical title-case keys (lead() in
# setup_and_import.py); these builders emit the API's snake_case fields.
def co_fields(r):
    return {"name": r["Company"] or r["Lead"], "company": r["Company"] or r["Lead"],
            "category": _cat(r), "industry": r["Industry"],
            "employees": r["Employees"], "revenue": r["Revenue"],
            "certs": r["Certs"], "city": r["City"], "state": r["State"],
            "phone": r["Phone"], "email": r["Email"], "website": r["Website"],
            "date_added": r["Date Added"], "source": r["Source"],
            "source_file": r["Source File"],
            "phone_key": phone_key(r.get("Phone"))}


def pe_fields(r):
    return {"name": r["Lead"], "title": r["Title"], "company": r["Company"],
            "email": r["Email"], "phone": r["Phone"], "category": _cat(r),
            "industry": r["Industry"], "employees": r["Employees"],
            "revenue": r["Revenue"], "city": r["City"], "state": r["State"],
            "date_added": r["Date Added"], "source": r["Source"],
            "source_file": r["Source File"],
            "phone_key": phone_key(r.get("Phone"))}


def jb_fields(r):
    return {"name": r["Job Title"], "company": r["Company"],
            "contact": r["Lead"] if r["Lead"] != r["Company"] else None,
            "contact_title": r["Title"], "email": r["Email"],
            "industry": r["Industry"], "employees": r["Employees"],
            "city": r["City"], "state": r["State"], "job_url": r["Job URL"],
            "date_added": r["Date Added"], "source": "Job board",
            "source_file": r["Source File"],
            "phone_key": phone_key(r.get("Phone"))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would change and write nothing")
    ap.add_argument("--limit", type=int, default=0,
                    help="cap the number of records uploaded, for a cautious first run")
    args = ap.parse_args()

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

    records = []
    for title, src, name_field, etype, build in (
            ("Companies", companies, "Company", "company", co_fields),
            ("People", people, "Lead", "person", pe_fields),
            ("Job Board", jobs, "Company", "job", jb_fields)):
        groups, info = cluster(src, name_field)
        codes, st = reg.resolve(con, keysets_for(groups, info, src, name_field),
                                etype)
        print(f"  {title}: {len(groups)} clusters — reused {st['reused']}, "
              f"new {st['minted']}, merged {st['merged']}")
        for members, code in zip(groups, codes):
            r = merge_cluster(src, members, name_field)
            if r is None:
                continue
            records.append({"lead_code": code, "kind": etype,
                            "fields": build(r)})

    if args.limit:
        records = records[:args.limit]

    known = domain_api.existing_codes()
    inserts = sum(1 for r in records if r["lead_code"] not in known)
    print(f"\nPlan: {len(records)} records — about {inserts} inserts, "
          f"{len(records) - inserts} known codes (updated only where a fact "
          f"actually moved); rows absent from the files stay untouched")

    if args.dry_run:
        for r in records[:3]:
            slim = {k: v for k, v in r["fields"].items() if v not in (None, "")}
            print(f"    sample {r['lead_code']} ({r['kind']}): {slim}")
        print("\n--dry-run: nothing written")
        return

    stamp = time.strftime("%Y%m%d-%H%M")
    job = domain_api.create_job(f"sync {stamp}",
                                idempotency_key=f"sync-{stamp}")
    print(f"Import job {job['id']}")
    domain_api.upload(job, records, progress=lambda done, total:
                      print(f"  uploaded {done}/{total}", end="\r"))
    print()
    out = domain_api.commit(job)
    c = out.get("counts") or {}
    ins = c.get("inserted") or {}
    print(f"Done: inserted co {ins.get('company', 0)} / pe {ins.get('person', 0)}"
          f" / jb {ins.get('job', 0)}, updated {c.get('updated', 0)}, "
          f"unchanged {c.get('skipped', 0)}, blocked {c.get('blocked', 0)} — "
          f"no rows were deleted.")


if __name__ == "__main__":
    main()
