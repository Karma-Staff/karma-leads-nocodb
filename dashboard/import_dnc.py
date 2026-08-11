"""Apply a do-not-call export to the leads system.

    python dashboard/import_dnc.py [file.csv] [--dry-run]

Every number in the file joins the blocklist and every lead sharing it is
marked removed — the same thing the app's 🚫 button does, in bulk. Defaults to
the newest CSV in `dnc/`.

Safe to re-run: numbers already banned are skipped and leads already removed
are left alone, so a fresh export each month only applies the difference.
Additive — statuses, notes, owners and favourites are untouched.

The writes go through the domain API's /api/dnc-import endpoint (service
token, see domain_api.py), which computes the blast radius server-side; this
script's job is reduced to parsing the CSV and asking. The pk() copy below is
only used to pre-count usable numbers for the local report — the server
applies the same rules again and is the one that decides.
"""
import csv
import io
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from setup_and_import import DATA           # noqa: E402  (the exports folder)
import domain_api                            # noqa: E402

# Zoho writes cp1252; other CRMs export utf-8. Try in order of likelihood.
ENCODINGS = ("utf-8-sig", "utf-8", "cp1252", "latin-1")

PHONE_HEADERS = ("phone", "phonenumber", "mobile", "mobilephone",
                 "primaryphone", "workphone", "telephone")


def norm(h):
    return re.sub(r"[^a-z0-9]", "", str(h or "").lower())


def pk(phone):
    """Bannable 10-digit key, or None — same rules as the server's dedupe.js."""
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
    if not phone_col:
        sys.exit(f"no phone column found in: {headers}")

    print(f"{path.name}  ({len(rows):,} rows, {enc}) — phone column {phone_col!r}")
    numbers = [str(r.get(phone_col) or "").strip() for r in rows]
    usable = {pk(n) for n in numbers} - {None}
    print(f"  {len(usable):,} usable numbers, {len(rows) - len(usable)} rows "
          f"unusable or duplicated in the file")

    plan = domain_api.dnc_import(numbers, dry_run=True, source=path.name)
    print(f"  server: {plan['alreadyBanned']:,} already banned, "
          f"{plan['newBans']:,} new bans, {plan['leadsToRemove']:,} leads to remove")

    if dry:
        print("\n--dry-run: nothing was written")
        return

    out = domain_api.dnc_import(numbers, dry_run=False, source=path.name)
    print(f"\nblocklisted {out['newBans']:,} numbers; removed "
          f"{out['leadsToRemove']:,} leads — they now live under the Removed view")


if __name__ == "__main__":
    main()
