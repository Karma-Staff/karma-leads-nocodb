# Karma Leads

Every lead we've collected — Apollo exports, Bitrix CRM dumps, vendor lists, the
master restoration database, LinkedIn job postings — pulled into one dashboard the
team can actually work: mark leads contacted, leave notes, favourite them, ban
numbers we're not allowed to call, drop in new spreadsheets as they arrive, and
pull fresh LinkedIn job leads on demand.

Built on [NocoDB](https://nocodb.com) with a custom front end on top.

- **Deep dive:** [`how-it-works.html`](how-it-works.html) — open it in a browser
  for an illustrated walkthrough of how the whole thing fits together. It also
  contains:
  - **Building one of these** — a phase-by-phase technical guide for someone
    with a data background who hasn't shipped a team-facing tool before, with
    the reasoning behind each decision and what this project got wrong first.
  - **Timeline** — the project's history, from thirteen loose exports to the
    current system.
- **For Claude Code:** [`../CLAUDE.md`](../CLAUDE.md)

---

## Quick start

1. **Start the server** — double-click
   `C:\Users\David\karma-leads-nocodb\start-dashboard.bat`
   (leave the black window open; closing it stops the dashboard).
2. **Open** http://localhost:8080/app
3. **Sign in** with your full email address and the password you were sent when
   you were invited. (No shared login, and no `admin`/`admin` shorthand — that
   maps to an account with no access to the leads, so it signs in and shows you
   nothing.)

http://localhost:8080/dashboard is the raw NocoDB admin UI — same login, used for
inviting members and poking at tables directly. Day to day you want `/app`.

> **If the page is blank or looks wrong after an update:** hard-refresh with
> **Ctrl+Shift+R**. The browser can otherwise mix a cached old file with a new one.

---

## What's in it

| Table | Rows | What it is |
|---|---:|---|
| **Companies** | 32,684 | Companies to call (Bitrix CRM, vendor lists, master restoration DB, adjuster lists) |
| **People** | 2,306 | Named individuals to call (Apollo exports, CRM rows with a contact name) |
| **Job Board** | 85 | LinkedIn job postings, with the hiring contact where we have one |
| **Segments** | 202 | Category × State groups — these power "Similar companies" |
| **Blocklist** | 531 | Phone numbers we are banned from calling |

**35,075 callable leads**, plus 251 held in **Removed** (the do-not-call list).
Companies and People are linked to each other by company name, so opening a
person shows their colleagues and opening a company shows everyone we know there.

### The numbers along the top

The strip above the list is six live figures, each with a bar showing the ratio
behind it:

| Tile | Now | What it tells you |
|---|---:|---|
| **Total leads** | 35.1k | Split by companies / people / jobs |
| **Phone numbers** | 32.0k | 91% of leads have a number to call |
| **Email addresses** | 11.6k | 33% have an address — the thinner channel |
| **Contacted** | 0 | Share of the base anyone has worked yet |
| **Qualified** | 0 | How many made it down the funnel |
| **New this week** | — | Added in the last 7 days, against the week before |

Hover any number for the exact figure. They refresh on load and after any import,
job search or status change.

---

## Using the app

### Finding leads

- **Sidebar** — Companies · People · Job board · Recent · Favorites · Removed,
  each with a live count. Removed leads are excluded from every other view. The
  two buttons at the bottom add leads: **🔎 Find jobs** and **⬆ Import leads**.
- **🕐 Recent** — the last 25 leads *you* worked on, most recent first: anything
  you opened, starred, re-statused, assigned or wrote a note on. It starts empty
  and fills as you go, it is yours alone (it follows your sign-in, not your
  browser), and **Clear** at the top right empties it. Clearing the list does not
  touch the leads themselves. Leads you removed drop out of it.
- **Search box** (top) — matches name, company, email and city.
- **⇅ Sort** — newest/oldest, name A–Z or Z–A, biggest/smallest company, most
  certifications, highest revenue, state, city, status. The menu only offers what
  the current tab actually has: no "certifications" on People, no "revenue" on the
  job board. Your choice sticks between sessions.
- **📍 State** — narrows to one state. Our sources disagree about spelling, so
  `FL` and `Florida` count as the same state; the filter matches both. State
  names are always written out in full on screen — never abbreviated — so a
  mixed column doesn't read as two different places.
- **◉ Status** — New / Contacted / Responded / Qualified / Not interested.
- **Pages** — first / prev / next / last along the bottom, with a
  **Show 25 / 50 / 100 / 200** selector. The range readout (`1–50 of 32,684`)
  tells you where you are.
- **▤ ▥ ▦ row height** — compact (default, most leads on screen), cozy, or
  comfortable (adds source and status chips). Remembered per browser.
- **Light / Dark** — the button at the top right names the mode it will switch
  to. Remembered per browser.
- **Resizable panes** — drag the left edge of the reading pane; double-click to
  reset.

### Working a lead

Click any row to open it on the right.

- **🔍 Google** — searches the company name *plus its location*, which is what
  separates one "ABC Restoration" from the other twelve.
- **in LinkedIn** — on a **person**, searches their name plus their company; on a
  **company or job**, opens LinkedIn's *Companies* tab for the company name alone
  (adding a city there usually loses the page).
- **Click the email address to copy it.** Shift-click opens a new mail instead.
- **Status** dropdown — New → Contacted → Responded → Qualified / Not interested.
- **★ Favorite** — from the row or the reading pane; collects under Favorites.
- **Owner** — type a name or email to claim the lead.
- **Notes** — a timestamped, per-user thread, sitting directly under the lead's
  details. This is the real record of what happened; the `Notes` field on the
  record itself is just a free-text summary.
- **Related leads** — people at that company, its open job postings, and similar
  companies (same category and state, via Segments).

### Browsing a whole segment

Under **Similar companies** the blue tag names the group the company belongs to
— `Restoration · New York`, `Vendor · Texas`. **Click the tag** (or
**See all … →** at the bottom of the list) and the middle pane switches to
*every* company in that group, paged like any other view — 1,432 restoration
companies in New York, for instance, rather than the six shown as a preview.

You can't miss when you're in one: the list header turns into a blue banner with
the segment name large and centred, the count above it, and a **← Back to
Companies** button on the left. Any sidebar view also takes you back out.

Search, state and status filters all still apply inside a segment, so you can
click into `Restoration · New York` and then narrow to uncontacted ones. Sorting is
the one thing that doesn't: segments come back in a fixed order, so the sort
control reads **Segment order** and is greyed out.

### Removing a lead / banning a number

Open a lead → **🚫**. This is not a delete, it's a *do-not-call*:

- the number goes on the **Blocklist**,
- **every lead sharing that number** across Companies, People and Job board is
  removed from all views,
- future imports of that number come in already removed.

The dialog tells you how many leads will go **before** you confirm. Check that
number — some franchise and toll-free lines are shared by several unrelated
businesses. A lead with no usable number removes only itself.

To undo: open it in the **Removed** view → **↩**. The lead comes back and the
number leaves the blocklist.

### Bulk do-not-call lists

When you have a DNC export from the CRM, drop the CSV in the repo's `dnc/`
folder and run:

```
python dashboard/import_dnc.py --dry-run     # preview: shows exactly what would go
python dashboard/import_dnc.py               # apply it
```

Every number in the file joins the Blocklist and every lead sharing it moves to
**Removed** — the same thing the 🚫 button does, for the whole file at once.
Nothing else is touched: statuses, notes, owners and favourites all survive.

Run it again next month with a fresh export and it only applies the difference,
so there's no harm in re-running. Always do the `--dry-run` first — it prints
how many leads each table would lose before anything is written.

> Applied so far: **531 numbers** from `DNC(Sheet1).csv`, which removed 229
> companies and 22 people.

---

## Adding leads: drop a spreadsheet on it

Two ways to add leads: this one, and [**🔎 Find jobs**](#pulling-fresh-job-leads-from-linkedin)
for live LinkedIn postings.

Click **⬆ Import leads**, or just drag a file anywhere onto the window, and drop an
`.xlsx`, `.xls` or `.csv`. There's no manual add-a-lead form — leads arrive either
from a file or from a job search.

It works out the rest for you:

- **Columns are matched by name**, so the Apollo, Bitrix, vendor, master-DB and
  LinkedIn job exports all import as-is. `Company Name` / `Organization` / `name`
  all mean company; `First Name` + `Last Name` make a person; the six Apollo phone
  columns are tried in Apollo's own order of preference. Columns it doesn't
  recognise are listed in the result panel and skipped.
- **Rows are routed** to the right table: a job export goes to Job board, a row
  whose person name differs from its company goes to People, everything else goes
  to Companies.
- **Duplicates are skipped** — a row is dropped if its email or phone already
  exists anywhere in the base.
- **Blocked numbers stay blocked**, and Bitrix-style placeholder numbers
  (`+119000000000`) are never treated as a real number.
- Imported leads get today's date, status **New**, source **Excel import**, the
  filename in Source File, and the category you pick in the dialog.

The result panel reports what landed where, what was skipped as a duplicate, and
what was blocked. A few thousand rows takes a few seconds — don't close the window
while it's running.

---

## Pulling fresh job leads from LinkedIn

**🔎 Find jobs** in the bottom-left searches live LinkedIn postings and drops the
results straight into the Job board. **⚙** beside it opens the settings.

It comes pre-loaded with our standard prospecting search, so most of the time you
just click the button and confirm:

> Back-office roles — office admin, estimator, bookkeeper, marketing coordinator,
> sales rep, billing specialist and a dozen more — at restoration companies with
> **200 employees or fewer**, anywhere in the US, posted in the **last 7 days**.
> Full-time only, staffing agencies hidden.

The reasoning: a small restoration firm hiring an office administrator is a firm
with money to spend and no back office to spend it on. That's our pitch.

### What you can change (⚙)

- **Job titles** and **description keywords** — comma-separated. Titles match the
  posting's title; keywords match the body, which is what keeps results inside
  the restoration trade.
- **Locations** — one per line, written as `City, State, Country`
  (`Miami, Florida, United States`). A bare `United States` works too.
- **Posted within** — last hour / 24 hours / 7 days / all active postings.
- **Max results** — 10 to 500. This is the cost dial; see below.
- **Advanced** — work arrangement, employment type, seniority, salary-data-only,
  hide staffing agencies, max company size, and recruiter contacts.

Settings are saved in your own browser. **Reset** puts the standard search back.
Clearing a field and saving means "any" — it won't silently refill.

### What it costs

The search is billed per job returned: **$5.00 per 1,000**, so 50 jobs is about
25¢. Two guards:

- The settings panel shows a running **maximum cost** as you type, and the
  confirm screen repeats it alongside your remaining credits. Nothing is spent
  until you press the button.
- The settings panel also charts your **Apify credit usage** — spent against your
  monthly cap, the daily spend for this billing cycle, and the reset date. The
  remaining figure also sits under the Find jobs button.

You only pay for jobs actually returned, so a search that matches nothing costs
nothing. Turning on **recruiter contacts** triples the rate to $15 per 1,000 — in
return, each job carries the recruiter's name, title and LinkedIn profile, which
is a real person to contact instead of a company. It's off by default and labelled
where you switch it on.

When the run finishes you get a summary: how many jobs matched, how many were new,
how many were already in the base, and **the exact amount charged**.

### What lands in the base

New rows go to **Job board** with the job title, company, city/state, industry,
company headcount, posting URL and posted date — plus the recruiter as the contact
if you enabled that. Jobs already in the base are skipped, matched on posting URL
and on title + company + city, since LinkedIn re-posts the same opening under
several IDs.

> **Not finding anything?** The most common cause is over-narrow settings — a
> one-hour window, or a city-level location on a trade that posts nationally.
> Widen the time range first.

---

## Inviting team members

1. Sign in as `pema@karmastaff.com` → click the base name **Karma Leads** →
   **Members**.
2. Invite by email with the role **Editor** — they can change statuses, notes and
   owners, but not the table structure. Copy the invite link and send it to them.
3. They open http://localhost:8080/app on **this** computer, or over the network at
   `http://<this-PC's-IP>:8080` (allow port 8080 through Windows Firewall first).

An account that can sign in but hasn't been invited to the base will be told so on
the login screen rather than being dropped into an empty app.

> ⚠️ **Rebuilding the base wipes member access.** After running `setup_v2.py`
> everyone has to be re-invited. See below.

---

## Rebuilding from the source files

```
python dashboard/setup_v2.py
```

**This is destructive.** It deletes the base and rebuilds it from the files in
`old leads/`, `master_leads/` and `New_job_search/`. Statuses, owners, notes,
comments, favourites and member invitations are all lost.

The **blocklist survives**: existing entries are read out of the live table first
and restored afterwards, and any lead matching a banned number comes back already
removed. You can also pre-seed numbers in `dashboard/blocklist.json`:

```json
[{ "Phone": "+1 555…", "Phone Key": "5551234567", "Reason": "asked not to be contacted" }]
```

**For routine additions, use the ⬆ Import leads drop zone instead** — it adds to
the base without touching anyone's work.

(`setup_and_import.py` is the older single-table importer. It is *not* dead code:
`setup_v2.py` imports its file parsers.)

---

## What the data looks like

**How we can reach them** — the two numbers on the top strip:

```
Phone   ████████████████████████████████████░░░░   32,039   91%
Email   █████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░   11,551   33%
```

Nearly everyone has a phone number; only a third have an email. This is a calling
list first and a mailing list second — worth knowing before anyone plans an email
campaign off it.

Firmographic coverage is uneven by source, and that's the data rather than a bug:

| | Employees | Revenue | Industry/trade | Location |
|---|---:|---:|---:|---:|
| People (Apollo) | 2,087 / 2,328 | 690 | 396 | 2,060 |
| Companies | 610 | 160 | 6,757 | 25,983 city / 10,394 state |
| Job Board | 85 / 85 | — | 84 | 83 |

Master-DB companies carry **Certs** (a count of IICRC/RIA certifications on file,
~2,900 records) instead of a headcount. Bare licence codes like `HIC`, `CGC` and
`B` are filtered out of Industry — only readable trades are kept. LinkedIn job
leads are the best-covered rows in the base: the source supplies headcount and
industry for essentially every posting.

Known quirks:

- The same business can appear twice from two different sources when the phone
  numbers differ. It shows up as a company listed under its own "Similar
  companies".
- Bitrix exports carry numeric ID codes in City/State/Industry; those are dropped.
- "Date Added" for the older files comes from the `MMDD` in the filename, because
  OneDrive resets file timestamps. Files without one have a blank date, so those
  leads never count towards "New this week" and never sort to the top under
  "Newest first". (The Recent tab is unaffected — it follows what you clicked,
  not when a lead was imported.)

---

## Server and files

| | |
|---|---|
| App folder | `C:\Users\David\karma-leads-nocodb` (deliberately outside OneDrive — a live SQLite file shouldn't be cloud-synced) |
| Database | `noco.db` in that folder — about 11 MB. **Back up by copying that one file** while the server is stopped; `node_modules` is 1.1 GB and just reinstalls with `npm install`. |
| Front end | `public\` in that folder — plain HTML/CSS/JS, no build step. Edit and refresh. |
| Import engine | `import-leads.js` in that folder |
| LinkedIn job search | `job-search.js` in that folder |
| Apify key | `apify_token.json` in that folder. Never leaves the server — the browser only ever talks to our own `/app-api` routes, so nobody can spend credits from the page. |
| Recent-tab trails | `recents.js` + `recents.json` in that folder — each person's last 25 leads, keyed by their email. Safe to delete: every trail just starts empty again. |
| API token for scripts | `api_token.json` in that folder |
| Table/column IDs | `dashboard/nocodb_ids.json` |
| Source spreadsheets | `old leads/`, `master_leads/`, `New_job_search/` |

### If something goes wrong

| Symptom | Fix |
|---|---|
| Page is blank or half-broken | Hard-refresh: **Ctrl+Shift+R** |
| "This site can't be reached" | The server isn't running — start `start-dashboard.bat` |
| Signed in but no leads, with a message about access | That account was never invited to the base (or a rebuild dropped it). Re-invite it as an Editor. |
| Import says "no recognisable columns" | The sheet's header row isn't where it should be, or the columns have unusual names — check the first row is the headings |
| Counts look wrong after removing leads | Refresh the page; counts recalculate on load |
| Job search returns 0 jobs | Settings are too narrow. Widen **Posted within** first, then drop a location or a title. Nothing is charged for a search that matches nothing. |
| Job search fails, or credits show "—" | Apify is unreachable or the monthly cap is spent. Check the credit bar in **⚙**; the cap resets on the date shown there. |
| Cost shown as "unavailable" after a run | The jobs still imported — only Apify's billing figure was slow to report. The credits line catches up within a minute. |
