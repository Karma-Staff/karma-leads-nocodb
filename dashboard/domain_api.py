"""How the Python pipeline reaches the leads system now.

The pipeline no longer talks to NocoDB, and it NEVER talks to PostgreSQL
directly — every write goes through the domain API's import-job endpoints,
authenticated with a scoped service token (imports:write and nothing else).
The same endpoints serve localhost in dev and the cloud host in production,
so there is exactly one code path.

Configuration comes from the environment, never from source files:

    KARMA_API_URL     e.g. http://localhost:8080
    KARMA_API_TOKEN   a klsvc_... token, minted with
                      `node server/cli.js token:create pipeline imports:write`

The flow sync.py drives:

    job = create_job("sync 2026-08-11", idempotency_key=...)
    upload(job, records)          # batches of <=500, idempotent by sequence
    result = commit(job)          # server dedupes/upserts and reports counts

Records are {"lead_code": ..., "kind": ..., "fields": {...}} with snake_case
field names. A record with a lead_code is matched by code (the registry's
identity survives); the server applies only real changes and never lets a
blank overwrite a populated cell.
"""
import os
import time

import requests

BASE_URL = os.environ.get("KARMA_API_URL", "http://localhost:8080")
_TOKEN = os.environ.get("KARMA_API_TOKEN", "")

BATCH = 500                     # the server's per-request record ceiling


def _headers():
    if not _TOKEN:
        raise SystemExit(
            "KARMA_API_TOKEN is not set. Mint one with\n"
            "  node server/cli.js token:create pipeline imports:write\n"
            "and export it (plus KARMA_API_URL if not localhost).")
    return {"Authorization": f"Bearer {_TOKEN}"}


def api(method, path, **kw):
    r = requests.request(method, BASE_URL + path, headers=_headers(),
                         timeout=kw.pop("timeout", 120), **kw)
    if not r.ok:
        raise RuntimeError(f"{method} {path} -> {r.status_code}: {r.text[:500]}")
    return r.json() if r.text else None


# ---------------- import jobs ----------------
def create_job(filename, idempotency_key=None, category=None):
    body = {"filename": filename}
    if idempotency_key:
        body["idempotency_key"] = idempotency_key
    if category:
        body["category"] = category
    return api("POST", "/api/import-jobs", json=body)


def upload(job, records, progress=None):
    """Stage records in <=500-row batches. Sequence numbers make retries safe:
    a re-sent batch overwrites itself instead of doubling."""
    for i in range(0, len(records), BATCH):
        api("POST", f"/api/import-jobs/{job['id']}/records",
            json={"seq_start": i, "records": records[i:i + BATCH]})
        if progress:
            progress(min(i + BATCH, len(records)), len(records))


def commit(job, poll_seconds=2, timeout=1800):
    """Commit and wait for the outcome. Replay-safe: committing a committed
    job just returns its stored counts."""
    out = api("POST", f"/api/import-jobs/{job['id']}/commit")
    deadline = time.time() + timeout
    while out["status"] == "processing" and time.time() < deadline:
        time.sleep(poll_seconds)
        out = api("GET", f"/api/import-jobs/{job['id']}")
    if out["status"] != "committed":
        raise RuntimeError(f"import job {job['id']}: {out['status']} "
                           f"({out.get('error')})")
    return out


# ---------------- reads ----------------
def existing_codes():
    """Every lead code currently in the base — how a dry run tells inserts
    from updates. Pages the (temporary) identity-lookup endpoint."""
    codes, cursor = set(), 0
    while True:
        out = api("GET", f"/api/identity-lookup?cursor={cursor}&limit=2000")
        for row in out["list"]:
            codes.add(row["lead_code"])
        cursor = out.get("nextCursor")
        if not cursor:
            return codes


def dnc_import(numbers, dry_run=True, source=None):
    body = {"numbers": list(numbers), "dry_run": dry_run}
    if source:
        body["source"] = source
    return api("POST", "/api/dnc-import", json=body)
