"""Apply a do-not-call export to the live base.

    python dashboard/import_dnc.py [file.csv] [--dry-run]

Every number in the file is added to the Blocklist and every lead sharing it,
across Companies / People / Job Board, is marked Removed — the same thing the
app's 🚫 button does, in bulk. Defaults to the newest CSV in `dnc/`.

Safe to re-run: numbers already banned are skipped and leads already removed
are left alone, so a fresh export each month only applies the difference.

This is additive and does NOT rebuild anything — statuses, notes, owners and
favourites are untouched.
"""
import csv
import io
import re
import sys
from pathlib import Path

from setup_and_import import api, DATA

BATCH = 100          # NocoDB's bulk ceiling
WHERE_CHUNK = 50     # keys per ~or chain, to keep the query string sane

# Zoho writes cp1252; other CRMs export utf-8. Try in order of likelihood.
ENCODINGS = ("utf-8-sig", "utf-8", "cp1252", "latin-1")

PHONE_HEADERS = ("phone", "phonenumber", "mobile", "mobilephone",
                 "primaryphone", "workphone", "telephone")
NAME_HEADERS = ("company", "companyname", "account", "accountname",
                "leadname", "name", "fullname")


def norm(h):
    return re.sub(r"[^a-z0-9]", "", str(h or "").lower())


def pk(phone):
    """Bannable 10-digit key, or None.

    Same rules as pk() in setup_v2.py and import-leads.js — placeholder numbers
    are shared by dozens of unrelated companies, so they must never become a
    key. Keep the three in step.
    """
    d = re.sub(r"\D", "", str(phone or ""))
    if len(d) > 10:
        d = d[-10:]
    if len(d) != 10:
        return None
    if d[0] in "01":                                # invalid NANP area code
        return None
    if len(set(d)) <= 2 or d[3:] == "0" * 7:        # 9000000000-style filler
        return None
    return d


def read_rows(path):
    raw = path.read_bytes()
    for enc in ENCODINGS:
        try:
            return list(csv.DictReader(io.StringIO(raw.decode(enc)))), enc
        except UnicodeDecodeError:
            continue
    return list(csv.DictReader(io.StringIO(raw.decode("latin-1", "replace")))), "latin-1"


def pick(headers, wanted):
    for h in headers:
        if norm(h) in wanted:
            return h
    return None


def find_tables():
    base = next((b for b in api("GET", "/api/v2/meta/bases").get("list", [])
                 if b["title"] == "Karma Leads" and not b.get("deleted")), None)
    if not base:
        sys.exit("Base 'Karma Leads' not found — is the server running?")
    tabs = {t["title"]: t["id"]
            for t in api("GET", f"/api/v2/meta/bases/{base['id']}/tables").get("list", [])}
    missing = {"Companies", "People", "Job Board", "Blocklist"} - set(tabs)
    if missing:
        sys.exit(f"missing tables: {sorted(missing)}")
    return tabs


def existing_keys(table_id):
    keys, offset = set(), 0
    while True:
        r = api("GET", f"/api/v2/tables/{table_id}/records"
                       f"?limit=500&offset={offset}&fields=Phone%20Key")
        rows = r.get("list", [])
        keys.update(x["Phone Key"] for x in rows if x.get("Phone Key"))
        if len(rows) < 500 or r.get("pageInfo", {}).get("isLastPage"):
            break
        offset += 500
    return keys


def live_rows_for(table_id, keys):
    """Ids of not-yet-removed leads whose Phone Key is in `keys`."""
    found, keys = [], list(keys)
    for i in range(0, len(keys), WHERE_CHUNK):
        chunk = keys[i:i + WHERE_CHUNK]
        where = ("(" + "~or".join(f"(Phone Key,eq,{k})" for k in chunk) + ")"
                 "~and(Removed,notchecked)")
        offset = 0
        while True:
            r = api("GET", f"/api/v2/tables/{table_id}/records",
                    params={"limit": 500, "offset": offset, "where": where,
                            "fields": "Id"})
            rows = r.get("list", [])
            found += [x["Id"] for x in rows]
            if len(rows) < 500 or r.get("pageInfo", {}).get("isLastPage"):
                break
            offset += 500
    return found


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry-run" in sys.argv

    if args:
        path = Path(args[0])
    else:
        candidates = sorted((DATA / "dnc").glob("*.csv"),
                            key=lambda p: p.stat().st_mtime, reverse=True)
        if not candidates:
            sys.exit(f"no CSV found in {DATA / 'dnc'}")
        path = candidates[0]
    if not path.exists():
        sys.exit(f"not found: {path}")

    rows, enc = read_rows(path)
    if not rows:
        sys.exit("that file has no rows")
    headers = list(rows[0].keys())
    phone_col = pick(headers, PHONE_HEADERS)
    name_col = pick(headers, NAME_HEADERS)
    if not phone_col:
        sys.exit(f"no phone column found in: {headers}")

    print(f"{path.name}  ({len(rows):,} rows, {enc}) — phone column {phone_col!r}")

    # de-duplicate inside the file, keeping the first name seen for each number
    wanted = {}
    rejected = 0
    for r in rows:
        key = pk(r.get(phone_col))
        if not key:
            rejected += 1
            continue
        wanted.setdefault(key, {
            "Phone": (r.get(phone_col) or "").strip(),
            "Company": (r.get(name_col) or "").strip() if name_col else "",
        })
    print(f"  {len(wanted):,} usable numbers, {rejected} unusable")

    tabs = find_tables()
    already = existing_keys(tabs["Blocklist"])
    fresh = {k: v for k, v in wanted.items() if k not in already}
    print(f"  {len(already):,} already on the Blocklist, {len(fresh):,} new")

    targets = {}
    for label in ("Companies", "People", "Job Board"):
        targets[label] = live_rows_for(tabs[label], wanted)
    total = sum(len(v) for v in targets.values())
    for label, ids in targets.items():
        print(f"  {label:<12} {len(ids):>6,} leads to remove")
    print(f"  {'TOTAL':<12} {total:>6,}")

    if dry:
        print("\n--dry-run: nothing was written")
        return

    if fresh:
        entries = [{"Phone": v["Phone"], "Phone Key": k, "Company": v["Company"],
                    "Reason": f"DNC list ({path.name})", "Added By": "dnc-import"}
                   for k, v in fresh.items()]
        for i in range(0, len(entries), BATCH):
            api("POST", f"/api/v2/tables/{tabs['Blocklist']}/records",
                json=entries[i:i + BATCH])
        print(f"\nblocklisted {len(entries):,} numbers")

    removed = 0
    for label, ids in targets.items():
        for i in range(0, len(ids), BATCH):
            api("PATCH", f"/api/v2/tables/{tabs[label]}/records",
                json=[{"Id": n, "Removed": True} for n in ids[i:i + BATCH]])
        removed += len(ids)
    print(f"removed {removed:,} leads — they now live under the Removed view")


if __name__ == "__main__":
    main()
