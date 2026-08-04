Karma Leads
===========

**Every lead we've collected — Apollo exports, Bitrix CRM dumps, vendor lists, the
master restoration database and LinkedIn job postings — in one dashboard the team
can actually work.** Mark leads contacted, leave notes, favourite them, ban numbers
we're not allowed to call, drop in new spreadsheets, and pull fresh LinkedIn job
leads on demand.

Built on [NocoDB](https://nocodb.com) with a custom front end on top.

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

1. **Start the server** — double-click `start-dashboard.bat`.
   _Leave the black window open; closing it stops the dashboard._
2. **Open** <http://localhost:8080/app>
3. **Sign in** with your full email address and the password from your invite.

> **No shared login, and no `admin`/`admin`.** That shorthand maps to an account
> with no access to the leads — it signs in and shows you nothing.

<http://localhost:8080/dashboard> is the raw NocoDB admin UI, same login, used for
inviting members. Day to day you want `/app`.

> **Blank or broken page after an update?** Hard-refresh with **Ctrl+Shift+R**.

---

What's in it
------------

| Table | Rows | What it is |
|---|---:|---|
| **Companies** | 32,888 | Companies to call — Bitrix CRM, vendor lists, master restoration DB, adjuster lists |
| **People** | 2,305 | Named individuals — Apollo exports, CRM rows with a contact name |
| **Job Board** | 84 | LinkedIn postings, with the hiring contact where we have one |
| **Segments** | 225 | Category × State groups — these power "Similar companies" |
| **Blocklist** | 531 | Numbers we are banned from calling |

**35,277 leads**, of which 241 sit in **Removed**. Companies and People are linked
by company name, so opening a person shows their colleagues and opening a company
shows everyone we know there.

**The strip along the top** is six live figures — total leads, phone coverage,
email coverage, Contacted, Qualified, and new-this-week — each with a bar showing
the ratio behind it. Hover any number for the exact figure. They refresh on load
and after any import, job search or status change.

> **This is a calling list first.** 32,253 leads have a phone number; only 11,737
> have an email. Worth knowing before anyone plans an email campaign off it.

---

Using the app
-------------

### Finding leads

- **Sidebar** — Companies · People · Job board · Recent · Favorites · Removed, each
  with a live count. Removed leads are excluded from every other view.
- **🕐 Recent** — the last 25 leads **you** worked on: anything you opened, starred,
  re-statused, assigned or noted. It starts empty, it's yours alone, and it follows
  your sign-in rather than your browser. **Clear** empties it without touching the
  leads.
- **Search** — matches name, company, email and city.
- **⇅ Sort** — newest, name, company size, certifications, revenue, state, city,
  status. The menu only offers what the current tab actually has. Your choice sticks.
- **📍 State** — our sources disagree about spelling, so `FL` and `Florida` count as
  the same state. State names always display in full, never abbreviated.
- **◉ Status** — New / Contacted / Responded / Qualified / Not interested.
- **Pages** — first / prev / next / last, with **Show 25 / 50 / 100 / 200**.
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
| **Notes** | A timestamped, per-user thread — the real record of what happened |

**Related leads** shows people at that company, its open job postings, and similar
companies.

### Browsing a whole segment

Under **Similar companies**, the blue tag names the group — `Restoration · New York`.
**Click the tag** and the middle pane switches to *every* company in that group,
paged like any other view. A blue banner and a **← Back to Companies** button make it
obvious where you are.

Search, state and status filters still apply inside a segment. **Sorting doesn't** —
segments come back in a fixed order, so the control reads *Segment order* and is
greyed out.

---

Adding leads
------------

### Drop a spreadsheet on it

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

### 🔎 Find jobs — live LinkedIn postings

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

Drop the CSV in `dnc/` and run:

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

### Normal refresh — use this one

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

### Full rebuild — rarely needed

```
python dashboard/setup_v2.py
```

**Destructive.** It's for changing the *structure* of the tables, not for getting new
leads in.

| ✅ Survives | ❌ Lost |
|---|---|
| Statuses, owners, favourites, notes | Member invitations — everyone must be re-invited |
| The blocklist | Row ids, so old deep links break |
| Every lead's **Lead Code** | — |

Work product survives because it's stored against each lead's permanent **Lead Code**
(`KL-7QX4M2H8ZB`) in `lead_registry.db`, not against its row number.

> ⚠️ **`lead_registry.db` is the one file here that cannot be regenerated.**
> `noco.db` can be rebuilt from the source files; the codes cannot. Keep a backup
> **somewhere other than this folder** — the automatic `lead_registry.db.bak-*`
> snapshots are on the same disk.

---

Team access
-----------

1. Sign in as `pema@karmastaff.com` → click **Karma Leads** → **Members**.
2. Invite by email as **Editor** — they can change statuses, notes and owners, but
   not the table structure.
3. They open <http://localhost:8080/app> on **this** computer, or over the network at
   `http://<this-PC's-IP>:8080` (allow port 8080 through Windows Firewall first).

An account that can sign in but hasn't been invited is told so on the login screen
rather than dropped into an empty app.

> **Thinking about hosting this properly?** `how-it-works.html` has a costed
> walkthrough — roughly **$30–50/month** for ~50 daily users, what breaks on deploy,
> and how admin vs user mode should work.

---

Troubleshooting
---------------

| Symptom | Fix |
|---|---|
| Page is blank or half-broken | Hard-refresh: **Ctrl+Shift+R** |
| "This site can't be reached" | Server isn't running — start `start-dashboard.bat` |
| Signed in but no leads | That account was never invited to the base. Re-invite as Editor |
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
| **App folder** | `C:\Users\David\karma-leads-nocodb` — deliberately outside OneDrive, because a live SQLite file shouldn't be cloud-synced |
| **Database** | `noco.db`, ~13 MB. Back up by copying that one file while the server is stopped |
| **Identity registry** | `lead_registry.db` — **the system of record.** Back this up off-machine |
| **Front end** | `public\` — plain HTML/CSS/JS, no build step. Edit and refresh |
| **Server modules** | `import-leads.js`, `job-search.js`, `recents.js` |
| **Apify key** | `apify_token.json` — never leaves the server; the browser only talks to our own `/app-api` routes |
| **API token** | `api_token.json` |
| **Table/column IDs** | `dashboard/nocodb_ids.json` |
| **Source spreadsheets** | `old leads/`, `master_leads/`, `New_job_search/` |

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
