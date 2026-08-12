# CLAUDE.md

Shared sales dashboard for a lead-gen team: Node/Express API + PostgreSQL,
vanilla SPA in `public/`, Python importers in `dashboard/`.

Run: `docker compose up -d` → `node server/migrate.js` → `node server/index.js`
(http://localhost:8080/app). No build step, no linter.

## Invariants (break these and the data lies)

- **Schema changes ONLY via `migrations/` + `node server/migrate.js`.**
  `karma_api` is the only DDL role.
- **`server/dedupe.js` is identity. Franchises are not duplicates**: an email
  match also needs the names to agree (one SERVPRO manager's email sits on nine
  franchises), a phone match yields when names AND emails disagree, name+city
  needs a real city, and `pk()` refuses Bitrix placeholder phones (up to 46
  unrelated companies share one). Every clause is there because it caught a
  real merge — after any change re-check counts per brand (servpro, stanley
  steemer, puroclean). Python twin: `dashboard/setup_v2.py`.
- **Every query over `leads` filters `deleted_at IS NULL`** (trash bin,
  `server/trash.js`, 30-day purge) or binned leads come back as phantom
  duplicates. Deleting a company bins its jobs; deleting a job never touches
  the company.
- **Removal ≠ deletion.** `POST /api/leads/:id/remove` is a phone ban that
  sweeps every lead sharing the number (Manage → DNC). `DELETE` is the bin.
- **KPI tile predicates are written three times** — `FOCUS` in
  `server/leads.js`, the FILTERs in `server/counts.js`, `FOCUS_TEST` in
  `public/app.js`. Change one, change all three, or a tile says 412 and opens
  380.
- `server/imports.js` is the only bulk write path — idempotent,
  blank-never-overwrites. The pipeline reaches it through
  `KARMA_API_URL`/`KARMA_API_TOKEN`, never Postgres directly.

## Working here

- Auth: WorkOS AuthKit (`server/auth.js`, httpOnly `kl_session`). member works
  leads; admin adds job search, imports, users, trash, DNC, Team activity.
  Enforced server-side — `.admin-only` is presentation only.
- Front end: state in one `S` object; `fromApi()` is the whole snake_case →
  title-case translation; paging is keyset; KPIs are one `/api/counts`.
  **Bump the `?v=` cache-busters in `index.html` on every markup/script change.**
- Keep `.env` (compose passwords) and `.env.server` (DATABASE_URL + WorkOS)
  split — nothing that names a database goes in `.env`.

## Known data issues (not bugs to "fix" silently)

- State naming is inconsistent across sources (`FL` vs `Florida`). The API's
  state filter matches both; the stored data is still split.
- **Roughly a fifth of States are inferred, not sourced.** `backfill_states()`
  fills blanks from city, else area code — 86% coverage at 96% accuracy, so
  expect ~1 in 25 inferred states to be wrong. Nothing in the code says this.
