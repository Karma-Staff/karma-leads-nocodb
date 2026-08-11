Karma Leads
===========

**Every lead we've collected — Apollo exports, Bitrix CRM dumps, vendor lists, the
master restoration database and LinkedIn job postings — in one dashboard the team
can actually work.** Mark leads contacted, leave notes, favourite them, ban numbers
we're not allowed to call, drop in new spreadsheets, and pull fresh LinkedIn job
leads on demand.

A custom dashboard and API over **PostgreSQL** (since the 2026-08-11
re-architecture), with [NocoDB](https://nocodb.com) as an admins-only grid on
the side.

| | |
|---|---|
| **Open the app** | <http://localhost:8080/app> |
| **Deep dive** | [`how-it-works.html`](how-it-works.html) — illustrated walkthrough, build guide, hosting costs and project timeline |
| **For Claude Code** | [`../CLAUDE.md`](../CLAUDE.md) |

**Contents** — [Quick start](#quick-start) · [What's in it](#whats-in-it) ·
[Using the app](#using-the-app) · [Adding leads](#adding-leads) ·
[Do-not-call](#do-not-call) · [Refreshing the data](#refreshing-the-data) ·
[Team access](#team-access) · [Troubleshooting](#troubleshooting) ·
[Files](#files)

---

Quick start
-----------

1. **Start everything** — double-click `start-dashboard.bat` (it brings up the
   database and the app).
   _Leave the black window open; closing it stops the dashboard._
2. **Open** <http://localhost:8080/app>
3. **Sign in** — the button takes you to the team sign-in page (WorkOS).
   **First time:** choose *Sign up* there and register with **the email you
   were invited under** — you're creating your sign-in credential, not your
   access. Access comes from the invite.

> **No shared login.** An account that signs in but was never invited is told
> "not invited — ask your manager" instead of being dropped into an empty app.
> Admins invite people with
> `node server/cli.js user:add name@karmastaff.com member`.

**Two account levels.** Everyone works leads the same way; **admins** (the
manager) additionally get 🔎 Find jobs, the import drop zone, user management,
the NocoDB admin link, and the **Team activity** tab — a per-day chart plus a
live feed of who did what, recorded by the server itself.

> **Blank or broken page after an update?** Hard-refresh with **Ctrl+Shift+R**.

---

What's in it
------------

| View | Rows | What it is |
|---|---:|---|
| **Companies** | 32,888 | Companies to call — Bitrix CRM, vendor lists, master restoration DB, adjuster lists |
| **People** | 2,305 | Named individuals — Apollo exports, CRM rows with a contact name |
| **Job board** | 144 | LinkedIn postings, with the hiring contact where we have one |
| *Segments* | 221 | Category × State groups behind "Similar companies" (computed, not a table you maintain) |
| *Blocklist* | 531 | Numbers we are banned from calling |

**35,337 leads**, of which 241 sit in **Removed**. Companies and People are linked,
so opening a person shows their colleagues and opening a company shows everyone we
know there.

**The strip along the top** is six live figures — total leads, phone coverage,
email coverage, Contacted, Qualified, and new-this-week — each with a bar showing
the ratio behind it. Hover any number for the exact figure. They refresh on load
and after any import, job search or status change.

> **This is a calling list first.** 32,012 live leads have a phone number; only
> 11,648 have an email. Worth knowing before anyone plans an email campaign off it.

---

Using the app
-------------

### Finding leads

- **Sidebar** — Companies · People · Job board · Recent · Favorites · Removed, each
  with a live count. Removed leads are excluded from every other view.
- **🕐 Recent** — the last 50 leads **you** worked on: anything you opened, starred,
  re-statused, assigned or noted. It starts empty, it's yours alone, and it follows
  your sign-in rather than your browser. **Clear** empties it without touching the
  leads.
- **Search** — matches name, company, email and city.
- **⇅ Sort** — newest, name, company size, certifications, revenue, state, city,
  status. The menu only offers what the current tab actually has. Your choice sticks.
- **📍 State** — our sources disagree about spelling, so `FL` and `Florida` count as
  the same state. State names always display in full, never abbreviated.
- **◉ Status** — New / Contacted / Responded / Qualified / Not interested.
- **Pages** — first / prev / next, with **Show 25 / 50 / 100 / 200**. ("Last"
  is greyed out by design — paging is now the fast kind that can't jump to an
  arbitrary page, in exchange page 400 costs the same as page 1.)
- **▤ ▥ ▦** row height, **Light / Dark**, and drag-to-resize panes. All remembered.

### Working a lead

Click any row to open it on the right.

| Control | What it does |
|---|---|
| **🔍 Google** | Searches the company name **plus its location** — what separates one "ABC Restoration" from the other twelve |
| **in LinkedIn** | On a person, their name plus company; on a company, LinkedIn's *Companies* tab |
| **Email address** | Click to copy. Shift-click opens a new mail instead |
| **Status** | New → Contacted → Responded → Qualified / Not interested |
| **★ Favorite** | From the row or the reading pane; collects under Favorites |
| **Owner** | Type a name or email to claim the lead |
| **Notes** | A timestamped, per-user thread — the real record of what happened. Hover your own note for ✎ edit and 🗑 delete |

**Related leads** shows people at that company, its open job postings, and similar
companies.

### Team activity (admins)

The **Team activity** tab in the sidebar is the manager's view of the whole
team: a per-day bar chart split by person, and a live feed — *"sarah set Acme
Restoration to Qualified · 10m ago"* — where every entry clicks through to the
lead. It's fed by the server's own log of every status change, note, removal,
import and job search, so it can't be gamed from a browser. Pick 7 / 30 / 90
days at the top. The log started at the migration cutover, so it fills in as
the team works.

### Browsing a whole segment

Under **Similar companies**, the blue tag names the group — `Restoration · New York`.
**Click the tag** and the middle pane switches to *every* company in that group,
paged like any other view. A blue banner and a **← Back to Companies** button make it
obvious where you are.

Search, state and status filters still apply inside a segment — and since the
re-architecture, **sorting works there too**.

---

Adding leads
------------

### Drop a spreadsheet on it (admins)

Click **⬆ Import leads**, or drag an `.xlsx`, `.xls` or `.csv` anywhere onto the
window. There's no manual add-a-lead form — leads arrive from a file or a job search.

- **Columns are matched by name**, so Apollo, Bitrix, vendor, master-DB and LinkedIn
  exports all import as-is. Unrecognised columns are listed and skipped.
- **Rows are routed** to Companies, People or Job board automatically.
- **Duplicates are skipped**, and **blocked numbers stay blocked**.
- Imports get today's date, status **New**, source **Excel import**, and the
  category you pick.

The result panel reports what landed where and what was skipped. A few thousand rows
takes a few seconds — don't close the window while it runs.

### 🔎 Find jobs — live LinkedIn postings (admins)

**🔎 Find jobs** searches live postings and drops results into the Job board.
**⚙** beside it opens the settings. It comes pre-loaded with our standard search:

> Back-office roles — office admin, estimator, bookkeeper, marketing coordinator and
> a dozen more — at restoration companies with **200 employees or fewer**, anywhere
> in the US, posted in the **last 7 days**.

_The reasoning: a small restoration firm hiring an office administrator is a firm
with money to spend and no back office to spend it on. That's our pitch._

**This one costs money.** Billed per job returned at **$5.00 per 1,000** — 50 jobs is
about 25¢. The settings panel shows a running maximum as you type, the confirm screen
repeats it with your remaining credits, and **nothing is spent until you press the
button**. A search that matches nothing costs nothing. Turning on **recruiter
contacts** triples the rate to $15/1,000, in return for a named person to call.

In **⚙** you can change job titles, description keywords, locations (one per line as
`City, State, Country`), the posting window, max results, and a set of advanced
filters. Settings save to your own browser; **Reset** restores the standard search.

> **Not finding anything?** Usually over-narrow settings. Widen **Posted within**
> first, then drop a location or a title.

---

Do-not-call
-----------

### One lead

Open it → **🚫**. This is not a delete, it's a *do-not-call*: the number joins the
**Blocklist**, **every lead sharing that number** is removed across all three tables,
and future imports of it arrive already removed.

**The dialog tells you how many leads will go before you confirm.** Check it — some
franchise and toll-free lines are shared by several unrelated businesses. A lead with
no usable number removes only itself.

To undo: open it in **Removed** → **↩**.

### A whole file

Drop the CSV in `dnc/` and run (same `KARMA_API_URL` / `KARMA_API_TOKEN`
environment as `sync.py`):

```
python dashboard/import_dnc.py --dry-run     # preview — always do this first
python dashboard/import_dnc.py               # apply
```

Same thing the 🚫 button does, for the whole file at once. Statuses, notes, owners
and favourites all survive. Re-running next month only applies the difference.

> Applied so far: **531 numbers**, which removed 229 companies and 22 people.

---

Refreshing the data
-------------------

### Normal refresh

Needs two environment variables (ask the admin — the token comes from
`node server/cli.js token:create`): `KARMA_API_URL` and `KARMA_API_TOKEN`.

```
python dashboard/sync.py --dry-run     # prints the plan, writes nothing
python dashboard/sync.py
```

Reads the source files and reconciles them against what's already there: **new leads
are added, changed details are updated, and nothing is ever deleted.** Your statuses,
owners, favourites and notes are untouched — a spreadsheet has no opinion about
whether you've qualified someone.

A lead that disappears from an export is left exactly where it is. Exports change all
the time; that isn't evidence a business closed. Use 🚫 when you want a lead gone.

### Changing the table structure

There is no destructive rebuild any more. Schema changes are SQL files in
`migrations/`, applied with `node server/migrate.js` — statuses, invitations
and row ids all survive. (`setup_v2.py` remains only as the home of the
dedupe functions `sync.py` imports.)

> ⚠️ Every lead's permanent **Lead Code** (`KL-7QX4M2H8ZB`) is the identity
> everything hangs off. The codes live in PostgreSQL now and in
> `data\lead_registry.db` (the pipeline's copy) — the nightly `pg_dump` in the
> production stack covers the first; keep a copy of the second off-machine.

---

Team access
-----------

1. **Invite them** (this is what grants access and sets the level):
   `node server/cli.js user:add name@karmastaff.com member` — or `admin` for
   the manager. Roles live in the app's own database; the sign-in provider has
   no say in them.
2. **They sign up**: at <http://localhost:8080/app> they click **Sign in**,
   choose *Sign up* on the hosted page, and register **with that exact
   email**. Order doesn't matter — signing up before being invited just shows
   "not invited" until step 1 happens.

Over the network it's `http://<this-PC's-IP>:8080` (allow port 8080 through
Windows Firewall first).

To promote, demote or disable someone later: the same `user:add` command
updates the role in place, and disabling is available to admins through the
API. The last remaining admin can't demote or disable themselves.

> **Hosting it properly** is ready when we are: `docker-compose.prod.yml` runs
> the same stack on any Docker host with TLS and nightly backups —
> `how-it-works.html` has the story.

---

Troubleshooting
---------------

| Symptom | Fix |
|---|---|
| Page is blank or half-broken | Hard-refresh: **Ctrl+Shift+R** |
| "This site can't be reached" | Server isn't running — start `start-dashboard.bat` |
| "… is not invited to Karma Leads" | You signed in with an email nobody invited. Ask an admin for `user:add`, or sign in with the invited address |
| Sign-in page itself errors ("redirect uri invalid") | The callback URL isn't allowlisted in the WorkOS dashboard → Redirects |
| Import says "no recognisable columns" | The header row isn't the first row, or the columns have unusual names |
| Counts look wrong after removing leads | Refresh — counts recalculate on load |
| Job search returns 0 jobs | Settings too narrow. Widen **Posted within** first. Nothing is charged |
| Job search fails, or credits show "—" | Apify unreachable or monthly cap spent. Check the credit bar in **⚙** |
| Cost shows "unavailable" after a run | The jobs still imported — only Apify's billing figure was slow |

---

Files
-----

| | |
|---|---|
| **App folder** | `C:\Users\David\karma-leads-nocodb` |
| **Database** | PostgreSQL in Docker (`docker compose up -d`) — `karma` is the application, `nocodb_meta` is NocoDB's own |
| **The API + app** | `server\` (Node) and `public\` (plain HTML/CSS/JS, no build step — edit and refresh) |
| **Identity registry** | `data\lead_registry.db` — the pipeline's code registry. Keep a copy off-machine |
| **Old database** | `data\noco.db` — the pre-migration SQLite, kept as a backup, no longer served |
| **Apify key** | `apify_token.json` (or the `APIFY_TOKEN` env var) — never leaves the server |
| **Secrets** | `.env` and `.env.server` — see `.env.example` for why there are two |
| **Source spreadsheets** | `old leads/`, `master_leads/`, `New_job_search/` (outside the repo) |

### Known data quirks

_These are the data, not bugs to fix silently._

- **The same business can appear twice** from two sources with different phone
  numbers. It shows up as a company listed under its own "Similar companies".
- **Firmographic coverage is uneven by source.** Apollo people have headcount;
  Bitrix and master-DB companies mostly don't — the master DB carries a
  certification count instead.
- **Roughly a fifth of states are inferred**, not sourced. The Bitrix exports had no
  usable state at all, so it's derived from the city or the phone's area code —
  about 96% accurate.
- **"Date Added" comes from the `MMDD` in the filename**, because OneDrive resets
  file timestamps. Files without one have a blank date, so those leads never count
  towards "New this week". _(The Recent tab is unaffected — it follows what you
  clicked.)_
