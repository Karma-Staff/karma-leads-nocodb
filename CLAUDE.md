# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

The whole Karma Leads system: a custom dashboard and its **domain API** (Node +
Express) over **PostgreSQL**, the Python importers that feed it, and a NocoDB
container demoted to an admin-only grid. Re-architected 2026-08-11 from the
original embedded-NocoDB-over-SQLite design (`docs/how-it-works.html` tells
that story; the old `data/noco.db` is kept as the pre-migration backup).

```
Browser (/app, vanilla JS)
   │ WorkOS AuthKit sealed session (httpOnly kl_session cookie)
   ▼
Domain API   server/index.js on :8080 — serves /app statics + /api/*
   │ pg pool (karma_api role — the ONLY role that may run DDL, via migrations)
   ▼
PostgreSQL 17 (docker: `docker compose up -d`)
   ├─ db `karma`        the application schema — the system of record
   └─ db `nocodb_meta`  NocoDB's own metadata
        ▲
NocoDB container (:8082, admin-only) — attached to `karma` as an external
source through the `nocodb_admin` role, which has row access but NO DDL.
```

The legacy npm-NocoDB server (`node index.js` on :8081) and its xc-auth
adapter were retired 2026-08-11 — WorkOS is the only sign-in.

- `server/` — the domain API: `index.js` (routes+static), `db.js` (pool),
  `auth.js` (WorkOS auth), `service-auth.js` (pipeline tokens), `leads.js`,
  `counts.js`, `recents.js`, `users.js`, `activity.js`, `jobsearch.js`,
  `imports.js` + `import-worker.js`, `dedupe.js` (THE identity/parsing
  implementation), `migrate.js`, `cli.js`.
- `migrations/` — plain SQL, applied by `node server/migrate.js`. **The only
  way the schema changes.** There is no destructive rebuild any more.
- `public/` — the front end (`app.js`, `app.css`, `index.html`). Same
  email-style three-pane UI; its data layer speaks to `/api/*` only.
- `dashboard/` — the Python importers (`sync.py`, `import_dnc.py`,
  `domain_api.py`, `registry.py`, `setup_and_import.py` for parsers,
  `setup_v2.py` for the cluster/guard functions).
- `docs/` — `team-guide.md` (team-facing), `how-it-works.html` (architecture
  story + timeline), `render-migration-runbook.html`, `screenshot.png`.
- `data/` — gitignored local state: `lead_registry.db`, the frozen `noco.db`
  backup, and `backups/` (registry snapshots).
- `scripts/etl-from-noco.js` — the one-off SQLite→Postgres migration, with its
  verification report. Kept as the recovery path from the frozen `noco.db`
  backup. **Destructive** (truncates + reloads from the backup) — never run it
  against a database holding work done since the migration.
- `docker-compose.yml` (dev: postgres + nocodb), `docker-compose.prod.yml` +
  `Caddyfile` + `Dockerfile` (prod adds the api container, TLS, backups).

**Secrets/config** (all gitignored, examples beside them): `.env` (compose
passwords ONLY), `.env.server` (the API's `DATABASE_URL` + the WorkOS keys),
`apify_token.json` (or `APIFY_TOKEN` env).
The raw lead exports still live outside the repo in
`C:\Users\David\OneDrive\Documents\GitHub\KarmaLeads` (override with
`KARMA_LEADS_DATA`) — real names, phones, and a do-not-call list.

## Commands

```bash
docker compose up -d                  # postgres (+ nocodb admin container)
node server/migrate.js                # apply pending migrations (--status to list)
node server/index.js                  # the app: http://localhost:8080/app
start-dashboard.bat                   # all of the above, in order

node server/cli.js token:create pipeline imports:write   # mint a service token
node server/cli.js user:add someone@karmastaff.com [admin|member]

# the everyday refresh from the source files — needs KARMA_API_URL and
# KARMA_API_TOKEN in the environment (see dashboard/domain_api.py)
python dashboard/sync.py --dry-run    # always first; prints the plan
python dashboard/sync.py
python dashboard/import_dnc.py [file.csv] [--dry-run]

python dashboard/registry.py KL-7QX4M2H8ZB    # explain one lead code
```

There is no build step, no linter; the front end is plain HTML/CSS/JS — edit
`public/`, bump the `?v=` cache-busters in `index.html`, refresh. Docker
Desktop works on this machine (WSL2 backend) — an older note here claimed
otherwise; it was fixed 2026-08-11.

## Account levels

Two levels, owned by the domain API (`app_users` + `organization_memberships`
in Postgres — NocoDB has no say):

- **member** — the lead-gen team: work leads, status/owner/notes/favorites,
  remove/restore, every list view except DNC. An accidental remove gets a
  5-second undo toast (bottom right) that restores the exact swept ids.
- **admin** — the manager: everything above plus 🔎 Find jobs (it spends the
  Apify balance), the import drop zone, user management, the NocoDB admin
  link, **deleting leads** (the trash bin, below), and the **Team activity**
  and **DNC** tabs (both under Manage; `/api/leads?removed=true` 403s for
  members).

Enforcement is server-side (403s in `server/*`); the `.admin-only hidden`
markup + reveal in `boot()` is presentation. `node server/cli.js user:add`
or the admin's `/api/users` endpoints manage the roster; the last admin
cannot demote or disable themselves.

**Auto-enrolment**: a first WorkOS sign-in from `@karmastaff.com`
(`AUTO_INVITE_DOMAIN`, `""` disables) creates the member row itself —
`autoInvite()` in `auth.js`. Other domains still bounce with "not invited",
and a **disabled** account is never resurrected by signing in again. Admin is
always a manual promotion (Users tab or the CLI).

## Delete and the trash bin (admin)

`server/trash.js` owns the only path that destroys lead data. `leads.deleted_at`
(+ `deleted_by`, migration `003_trash.sql`) is the bin: a deleted lead vanishes
from every list, count, dedupe lookup, related-rows panel and `findLead()`, but
the row survives for **30 days**, then `purge()` hard-deletes it — swept once at
boot and once a day (`startSweeper()`), or immediately via `DELETE /api/trash`
(the Trash item in the user menu → *Empty trash now*, two clicks).

- **The cascade is asymmetric on purpose**: deleting a **company** also bins its
  job postings; deleting a **job** never touches the company the scrape built.
- **`now()` is transaction-stable, so a company and the jobs it swept share one
  `deleted_at`** — that shared timestamp is the batch id `POST
  /api/trash/:id/restore` matches on, so a restore puts back exactly that sweep
  and not jobs binned separately.
- Hard delete nulls `company_lead_id` on survivors first: that FK has no
  `ON DELETE` clause and would otherwise refuse the delete. Everything else
  (`lead_keys`, `lead_code_aliases`, `lead_comments`, `recents`) cascades;
  `activity_log` has no FK and outlives its leads.
- Every read path filters `deleted_at IS NULL` — `leads.js`, `counts.js`,
  `recents.js`, the `imports.js` dedupe probes, `jobsearch.js`'s known-jobs and
  company-match queries, and the `segments` view. **Add the filter to any new
  query over `leads`**, or binned leads reappear as phantom duplicates.
  Exception: `imports.js`'s lead_code path still updates a binned lead — code is
  identity, and inserting a second row would collide on the UNIQUE `lead_code`.

## The activity log (Team activity tab)

`activity_log` is append-only and written **by the API inside each mutation's
transaction** — status/owner/favorite changes carry from→to, removals carry
reason and blast radius, imports and job searches carry their counts. The one
client-reported event is `open` (it's a read). Nothing ever updates or deletes
log rows; the Recent tab's per-user trail (`recents` table, 50 rows, deduped)
is a separate thing and clearing it does not touch the log.

The tab's **default view is status changes only** — everything is still
logged, but `/api/activity` filters to `action = 'status'` unless `full=1`;
the Logs toggle in the tab header flips to the unfiltered feed.

NocoDB's own audit (`nc_audit_v2`) stays off — it once grew to 1.3 GB.

## Lead identity

Every lead carries a **Lead Code** (`KL-` + 10 Crockford base32) — an opaque
surrogate key minted by `dashboard/registry.py` (Python) or
`server/dedupe.js mintCode()` (JS, same alphabet). `leads.lead_code` is UNIQUE;
old codes from merges live in `lead_code_aliases` so bookmarks still resolve
(`GET /api/leads/KL-…` follows them). `lead_keys` holds every natural key a
lead ever arrived on, migrated from the registry.

`data/lead_registry.db` (SQLite, gitignored) is still the Python pipeline's
identity store — `resolve()` there answers "which code is this cluster" during
`sync.py`. Migration proof: the first post-migration dry-run resolved all
35,243 clusters to existing codes — **0 minted, 0 merged**. The 6b step (moving
resolve() into the import worker on `lead_keys`, retiring the SQLite file) is
designed but not yet done.

## Imports (the only bulk write path)

`server/imports.js` — one contract for the drop zone AND the pipeline:

- `POST /api/import-jobs` (idempotency_key ⇒ retries return the same job;
  a raw file body parses off-thread in `import-worker.js` and auto-commits)
- `POST /api/import-jobs/:id/records` — ≤500 records/batch, schema-validated,
  idempotent by (job, seq)
- `POST /api/import-jobs/:id/commit` — replay-safe; dedupes with indexed key
  lookups sized to the import (never a scan of the base), applies
  blank-never-overwrites, skips no-op updates (`IS DISTINCT FROM`)
- `GET /api/identity-lookup` — TEMPORARY (dry-run insert/update split); dies in 6b
- `POST /api/dnc-import` — bulk 🚫 with dry-run blast radius

Auth: an admin session, or a **service token** (`klsvc_…`, sha256-hashed in
`service_tokens`, scope `imports:write` only — it cannot touch users, roles or
any other endpoint; revoke/rotate via `cli.js`). The pipeline reads
`KARMA_API_URL`/`KARMA_API_TOKEN` from the environment, never source files,
and NEVER connects to Postgres directly.

## Job search: two boards, one endpoint

`POST /api/job-search` takes a `scraper` key — `linkedin` (the fantastic-jobs
actor, default, full filter set) or `indeed` (`misceres~indeed-scraper`: one
title + one location per run, no filters, lower per-result price). The
registry in `server/jobsearch.js` (`SCRAPERS`/`RATES`/`normalizeItem()`) owns
the per-board actor id, rates and item mapping; the admin picks the board in
the ⚙ job-search settings. Jobs from either board land as `kind = 'job'`
leads, told apart by `source_file` (`LinkedIn search` / `Indeed search`).

The choice changes price, filters and whether companies get written, so it is
deliberately loud in the UI (`JS_BOARDS`/`JS_MARK` in `app.js`, `.board-*` in
`app.css`): two brand cards carrying the per-1,000 price, the armed board named
on the 🔎 button (`#js-board-tag`, painted by `paintBoardTag()`), and a brand
banner with a one-click board swap on the confirm step.

## Job search also writes companies (LinkedIn only)

`POST /api/job-search` (`server/jobsearch.js resolveCompanies()`) upserts a
`company` lead for every organization in a **LinkedIn** scrape — logo
(`leads.logo_url`),
website, industry, headcount, and the org's LinkedIn **HQ** city/state (never
the posting's location) — and links each new job via `company_lead_id`.
Matching keeps the franchise guards: name+city keys (`lead_keys`) against the
whole base; bare organization name only among `source = 'Job board'` companies
(within one job board the org name is one LinkedIn entity). On a match only
blank fields are backfilled — a scrape never overwrites curated data. The
front end overlays `logo_url` on the initials avatar and falls back to
initials if the URL goes stale. Indeed scrapes skip the company upsert on
purpose: their items carry only a display name (no HQ/logo/website), and the
bare-name rule above assumes one LinkedIn entity per name — a second board
feeding it could merge franchises.

## Dedupe: franchises are not duplicates

The identity logic lives in **`server/dedupe.js`** (extracted verbatim from the
old import-leads.js, which was itself a port of setup_v2.py — the Python
`cluster()`/guards in `dashboard/setup_v2.py` remain its sibling until 6b;
change the guards in both). The lore is unchanged and load-bearing:

- **Email is not identity.** One SERVPRO regional manager's email sits on nine
  separate franchises. An email match also needs the names to agree and the
  cities not to conflict.
- **Phone is the strongest signal, but gets mistyped.** A phone match is
  refused when the names AND the emails both disagree.
- **Name+city needs a real city** and yields to a phone disagreement — unless
  the source itself said "X DBA Y" (`aliases()` splits DBA names so the master
  sheet meets the vendor files). Names that normalise to a bare trade word
  (`GENERIC`) never match.
- **`pk()` refuses Bitrix placeholder numbers** (`+119000000000`-style: bad
  area code, ≤2 distinct digits, 7 trailing zeros) — up to 46 unrelated
  companies share one. Do not loosen it. Copies: `dedupe.js pk()` (canonical),
  `setup_v2.py phone_key()`, `import_dnc.py pk()` (report-only).

When changing any of this, re-check the counts per brand (`stanley steemer`,
`servpro`, `puroclean`, `rainbow international`): a drop means franchises are
being eaten.

## The front end (`public/`)

Same ~1,900-line vanilla SPA, new data layer. State in one `S` object.

- Sign-in is one button to `/api/auth/login` (WorkOS hosted page); the session
  is the httpOnly `kl_session` cookie — the client holds no token.
  `/api/me` answers identity + role; 403 = authenticated but not invited.
- **`fromApi()` is the whole schema translation**: the API speaks snake_case,
  the render layer still reads the NocoDB-era title-case keys. New fields go
  through there.
- **Every tab is one `/api/leads` query.** Union tabs and their 1,000-row
  correctness cap are gone; Favorites/DNC are filters; a segment is
  `category`+`state` (the Segments table is now a SQL view for the admin grid).
- **Paging is keyset** (`S.cursors`), not offset: any earlier page and exactly
  one page forward are reachable; the "last page" button is disabled by design.
  The Recent tab still pages its ≤50 rows locally.
- The reading pane's related rows arrive embedded on `GET /api/leads/:id`
  (one round trip); only the similar-companies preview is a second fetch.
- Notes are `lead_comments` rows with edit/delete for the author (admin can
  moderate). The old NocoDB record-comments API is gone.
- The Recent tab is still an activity trail, not a date filter; mutations
  touch it server-side, `open` is posted by `touchLead()`.
- KPI row = one `GET /api/counts` (was ~26 requests). `--cat-1..8` are the
  validated categorical slots (light+dark, CVD-checked against this app's own
  surfaces); the Team activity chart uses all 8, folding a 9th person into grey.
- **The KPI tiles are work queues, and clicking one filters the list.** Four
  tiles — Ready to work (has phone, still New), Needs enrichment (no phone and
  no email), Unassigned (no owner), New this week (+ delta vs the previous 7
  days). Each arms `S.focus`, which rides along with whatever tab you are on
  (`?focus=` → `FOCUS` in `leads.js`); clicking the armed tile clears it.
  **The tile's count and the list it opens are the same predicate, written
  twice** — `FOCUS` in `server/leads.js`, the FILTER clauses in
  `server/counts.js`, and `FOCUS_TEST` in `app.js` for the Recent tab's local
  paging. Change one, change all three, or a tile will say 412 and open 380.
- Design rules that survived the migration: states display in full
  (`fullState()`); drawn SVG icons in the nav, not emoji; shallow corner radii;
  `color-scheme` on `:root` for native controls; **bump `?v=` on every
  markup+script change**.

## Gotchas that will bite

- **Keep `.env` (compose passwords) and `.env.server` (API config) split.**
  The legacy NocoDB server once auto-loaded a `DATABASE_URL` from `.env` and
  poured its metadata schema into the app database
  (`scripts/cleanup-nocodb-pollution.sql` was the mop). The server is gone;
  the habit stays: nothing that names a database goes in `.env`.
- **Removal is a phone ban, deletion is the trash.** `POST
  /api/leads/:id/remove` blocklists the number and sweeps every lead sharing
  it, in one transaction; the rows stay, under Manage → **DNC**. `DELETE
  /api/leads/:id` is the admin's, and takes the lead out of the app entirely
  (see below). Don't conflate them.
- **`karma_api` is the only DDL role, and only via `migrations/`.** The
  NocoDB container's `nocodb_admin` role has row access only — an admin-grid
  user can edit data, never the schema (verified: `CREATE TABLE` is denied).
- **Windows lets two processes bind one port.** A stale `node server/index.js`
  and its replacement can both "own" :8080 with traffic going to the old one —
  kill by PID from `netstat -ano` before restarting, or you will debug ghosts.
- **pg type parsers in `db.js` are load-bearing**: bigint→Number and
  date→plain `YYYY-MM-DD` string. Without them ids arrive as strings and
  dates as timezone-shifted ISO datetimes.
- Dates still come from filenames (`file_date()` in `setup_and_import.py`) —
  OneDrive refreshes mtimes. Blank Date Added = no MMDD token in the filename.
- `navigator.clipboard` needs a secure context: fine on localhost and behind
  Caddy's TLS, not over `http://<lan-ip>` — `copyText()` keeps its fallback.

## Known data issues (not bugs to "fix" silently)

- Firmographic coverage is uneven by source (Apollo people have headcount,
  Bitrix/master companies mostly don't; master-DB companies carry certs).
- State naming is inconsistent across sources (`FL` vs `Florida`). The API's
  state filter matches both; the stored data is still split.
- **Roughly a fifth of States are inferred, not sourced** —
  `backfill_states()` fills blanks from city (else area code); measured 86%
  coverage at 96% accuracy. Expect ~1 in 25 inferred states to be wrong.
- One business can appear twice across sources when phones differ — shows up
  as a company listed under its own "Similar companies".

## Auth: WorkOS AuthKit

Implemented in `server/auth.js`, active whenever `WORKOS_API_KEY` /
`WORKOS_CLIENT_ID` / `WORKOS_REDIRECT_URI` / `SESSION_SECRET` are set in
`.env.server`. Sign-in happens on WorkOS's hosted page; the sealed session
lives in the httpOnly `kl_session` cookie and is validated locally (refresh
re-seals it). Being able to sign in ≠ being invited: the email must exist in
`app_users` or the callback bounces back with "not invited". First-time users
choose *Sign up* on the hosted page with their invited email.

**The redirect URI must be allowlisted in the WorkOS dashboard** (Redirects
page) — for dev that is `http://localhost:8080/api/auth/callback`; production
adds the https one. If the WorkOS env vars are missing the server boots with
a warning and nobody can sign in — there is no fallback login.

## Remaining migration work

- **6b**: port `resolve()`/`keysets_for()` into the import worker over
  `lead_keys`; retire `lead_registry.db`.
- **NocoDB admin table sync**: one click in the container UI (Data Sources →
  Sync) to import the table models the attach didn't auto-sync.
- **Cloud deploy**: the repo is a Render Blueprint (`render.yaml` — web
  service from the `Dockerfile` + managed Postgres; health check `/app/`;
  restore the local dump before the team moves over). The walkthrough is
  `docs/render-migration-runbook.html`; `docker-compose.prod.yml` + `Caddyfile`
  remain the self-hosted alternative.
