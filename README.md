# Karma Leads

A leads dashboard for Karma Staff: ~38k restoration-industry companies, people and
job-board postings, imported from a pile of CSV/XLSX exports into
[NocoDB](https://nocodb.com), with a custom email-style front end on top.

![the dashboard](test_image.png)

## Layout

Everything in this repo is code. Two things it deliberately does **not** contain:

| What | Where | Why not here |
|---|---|---|
| `noco.db` | this folder, gitignored | The live database — statuses, owners, notes, invitations. Rewritten constantly. |
| Raw lead exports | `…\OneDrive\Documents\GitHub\KarmaLeads\` | Real names, phone numbers, emails and a do-not-call list. Stays out of git, keeps its OneDrive backup. |

```
index.js              server entry — express routes, then Noco.init
import-leads.js       /app-api/import  — the drop-zone spreadsheet importer
job-search.js         /app-api/job-search — LinkedIn search via the Apify actor
recents.js            /app-api/recents — per-account "recently touched" trail
public/               the front end: app.js (~1,200-line vanilla SPA), app.css, index.html
dashboard/
  setup_v2.py         full rebuild: parse → split → dedupe → create → link → views
  setup_and_import.py v1 importer; still the home of every parse_* and the cleaning helpers
  import_dnc.py       bulk do-not-call application
  README.md           team-facing guide
  how-it-works.html   illustrated architecture walkthrough + build guide + timeline
  nocodb_ids.json     generated table/column ids for the Python scripts
CLAUDE.md             working notes: design decisions, gotchas, known data issues
```

## Running it

```bash
node index.js          # or start-dashboard.bat
```

- `http://localhost:8080/app` — the team UI
- `http://localhost:8080/dashboard` — the NocoDB admin UI

There is no build step, no test suite and no linter. The front end is plain
HTML/CSS/JS — edit `public\` and refresh. When you change markup and script
together, bump the `?v=N` on `app.js` / `app.css` in `index.html`, or a browser
that mixes an old file with a new one renders a blank page.

## First-time setup

Three secret files, none of them in git. Copy each `.example.json` and fill it in:

| File | Holds |
|---|---|
| `api_token.json` | A NocoDB API token — the Python scripts authenticate with it |
| `apify_token.json` | An Apify API token for the LinkedIn job search. Never reaches the browser. |
| `admin_credentials.json` | Super-admin seed. Only read when initialising an empty `noco.db`. |

Then `npm install`, and point `KARMA_LEADS_DATA` at the folder holding the raw
exports if it is not at the default path in `dashboard/setup_and_import.py`.

## Rebuilding the base

```bash
python dashboard/setup_v2.py     # DESTRUCTIVE
```

This **deletes and recreates the base**. Statuses, owners, notes, comments,
favourites and every member's invitation are lost; only the Blocklist survives.
To add new files to a base the team is already using, use the app's import drop
zone instead. See `CLAUDE.md` for the full pipeline and the list of things that
will bite you.
