"""Durable identity for leads, so a rebuild stops being a destructive event.

The problem this exists to solve
--------------------------------
`setup_v2.py` drops the base and recreates it, and NocoDB row Ids are positional.
So every rebuild renumbered every lead: statuses, owners, favourites and notes
were destroyed, `recents.json` silently pointed at *different* companies, and any
deep link went stale. Fixing a data bug and keeping the team's work were
mutually exclusive — which mattered the moment anyone actually used the tool.

The shape
---------
Standard master-data management: a meaningless surrogate key plus a crosswalk of
every natural key ever observed for it.

    lead        one row per real-world business  ->  lead_code, the primary key
    lead_key    natural key  ->  lead_code        (phone / email / name+city)
    lead_work   status, owner, favourite, removed keyed by lead_code
    lead_note   record comments keyed by lead_code

`lead_code` is deliberately opaque — `KL-7QX4M2H8ZB`, drawn from Crockford
base32, carrying no phone number, no name, no row number and no entity type.
A key derived from the data breaks the moment the data is corrected, which is
the whole reason surrogate keys exist. Entity type lives in a *column* precisely
because a lead can move between Companies and People when a source changes its
mind about whether `Lead` differs from `Company`; if the type were baked into
the key, that move would orphan the identity.

Crockford's alphabet omits I, L, O and U, so a code read down a phone or copied
out of a support ticket cannot be ambiguous. `normalize_code()` applies the
decoding rule (I/l -> 1, O -> 0) so a mistyped code still resolves.

THIS FILE'S DATABASE IS THE CROWN JEWELS. `lead_registry.db` is the only place
the mapping lives. `noco.db` is now a disposable projection of it — losing the
registry means every lead gets a new code and all work product detaches.
`backup()` is called automatically before any destructive operation.
"""
import os
import re
import shutil
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
DB = APP / "lead_registry.db"

SCHEMA_VERSION = 2

# Crockford base32: no I, L, O or U, so codes survive being read aloud.
_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_PREFIX = "KL-"
_CODE_LEN = 10
_CODE_RE = re.compile(r"^KL-[0-9A-HJKMNP-TV-Z]{%d}$" % _CODE_LEN)

ENTITY_TYPES = ("company", "person", "job")
# Strongest first. The crosswalk registers the weaker kinds only when a cluster
# has nothing better, so two same-named branches never fight over one key.
KEY_TYPES = ("phone", "email", "namecity", "name")

DDL = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS lead (
    lead_code   TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('company','person','job')),
    first_seen  TEXT NOT NULL,
    last_seen   TEXT NOT NULL,
    -- set when a later run proves two codes were always one business. The
    -- tombstone is kept, never deleted, so old deep links still resolve.
    merged_into TEXT REFERENCES lead(lead_code)
);
CREATE INDEX IF NOT EXISTS lead_merged_idx ON lead(merged_into);

-- entity_type is part of the key, not a tag on it. A contact shares their
-- employer's phone number, so ('phone', 2125551000) legitimately names both a
-- company and a person — two different businesses-of-record. Without the
-- namespace the person inherits the company's code, then steals the key, and
-- the next run sees both codes on one cluster and "merges" them. Measured: 243
-- of 32,887 company codes drifted on the second run before this was scoped.
CREATE TABLE IF NOT EXISTS lead_key (
    entity_type TEXT NOT NULL CHECK (entity_type IN ('company','person','job')),
    key_type  TEXT NOT NULL CHECK (key_type IN ('phone','email','namecity','name')),
    key_value TEXT NOT NULL,
    lead_code TEXT NOT NULL REFERENCES lead(lead_code),
    PRIMARY KEY (entity_type, key_type, key_value)
);
CREATE INDEX IF NOT EXISTS lead_key_code_idx ON lead_key(lead_code);

CREATE TABLE IF NOT EXISTS lead_work (
    lead_code  TEXT PRIMARY KEY REFERENCES lead(lead_code),
    status     TEXT,
    owner      TEXT,
    favorite   INTEGER NOT NULL DEFAULT 0,
    removed    INTEGER NOT NULL DEFAULT 0,
    notes      TEXT,
    updated_at TEXT NOT NULL
);

-- A note's identity CANNOT include created_at. Restoring a comment mints a fresh
-- timestamp (the API will not accept the original), so the next harvest saw it as
-- a new note and every rebuild doubled the count. Author + body it is: the cost is
-- that one person posting the identical text twice on one lead collapses to one,
-- which is a far better failure than unbounded duplication.
CREATE TABLE IF NOT EXISTS lead_note (
    note_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_code  TEXT NOT NULL REFERENCES lead(lead_code),
    author     TEXT,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (lead_code, author, body)
);
CREATE INDEX IF NOT EXISTS lead_note_code_idx ON lead_note(lead_code);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
"""


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect(path=None):
    con = sqlite3.connect(path or DB)
    con.row_factory = sqlite3.Row
    con.executescript(DDL)
    con.execute("INSERT OR IGNORE INTO meta(k, v) VALUES ('schema_version', ?)",
                (str(SCHEMA_VERSION),))
    con.commit()
    _migrate(con)
    return con


def _migrate(con):
    """Bring an older registry up to SCHEMA_VERSION. Additive and idempotent."""
    row = con.execute("SELECT v FROM meta WHERE k = 'schema_version'").fetchone()
    have = int(row["v"]) if row else SCHEMA_VERSION

    if have < 2:
        # lead_note's UNIQUE used to include created_at, so restored comments came
        # back as new notes and every rebuild doubled them. Rebuild the table on
        # (lead_code, author, body), keeping the earliest copy of each.
        con.executescript("""
            CREATE TABLE lead_note_v2 (
                note_id    INTEGER PRIMARY KEY AUTOINCREMENT,
                lead_code  TEXT NOT NULL REFERENCES lead(lead_code),
                author     TEXT,
                body       TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE (lead_code, author, body)
            );
            INSERT INTO lead_note_v2(lead_code, author, body, created_at)
              SELECT lead_code, author, body, MIN(created_at)
              FROM lead_note GROUP BY lead_code, author, body;
            DROP TABLE lead_note;
            ALTER TABLE lead_note_v2 RENAME TO lead_note;
            CREATE INDEX IF NOT EXISTS lead_note_code_idx ON lead_note(lead_code);
        """)
        con.execute("UPDATE meta SET v = '2' WHERE k = 'schema_version'")
        con.commit()
        print("  registry migrated to schema 2 (de-duplicated notes)")


def backup(path=None):
    """Copy the registry aside before anything destructive touches it."""
    src = Path(path or DB)
    if not src.exists():
        return None
    dst = src.with_suffix(f".db.bak-{datetime.now():%Y%m%d-%H%M%S}")
    con = sqlite3.connect(src)
    try:                                    # online backup: WAL-safe, no lock games
        out = sqlite3.connect(dst)
        con.backup(out)
        out.close()
    finally:
        con.close()
    return dst


# ------------------------------------------------------------------- codes
def new_code(rand=os.urandom):
    n = int.from_bytes(rand(8), "big")
    body = ""
    for _ in range(_CODE_LEN):
        body = _ALPHABET[n % 32] + body
        n //= 32
    return _PREFIX + body


def normalize_code(code):
    """Crockford decoding: I/l -> 1, O -> 0, case-insensitive. None if malformed."""
    if not code:
        return None
    s = str(code).strip().upper().replace(" ", "")
    if not s.startswith(_PREFIX):
        s = _PREFIX + s.lstrip("-")
    head, body = s[:len(_PREFIX)], s[len(_PREFIX):]
    body = body.replace("I", "1").replace("L", "1").replace("O", "0").replace("U", "V")
    out = head + body
    return out if _CODE_RE.match(out) else None


# --------------------------------------------------------------- resolution
def _follow(con, code, _seen=None):
    """Walk merged_into to the surviving code."""
    seen = _seen or set()
    while code and code not in seen:
        seen.add(code)
        row = con.execute("SELECT merged_into FROM lead WHERE lead_code = ?",
                          (code,)).fetchone()
        if row is None or row["merged_into"] is None:
            return code
        code = row["merged_into"]
    return code


def resolve(con, clusters, entity_type, stamp=None):
    """Give every cluster a lead_code, reusing the one it had last time.

    `clusters` is a list of key-sets — one set of (key_type, key_value) tuples per
    real-world business, in output order. Returns (codes, stats) where codes[i] is
    the lead_code for clusters[i].

    Three cases, and the third is the one that matters:
      * no key matches      -> mint a new code
      * one code matches    -> reuse it (the common path)
      * several codes match -> a previously-split business has been recognised as
        one. The oldest code survives; the others are tombstoned with merged_into
        and their keys and work product move across. Nothing is deleted, so an old
        code pasted into a URL still resolves to the survivor.
    """
    assert entity_type in ENTITY_TYPES, entity_type
    stamp = stamp or now()
    codes, claimed = [], set()
    stats = {"reused": 0, "minted": 0, "merged": 0, "keyless": 0}

    for keys in clusters:
        found = []
        for kt, kv in keys:
            row = con.execute(
                "SELECT lead_code FROM lead_key WHERE entity_type = ? "
                "AND key_type = ? AND key_value = ?",
                (entity_type, kt, kv)).fetchone()
            if row:
                surviving = _follow(con, row["lead_code"])
                if surviving and surviving not in found:
                    found.append(surviving)

        # a code already handed to an earlier cluster this run cannot be reused,
        # or two live rows would share one identity
        found = [c for c in found if c not in claimed]

        if not found:
            code = new_code()
            while con.execute("SELECT 1 FROM lead WHERE lead_code = ?",
                              (code,)).fetchone():
                code = new_code()
            con.execute(
                "INSERT INTO lead(lead_code, entity_type, first_seen, last_seen) "
                "VALUES (?,?,?,?)", (code, entity_type, stamp, stamp))
            stats["minted"] += 1
            if not keys:
                stats["keyless"] += 1
        else:
            # oldest wins, so the code a human has already seen is the one kept
            rows = con.execute(
                "SELECT lead_code, first_seen FROM lead WHERE lead_code IN "
                "(%s) ORDER BY first_seen, lead_code" % ",".join("?" * len(found)),
                found).fetchall()
            code = rows[0]["lead_code"]
            for loser in [r["lead_code"] for r in rows[1:]]:
                con.execute("UPDATE lead_key SET lead_code = ? WHERE lead_code = ?",
                            (code, loser))
                con.execute(
                    "INSERT INTO lead_work(lead_code, status, owner, favorite, "
                    "removed, notes, updated_at) "
                    "SELECT ?, status, owner, favorite, removed, notes, updated_at "
                    "FROM lead_work WHERE lead_code = ? "
                    "ON CONFLICT(lead_code) DO NOTHING", (code, loser))
                con.execute("UPDATE lead_note SET lead_code = ? WHERE lead_code = ?",
                            (code, loser))
                con.execute("DELETE FROM lead_work WHERE lead_code = ?", (loser,))
                con.execute("UPDATE lead SET merged_into = ?, last_seen = ? "
                            "WHERE lead_code = ?", (code, stamp, loser))
                stats["merged"] += 1
            con.execute("UPDATE lead SET last_seen = ?, entity_type = ? "
                        "WHERE lead_code = ?", (stamp, entity_type, code))
            stats["reused"] += 1

        claimed.add(code)
        codes.append(code)
        # OR IGNORE, never overwrite: if this key already belongs to another live
        # code, that cluster claimed it first and stealing it would make both
        # identities churn on every subsequent run. Genuine merges have already
        # repointed the loser's keys above.
        for kt, kv in keys:
            con.execute(
                "INSERT OR IGNORE INTO lead_key(entity_type, key_type, key_value, "
                "lead_code) VALUES (?,?,?,?)", (entity_type, kt, kv, code))

    con.commit()
    return codes, stats


# ------------------------------------------------------------- work product
WORK_FIELDS = ("status", "owner", "favorite", "removed", "notes")


def save_work(con, items, stamp=None):
    """items: iterable of (lead_code, dict). Blank/None values do not overwrite.

    Codes are followed through merged_into first: a browser still holding a
    tombstoned code must not strand the team's work on a dead identity.
    """
    stamp = stamp or now()
    n = 0
    for code, w in items:
        code = _follow(con, code)
        con.execute(
            "INSERT INTO lead_work(lead_code, status, owner, favorite, removed, "
            "notes, updated_at) VALUES (?,?,?,?,?,?,?) "
            "ON CONFLICT(lead_code) DO UPDATE SET "
            "  status=COALESCE(excluded.status, lead_work.status),"
            "  owner=COALESCE(excluded.owner, lead_work.owner),"
            "  favorite=excluded.favorite, removed=excluded.removed,"
            "  notes=COALESCE(excluded.notes, lead_work.notes),"
            "  updated_at=excluded.updated_at",
            (code, w.get("status"), w.get("owner"), int(bool(w.get("favorite"))),
             int(bool(w.get("removed"))), w.get("notes"), stamp))
        n += 1
    con.commit()
    return n


def load_work(con):
    return {r["lead_code"]: dict(r) for r in
            con.execute("SELECT * FROM lead_work")}


def save_notes(con, items):
    """items: iterable of (lead_code, author, body, created_at). Idempotent."""
    n = 0
    for code, author, body, created in items:
        code = _follow(con, code)
        cur = con.execute(
            "INSERT OR IGNORE INTO lead_note(lead_code, author, body, created_at) "
            "VALUES (?,?,?,?)", (code, author, body, created))
        n += cur.rowcount
    con.commit()
    return n


def load_notes(con):
    out = {}
    for r in con.execute("SELECT * FROM lead_note ORDER BY created_at"):
        out.setdefault(r["lead_code"], []).append(dict(r))
    return out


def stats(con):
    g = lambda q: con.execute(q).fetchone()[0]
    return {
        "leads": g("SELECT COUNT(*) FROM lead WHERE merged_into IS NULL"),
        "tombstoned": g("SELECT COUNT(*) FROM lead WHERE merged_into IS NOT NULL"),
        "keys": g("SELECT COUNT(*) FROM lead_key"),
        "with_work": g("SELECT COUNT(*) FROM lead_work"),
        "notes": g("SELECT COUNT(*) FROM lead_note"),
        "by_type": {r[0]: r[1] for r in con.execute(
            "SELECT entity_type, COUNT(*) FROM lead WHERE merged_into IS NULL "
            "GROUP BY 1")},
    }


if __name__ == "__main__":
    con = connect()
    s = stats(con)
    print(f"registry: {DB}")
    print(f"  live leads    {s['leads']}   {s['by_type']}")
    print(f"  tombstoned    {s['tombstoned']}")
    print(f"  natural keys  {s['keys']}")
    print(f"  with work     {s['with_work']}")
    print(f"  notes         {s['notes']}")
    if len(sys.argv) > 1:                    # registry.py KL-XXXX -> explain a code
        code = normalize_code(sys.argv[1])
        if not code:
            print(f"\n{sys.argv[1]!r} is not a valid lead code")
        else:
            row = con.execute("SELECT * FROM lead WHERE lead_code = ?",
                              (code,)).fetchone()
            print(f"\n{code}: {dict(row) if row else 'not found'}")
            if row:
                for k in con.execute(
                        "SELECT key_type, key_value FROM lead_key WHERE lead_code = ?",
                        (code,)):
                    print(f"    {k['key_type']:<9}{k['key_value']}")
