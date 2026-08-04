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
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from setup_and_import import (api, collect, APP)  # noqa: E402
import registry as reg  # noqa: E402

BASE_URL = "http://localhost:8080"

STATUSES = "'New','Contacted','Responded','Qualified','Not interested'"
CATEGORIES = ("'Restoration','Independent Adjuster','Public Adjuster',"
              "'Insurance','Vendor','Other'")

SUFFIXES = {"llc", "inc", "co", "corp", "ltd", "llp", "pc", "pa", "the",
            "company", "corporation", "incorporated"}

# "Arma Hawk, Llc / Dba Servpro Of Alexandria" — the master sheet lists the
# franchisee's legal entity, the Bitrix exports list the trading name. Without
# splitting on this the two never match and the same business lands twice.
DBA = re.compile(r"\bd\s*[/.]?\s*b\s*[/.]?\s*a\b\.?", re.I)


def norm_co(name):
    if not name:
        return None
    s = re.sub(r"[^a-z0-9 ]+", " ", name.lower())
    words = [w for w in s.split() if w not in SUFFIXES]
    return " ".join(words) or None


# norm_co() drops SUFFIXES wherever they appear, so 'Pc Restorations' comes back
# as bare 'restorations'. A trade word on its own names half the industry and must
# never be the thing two rows are merged on.
GENERIC = {"restoration", "restorations", "cleaning", "cleaners", "construction",
           "services", "service", "roofing", "adjusters", "adjuster", "plumbing",
           "contracting", "contractors", "builders", "remodeling", "damage",
           "emergency", "recovery", "mitigation", "environmental", "disaster"}


def aliases(name):
    """Every normalised name a string stands for, and whether it said "DBA".

    'Brc Construction, Inc. Dba Pc Restorations' -> both halves plus the whole,
    so it can meet a bare 'PC Restorations' from another export.
    """
    if not name:
        return set(), False
    parts = DBA.split(name)
    is_dba = len(parts) > 1
    out = {norm_co(" ".join(parts))} if is_dba else {norm_co(name)}
    if is_dba:
        out.update(norm_co(p) for p in parts)
    return {a for a in out if a and a not in GENERIC}, is_dba


def phone_key(phone):
    """Bannable, dedupable phone key, or None.

    The Bitrix exports are full of placeholders ('+119000000000') shared by
    dozens of unrelated companies — keying on those would let one ban wipe out
    46 good leads, and would merge them into a single row.
    """
    d = re.sub(r"\D", "", phone or "")
    if len(d) > 10:
        d = d[-10:]
    if len(d) != 10:
        return None
    if d[0] in "01":                 # invalid NANP area code
        return None
    if len(set(d)) <= 2 or d[3:] == "0" * 7:   # 9000000000-style filler
        return None
    return d


class _Union:
    def __init__(self, n):
        self.p = list(range(n))

    def find(self, x):
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return False
        self.p[max(ra, rb)] = min(ra, rb)
        return True


def cluster(rows, name_field):
    """Group rows that are the same business, and only those.

    The old version picked ONE key per row — email, else phone, else name+city —
    so a phone-only export could never meet an email-only one however much they
    overlapped. This unions on any agreeing key instead, with three guards that
    exist because franchises are not duplicates:

      * phone wins, but a number mistyped onto someone else's row is the one way
        it lies — so it is refused when the names AND emails both disagree;
      * email alone is not identity. t.braun@servpro.com sits on nine separate
        SERVPRO franchises; merging on it erased eight real businesses. It needs
        the names to agree and the cities not to conflict;
      * name+city needs a real city, and yields to a phone disagreement unless
        the source itself said "X DBA Y".

    Returns (clusters, info): clusters is a list of row-index lists; info is the
    per-row (email, phone, aliases, city, is_dba) tuple the registry reuses so the
    crosswalk is keyed exactly the way the matching was done.
    """
    n = len(rows)
    uf = _Union(n)
    info, email_ix, phone_ix = [], {}, {}
    for i, r in enumerate(rows):
        email = (r.get("Email") or "").strip().lower() or None
        ph = phone_key(r.get("Phone"))
        al, is_dba = aliases(r.get(name_field))
        city = (r.get("City") or "").strip().lower()
        info.append((email, ph, al, city, is_dba))
        if email:
            email_ix.setdefault(email, []).append(i)
        if ph:
            phone_ix.setdefault(ph, []).append(i)

    def pairs(group):
        for x in range(len(group)):
            for y in range(x + 1, len(group)):
                i, j = group[x], group[y]
                if uf.find(i) != uf.find(j):
                    yield i, j

    for group in phone_ix.values():
        for i, j in pairs(group):
            ei, _, ai, _, _ = info[i]
            ej, _, aj, _, _ = info[j]
            if (ei and ej and ei != ej) and (ai and aj and not (ai & aj)):
                continue
            uf.union(i, j)

    for group in email_ix.values():
        for i, j in pairs(group):
            _, _, ai, ci, _ = info[i]
            _, _, aj, cj, _ = info[j]
            if ai and aj and not (ai & aj):
                continue                      # shared contact, not one business
            if ci and cj and ci != cj:
                continue                      # same brand, two towns
            uf.union(i, j)

    alias_ix = defaultdict(list)
    for i, (_, _, al, city, _) in enumerate(info):
        if city:
            for a in al:
                alias_ix[(a, city)].append(i)
    for group in alias_ix.values():
        for i, j in pairs(group):
            ei, pi, _, _, di = info[i]
            ej, pj, _, _, dj = info[j]
            if ei and ej and ei != ej:
                continue
            if pi and pj and pi != pj and not (di or dj):
                continue                      # two branches, not one business
            uf.union(i, j)

    groups = defaultdict(list)
    for i in range(n):
        groups[uf.find(i)].append(i)
    return [groups[root] for root in sorted(groups)], info


def cluster_natural_keys(members, info):
    """The keys a cluster should be remembered by, for the identity crosswalk.

    Strong keys only (phone, email) — a name+city key is registered only when the
    cluster has nothing stronger, because two same-named branches in one town
    would otherwise fight over it and thrash each other's codes between runs.
    """
    keys = set()
    for i in members:
        email, ph, _, _, _ = info[i]
        if ph:
            keys.add(("phone", ph))
        if email:
            keys.add(("email", email))
    if keys:
        return keys
    for i in members:
        _, _, al, city, _ = info[i]
        if city:
            for a in al:
                keys.add(("namecity", f"{a}|{city}"))
    return keys


def merge_cluster(rows, members, name_field):
    """Collapse one cluster into a single row, filling blanks from its siblings."""
    kept = rows[members[0]]
    for j in members[1:]:
        for f, v in rows[j].items():
            if v and not kept.get(f):
                kept[f] = v
    if kept.get(name_field) or kept.get("Email") or kept.get("Phone"):
        return kept
    return None


def dedupe(rows, name_field):
    """cluster() then collapse — the shape callers other than the registry want."""
    groups, _ = cluster(rows, name_field)
    out = (merge_cluster(rows, m, name_field) for m in groups)
    return [r for r in out if r is not None]


def name_only_keys(rows, members, name_field):
    """Last-resort identity for a cluster with no phone, no email and no city.

    ~610 rows arrive that way (mostly adjuster lists that are names alone). Without
    some key they would be handed a fresh code on every rebuild and quietly leak
    their work product. A bare name collides for only 13 of them — Stanley Steemer
    and friends — and resolve()'s one-code-per-cluster guard mints fresh codes for
    the losers rather than letting two live rows share an identity.
    """
    keys = set()
    for i in members:
        al, _ = aliases(rows[i].get(name_field))
        for a in al:
            keys.add(("name", a))
    return keys


def _fallback_key(row, name_field):
    """Identity of last resort: a cluster with nothing indexable at all.

    Two rows reach this — one with no Company at all, and one called just
    "Restoration", which aliases() drops as a bare trade word. Content-derived
    rather than positional, so it survives rows moving around in the file.
    """
    parts = (row.get(name_field), row.get("City"), row.get("Source File"))
    return "~" + "|".join(str(p or "").strip().lower() for p in parts)


def keysets_for(groups, info, rows, name_field):
    """The identity keys for each cluster, in cluster order.

    A cluster whose every key is already spoken for by an earlier cluster cannot
    find itself again next run: it mints a fresh code every time and quietly leaks
    its work product. Three separate causes converge here —

      * contactless namesakes ("Stanley Steemer" twice, no phone/email/city);
      * the deliberate non-merges, where our own guards keep two businesses apart
        that share a key — nine SERVPRO franchises on one manager's email, or two
        firms on one mistyped phone number;
      * the two rows with no indexable name at all.

    All three get the same treatment: number the duplicate, deterministically. If
    the input order ever changes two such clusters may swap codes, which is
    harmless precisely because nothing distinguishes them in the first place.
    """
    out, used, seen = [], {}, set()
    for m in groups:
        keys = (cluster_natural_keys(m, info)
                or name_only_keys(rows, m, name_field)
                or {("name", _fallback_key(rows[m[0]], name_field))})
        if keys <= seen:                 # nothing here is this cluster's own
            sig = frozenset(keys)
            n = used[sig] = used.get(sig, 0) + 1
            keys = {(kt, f"{kv}#{n}") for kt, kv in keys}
        seen |= keys
        out.append(keys)
    return out


def harvest(con):
    """Pull the team's work out of the live base into the registry.

    Runs before the base is deleted. Rows are matched by their Lead Code, so the
    very first run — against a base built before codes existed — harvests nothing
    and simply starts the history from here.
    """
    tables, found, snapshot = {}, 0, {}
    for b in api("GET", "/api/v2/meta/bases").get("list", []):
        if b["title"] != "Karma Leads":
            continue
        for t in api("GET", f"/api/v2/meta/bases/{b['id']}/tables").get("list", []):
            if t["title"] in ("Companies", "People", "Job Board"):
                tables[t["title"]] = t["id"]
    if not tables:
        return {}

    work, by_row = [], {}
    for title, tid in tables.items():
        cols = {c["title"] for c in
                api("GET", f"/api/v2/meta/tables/{tid}")["columns"]}
        if "Lead Code" not in cols:
            print(f"  {title}: no Lead Code column — nothing to harvest")
            continue
        want = [c for c in ("Id", "Lead Code", "Status", "Owner", "Favorite",
                            "Removed", "Notes") if c in cols or c == "Id"]
        offset = 0
        while True:
            res = api("GET", f"/api/v2/tables/{tid}/records?limit=1000"
                              f"&offset={offset}&fields="
                              + requests.utils.quote(",".join(want)))
            batch = res.get("list", [])
            for rec in batch:
                code = reg.normalize_code(rec.get("Lead Code"))
                if not code:
                    continue
                by_row[(tid, rec["Id"])] = code
                # Only rows carrying actual work — a base full of untouched
                # 'New' rows should not create 35k work rows.
                # Removed is deliberately NOT harvested: it is derived from the
                # blocklist, which is carried across separately and re-applied.
                # Storing it would make a removal stick forever even after the
                # number came off the do-not-call list.
                if (rec.get("Status") not in (None, "", "New")
                        or rec.get("Owner") or rec.get("Favorite")
                        or rec.get("Notes")):
                    work.append((code, {
                        "status": rec.get("Status"), "owner": rec.get("Owner"),
                        "favorite": rec.get("Favorite"),
                        "notes": rec.get("Notes")}))
            if len(batch) < 1000:
                break
            offset += 1000
        snapshot[title] = (tid, {c: rid for (t_, rid), c in by_row.items()
                                 if t_ == tid})
        found += 1

    n = reg.save_work(con, work)
    m = harvest_notes(con, by_row)
    print(f"  harvested {n} rows of work product and {m} notes "
          f"from {found} tables")
    return snapshot


def orphan_rows(snapshot, keep):
    """Rows in the base that this parse will not reproduce — carry them across.

    The 🔎 Find jobs button inserts straight into the Job Board; those rows exist
    in no source file, so a rebuild used to bin them along with the Apify credits
    that paid for them. Anything with a Lead Code the parse did not produce is
    fetched in full and re-inserted afterwards, which is the same courtesy the
    blocklist already got.
    """
    out = {}
    for title, (tid, by_code) in snapshot.items():
        missing = [rid for code, rid in by_code.items()
                   if code not in keep.get(title, set())]
        if not missing:
            continue
        rows = []
        for i in range(0, len(missing), 100):
            ids = ",".join(str(x) for x in missing[i:i + 100])
            where = requests.utils.quote("~or".join(f"(Id,eq,{x})"
                                                    for x in missing[i:i + 100]))
            res = api("GET", f"/api/v2/tables/{tid}/records"
                             f"?limit=100&where={where}")
            rows += res.get("list", [])
        # drop everything NocoDB owns: row id, audit stamps, link fields
        clean_rows = []
        for r in rows:
            clean_rows.append({k: v for k, v in r.items()
                               if k not in ("Id", "CreatedAt", "UpdatedAt",
                                            "nc_created_by", "nc_updated_by")
                               and not isinstance(v, (list, dict))})
        out[title] = clean_rows
        print(f"  carrying {len(clean_rows)} {title} rows that are in no source file")
    return out


def harvest_notes(con, by_row):
    """Record comments, read straight from noco.db.

    The comments API is one call per row; at 35k rows that is untenable for a step
    that runs on every rebuild. This reads the same data in one query. It is the
    only place setup_v2 reaches past the API, so it is wrapped — a NocoDB schema
    change here must not be able to abort a rebuild.
    """
    db = APP / "noco.db"
    if not db.exists() or not by_row:
        return 0
    items = []
    try:
        con2 = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        con2.row_factory = sqlite3.Row
        rows = con2.execute(
            "SELECT fk_model_id, row_id, comment, created_by_email, created_at "
            "FROM nc_comments WHERE is_deleted IS NOT 1").fetchall()
        con2.close()
        for r in rows:
            code = by_row.get((r["fk_model_id"], int(r["row_id"])))
            if code and r["comment"]:
                items.append((code, r["created_by_email"], r["comment"],
                              str(r["created_at"])))
    except Exception as e:                       # noqa: BLE001 - never fatal
        print(f"  (could not read comments: {e})")
        return 0
    return reg.save_notes(con, items)


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

    # Cluster rather than dedupe: the identity registry needs to see which rows
    # formed each business so it can remember every natural key they arrived on.
    co_groups, co_info = cluster(companies, "Company")
    pe_groups, pe_info = cluster(people, "Lead")
    jb_groups, jb_info = cluster(jobs, "Company")

    # ---------------- identity + work product
    # Harvest BEFORE the base is deleted, or the team's work goes with it.
    print("Registry:", reg.DB)
    bak = reg.backup()
    if bak:
        print(f"  backed up to {bak.name}")
    con = reg.connect()
    snapshot = harvest(con)

    def codes_for(groups, info, rows, name_field, entity_type):
        codes, st = reg.resolve(con, keysets_for(groups, info, rows, name_field),
                                entity_type)
        label = {"company": "companies", "person": "people", "job": "jobs"}
        print(f"  {label[entity_type]:<10} reused {st['reused']:>6}  new {st['minted']:>6}"
              f"  merged {st['merged']:>4}  untrackable {st['keyless']:>4}")
        return codes

    print("Resolving lead codes:")
    co_codes = codes_for(co_groups, co_info, companies, "Company", "company")
    pe_codes = codes_for(pe_groups, pe_info, people, "Lead", "person")
    jb_codes = codes_for(jb_groups, jb_info, jobs, "Company", "job")

    work = reg.load_work(con)
    notes = reg.load_notes(con)

    def collapse(groups, codes, rows, name_field):
        out = []
        for members, code in zip(groups, codes):
            r = merge_cluster(rows, members, name_field)
            if r is not None:
                r["Lead Code"] = code
                out.append(r)
        return out

    companies = collapse(co_groups, co_codes, companies, "Company")
    people = collapse(pe_groups, pe_codes, people, "Lead")
    jobs = collapse(jb_groups, jb_codes, jobs, "Company")
    print(f"Split: {len(companies)} companies, {len(people)} people, "
          f"{len(jobs)} job postings")

    # anything already in the base that these files do not reproduce — read it
    # out now, while the base still exists
    orphans = orphan_rows(snapshot, {
        "Companies": {r["Lead Code"] for r in companies},
        "People": {r["Lead Code"] for r in people},
        "Job Board": {r["Lead Code"] for r in jobs}})

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
        C("Lead Code", "SingleLineText"),
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
        C("Lead Code", "SingleLineText"),
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
        C("Lead Code", "SingleLineText"),
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
        """Bannable phone key for a row — see phone_key(), which dedupe() shares."""
        return phone_key(r.get("Phone"))

    def with_work(r, row):
        """Overlay the team's saved work onto a freshly parsed row.

        Parsed data wins on facts (phone, city, employees — the file is newer);
        the registry wins on judgement (status, owner, favourite, notes), because
        nothing in a spreadsheet knows that someone already qualified this lead.
        """
        code = r.get("Lead Code")
        row["Lead Code"] = code
        w = work.get(code)
        if w:
            row["Status"] = w["status"] or row.get("Status") or "New"
            row["Owner"] = w["owner"] or row.get("Owner")
            row["Notes"] = w["notes"] or row.get("Notes")
            row["Favorite"] = bool(w["favorite"])
            # Removed is intentionally left to the blocklist above — see harvest()
        return row

    def co_row(r):
        return with_work(r, {"Company": r["Company"] or r["Lead"],
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
                "Phone Key": pk(r), "Removed": pk(r) in banned})

    def pe_row(r):
        return with_work(r, {
                "Name": r["Lead"], "Title": r["Title"], "Company": r["Company"],
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
                "Phone Key": pk(r), "Removed": pk(r) in banned})

    def jb_row(r):
        return with_work(r, {
                "Job Title": r["Job Title"], "Company": r["Company"],
                "Contact": r["Lead"] if r["Lead"] != r["Company"] else None,
                "Contact Title": r["Title"], "Email": r["Email"],
                "Industry": r["Industry"], "Employees": r["Employees"],
                "City": r["City"], "State": r["State"],
                "Job URL": r["Job URL"], "Status": r["Status"],
                "Posted": r["Date Added"], "Source File": r["Source File"],
                "Phone Key": pk(r), "Removed": pk(r) in banned})

    print("Inserting companies:")
    co_ids = insert(co_tid, [co_row(r) for r in companies])
    print("Inserting people:")
    pe_ids = insert(pe_tid, [pe_row(r) for r in people])
    print("Inserting job postings:")
    jb_ids = insert(jb_tid, [jb_row(r) for r in jobs])

    for title, tid in (("Companies", co_tid), ("People", pe_tid),
                       ("Job Board", jb_tid)):
        rows_back = orphans.get(title) or []
        if rows_back:
            print(f"Restoring {len(rows_back)} carried {title} rows:")
            insert(tid, rows_back)

    if notes:
        restored = 0
        for tid, ids, rws in ((co_tid, co_ids, companies),
                              (pe_tid, pe_ids, people),
                              (jb_tid, jb_ids, jobs)):
            for rid, r in zip(ids, rws):
                for note in notes.get(r.get("Lead Code"), []):
                    try:
                        api("POST", "/api/v2/meta/comments",
                            json={"fk_model_id": tid, "row_id": str(rid),
                                  "comment": note["body"]})
                        restored += 1
                    except Exception as e:       # noqa: BLE001
                        print(f"  note on {r.get('Lead Code')} failed: {e}")
        print(f"Restored {restored} notes")
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

    # Lead Code is plumbing like Phone Key — it identifies the row, it is not
    # something to browse. Still queryable, just not in the way.
    CO_HIDE = [co_cols[t] for t in ("Notes", "Source", "Source File",
                                    "Phone Key", "Lead Code")]
    PE_HIDE = [pe_cols[t] for t in ("Notes", "Source", "Source File", "City",
                                    "State", "Revenue", "Phone Key", "Lead Code")]
    JB_HIDE = [jb_cols[t] for t in ("Notes", "Source File", "Phone Key",
                                    "Lead Code")]

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
