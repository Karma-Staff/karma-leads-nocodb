# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

The whole system, in one folder: the NocoDB server, the custom front end, and the
Python importers that turn a pile of lead exports into the dashboard.
`C:\Users\David\karma-leads-nocodb\` is both the git repo **and** the folder the
server runs from.

- `index.js`, `import-leads.js`, `job-search.js`, `recents.js` — the server and its
  `/app-api` routes.
- `public/` — the front end (`app.js`, `app.css`, `index.html`).
- `dashboard/` — the Python importers, `README.md` (team-facing), `how-it-works.html`,
  and the generated `nocodb_ids.json`.
- `test_image.png` — the reference design the custom UI was built from.

**Two things live outside git, both by design** (see `.gitignore`):

- **`noco.db`** sits in this folder but is never committed — it is the live database
  and it is rewritten constantly. Same for `recents.json`, `dashboard/blocklist.json`
  and the three `*_token.json` / `admin_credentials.json` secrets, each of which has
  a `.example.json` beside it.
- **The raw lead exports** — `old leads/`, `master_leads/`, `New_job_search/`, `dnc/`
  — stay in `C:\Users\David\OneDrive\Documents\GitHub\KarmaLeads\`. They are real
  names, phone numbers, emails and a do-not-call list, so they are kept off GitHub
  and keep their OneDrive backup instead. The Python scripts reach them through
  `DATA` in `setup_and_import.py` (override with the `KARMA_LEADS_DATA` env var);
  `APP` is this repo. There is no `REPO` constant any more — it conflated the two.

**This folder must never move into OneDrive.** `node_modules` is ~70,000 files and
1.1 GB of NocoDB dependencies, and OneDrive would also try to cloud-sync a live
SQLite file mid-write. That is the entire reason the split existed.

`how-it-works.html` is the illustrated architecture walkthrough. It also carries
**"Building one of these"** — a phase-by-phase technical guide aimed at an
intermediate data scientist, covering the reasoning behind each design decision
and what the project got wrong first — **"Going live"**, which costs out hosting
for ~50 daily users and specifies admin vs user mode — and a **Timeline** of the
project's history. **Add a timeline entry whenever you ship something notable.**
`dashboard/README.md` is the team-facing guide and is deliberately kept short:
put the reasoning in `how-it-works.html` and the instructions in the README.

**The running system is not in this repo.** NocoDB, its SQLite database, and the
front end live in `C:\Users\David\karma-leads-nocodb\` — outside OneDrive on
purpose, so a live `noco.db` is never cloud-synced. Editing files here does not
change the UI.

## Commands

```bash
# start the server (from the repo root — same folder either way now)
cd C:\Users\David\karma-leads-nocodb && node index.js     # or start-dashboard.bat
# http://localhost:8080/app  = team UI   |  /dashboard = NocoDB admin UI

# refresh from the source files WITHOUT dropping anything — the everyday path
python dashboard/sync.py --dry-run
python dashboard/sync.py

# rebuild the whole base from the source files — DESTRUCTIVE, see below.
# Only needed for schema changes now; work product is carried across via the
# identity registry, but row ids, views and invitations are still recreated.
python dashboard/setup_v2.py

# inspect the identity registry, or explain one lead code
python dashboard/registry.py
python dashboard/registry.py KL-7QX4M2H8ZB
```

Requires the server already running on :8080 and the API token at
`api_token.json` in the repo root (read with `encoding="utf-8-sig"`).
There is no build step, no test suite, and no linter. The front end is plain
HTML/CSS/JS — edit `public\` and refresh.

`python dashboard/setup_v2.py` **deletes and recreates the base**: statuses, owners,
notes, comments, favourites **and every member's invitation** are lost. Only the
Blocklist survives (read out of the live table first, topped up from
`dashboard/blocklist.json`, restored after). For adding new files to a base the
team is already using, use the app's import drop zone instead.

## Import pipeline (rebuild path)

Two files, one chain — `setup_and_import.py` is the v1 single-table importer but is
**not** dead code: `setup_v2.py` imports `api()`, `collect()`, `phone_digits` and
`REPO` from it.

1. **Parse** (`setup_and_import.py`) — one `parse_*` per export shape (`parse_apollo`,
   `parse_company_list`, `parse_bitrix`, `parse_vendor_xlsx`, `parse_master`,
   `parse_jobs`), each emitting the flat dict from `lead()`. `collect()` is the
   hardcoded file→parser→category manifest; **adding a source file means adding a
   line there**, reusing an existing parser if the columns match.
2. **Split + dedupe** (`setup_v2.py`) — `Source == "Job board"` → jobs; a row whose
   `Lead` differs from its `Company` → people; everything else → companies.
   `dedupe()` unions rows that agree on **any** key, merging non-empty fields into
   the kept row. See "Dedupe: franchises are not duplicates" below — it is not a
   ladder any more, and the guards are load-bearing.
3. **Create + link** — five tables (Companies, People, Job Board, Segments,
   Blocklist). People and jobs attach to companies by `norm_co()` name match
   (suffixes like llc/inc stripped); Segments are Category × State and power
   "Similar companies".
4. **Views** — per table: main list, Recent (30d), ⭐ Favorites, 🚫 Removed, with
   cluttered columns hidden via the grid-columns PATCH. IDs land in
   `dashboard/nocodb_ids.json`.

Shared cleaning helpers live in `setup_and_import.py` and should be reused rather
than reinvented: `clean`, `clean_place` (drops purely-numeric Bitrix ID codes),
`clean_phone` (strips the leading apostrophe), `to_int`, `trade_label` (readable
trade or `None` — filters bare licence codes like `HIC`/`CGC`/`B`), `cert_count`,
`file_date`.

## Lead identity (`dashboard/registry.py`, `lead_registry.db`)

**`noco.db` is now a projection. `lead_registry.db` is the system of record.**

Every lead carries a **Lead Code** — `KL-7QX4M2H8ZB`, Crockford base32, opaque on
purpose. It is a surrogate key: it encodes no phone number, no name, no row id
and no entity type, because a key derived from the data breaks the moment the
data is corrected. Entity type lives in a *column*, so a lead can move between
Companies and People (a source changing its mind about whether `Lead` differs
from `Company`) without orphaning its identity.

```
lead        lead_code PK, entity_type, first_seen, last_seen, merged_into
lead_key    (entity_type, key_type, key_value) PK -> lead_code
lead_work   lead_code PK, status, owner, favorite, removed, notes
lead_note   record comments, keyed by lead_code
```

`resolve()` matches each dedupe cluster to its existing code through `lead_key`,
which remembers **every natural key the lead ever arrived on**. Three outcomes:
no match mints a code, one match reuses it, several matches mean a previously
split business has been recognised as one — the oldest code wins and the others
are **tombstoned via `merged_into`, never deleted**, so an old code in a URL still
resolves. Measured on the real corpus: a 15,638-row export landing on an existing
19,145-row base left 17,374 of 17,382 codes untouched.

Things that are load-bearing and were each found by a failing test:

- **`entity_type` is part of the key, not a tag on it.** A contact shares their
  employer's phone, so `('phone', 2125551000)` names both a company and a person.
  Unscoped, the person inherited the company's code and stole the key; 243 of
  32,887 company codes drifted on the second run.
- **Key registration is `INSERT OR IGNORE`, never overwrite.** If a key already
  belongs to another live code, that cluster claimed it first; stealing it makes
  both identities churn forever.
- **`keysets_for()` numbers a cluster whose every key is already taken.** Nine
  SERVPRO franchises share one manager's email and our guards *correctly* refuse
  to merge them — but then eight of them can never find themselves again and mint
  a fresh code every run, silently leaking work product. Same for contactless
  namesakes and the two rows with no indexable name.
- **`save_work()`/`save_notes()` follow `merged_into`**, so a browser holding a
  tombstoned code cannot strand the team's work on a dead identity.

`setup_v2.py` now harvests work product into the registry **before** deleting the
base and replays it on insert. Parsed files win on facts (phone, city, employees);
the registry wins on judgement (status, owner, favourite, notes) — nothing in a
spreadsheet knows a lead was already qualified.

**Back the registry up somewhere that is not this folder.** `noco.db` can be
rebuilt from the source files; the codes cannot. `setup_v2.py` and `sync.py`
snapshot it to `lead_registry.db.bak-*` before writing, but that is beside it on
the same disk.

## Refreshing without a rebuild (`dashboard/sync.py`)

```bash
python dashboard/sync.py --dry-run      # always first; prints the plan
python dashboard/sync.py [--limit N]
```

The everyday path. Same files, same clusters, same codes, then: new code →
INSERT, known code → PATCH **only the fields that actually changed**, code absent
from the files → **left alone, never deleted**. A lead vanishing from an export
means the export changed, not that the business closed, and someone may have
spent a week working it — removal is a human decision made with the 🚫 button.
A blank in a file never blanks a populated cell, so a thinner export cannot strip
detail an earlier one supplied. Status/Owner/Favorite/Notes are never written.

`setup_v2.py` remains the only way to change the *schema*, and is still
destructive — but it is no longer the only way to get new data in, which is what
made it dangerous.

## Dedupe: franchises are not duplicates

`dedupe()` in `setup_v2.py` (ported to `import-leads.js`) unions rows that agree
on **any** key. It used to pick one key per row — email, else phone, else
name+city — which meant a phone-only export could never meet an email-only one
however much they overlapped: `Vendor Leads 1216.csv` carries no email at all so
every row keyed on phone, while `Bitrix Vendor Leads 1007` keyed 100% on email.
Those two files could not collide *by construction*.

Unioning on any key alone would have been worse, because the obvious keys lie:

- **Email is not identity.** `t.braun@servpro.com` — one regional manager — sits
  on nine separate SERVPRO franchises with nine different phone numbers. The old
  ladder keyed all nine on that email and collapsed them into one row, erasing
  eight real businesses. An email match now also needs the **names to agree** and
  the **cities not to conflict**.
- **Phone is the strongest signal, but gets mistyped.** `Willies Shoe Repair` and
  `Williams Wooden Floor Company` share a number in the source. A phone match is
  refused when the names *and* the emails both disagree.
- **Name+city needs a real city**, and yields to a phone disagreement — two
  branches in one town are two businesses — *unless* the source itself said
  "X DBA Y".

`aliases()` is why the master sheet ever meets the Bitrix exports: the master
lists the franchisee's legal entity (`Arma Hawk, Llc / Dba Servpro Of
Alexandria`), the vendor files list the trading name (`ServPro of Alexandria`).
Splitting on DBA indexes both halves. Names that normalise to a bare trade word
are dropped (`GENERIC`) — `norm_co()` strips `pc` wherever it appears, so
"Pc Restorations" comes back as "restorations", which would match half the
industry.

`phone_key()` is now the single implementation of the Bitrix-placeholder
rejection; the `pk(r)` inside `main()` delegates to it. Dedupe uses it too, so
`+119000000000`-style fillers no longer merge unrelated companies (they used to,
via `phone_digits`, along with 7-digit fragments — 69 rows silently lost).

When changing any of this, re-check the counts per brand
(`stanley steemer`, `servpro`, `puroclean`, `rainbow international`): a drop
means franchises are being eaten.

## Do-not-call imports (`dashboard/import_dnc.py`)

```bash
python dashboard/import_dnc.py [file.csv] [--dry-run]
```

Bulk version of the app's 🚫 button: every number in the file joins the
Blocklist and every lead sharing it is marked `Removed`. Defaults to the newest
CSV in `dnc/`. Additive — it does not rebuild, so statuses, notes and owners
survive. **Idempotent**: already-banned numbers and already-removed leads are
skipped, so a fresh monthly export only applies the difference. Always
`--dry-run` first; it prints the exact blast radius.

Applied 2026-08-03 from `dnc/DNC(Sheet1).csv` (Zoho export, cp1252): 531 usable
numbers of 756 rows, removing 229 companies and 22 people.

Note this file carries a **third copy of `pk()`** alongside `phone_key()` in
`setup_v2.py` and `pk()` in `import-leads.js`. All three must stay in step.

## The front end (`C:\Users\David\karma-leads-nocodb\public\`)

`app.js` is a ~1,200-line vanilla SPA over the NocoDB REST API — an email-style
three-pane client, no framework, no build. State lives in one `S` object.

- Signs in via `/api/v1/auth/user/signin`, keeps the JWT in `localStorage`, sends
  `xc-auth`. Sign in with a real email — there is **no** admin/admin shorthand
  (it mapped to an account with no base access, so it signed in and showed nothing).
- `discover()` resolves base/table/column **ids at runtime** by title — never
  hardcode ids in `app.js` (`nocodb_ids.json` is for the Python scripts).
- `boot()` must call `discover()` *before* hiding the login screen, so an account
  without base access gets an explanation instead of an empty shell.
- `TABS` maps the six sidebar tabs; `favorites`/`removed` are unions that fetch
  each of the three lead tables and merge locally. `recent` is not a union — see
  below.
- Paging is `limit`/`offset` against NocoDB; union tabs over-fetch each table and
  slice the window locally (`UNION_MAX`), re-sorting with `unionComparator()`.
- `SORTS` entries use `@date`/`@name` placeholders resolved per table by
  `sortField()`; `sortUsable()` hides options a table has no column for.
- The state filter matches both spellings (`FL` and `Florida`) via `STATE_NAME`,
  using `like` because SQLite `=` is case-sensitive on text.
- Notes are NocoDB record comments (`/api/v2/meta/comments`), not the `Notes` column.
- Deep links `/app/?tab=people&open=123`; `?token=`, `?theme=`, `?density=` exist
  for headless-Chrome testing.

**The Recent tab is an activity trail, not a date filter.** It shows the last 25
leads *this account touched* — opened, favourited, re-statused, re-assigned or
noted — newest first, and starts empty for a new account. `TABS.recent` is marked
`activity: true` (not `union`), and `loadList()` takes a separate branch:
`fetchRecentRows()` looks the recorded ids back up one request per table (an
`~or` chain of `(Id,eq,N)`), then filters locally with `matchesFilters()` because
25 rows aren't worth a where clause. Rows that were deleted or removed since are
skipped, and the row date shows `_touchedAt` rather than Date Added. The sort
control is disabled there — the trail has one meaningful order — but `S.sort` is
left alone so the last real choice survives a visit.

The trail itself is per account and server-side (`recents.js` →
`C:\Users\David\karma-leads-nocodb\recents.json`, keyed by email), so it follows
the person between browsers. `touchLead()` writes it fire-and-forget and never
re-renders the list on the response — reshuffling rows under someone's pointer is
worse than being one entry stale. localStorage `kl_recents` is only a paint-first
cache and the fallback when the endpoint is down. `RECENT_MAX` in `app.js` and
`MAX` in `recents.js` must agree. Its GET/POST/DELETE routes are registered in
`index.js` **before** `Noco.init`, same as the import route, and they identify
the caller by asking NocoDB `/api/v1/auth/user/me` with the caller's own JWT —
an entry can only ever land under the account that signed in.

**The segment view** is a seventh tab that isn't in the sidebar: clicking the
segment tag in a company's "Similar companies" block calls `openSegment(id,
label)`, which sets `S.segment` and `S.tab = "segment"`. `loadList()` takes a
third branch through `fetchSegmentPage()`, reading the Segments↔Companies link
(`/links/{colId}/records/{segmentId}`) rather than the Companies table. That
endpoint honours `where`, `fields`, `limit` and `offset` but **silently ignores
`sort`** — hence the disabled "Segment order" sort control, and don't add sort
options back. It also projects down to `Id` + primary value unless you pass
`fields`, which is why `SEGMENT_FIELDS` exists; without it every row loses its
city, certs and date. Any sidebar tab clears `S.segment` via `setTab()`.

**The KPI row** (`.stats` in `index.html`, filled by `runCounts()`) is six
hairline-separated cells, not floating cards: total leads with a
companies/people/jobs composition bar, phone and email coverage meters,
Contacted and Qualified progress meters, and new-this-week with a delta. Meter
tracks are `--accent-soft` — a lighter step of the fill's own hue, not grey —
and the three composition hues (`--cat-1..3`, re-stepped per theme) were
validated for colour-blind separation against this app's own surfaces. Every
bar carries a written label beside it, so no value is conveyed by colour or bar
length alone. `countAllWith()` skips tables lacking the column (Job Board has
`Email` but no `Phone`); the whole refresh is ~26 parallel counts (~0.3s) and
`refreshCounts()` coalesces concurrent calls.

**Iconography is drawn, not typed.** The sidebar views use inline stroke SVGs
(`.nav-ic`, 1.6px `currentColor`) rather than emoji — emoji render differently
per platform and carry their own colour, which fought the active-tab accent.
The logo is an SVG `K` on a rounded tile (`.logo-mark`, filled from `--accent`
so it themes) beside a two-weight `.wordmark` — **Karma**Leads. The favicon is
the same path inline. Row-level facts (📍 city, 🏅 certs, ✉/☎) are still emoji;
converting those is the obvious next sweep.

**Related rows drop the avatar for companies and jobs** (`relatedRow(..., false)`).
An initials circle beside a company name reads as a logo we don't have. People
keep theirs. Company rows carry the city instead, which is why the similar-
companies link fetch asks for `fields=Id,Company,City,State` — the link endpoint
would otherwise return names only.

**Corner radii are deliberately shallow** — `--radius: 6px` for panels, 4–5px
for controls, and no pill shapes; the brief was "straighter and professional".
Circles (avatars, status dots, spinner) are intentional and stayed. The theme
toggle is a text button that names the mode it switches *to* ("Dark" while
light, "Light" while dark), driven by the existing `.theme-ic-*` show/hide
rules — not an emoji.

**Native controls need `color-scheme`.** `:root` sets `color-scheme: light` and
`:root[data-theme="dark"]` sets `dark`. Without it a dark-theme `<select>`
drops a white popup behind near-white option text — the filter dropdowns were
unreadable in dark mode. Style-only fixes on `option` don't cover every build;
the `color-scheme` declaration is the actual fix.

**Changing markup and script together needs a cache-bust.** `index.html` loads
`app.js?v=N` / `app.css?v=N` — bump `N` on every change. A browser that mixes an
old file with a new one throws in `wire()` and renders a blank page; wiring is
best-effort now (`on()` helper) but the version bump is the real fix.

## Spreadsheet import (`karma-leads-nocodb\import-leads.js`)

The app's drop zone POSTs the raw file to `/app-api/import`, a route registered in
`index.js` **before** `Noco.init` (anything after it never sees the request). The
module parses with the `xlsx` package, maps headers by synonym, splits rows, and
bulk-inserts using the *caller's* JWT rather than the API token, so NocoDB
permissions still apply.

It is a deliberate port of `dashboard/setup_v2.py` — same `pk()` phone-key
rejections, same `aliases()` / any-key union and the same three guards, same
blocklist behaviour. **Change one and change the other**, or an import and a
rebuild will disagree about where a row belongs. Before inserting it scans
existing records across the three tables to skip leads already in the base — it
reads `Email`, `Phone Key`, `Company`, `Name` and `City`, because a bare key
match is not enough to call two rows the same business. The scan stops at
`SCAN_CAP` rows and reports `partialDedupe` rather than grinding forever.

## LinkedIn job search (`karma-leads-nocodb\job-search.js`)

The sidebar's **🔎 Find jobs** button queries the Apify actor
`fantastic-jobs/advanced-linkedin-job-search-api` and inserts results into the
Job Board table; the ⚙ gear edits search parameters (kept per-browser in
localStorage `kl_jobsearch`). Two routes in `index.js`, registered before
`Noco.init` like the others: `POST /app-api/job-search` and
`GET /app-api/apify-usage` (credits bar + daily-spend sparkline in the gear
modal, credits line under the button).

- The Apify token lives in `karma-leads-nocodb\apify_token.json` and never
  reaches the browser. The route rebuilds the actor input from a whitelist —
  `buildInput()` caps `limit` at 500 — so the browser can't inflate spend.
- `searchJobs()` calls `discover()` (reused from `import-leads.js`, along with
  `nc`/`insertAll`) *before* the paid Apify call, so a bad JWT costs nothing.
- Billing is pay-per-result: read the live rates via `actorRates()` (cached
  6h) rather than hardcoding — the store page's "$1.50/1,000" blurb was stale,
  the actual event price is $5/1,000 ($15/1,000 with `recruiterOnly`), and it
  can change again. The "actual cost" figure is computed as
  `found × rate + actor-start` because Apify's own `usageTotalUsd` /
  `chargedEventCounts` lag the run by 5–15s.
- Jobs have no phones, so dedupe is by Job URL (query string stripped) with a
  title|company|city fallback — LinkedIn reposts one opening under several job
  ids. Do **not** skip on the actor's `ats_duplicate` flag: it marks overlap
  with the vendor's *other* dataset, not duplication within the results.
- Locations must be sent as full "City, State, Country" strings — the settings
  modal uses one-per-line because the values themselves contain commas. A bare
  country ("United States") also works.
- `JS_DEFAULTS` in `app.js` prefills the standard prospecting search (back-
  office titles × restoration description keywords × `organizationEmployeesLte`
  200, US-wide, 50 results). Merging uses `??`, so a field the user emptied
  *and saved* stays empty — only never-saved fields get defaults. The Reset
  button clears `kl_jobsearch` to return to them.

## Database size

`noco.db` should sit around **10–15 MB**. If it is in the hundreds of MB,
something below has regressed — the leads themselves are only ~7 MB.

- **Audit logging is off** (`NC_DISABLE_AUDIT=true` in `index.js`, beside
  `NC_DISABLE_TELE`). NocoDB otherwise writes a row to `nc_audit_v2` for every
  insert *and every link*, with the full record JSON inline. One rebuild links
  all ~35k rows, so a single run wrote ~180 MB. It had reached 1.3 GB — 586k
  audit rows for 7 MB of leads — before this was switched off (cleared
  2026-08-03). Nothing reads that table; the Recent tab is `recents.json`.
- **`setup_v2.py` orphans the old base.** NocoDB *soft*-deletes: the base gets
  `deleted=1` in `nc_bases_v2` but its physical `nc_<prefix>___*` tables and
  every row in them stay forever. Seven dead bases had accumulated (five full
  copies of Companies). Each rebuild leaves another ~6 MB behind.

To clean up: stop the server (VACUUM needs an exclusive lock), then
`DELETE FROM nc_audit_v2`, drop the `nc_<prefix>___*` tables whose `base_id` in
`nc_models_v2` maps to a `deleted=1` base, and `VACUUM`. Verify the live prefix
first — it is the one base with `deleted=0`. SQLite does not shrink the file
without the VACUUM. Physical columns are snake_case (`source_file`), not the
display titles the API uses (`Source File`).

## Gotchas that will bite

- **Removal is a phone ban.** `removeLead()` bans the number and sweeps all three
  tables. `pk()` in `setup_v2.py` (and its port in `import-leads.js`) deliberately
  refuses to key on Bitrix placeholder numbers (`+119000000000`-style: bad area
  code, ≤2 distinct digits, 7 trailing zeros) — up to 46 unrelated companies share
  one. Do not loosen that validation.
- **States display in full, never abbreviated.** `fullState()` expands `NY` →
  `New York`; `fullSegmentLabel()` does the same for the state half of a
  stored segment title (`Restoration · NY` → `Restoration · New York`). The
  *stored* values and the filter's option values stay abbreviated — only labels
  change, and `buildWhere()` still matches both spellings. There is no
  abbreviating helper any more; don't reintroduce one.
- **Checkbox filters** need `checked`/`notchecked`; `(Favorite,eq,true)` matches nothing.
- **Bulk insert is capped at 100 records** per call (422 `ERR_MAX_PAYLOAD_LIMIT_EXCEEDED`).
- **Link columns**: created on the parent side as uidt `Links`; the auto-created
  mirror on the child is uidt `LinkToAnotherRecord`. Code that walks link columns
  must accept both. Link records from the parent side to batch children.
- **`Noco.init({}, httpServer, app)`** — the 3-arg form. `Noco.init({})` alone crashes.
- **Dates come from filenames.** OneDrive refreshes mtimes, so `file_date()` reads
  the MMDD token in the filename (Jan–Jul → 2025, Aug–Dec → 2024). Files with no
  token get a blank Date Added — that is why some leads never show under the
  NocoDB **Recent (30d)** view or the "New this week" tile. (The app's own Recent
  tab is unaffected; it tracks interactions, not dates.)
- **`navigator.clipboard` needs a secure context.** Fine on localhost, not over
  `http://<lan-ip>` — `copyText()` keeps an `execCommand` fallback for that.
- Docker is not usable on this machine (no WSL); NocoDB runs from the npm package.

## Known data issues (not bugs to "fix" silently)

- Firmographic coverage is uneven by source: Apollo people have headcount,
  Bitrix/master companies mostly do not; master-DB companies carry a certification
  count instead.
- State naming is inconsistent across sources (`FL` vs `Florida`), which splits
  segments. The UI works around it; the data is still split.
- **Roughly a fifth of States are inferred, not sourced.** The Bitrix exports put
  unresolved picklist IDs (`7318`) in the State column, which `clean_place()`
  drops — `Vendor Leads 1216.csv` arrived with 15,638 rows and no state at all.
  `backfill_states()` in `setup_and_import.py` fills a blank State from the row's
  own city (a city that resolves to one state 90%+ of the time in this corpus),
  else from the geographic NANP area code in `AREA_STATE`. Measured on a 30%
  holdout of the rows that do carry a state: **86% coverage at 96% accuracy** —
  so expect roughly one inferred state in twenty-five to be wrong, usually a
  national company whose number is a head-office line. City is tried first
  because it is the row's own location field; the phone may be a mobile.
  It runs at the end of `collect()`, so it applies to every rebuild.
- One business can appear twice across sources when phones differ — dedupe falls
  through to company+city. Shows up as a company listed under its own "Similar
  companies".
