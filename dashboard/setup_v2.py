"""
Karma Leads — the clustering and franchise guards (the Python sibling of
server/dedupe.js; change the guards in BOTH until step 6b retires this side).

sync.py imports cluster()/keysets_for()/merge_cluster()/phone_key() from here
to resolve which Lead Code each incoming cluster is. The NocoDB base-rebuild
half that used to live below (harvest/insert/link/main) was retired 2026-08-11
with the legacy server — the schema now only ever changes via migrations/.
"""
import re
from collections import defaultdict

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
