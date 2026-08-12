/* Karma Leads — email-style client over the domain API */
"use strict";

const $ = (id) => document.getElementById(id);
const S = {
  me: null,            // {id, email, display_name, role} from /api/me
  tab: "companies",
  q: "",
  status: "",
  state: "",           // two-letter code, "" = everywhere
  focus: "",           // armed KPI tile: ready | enrich | unassigned | week
  sort: "recent",
  list: [],
  page: 1,             // 1-based
  pageSize: 50,
  total: 0,
  cursors: [null],     // cursors[n] reaches page n+1 — keyset paging, not offset
  sel: null,           // {row, tkey}
  // Select is a mode an admin turns on in the filter row; the selection it
  // gathers is lead id -> {name, kind}, kept across paging (that's the point
  // of it) and dropped whenever the list itself changes.
  selectMode: false,
  picked: new Map(),
  recents: [],         // rows already joined with their leads — see loadRecents()
  segment: null,       // {category, state, label} while browsing one segment
};
const PAGE_SIZES = [25, 50, 100, 200];

/* Every tab is the same /api/leads query with different parameters — the old
   three-tables-merged-in-the-browser union (and its 1,000-row correctness cap)
   is gone; Favorites and DNC are just filters now. */
const TABS = {
  companies: { title: "Companies", kind: "company", pv: "Company", dateField: "Date Added" },
  people:    { title: "People",    kind: "person",  pv: "Name",    dateField: "Date Added" },
  jobs:      { title: "Job board", kind: "job",     pv: "Job Title", dateField: "Posted" },
  // "Recent" is an activity trail, not a date filter: the last 50 leads this
  // account actually touched, newest first. Starts empty for a new account.
  recent:    { title: "Recent activity", activity: true },
  favorites: { title: "Favorites", favorite: true },
  // admin-only under Manage: members remove with a 5s undo instead of a tab
  removed:   { title: "DNC — do not call", removedTab: true, admin: true },
  // admin-only, and not a list of leads at all: the team's action log
  stats:     { title: "Team activity", stats: true, admin: true },
  // not in the sidebar: entered by clicking a segment tag in the reading pane
  segment:   { title: "Segment", kind: "company", pv: "Company",
               dateField: "Date Added", segment: true },
};
const UNION_KEYS = ["companies", "people", "jobs"];
const KIND_TAB = { company: "companies", person: "people", job: "jobs" };

/* The API speaks snake_case; the render layer below still reads the NocoDB-era
   title-case keys. This adapter is the whole translation, in one place, so the
   ~100 render call sites didn't have to change in the cutover. */
function fromApi(r) {
  const _t = KIND_TAB[r.kind] || "companies";
  return {
    _t, Id: r.id, "Lead Code": r.lead_code,
    Company: r.company, Name: r.kind === "person" ? r.name : r.company,
    "Job Title": r.kind === "job" ? r.name : null,
    Title: r.title, Contact: r.contact, "Contact Title": r.contact_title,
    Email: r.email, Phone: r.phone, "Phone Key": r.phone_key,
    Website: r.website, "Job URL": r.job_url, Logo: r.logo_url,
    Category: r.category, Industry: r.industry,
    Employees: r.employees, Revenue: r.revenue, Certs: r.certs,
    City: r.city, State: r.state,
    Status: r.status, Owner: r.owner,
    Favorite: r.favorite, Removed: r.removed,
    Source: r.source, "Source File": r.source_file,
    "Date Added": r.date_added, Posted: r.date_added,
    _related: r.related || null,
    ...(r.touched_at ? { _touchedAt: r.touched_at } : {}),
  };
}

const SRC_CHIP = {
  "Job board": "job", "Excel import": "excel", "Apollo export": "apollo",
  "Bitrix CRM": "bitrix", "Master DB": "master",
};
const STATUSES = ["New", "Contacted", "Responded", "Qualified", "Not interested"];

/* Sort options — the keys go straight to /api/leads?sort=. An option is only
   offered where the underlying data exists: certifications only ever came in
   on companies, and job rows carry no revenue. */
const SORTS = [
  { key: "recent", label: "Newest first" },
  { key: "oldest", label: "Oldest first" },
  { key: "name", label: "Name A–Z" },
  { key: "name_z", label: "Name Z–A" },
  { key: "size", label: "Biggest company" },
  { key: "size_asc", label: "Smallest company" },
  { key: "certs", label: "Most certifications" },
  { key: "revenue", label: "Highest revenue" },
  { key: "state", label: "State A–Z" },
  { key: "city", label: "City A–Z" },
  { key: "status", label: "Status" },
];
const SORTLESS = { people: ["certs"], jobs: ["certs", "revenue"] };
const sortUsable = (key, tkey) => !(SORTLESS[tkey] || []).includes(key);

/* ---------------- api ---------------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    // during boot a 401 just means "show the login screen" — only a session
    // dying mid-use triggers the full sign-out (else a cookie-less first
    // visit would reload forever)
    if (S.booted) logout();
    throw new Error("Not signed in");
  }
  if (!res.ok) {
    const text = await res.text();
    let msg;                          // the API sends {error: "readable message"}
    try { msg = JSON.parse(text).error; } catch { /* not JSON */ }
    throw new Error(msg || `${path} -> ${res.status}: ${text}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/* ---------------- helpers ---------------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function initials(name) {
  if (!name) return "?";
  const w = String(name).trim().split(/\s+/);
  return ((w[0]?.[0] || "") + (w[1]?.[0] || "")).toUpperCase() || "?";
}
const AV_COLORS = ["#5470b8", "#8a5cb8", "#3f8f6b", "#b8745c", "#5c93b8", "#b85c85"];
function avColor(name) {
  let h = 0;
  for (const c of String(name || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AV_COLORS[h % AV_COLORS.length];
}
function relTime(d) {
  if (!d) return "";
  const t = new Date(d).getTime();
  if (Number.isNaN(t)) return "";
  const s = (Date.now() - t) / 1000;
  if (s < 3600) return "just now";
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
/* absolute date for the detail grid — "Aug 12, 2026", never a raw ISO string.
   A leading YYYY-MM-DD is taken as a plain local date so it doesn't shift a
   day in negative-UTC timezones. */
function fmtDate(d) {
  if (!d) return "";
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
  const t = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(d);
  return Number.isNaN(t.getTime())
    ? String(d)
    : t.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function displayName(row, tkey) {
  return row[TABS[tkey].pv] || row.Company || "(no name)";
}
function chip(cls, label) {
  return label ? `<span class="chip ${cls}">${esc(label)}</span>` : "";
}
function statusChip(st) {
  const cls = "chip-st-" + (st || "New").toLowerCase().replace(/\s+/g, "");
  return chip(cls, st || "New");
}
function sourceChip(src) {
  return chip("chip-src-" + (SRC_CHIP[src] || "other"), src);
}

/* ---------------- auth ---------------- */
function logout() {
  // clear the sealed session server-side and end it at WorkOS too
  fetch("/api/auth/logout", { method: "POST" })
    .then((r) => r.json())
    .then((o) => { location.href = o.url || "/"; })
    .catch(() => location.reload());
}

/* ---------------- meta discovery ---------------- */
async function discover() {
  // one call answers both "who am I" and "am I invited" — the API's 403 body
  // ("x is not invited...") surfaces on the login screen via api()'s message
  S.me = await api("/api/me");
}

/* 35,271 -> "35.3k"; small numbers stay exact. The tile carries the precise
   figure in its title attribute. */
function compact(n) {
  if (n < 10000) return n.toLocaleString();
  if (n < 1e6) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
}
const pct = (n, total) => total > 0 ? (n / total) * 100 : 0;

/* ---------------- the KPI tiles ----------------
   Four work queues, each one clickable. The tile's number and the list you get
   by clicking it are the same predicate (FOCUS in server/leads.js), so a tile
   is a to-do count you can act on rather than a statistic you read past. */
const FOCUS_LABEL = {
  ready: "Ready to work",
  enrich: "Needs enrichment",
  unassigned: "Unassigned",
  week: "New this week",
};

function setTile(id, value, sideHtml, vizHtml) {
  const v = $("stat-" + id);
  if (v) {
    v.textContent = compact(value);
    v.title = value.toLocaleString() + " leads";
  }
  const s = $("side-" + id);
  if (s) s.innerHTML = sideHtml || "";
  const z = $("viz-" + id);
  if (z) z.innerHTML = vizHtml || "";
}

/* a queue as a share of the live base: the meter plus the percentage written
   out, so the ratio is never carried by bar length alone */
function queueTile(id, value, total) {
  const p = pct(value, total);
  setTile(id, value,
    `${p > 0 && p < 1 ? "<1" : Math.round(p)}% of base`,
    `<div class="meter${value ? "" : " is-empty"}"><span style="width:${p.toFixed(1)}%"></span></div>`);
}

/* S.focus is an overlay filter like S.status/S.state: it rides along with
   whichever tab you are on, so arming "Unassigned" inside Companies means
   unassigned companies. The armed tile is the filter's only control — click it
   again to clear. */
function paintTiles() {
  document.querySelectorAll(".stat[data-focus]").forEach((b) => {
    const on = b.dataset.focus === S.focus;
    b.classList.toggle("armed", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function toggleFocus(key) {
  if (!FOCUS_LABEL[key]) return;
  S.focus = S.focus === key ? "" : key;
  paintTiles();
  // Team activity reads the log, not the leads table — there is no list there
  // to filter, so arming a queue from it means "show me those leads"
  if (S.focus && TABS[S.tab].stats) return setTab("companies");
  const list = $("lead-list");
  if (list) list.scrollTop = 0;
  loadList(true);
}

let countsPending = false;
async function refreshCounts() {
  if (countsPending) return;            // coalesce the burst after a bulk import
  countsPending = true;
  try { await runCounts(); }
  catch (e) { console.warn("[karma] counts failed", e); }
  finally { countsPending = false; }
}

async function runCounts() {
  // one aggregate endpoint, one SQL pass, cached 30s server-side — this used
  // to be ~26 separate count queries per refresh
  const c = await api("/api/counts");
  const total = c.total;
  $("count-companies").textContent = c.companies.toLocaleString();
  $("count-people").textContent = c.people.toLocaleString();
  $("count-jobs").textContent = c.jobs.toLocaleString();
  $("count-favorites").textContent = c.favorites.toLocaleString();
  $("count-removed").textContent = c.removed.toLocaleString();
  // ("Recent" is the activity trail — its badge comes from S.recents)

  // the three work queues, each as a count + its share of the live base
  queueTile("ready", c.ready, total);
  queueTile("enrich", c.needs_enrichment, total);
  queueTile("unassigned", c.unassigned, total);

  // new-this-week gets a two-bar comparison, not a share meter: a week's
  // intake against 35k would be a permanently empty bar, while against the
  // previous 7 days it is the comparison the delta is actually claiming.
  // A percentage off a near-zero baseline is noise ("↑8000%" for 1 -> 81), so
  // the delta only appears when the prior week is big enough to mean anything.
  const wk = c.week, prev = c.prev_week, top = Math.max(wk, prev, 1);
  const change = prev >= 10 ? Math.round(((wk - prev) / prev) * 100) : null;
  const arrow = change > 0 ? "↑" : change < 0 ? "↓" : "→";
  const dir = change > 0 ? " up" : change < 0 ? " down" : "";
  setTile("week", wk,
    change !== null
      ? `<span class="delta${dir}">${arrow} ${Math.abs(change)}%</span>` : "",
    `<div class="spark">
       <span style="height:${((prev / top) * 100).toFixed(1)}%"
             title="previous 7 days: ${prev.toLocaleString()}"></span>
       <span class="now" style="height:${((wk / top) * 100).toFixed(1)}%"
             title="this week: ${wk.toLocaleString()}"></span>
     </div>`);
  const sub = $("sub-week");
  if (sub) sub.innerHTML = change !== null
    ? `vs <b>${prev.toLocaleString()}</b> the previous 7 days`
    : wk ? `previous 7 days: <b>${prev.toLocaleString()}</b>`
         : "nothing added in 7 days";

  paintTiles();
}

/* ---------------- recents (the leads this account touched) ----------------
   The trail is kept per account by the server so it follows the person between
   browsers. Mutations (status, owner, favorite, remove, notes) land on it
   server-side inside their own endpoints now; the one event the client still
   reports is "open", because opening a lead is a read the server can't see.
   The GET returns full rows already joined with their leads, removed ones
   filtered out — no second lookup. */
const RECENT_MAX = 50;                   // keep in step with MAX in server/recents.js

function recentsBadge() {
  const el = $("count-recent");
  if (el) el.textContent = S.recents.length.toLocaleString();
}

async function loadRecents() {
  try {
    S.recents = ((await api("/api/recents")).list || []).map(fromApi);
    recentsBadge();
  } catch (e) {
    console.warn("[karma] recents unavailable", e);
  }
}

/* Record an open. Fire-and-forget on purpose — nothing the user does should
   ever wait on the trail being written. */
function touchLead(item) {
  if (!item || !UNION_KEYS.includes(item._t) || !item.Id) return;
  S.recents = [
    { ...item, _touchedAt: new Date().toISOString() },
    ...S.recents.filter((x) => x.Id !== item.Id),
  ].slice(0, RECENT_MAX);
  recentsBadge();
  // the list is deliberately not re-rendered on the response: reshuffling rows
  // under the pointer while someone is reading a lead is worse than being stale
  api("/api/recents", {
    method: "POST",
    body: JSON.stringify({ lead_id: item.Id }),
  }).catch((e) => console.warn("[karma] could not save recent", e));
}

/* The trail is 50 rows and already in the right order, so its search, status
   and state filters run here instead of as a where clause. */
/* The Recent tab pages its ≤50-row trail locally, so the armed tile has to be
   re-implemented client-side. Keep these in step with FOCUS in server/leads.js
   — same rule, two runtimes, exactly like the dedupe guards. */
const filled = (v) => !!String(v ?? "").trim();
const daysAgo = (n) => {                    // local YYYY-MM-DD, matching date_added
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const FOCUS_TEST = {
  ready:      (r) => filled(r.Phone) && (r.Status || "New") === "New",
  enrich:     (r) => !filled(r.Phone) && !filled(r.Email),
  unassigned: (r) => !filled(r.Owner),
  week:       (r) => !!r["Date Added"] && r["Date Added"] >= daysAgo(6),
};

function matchesFilters(r) {
  if (S.focus && !FOCUS_TEST[S.focus](r)) return false;
  if (S.status && (r.Status || "New") !== S.status) return false;
  if (S.state) {
    const st = String(r.State || "").trim().toLowerCase();
    const full = (STATE_NAME[S.state] || "").toLowerCase();
    if (st !== S.state.toLowerCase() && (!full || st !== full)) return false;
  }
  if (S.q) {
    const hay = [displayName(r, r._t), r.Company, r.Email, r.City, r.Contact]
      .filter(Boolean).join(" ").toLowerCase();
    if (!hay.includes(S.q.toLowerCase())) return false;
  }
  return true;
}

/* ---------------- list ----------------
   One endpoint serves every tab: /api/leads with different parameters. The
   sidebar tabs are kind filters, Favorites/DNC are boolean filters (no
   more browser-side union or its 1,000-row cap), and a segment is just
   category + state. Paging is keyset: cursors[n] reaches page n+1, so page
   400 costs what page 1 costs and rows can't shift underneath the pager. */
function listParams() {
  const cfg = TABS[S.tab];
  const p = new URLSearchParams();
  if (cfg.segment && S.segment) {
    p.set("kind", "company");
    p.set("category", S.segment.category);
    p.set("state", S.segment.state);
  } else {
    if (cfg.kind) p.set("kind", cfg.kind);
    if (cfg.favorite) p.set("favorite", "true");
    if (cfg.removedTab) p.set("removed", "true");
    if (S.state) p.set("state", S.state);
  }
  if (S.q) p.set("q", S.q);
  if (S.status) p.set("status", S.status);
  if (S.focus) p.set("focus", S.focus);          // an armed KPI tile
  p.set("sort", sortUsable(S.sort, S.tab) ? S.sort : "recent");
  p.set("limit", S.pageSize);
  const cur = S.cursors[S.page - 1];
  if (cur) p.set("cursor", cur);
  return p;
}

function openSegment(category, state, label) {
  S.segment = { category, state, label };
  S.tab = "segment";
  S.page = 1;
  S.cursors = [null];
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
  $("segment-back")?.classList.remove("hidden");
  $("seg-eyebrow")?.classList.remove("hidden");
  $("list-head")?.classList.add("in-segment");
  $("clear-recents")?.classList.add("hidden");
  renderSortOptions();
  $("lead-list").scrollTop = 0;
  loadList(true);
}

function exitSegment() {
  S.segment = null;
  setTab("companies");
}

async function loadList(resetPage = false) {
  // a new list is a new selection: paging keeps the ticks, changing tab,
  // search, filter or sort drops them rather than acting on rows nobody can
  // still see
  if (resetPage) { S.page = 1; S.cursors = [null]; S.picked.clear(); }
  const cfg = TABS[S.tab];
  // Team activity reads the log, not the leads table — no list, no pager
  if (cfg.stats) return loadStats();
  // the armed tile is named in the header too: a list that is short because a
  // KPI tile is filtering it should never look like a list that is just short
  $("list-title").textContent =
    (cfg.segment ? (S.segment?.label || "Segment") : cfg.title)
    + (S.focus ? ` · ${FOCUS_LABEL[S.focus]}` : "");

  if (cfg.activity) {
    // 50 rows at most: refetch the trail, filter and page locally
    await loadRecents();
    const rows = S.recents.filter(matchesFilters);
    S.total = rows.length;
    const start = (S.page - 1) * S.pageSize;
    S.list = rows.slice(start, start + S.pageSize);
  } else {
    if (cfg.segment && !S.segment) return exitSegment();
    const r = await api(`/api/leads?${listParams()}`);
    S.list = (r.list || []).map(fromApi);
    if (r.total != null) S.total = r.total;      // only sent on the first page
    S.cursors[S.page] = r.nextCursor;
    if (cfg.segment) {
      const eb = $("seg-eyebrow");
      if (eb) eb.textContent =
        `Segment · ${S.total.toLocaleString()} compan${S.total === 1 ? "y" : "ies"}`;
    }
  }
  // the page can fall off the end when rows leave the view (unfavorited, removed)
  if (!S.list.length && S.page > 1) {
    S.page = 1;
    S.cursors = [null];
    return loadList();
  }
  renderList();
  renderPager();
}

function pageCount() {
  return Math.max(1, Math.ceil(S.total / S.pageSize));
}

function goToPage(n) {
  let p = Math.min(Math.max(1, n), pageCount());
  // keyset paging can only reach pages whose cursor it has seen: any earlier
  // page (cursors are kept), or exactly one page forward. The activity tab
  // pages a 50-row local array and can jump anywhere.
  if (!TABS[S.tab].activity && p > S.page) {
    p = S.cursors[S.page] ? S.page + 1 : S.page;
  }
  if (p === S.page) return;
  S.page = p;
  $("lead-list").scrollTop = 0;
  loadList();
}

function renderPager() {
  // highlight the controls that are actually narrowing the list
  $("filter-state")?.closest(".ctl")?.classList.toggle("on", !!S.state);
  $("filter-status")?.closest(".ctl")?.classList.toggle("on", !!S.status);
  $("sort-by")?.closest(".ctl")?.classList.toggle("on",
    S.sort !== "recent" && !TABS[S.tab].activity && !TABS[S.tab].segment);
  const pages = pageCount();
  const from = S.total ? (S.page - 1) * S.pageSize + 1 : 0;
  const to = Math.min(S.page * S.pageSize, S.total);
  $("pager-range").textContent = S.total
    ? `${from.toLocaleString()}–${to.toLocaleString()} of ${S.total.toLocaleString()}`
    : "no leads";
  $("pager-page").textContent = `Page ${S.page} of ${pages.toLocaleString()}`;
  $("pager-first").disabled = $("pager-prev").disabled = S.page <= 1;
  const activity = TABS[S.tab].activity;
  $("pager-next").disabled = activity
    ? S.page >= pages
    : !S.cursors[S.page];               // keyset: next exists only via its cursor
  // "last" needs an arbitrary jump, which keyset paging deliberately gave up
  $("pager-last").disabled = activity ? S.page >= pages : true;
  $("pager-last").title = activity ? "Last page" : "Not available with fast paging";
  $("page-size").value = String(S.pageSize);
}

function rowSubtitle(r) {
  if (r._t === "jobs") return [r.Company, r.Contact].filter(Boolean).join(" · ");
  if (r._t === "people") return r.Title || "";
  return r.Category || "";
}

/* ---- fact formatting: location + size ---- */
const US_STATE_ABBR = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY", "district of columbia": "DC",
};
/* abbreviation -> full name, for the state filter and every label that shows a
   state. "of" stays lowercase so DC doesn't read "District Of Columbia". */
const STATE_NAME = Object.fromEntries(Object.entries(US_STATE_ABBR)
  .map(([full, ab]) => [ab, full.replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\bOf\b/g, "of")]));

/* States are displayed in full, never abbreviated: the sources disagree
   ("FL" in one file, "Florida" in the next) and a mixed column reads as two
   different places. Filtering still keys off the abbreviation — only the
   label changes. */
function fullState(s) {
  if (!s) return "";
  const k = String(s).trim();
  return STATE_NAME[k.toUpperCase()] || titleCase(k);
}
function titleCase(s) {
  return String(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
function locationLabel(r) {
  const city = r.City ? titleCase(r.City) : "";
  const st = fullState(r.State);
  if (city && st) return `${city}, ${st}`;
  return city || st || "";
}
/* Segment titles are stored as "Category · ST" by the rebuild; expand the
   state half for display without touching the stored value. */
function fullSegmentLabel(label) {
  const parts = String(label || "").split("·").map((p) => p.trim());
  if (parts.length < 2) return String(label || "");
  const last = parts[parts.length - 1];
  if (STATE_NAME[last.toUpperCase()]) parts[parts.length - 1] = STATE_NAME[last.toUpperCase()];
  return parts.join(" · ");
}
/* size band from headcount — the "label about size" on each card */
function sizeBand(n) {
  if (!n || n < 1) return null;
  if (n === 1) return { label: "Solo", cls: "size-1" };
  if (n <= 10) return { label: "Micro", cls: "size-2" };
  if (n <= 50) return { label: "Small", cls: "size-3" };
  if (n <= 200) return { label: "Mid", cls: "size-4" };
  return { label: "Large", cls: "size-5" };
}
function fmtMoney(v) {
  if (!v || v <= 0) return "";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${v}`;
}
/* one compact facts line: location · size · revenue · industry */
function factsHtml(r) {
  const out = [];
  const loc = locationLabel(r);
  if (loc) out.push(`<span class="fact"><span class="fact-ic">📍</span>${esc(loc)}</span>`);
  const band = sizeBand(r.Employees);
  if (band) {
    out.push(`<span class="fact"><span class="fact-ic">👥</span>${r.Employees.toLocaleString()}` +
      `<span class="size-tag ${band.cls}">${band.label}</span></span>`);
  }
  const rev = fmtMoney(r.Revenue);
  if (rev) out.push(`<span class="fact"><span class="fact-ic">💵</span>${rev}</span>`);
  if (r.Certs > 0)
    out.push(`<span class="fact" title="certifications on file"><span class="fact-ic">🏅</span>${r.Certs} cert${r.Certs > 1 ? "s" : ""}</span>`);
  if (r.Industry) out.push(`<span class="fact fact-industry">${esc(titleCase(r.Industry))}</span>`);
  return out.length ? `<div class="lead-facts">${out.join("")}</div>` : "";
}

/* the initials circle, overlaid by the real logo when the scrape brought one —
   a stale or blocked logo URL just falls back to the initials */
function avatarHtml(name, logo, cls = "avatar", style = "") {
  return `<span class="${cls}" style="${style}background:${avColor(name)}">${esc(initials(name))}${
    logo ? `<img class="avatar-img" src="${esc(logo)}" alt="" loading="lazy" onerror="this.remove()">` : ""}</span>`;
}

/* bulk imports gave most of the base the same Date Added, so the list column
   shows reachability instead — both slots always render so absence is visible */
function reachHtml(r) {
  return `<span class="lead-reach">` +
    `<span class="reach-ic${r.Email ? "" : " off"}" title="${r.Email ? "has email" : "no email"}">✉</span>` +
    `<span class="reach-ic${r.Phone ? "" : " off"}" title="${r.Phone ? "has phone" : "no phone"}">☎</span>` +
    `</span>`;
}

function renderList() {
  const el = $("lead-list");
  const canPick = isAdmin() && S.selectMode;
  el.innerHTML = S.list.map((r, i) => {
    const name = displayName(r, r._t);
    // jobs carry the company in the subtitle instead, so the title stays readable
    const co = r._t === "people" && r.Company && r.Company !== name
      ? ` <span class="co">· ${esc(r.Company)}</span>` : "";
    // the full name, for the tooltip on rows the ellipsis truncates
    const full = co ? `${name} · ${r.Company}` : name;
    // the activity trail's touched-at and a job's posting date are real
    // information; an import date is one bulk-load day — show reach instead
    const date = r._touchedAt || (r._t === "jobs" ? r[TABS[r._t].dateField] : "");
    const side = date ? `<span class="lead-date">${relTime(date)}</span>` : reachHtml(r);
    const sel = S.sel && S.sel.row.Id === r.Id && S.sel.tkey === r._t ? " selected" : "";
    const picked = S.picked.has(r.Id);
    return `
    <div class="lead-row${sel}${picked ? " picked" : ""}" data-i="${i}">
      ${canPick ? `<input type="checkbox" class="row-pick" data-pick="${i}"
              ${picked ? "checked" : ""} title="Select — shift-click for a range"
              aria-label="Select ${esc(name)}">` : ""}
      ${avatarHtml(name, r.Logo)}
      <div class="lead-row-main">
        <div class="lead-name" title="${esc(full)}"><span class="status-dot ${statusDotCls(r.Status)}" title="${esc(r.Status || "New")}"></span>${esc(name)}${co}</div>
        ${rowSubtitle(r) ? `<div class="lead-sub">${esc(rowSubtitle(r))}</div>` : ""}
        ${factsHtml(r)}
        <div class="lead-meta">${sourceChip(r.Source || (r._t === "jobs" ? "Job board" : ""))}${statusChip(r.Status)}</div>
      </div>
      <div class="lead-side">
        <button class="fav-star${r.Favorite ? " on" : ""}" data-fav="${i}"
                title="${r.Favorite ? "Remove from favorites" : "Add to favorites"}">★</button>
        ${side}
      </div>
    </div>`;
  }).join("") || `<div class="detail-empty" style="height:200px"><p>${
    S.tab === "recent" && !S.recents.length
      ? "Nothing here yet — leads you open or update show up in this list"
      : "No leads match"}</p></div>`;
  el.querySelectorAll(".lead-row").forEach((row) =>
    row.addEventListener("click", () => select(S.list[+row.dataset.i])));
  el.querySelectorAll("[data-fav]").forEach((star) =>
    star.addEventListener("click", (e) => {
      e.stopPropagation();                       // don't open the lead
      toggleFavorite(S.list[+star.dataset.fav]);
    }));
  el.querySelectorAll("[data-pick]").forEach((box) =>
    box.addEventListener("click", (e) => {
      e.stopPropagation();                       // ticking is not opening
      onPick(+box.dataset.pick, box.checked, e.shiftKey);
    }));
  renderBulkTools();
}

/* ---------------- bulk selection (admin) ----------------
   Select is a mode, toggled from the filter row, because a permanent checkbox
   column turns a reading list into a form. With it on, every row grows a box
   and the three things that can happen to a selection — assign an owner, ban
   the numbers, bin the leads — sit beside the toggle. They are the same three
   mutations the reading pane offers on one lead, applied by the server under
   the same rules (server/bulk.js). Members never see any of it, and the routes
   403 them anyway. */
const isAdmin = () => S.me?.role === "admin";
const BULK_MAX = 500;                 // keep in step with MAX_IDS in server/bulk.js
let lastPick = null;                  // row index, for shift-click ranges

function setPick(r, on) {
  if (!r) return;
  if (on) {
    if (!S.picked.has(r.Id) && S.picked.size >= BULK_MAX) return;
    S.picked.set(r.Id, { name: displayName(r, r._t), kind: r._t });
  } else S.picked.delete(r.Id);
}

function onPick(i, on, shift) {
  if (shift && lastPick !== null && lastPick !== i) {
    const [a, b] = lastPick < i ? [lastPick, i] : [i, lastPick];
    for (let k = a; k <= b; k++) setPick(S.list[k], on);
  } else {
    setPick(S.list[i], on);
  }
  lastPick = i;
  if (S.picked.size >= BULK_MAX)
    toast(`${BULK_MAX} leads is the most one action can take`);
  paintPicks();
}

/* Rows are repainted in place, never re-rendered: replacing the list's HTML
   would throw a scrolled list back to the top halfway through a selection. */
function paintPicks() {
  $("lead-list")?.querySelectorAll("[data-pick]").forEach((box) => {
    const r = S.list[+box.dataset.pick];
    const on = !!r && S.picked.has(r.Id);
    box.checked = on;
    box.closest(".lead-row")?.classList.toggle("picked", on);
  });
  renderBulkTools();
}

/* the filter row's bulk half: the toggle is always there for an admin, the
   count and the three actions only while the mode is on */
function renderBulkTools() {
  const tools = $("bulk-tools");
  if (!tools || !isAdmin()) return;
  const on = S.selectMode;
  const n = S.picked.size;
  const onPage = S.list.filter((r) => S.picked.has(r.Id)).length;
  const toggle = $("bulk-toggle");
  toggle.classList.toggle("on", on);
  toggle.setAttribute("aria-pressed", String(on));
  toggle.title = on
    ? "Done selecting — hides the checkboxes and clears the selection"
    : "Select several leads at once";
  $("bulk-pick-all").classList.toggle("hidden", !on);
  ["bulk-assign", "bulk-dnc", "bulk-delete"].forEach((id) =>
    $(id).classList.toggle("hidden", !on));
  if (!on) return;
  $("bulk-count").textContent = n ? `${n.toLocaleString()} selected` : "none selected";
  const all = $("bulk-all");
  all.checked = !!S.list.length && onPage === S.list.length;
  all.indeterminate = onPage > 0 && onPage < S.list.length;
  $("bulk-assign").disabled = !n;
  $("bulk-delete").disabled = !n;
  // the DNC tab lists leads whose numbers are already banned
  $("bulk-dnc").disabled = !n || !!TABS[S.tab].removedTab;
}

/* Turning the mode off drops the selection — leaving ticks alive under a
   list with no checkboxes is how a later click deletes something nobody
   remembers picking. */
function setSelectMode(on) {
  S.selectMode = !!on;
  localStorage.setItem("kl_select_mode", S.selectMode ? "1" : "");
  if (!S.selectMode) {
    S.picked.clear();
    lastPick = null;
  }
  renderList();                        // rows gain or lose their checkbox
}

function clearPicks() {
  S.picked.clear();
  lastPick = null;
  paintPicks();
}

/* every bulk action ends the same way: the selection is spent, the list and
   the tiles are stale, and the reading pane may be showing a lead that just
   left the view */
async function afterBulk(ids, { closeDetail = false } = {}) {
  const openId = S.sel?.row?.Id;
  const hitOpen = openId != null && ids.includes(openId);
  clearPicks();
  closeModal();
  if (hitOpen && closeDetail) {
    S.sel = null;
    $("detail").classList.add("hidden");
    $("detail-empty").classList.remove("hidden");
  }
  await loadList();
  refreshCounts();
  if (hitOpen && !closeDetail) select(S.sel ? S.sel.row : { Id: openId });
}

/* ---------------- detail ---------------- */
async function select(item) {
  S.sel = { row: item, tkey: item._t };
  renderList();
  $("detail-empty").classList.add("hidden");
  const d = $("detail");
  d.classList.remove("hidden");
  d.innerHTML = `<p style="color:var(--ink-3)">Loading…</p>`;
  try {
    // one call returns the lead AND its related rows (company, colleagues,
    // jobs, similar-count) — this used to be four separate link fetches
    const row = fromApi(await api(`/api/leads/${item.Id}`));
    S.sel = { row, tkey: row._t };
    renderDetail(row);
    touchLead(row);             // only once the lead really loaded
    loadComments(row);
    renderRelated(row);
  } catch (e) {
    d.innerHTML = `<p style="color:var(--ink-3)">Could not load lead (${esc(e.message)})</p>`;
  }
}

function dgItem(label, valueHtml) {
  return valueHtml
    ? `<div class="dg-item"><div class="dg-label">${label}</div><div class="dg-value">${valueHtml}</div></div>`
    : "";
}

/* the four-colour Google G, inline so the page stays self-contained */
const GOOGLE_G = `<svg class="brand-ic" viewBox="0 0 48 48" aria-hidden="true">
  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.28-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.55 10.78l7.98-6.19z"/>
  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
</svg>`;
const LINKEDIN_IN = `<svg class="brand-ic" viewBox="0 0 24 24" aria-hidden="true">
  <rect width="24" height="24" rx="3" fill="#fff"/>
  <path fill="#0a66c2" d="M4.98 3.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM3 9.5h4v11H3v-11zm6.5 0h3.8v1.5h.05c.53-.95 1.83-1.95 3.77-1.95 4.03 0 4.78 2.5 4.78 5.76v5.69h-4v-5.05c0-1.2-.02-2.75-1.75-2.75-1.75 0-2.02 1.31-2.02 2.66v5.14h-4v-11z"/>
</svg>`;

/* one-click research.
   Google: company + where it is — location is what disambiguates a generic name.
   LinkedIn: person -> name + company, all-results. Company/job -> the company
   name alone in the companies vertical; a city in the keywords loses the page. */
function lookupHtml(r, fallbackName) {
  const person = r._t === "people";
  const company = r.Company || (r._t === "companies" ? fallbackName : "");
  const gq = [company || fallbackName, locationLabel(r)].filter(Boolean).join(" ");
  const lq = person ? [fallbackName, company].filter(Boolean).join(" ") : company;
  const liUrl = person
    ? "https://www.linkedin.com/search/results/all/?keywords="
    : "https://www.linkedin.com/search/results/companies/?keywords=";

  const btns = [];
  if (gq.trim()) {
    btns.push(`
      <a class="lookup-btn lookup-google" target="_blank" rel="noopener"
         title="Google &quot;${esc(gq)}&quot;"
         href="https://www.google.com/search?q=${encodeURIComponent(gq)}"
         >${GOOGLE_G}Google</a>`);
  }
  if (lq.trim()) {
    btns.push(`
      <a class="lookup-btn lookup-li" target="_blank" rel="noopener"
         title="${person ? "Search LinkedIn for" : "Find the LinkedIn company page for"} &quot;${esc(lq)}&quot;"
         href="${liUrl}${encodeURIComponent(lq)}"
         >${LINKEDIN_IN}LinkedIn</a>`);
  }
  return btns.length ? `<div class="detail-lookup">${btns.join("")}</div>` : "";
}

function renderDetail(r) {
  const tkey = r._t;
  const name = displayName(r, tkey);
  const dateField = TABS[tkey].dateField;
  const sub = tkey === "people"
    ? [r.Title, r.Company].filter(Boolean).join(" · ")
    : tkey === "jobs"
      ? [r.Company, r.Contact ? `contact: ${r.Contact}` : null].filter(Boolean).join(" · ")
      : [r.Category, locationLabel(r)].filter(Boolean).join(" · ");
  const band = sizeBand(r.Employees);

  const opts = STATUSES.map((s) =>
    `<option${(r.Status || "New") === s ? " selected" : ""}>${s}</option>`).join("");

  $("detail").innerHTML = `
    <div class="detail-top">
      ${avatarHtml(name, r.Logo, "avatar", "width:44px;height:44px;font-size:16px;")}
      <div class="detail-headings">
        <div class="detail-name" title="${esc(name)}">${esc(name)}</div>
        <div class="detail-co">${esc(sub)}</div>
        <!-- the status select lives under the title, not beside it — inline it
             steals half the header width and wraps long company names. Own
             class: the density modes hide .lead-meta everywhere -->
        <div class="detail-meta">
          <select class="status-select" id="d-status">${opts}</select>
          ${sourceChip(r.Source || (tkey === "jobs" ? "Job board" : ""))}
        </div>
      </div>
      <div class="detail-actions">
        <button class="fav-btn" id="d-fav" title="Favorite">
          <span class="fav-star${r.Favorite ? " on" : ""}" style="font-size:20px">★</span>
        </button>
      </div>
    </div>

    ${lookupHtml(r, name)}

    <div class="detail-grid">
      ${dgItem("Email", r.Email
        ? `<button class="copyable" data-copy="${esc(r.Email)}"
                   title="Click to copy · shift-click to compose">${esc(r.Email)}</button>`
        : "")}
      ${dgItem("Phone", r.Phone ? `<a href="tel:${esc(r.Phone)}">${esc(r.Phone)}</a>` : "")}
      ${dgItem("Website", r.Website ? `<a href="${esc(/^https?:/.test(r.Website) ? r.Website : "https://" + r.Website)}" target="_blank">${esc(r.Website)}</a>` : "")}
      ${dgItem("Location", esc(locationLabel(r)))}
      ${band ? dgItem("Company size", `${r.Employees.toLocaleString()} employees <span class="size-tag ${band.cls}">${band.label}</span>`) : ""}
      ${fmtMoney(r.Revenue) ? dgItem("Annual revenue", esc(fmtMoney(r.Revenue))) : ""}
      ${r.Industry ? dgItem("Industry / trade", esc(titleCase(r.Industry))) : ""}
      ${r.Certs > 0 ? dgItem("Certifications", `${r.Certs} on file`) : ""}
      ${tkey === "jobs" && r["Job URL"] ? dgItem("Job posting", `<a href="${esc(r["Job URL"])}" target="_blank">Open on LinkedIn ↗</a>`) : ""}
      ${tkey === "jobs" ? dgItem("Contact title", esc(r["Contact Title"])) : ""}
      <div class="dg-item"><div class="dg-label">Owner</div>
        <div class="dg-value"><input id="d-owner" value="${esc(r.Owner || "")}" placeholder="unassigned"></div></div>
      ${dgItem("Added", esc(fmtDate(r[dateField])))}
      ${dgItem("Source file", esc(r["Source File"]))}
    </div>

    <div class="detail-section">
      <h4>Notes</h4>
      <div id="comments"><p style="color:var(--ink-3);font-size:13px">Loading notes…</p></div>
      <div class="note-box">
        <input id="note-input" placeholder="Write a note…">
        <button class="note-send" id="note-send" title="Send">➤</button>
      </div>
    </div>

    <!-- the two destructive actions live below the notes, out of reach of the
         header: DNC bans the phone number and keeps the lead; delete (admins
         only) takes it out of the app into the trash bin. -->
    <div class="detail-danger">
      <button class="remove-btn" id="d-remove"
              title="${r.Removed ? "Restore this lead and un-ban its number" : "DNC — bans the phone number from calling"}">${
                r.Removed ? "↩ Restore" : "🚫 DNC"}</button>
      ${S.me?.role === "admin" ? `<button class="delete-btn" id="d-delete"
              title="Delete — moves this lead to the trash bin">🗑 Delete</button>` : ""}
    </div>

    <div class="detail-section" id="related-section"></div>`;

  $("d-status").addEventListener("change", async (e) => {
    // the server logs the change (with old -> new) and touches the trail
    await patchLead(r.Id, { status: e.target.value });
    r.Status = e.target.value;
    const li = S.list.find((x) => x.Id === r.Id && x._t === tkey);
    if (li) li.Status = r.Status;
    renderList();
    refreshCounts();
  });
  $("detail").querySelectorAll("[data-copy]").forEach((el) =>
    el.addEventListener("click", (e) => {
      const value = el.dataset.copy;
      if (e.shiftKey) { location.href = `mailto:${value}`; return; }
      copyText(value, el);
    }));
  $("d-fav").addEventListener("click", () => toggleFavorite(r));
  $("d-remove").addEventListener("click", () =>
    r.Removed ? doRestore(r) : openRemoveModal(r));
  $("d-delete")?.addEventListener("click", () => openDeleteModal(r));
  $("d-owner").addEventListener("change", async (e) => {
    await patchLead(r.Id, { owner: e.target.value || null });
    r.Owner = e.target.value;
  });
  $("note-send").addEventListener("click", () => sendNote(r));
  $("note-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendNote(r);
  });
}

/* navigator.clipboard needs a secure context — that's fine on localhost but not
   over http://<lan-ip>, so keep the old execCommand path as a fallback */
async function copyText(value, el) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(value);
    ok = true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand("copy");
      ta.remove();
    } catch { ok = false; }
  }
  if (el && ok) {
    el.classList.add("copied");
    setTimeout(() => el.classList.remove("copied"), 1200);
  }
  toast(ok ? `Copied ${value}` : "Could not copy — select it manually");
}

function statusDotCls(st) {
  return "sd-" + (st || "New").toLowerCase().replace(/\s+/g, "");
}

/* toggle favorite from anywhere; keeps list, detail and counts in sync */
async function toggleFavorite(item) {
  const next = !item.Favorite;
  item.Favorite = next;
  const li = S.list.find((x) => x.Id === item.Id && x._t === item._t);
  if (li) li.Favorite = next;
  if (S.sel && S.sel.row.Id === item.Id && S.sel.tkey === item._t)
    S.sel.row.Favorite = next;
  renderList();
  // update the open detail's star in place — a re-render would drop notes/related
  const star = document.querySelector("#d-fav .fav-star");
  if (star && S.sel && S.sel.row.Id === item.Id && S.sel.tkey === item._t)
    star.classList.toggle("on", next);
  try {
    await patchLead(item.Id, { favorite: next });   // server logs + touches trail
    if (S.tab === "favorites") loadList();
    refreshCounts();
  } catch (e) {
    item.Favorite = !next;                       // put it back if the save failed
    renderList();
  }
}

/* ban a number: the server blocklists it and sweeps every lead sharing it,
   in one transaction, and logs who did it and how many leads it took down */
async function removeLead(r, reason) {
  // {affected, ids} — ids are the exact sweep, so an undo can hand them back
  return api(`/api/leads/${r.Id}/remove`, {
    method: "POST", body: JSON.stringify({ reason: reason || "" }),
  });
}

async function restoreLead(r) {
  // un-removes the row and lifts the number's ban, server-side, logged
  await api(`/api/leads/${r.Id}/restore`, { method: "POST" });
}

async function patchLead(id, fields) {
  await api(`/api/leads/${id}`, {
    method: "PATCH", body: JSON.stringify(fields),
  });
}

/* ---------------- related ----------------
   People get an initials avatar — that reads as a person. Companies and job
   postings only get one when a scrape brought the real logo: an initials
   circle beside a company name looks like a logo we don't have, so logo-less
   rows stay plain text. */
function relatedRow(name, sub, onclickIdx, avatar = true, logo = null) {
  return `
  <div class="related-row${avatar || logo ? "" : " no-avatar"}" data-rel="${onclickIdx}">
    ${avatar || logo ? avatarHtml(name, logo, "avatar avatar-sm") : ""}
    <div class="related-main">
      <div class="related-name" title="${esc(name)}">${esc(name)}</div>
      ${sub ? `<div class="related-sub">${esc(sub)}</div>` : ""}
    </div>
  </div>`;
}

/* Related rows arrive embedded on the detail response (r._related): the
   company, colleagues, open jobs, and how many similar companies share this
   one's Category × State. The only extra fetch is the similar-companies
   preview, because six teaser rows aren't worth shipping on every open. */
async function renderRelated(r) {
  const el = $("related-section");
  if (!el) return;
  const rel = r._related || {};
  const actions = [];   // parallel to data-rel indices
  let html = "";
  try {
    if (r._t === "companies") {
      if (rel.people?.length) {
        html += `<h4>People at ${esc(r.Company)}</h4>`;
        for (const p of rel.people) {
          html += relatedRow(p.name || "?", p.title || "", actions.length);
          actions.push(() => select({ Id: p.id, _t: "people" }));
        }
      }
      if (rel.jobs?.length) {
        html += `<h4 style="margin-top:14px">Open jobs</h4>`;
        for (const j of rel.jobs) {
          html += relatedRow(j.name || "?", "", actions.length, false);
          actions.push(() => select({ Id: j.id, _t: "jobs" }));
        }
      }
      if (rel.similar?.count > 0) {
        const { category, state, count } = rel.similar;
        const label = `${category} · ${fullState(state)}`;
        const preview = await api(`/api/leads?kind=company&limit=7&` +
          `category=${encodeURIComponent(category)}&state=${encodeURIComponent(state)}`);
        const others = (preview.list || []).filter((x) => x.id !== r.Id).slice(0, 6);
        if (others.length) {
          // the segment name is the way into the full list — a preview of six
          // out of a few hundred is a teaser, not an answer
          html += `<h4 style="margin-top:14px">Similar companies
            <button class="seg-tag" data-seg-cat="${esc(category)}"
              data-seg-state="${esc(state)}" data-seg-label="${esc(label)}"
              title="Browse all ${count.toLocaleString()} companies in ${esc(label)}"
              >${esc(label)}</button>
            <span class="seg-count">${count.toLocaleString()}</span></h4>`;
          for (const c of others) {
            html += relatedRow(c.name || "?",
              locationLabel({ City: c.city, State: c.state }), actions.length,
              false, c.logo_url);
            actions.push(() => select({ Id: c.id, _t: "companies" }));
          }
          html += `<button class="seg-all" data-seg-cat="${esc(category)}"
            data-seg-state="${esc(state)}" data-seg-label="${esc(label)}"
            >See all ${count.toLocaleString()} in ${esc(label)} →</button>`;
        }
      }
    } else {
      if (rel.company) {
        html += `<h4>Company</h4>`;
        html += relatedRow(rel.company.name || "?", "View company record →",
          actions.length, false, rel.company.logo_url);
        actions.push(() => select({ Id: rel.company.id, _t: "companies" }));
      }
      if (r._t === "people" && rel.people?.length) {
        html += `<h4 style="margin-top:14px">Also at ${esc(rel.company?.name || r.Company)}</h4>`;
        for (const p of rel.people) {
          html += relatedRow(p.name || "?", p.title || "", actions.length);
          actions.push(() => select({ Id: p.id, _t: "people" }));
        }
      }
    }
  } catch (e) { /* related info is best-effort */ }
  el.innerHTML = html;
  el.querySelectorAll(".related-row").forEach((row) =>
    row.addEventListener("click", () => actions[+row.dataset.rel]()));
  el.querySelectorAll("[data-seg-cat]").forEach((b) =>
    b.addEventListener("click", () =>
      openSegment(b.dataset.segCat, b.dataset.segState, b.dataset.segLabel)));
}

/* ---------------- notes (first-class now, with edit and delete) ---------- */
async function loadComments(r) {
  const el = $("comments");
  if (!el) return;
  try {
    const list = (await api(`/api/leads/${r.Id}/comments`)).list || [];
    if (!list.length) {
      el.innerHTML = `<p style="color:var(--ink-3);font-size:13px">No notes yet — be the first.</p>`;
      return;
    }
    el.innerHTML = list.map((c) => {
      const who = c.author_email || "someone";
      const mine = c.author_user_id === S.me?.id || S.me?.role === "admin";
      return `
      <div class="comment" data-cid="${c.id}">
        <span class="avatar avatar-sm" style="background:${avColor(who)}">${esc(initials(who))}</span>
        <div class="comment-body">
          <div class="comment-head"><b>${esc(who)}</b> · ${esc(relTime(c.created_at))}${
            c.updated_at ? " · edited" : ""}${
            mine ? ` <button class="note-act" data-edit="${c.id}" title="Edit note">✎</button>
                    <button class="note-act" data-del="${c.id}" title="Delete note">🗑</button>` : ""}</div>
          <div class="comment-text">${esc(c.body)}</div>
        </div>
      </div>`;
    }).join("");
    el.querySelectorAll("[data-edit]").forEach((b) =>
      b.addEventListener("click", () => {
        // swap the text for an input in place — Enter saves, Escape cancels
        const row = el.querySelector(`[data-cid="${b.dataset.edit}"] .comment-text`);
        if (!row || row.querySelector("input")) return;
        const old = row.textContent;
        row.innerHTML = "";
        const input = document.createElement("input");
        input.value = old;
        input.className = "note-edit";
        row.appendChild(input);
        input.focus();
        input.addEventListener("keydown", async (e) => {
          if (e.key === "Escape") { row.textContent = old; return; }
          if (e.key !== "Enter") return;
          const next = input.value.trim();
          if (!next || next === old) { row.textContent = old; return; }
          await api(`/api/comments/${b.dataset.edit}`, {
            method: "PATCH", body: JSON.stringify({ body: next }),
          });
          loadComments(r);
        });
      }));
    el.querySelectorAll("[data-del]").forEach((b) =>
      b.addEventListener("click", async () => {
        await api(`/api/comments/${b.dataset.del}`, { method: "DELETE" });
        loadComments(r);
      }));
  } catch (e) {
    el.innerHTML = `<p style="color:var(--ink-3);font-size:13px">Notes unavailable</p>`;
  }
}

async function sendNote(r) {
  const input = $("note-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  // the server records the note action in the team log and the trail
  await api(`/api/leads/${r.Id}/comments`, {
    method: "POST", body: JSON.stringify({ body: text }),
  });
  loadComments(r);
}

/* ---------------- import leads from a spreadsheet ---------------- */
const IMPORT_CATEGORIES = ["Restoration", "Vendor", "Independent Adjuster",
  "Public Adjuster", "Insurance", "Other"];

function openImportModal() {
  $("modal-title").textContent = "Import leads";
  $("modal-body").innerHTML = `
    <p class="modal-sub">Drop an Excel or CSV export here — columns are matched
      automatically and each row lands in Companies, People or Job board.</p>
    <div class="dropzone" id="dropzone">
      <div class="dz-art">📄</div>
      <div class="dz-main">Drag a file here</div>
      <div class="dz-sub">.xlsx · .xls · .csv &nbsp;·&nbsp; or <button type="button" class="linkish" id="dz-browse">browse</button></div>
      <input type="file" id="dz-file" accept=".xlsx,.xls,.csv" hidden>
    </div>
    <label class="modal-field">Category for these leads
      <select id="import-category">
        ${IMPORT_CATEGORIES.map((c) =>
          `<option${c === "Other" ? " selected" : ""}>${c}</option>`).join("")}
      </select>
    </label>
    <div class="modal-actions">
      <button type="button" class="btn-secondary" id="modal-cancel">Close</button>
    </div>`;
  $("modal-backdrop").classList.remove("hidden");
  $("modal-cancel").addEventListener("click", closeModal);
  $("dz-browse").addEventListener("click", () => $("dz-file").click());
  $("dz-file").addEventListener("change", (e) => {
    if (e.target.files[0]) runImport(e.target.files[0]);
  });
  const dz = $("dropzone");
  dz.addEventListener("click", () => $("dz-file").click());
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.add("over");
  }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.remove("over");
  }));
  dz.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0];
    if (f) runImport(f);
  });
}

async function runImport(file) {
  const category = $("import-category")?.value || "Other";
  $("modal-body").innerHTML = `
    <div class="import-busy">
      <div class="spinner"></div>
      <div><strong>${esc(file.name)}</strong></div>
      <div class="dz-sub">Parsing and matching against existing leads…<br>
        large files can take a minute — don't close this window.</div>
    </div>`;
  try {
    // one import job: the server parses off-thread, stages, dedupes with the
    // franchise guards, commits, and logs the whole thing under this account
    const res = await fetch("/api/import-jobs", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-filename": encodeURIComponent(file.name),
        "x-category": category,
      },
      body: file,
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || `upload failed (${res.status})`);
    renderImportResult(out);
    refreshCounts();
    loadList(true);
  } catch (e) {
    $("modal-body").innerHTML = `
      <div class="import-error">
        <div class="dz-art">⚠️</div>
        <p><strong>Import failed</strong></p>
        <p class="dz-sub">${esc(e.message)}</p>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="modal-cancel">Close</button>
        <button type="button" class="btn-primary" id="import-again">Try another file</button>
      </div>`;
    $("modal-cancel").addEventListener("click", closeModal);
    $("import-again").addEventListener("click", openImportModal);
  }
}

function renderImportResult(o) {
  const c = o.counts || {};
  const ins = c.inserted || {};
  const total = (ins.company || 0) + (ins.person || 0) + (ins.job || 0);
  const line = (label, n) => n
    ? `<div class="ir-row"><span>${label}</span><strong>${n.toLocaleString()}</strong></div>` : "";
  $("modal-body").innerHTML = `
    <div class="import-done">
      <div class="dz-art">${total ? "✅" : "🤔"}</div>
      <p><strong>${total.toLocaleString()} lead${total === 1 ? "" : "s"} added</strong>
         from ${esc(o.file)}</p>
      <p class="dz-sub">${(o.rows || 0).toLocaleString()} rows read · detected as a ${esc(o.detected || "lead list")}</p>
    </div>
    <div class="import-report">
      ${line("Companies", ins.company)}
      ${line("People", ins.person)}
      ${line("Job board", ins.job)}
      ${line("Skipped — already in the base", c.duplicates)}
      ${line("Added but hidden — blocked number", c.blocked)}
    </div>
    ${o.unmapped?.length ? `<p class="dz-sub">Columns ignored: ${esc(o.unmapped.slice(0, 12).join(", "))}${o.unmapped.length > 12 ? "…" : ""}</p>` : ""}
    <div class="modal-actions">
      <button type="button" class="btn-secondary" id="import-again">Import another</button>
      <button type="button" class="btn-primary" id="modal-cancel">Done</button>
    </div>`;
  $("modal-cancel").addEventListener("click", closeModal);
  $("import-again").addEventListener("click", openImportModal);
  if (total) toast(`Imported ${total.toLocaleString()} leads from ${o.file}`);
}

/* dropping a file anywhere in the app opens the importer. Import is admin-only,
   so for a member this stays inert apart from swallowing the drop — the
   browser navigating away to a spreadsheet is nobody's idea of a feature */
function wireGlobalDrop() {
  const hasFile = (e) => Array.from(e.dataTransfer?.types || []).includes("Files");
  window.addEventListener("dragover", (e) => {
    if (!hasFile(e)) return;
    e.preventDefault();
    if (S.me?.role !== "admin") return;
    if ($("modal-backdrop").classList.contains("hidden")) openImportModal();
    document.body.classList.add("dragging");
  });
  window.addEventListener("dragleave", (e) => {
    if (e.relatedTarget === null) document.body.classList.remove("dragging");
  });
  window.addEventListener("drop", (e) => {
    if (!hasFile(e)) return;
    e.preventDefault();                     // never let the browser open the file
    document.body.classList.remove("dragging");
    if (S.me?.role !== "admin") return;
    const f = e.dataTransfer.files[0];
    if (f && $("dropzone")) runImport(f);
  });
}

function closeModal() {
  $("modal-backdrop").classList.add("hidden");
  document.querySelector(".modal")?.classList.remove("wide");
}

/* ---------------- manage team (admin) ----------------
   The UI over server/users.js. @karmastaff.com accounts appear here on their
   own after first sign-in (auto-enrolment); this screen is for promoting
   admins, disabling leavers, and pre-inviting outside emails. The server
   holds the real rules — last-admin lockout etc. — we just show its errors. */
async function openUsersModal() {
  $("modal-title").textContent = "Manage team";
  $("modal-body").innerHTML = `
    <p class="modal-sub">Anyone with a company email joins as a <b>member</b> the
      first time they sign in. Admins are promoted here — they get imports, job
      search, this screen and the Team activity tab.</p>
    <div id="users-list" class="users-list"><div class="modal-sub">Loading…</div></div>
    <form id="user-add-row" class="user-add-row">
      <input type="email" id="user-add-email" placeholder="invite an email outside the company…" required>
      <select id="user-add-role"><option value="member" selected>member</option><option value="admin">admin</option></select>
      <button type="submit" class="btn-secondary">Add</button>
    </form>
    <div id="users-error" class="login-error hidden"></div>
    <div class="modal-actions">
      <button type="button" class="btn-secondary" id="modal-cancel">Close</button>
    </div>`;
  $("modal-backdrop").classList.remove("hidden");
  $("modal-cancel").addEventListener("click", closeModal);
  $("user-add-row").addEventListener("submit", async (e) => {
    e.preventDefault();
    await usersCall("/api/users", "POST",
      { email: $("user-add-email").value, role: $("user-add-role").value });
    $("user-add-email").value = "";
  });
  await renderUsersList();
}

async function usersCall(path, method, body) {
  const err = $("users-error");
  err.classList.add("hidden");
  try {
    await api(path, { method, body: JSON.stringify(body) });
    await renderUsersList();
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove("hidden");
  }
}

async function renderUsersList() {
  const { list } = await api("/api/users");
  const rows = list.map((u) => {
    const me = u.id === S.me.id;
    const who = esc(u.display_name || u.email.split("@")[0]);
    return `
    <div class="user-row${u.disabled ? " user-disabled" : ""}">
      <span class="avatar" style="background:${avColor(u.display_name || u.email)}">${initials(u.display_name || u.email)}</span>
      <div class="user-id">
        <div class="user-name">${who}${me ? " <span class='user-you'>(you)</span>" : ""}</div>
        <div class="user-sub">${esc(u.email)}${u.disabled ? " · disabled"
          : u.last_active ? " · active " + relTime(u.last_active) : ""}</div>
      </div>
      <select class="user-role" data-id="${u.id}" ${u.disabled ? "disabled" : ""}>
        <option value="member"${u.role !== "admin" ? " selected" : ""}>member</option>
        <option value="admin"${u.role === "admin" ? " selected" : ""}>admin</option>
      </select>
      <button type="button" class="btn-ghost user-toggle" data-id="${u.id}" data-disable="${!u.disabled}">
        ${u.disabled ? "Restore" : "Disable"}</button>
    </div>`;
  }).join("");
  $("users-list").innerHTML = rows || `<div class="modal-sub">No accounts yet.</div>`;
  $("users-list").querySelectorAll(".user-role").forEach((sel) =>
    sel.addEventListener("change", () =>
      usersCall(`/api/users/${sel.dataset.id}`, "PATCH", { role: sel.value })));
  $("users-list").querySelectorAll(".user-toggle").forEach((btn) =>
    btn.addEventListener("click", () =>
      usersCall(`/api/users/${btn.dataset.id}`, "PATCH",
        { disabled: btn.dataset.disable === "true" })));
}

/* ---------------- job search (Apify) ----------------
   The 🔎 button runs a search with the saved settings (confirm step first,
   with a hard max-cost figure); the ⚙ gear edits them. Settings live in
   localStorage — they're personal defaults, not shared state. The Apify
   token never reaches the browser: everything goes through the domain API.
   Two job boards, picked in settings: LinkedIn (the fantastic-jobs actor,
   full filter set) and Indeed (misceres/indeed-scraper — one title + one
   location per search, no filters, but a lower per-job price). */
const JS_LS = "kl_jobsearch";

/* The two boards are not interchangeable — one costs more and returns company
   records, the other is one-title-one-location and jobs only — so the picker is
   a pair of full-width brand cards, not a radio pair, and the chosen board is
   named on the 🔎 button and in the confirm step. Brand marks are drawn (the
   nav has no emoji anywhere else either). */
const JS_MARK = {
  linkedin: `<svg class="board-mark" viewBox="0 0 24 24" aria-hidden="true">
    <rect width="24" height="24" rx="4" fill="#0a66c2"/>
    <path fill="#fff" d="M6.2 4.6a1.9 1.9 0 100 3.8 1.9 1.9 0 000-3.8zM4.5 9.9h3.4v9.6H4.5V9.9zm5.4 0h3.25v1.3h.05c.45-.82 1.56-1.68 3.22-1.68 3.45 0 4.08 2.16 4.08 4.97v5.01h-3.4v-4.44c0-1.06-.02-2.42-1.5-2.42s-1.73 1.15-1.73 2.34v4.52H9.9V9.9z"/>
  </svg>`,
  indeed: `<svg class="board-mark" viewBox="0 0 24 24" aria-hidden="true">
    <rect width="24" height="24" rx="4" fill="#003a9b"/>
    <circle cx="12" cy="6.6" r="2.2" fill="#fff"/>
    <path fill="#fff" d="M9.85 10.1h4.3v7.1c0 1.5.5 1.9 1.35 1.9v2.1c-3.7.35-5.65-.85-5.65-4.1v-7z"/>
  </svg>`,
};
const JS_BOARDS = [
  { key: "linkedin", label: "LinkedIn", tag: "Richest data" },
  { key: "indeed", label: "Indeed", tag: "Cheapest per job" },
];
const JS_SCRAPERS = JS_BOARDS.map((b) => [b.key, b.label]);
const JS_RATES_FALLBACK = {
  linkedin: { perResultUsd: 0.005, recruiterPerResultUsd: 0.015,
    limitMin: 10, limitMax: 500, limitDefault: 100 },
  indeed: { perResultUsd: 0.003, limitMin: 10, limitMax: 500, limitDefault: 100 },
};
const JS_TIME_RANGES = [["1h", "Last hour"], ["24h", "Last 24 hours"],
  ["7d", "Last 7 days"], ["6m", "All active jobs"]];
const JS_ARRANGEMENTS = ["On-site", "Hybrid", "Remote OK", "Remote Solely"];
const JS_EMPLOYMENT = [["FULL_TIME", "Full-time"], ["PART_TIME", "Part-time"],
  ["CONTRACTOR", "Contract"], ["TEMPORARY", "Temporary"], ["INTERN", "Internship"]];
const JS_SENIORITY = ["Internship", "Entry level", "Associate",
  "Mid-Senior level", "Director", "Executive"];

/* Pema's standard prospecting search, prefilled so a search is one click, not
   a fill-in operation: back-office roles at small (≤200-person) restoration
   companies anywhere in the US. Clearing a field and saving still means
   "blank on purpose" — defaults only apply where nothing was ever saved. */
const JS_DEFAULTS = {
  titles: ["Office Administrator", "Office Admin", "Administrative Assistant",
    "Office Manager", "Estimator", "Bookkeeper", "Bookkeeping",
    "Accounting Clerk", "Accounts Receivable", "Digital Marketer",
    "Marketing Coordinator", "Sales Representative",
    "Business Development Representative", "Customer Success",
    "Customer Service Representative", "Account Manager", "Medical Biller",
    "Billing Specialist"].join(", "),
  locations: "United States",
  timeRange: "7d",
  limit: 50,
  employment: ["FULL_TIME"],
  description: ["restoration", "water damage", "fire damage",
    "mold remediation", "mitigation", "Xactimate", "Symbility", "IICRC",
    "disaster recovery", "storm damage"].join(", "),
  maxEmployees: 200,
};

let APIFY_USAGE = null;          // {usedUsd,maxUsd,remainingUsd,cycleEndsAt,daily,rates}

const jsRates = (scraper = "linkedin") =>
  APIFY_USAGE?.scraperRates?.[scraper] || JS_RATES_FALLBACK[scraper]
    || JS_RATES_FALLBACK.linkedin;
const jsBoard = (s) =>
  (JS_SCRAPERS.find(([v]) => v === s.scraper) || JS_SCRAPERS[0])[1];
/* results are billed per job actually returned, so limit × rate is a ceiling */
const jsMaxCost = (s) => {
  const r = jsRates(s.scraper);
  return (+s.limit || r.limitDefault) *
    (s.scraper === "linkedin" && s.recruiterOnly
      ? r.recruiterPerResultUsd : r.perResultUsd);
};
const usd = (n) => n == null ? "—"
  : "$" + (+n >= 0.1 || +n === 0 ? (+n).toFixed(2) : (+n).toFixed(3));
const splitCommas = (s) => String(s || "").split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
const splitLines = (s) => String(s || "").split(/[\n;]/).map((x) => x.trim()).filter(Boolean);

function jsSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(JS_LS)) || {}; } catch (e) { /* fresh */ }
  // ?? not || — a deliberately emptied-and-saved field must stay empty
  return {
    scraper: s.scraper === "indeed" ? "indeed" : "linkedin",
    titles: s.titles ?? JS_DEFAULTS.titles,
    locations: s.locations ?? JS_DEFAULTS.locations,
    timeRange: s.timeRange || JS_DEFAULTS.timeRange,
    limit: +s.limit || JS_DEFAULTS.limit,
    arrangement: s.arrangement || [],
    employment: s.employment ?? JS_DEFAULTS.employment,
    seniority: s.seniority || [], hasSalary: !!s.hasSalary,
    removeAgency: s.removeAgency !== false,        // default on
    description: s.description ?? JS_DEFAULTS.description,
    maxEmployees: s.maxEmployees === undefined
      ? JS_DEFAULTS.maxEmployees : (+s.maxEmployees || null),
    recruiterOnly: !!s.recruiterOnly,
    saved: !!s.saved,
  };
}
const saveJsSettings = (s) => localStorage.setItem(JS_LS, JSON.stringify(s));

/* the 🔎 button names the board it is armed with — the choice lives in
   localStorage, so without this nothing on screen says which one runs */
function paintBoardTag() {
  const el = $("js-board-tag");
  if (!el) return;
  const s = jsSettings();
  el.textContent = jsBoard(s);
  el.className = "js-board-tag board-chip board-chip-" + s.scraper;
}

async function loadApifyUsage() {
  paintBoardTag();
  try { APIFY_USAGE = await api("/api/apify-usage"); }
  catch (e) { console.warn("[karma] apify usage unavailable", e.message); }
  const el = $("credits-line");
  if (el) el.textContent = APIFY_USAGE?.remainingUsd != null
    ? `Apify credits: ${usd(APIFY_USAGE.remainingUsd)} left` : "";
}

/* daily spend as inline SVG bars — no chart library in this app */
function spendSparkline(daily) {
  if (!daily?.length) return `<div class="dz-sub">No usage yet this cycle.</div>`;
  const w = 360, h = 54, gap = 2;
  const max = Math.max(...daily.map((d) => d.usd), 0.01);
  const bw = Math.max(2, (w - gap * (daily.length - 1)) / daily.length);
  const bars = daily.map((d, i) => {
    const bh = Math.max(1.5, (d.usd / max) * (h - 4));
    return `<rect x="${(i * (bw + gap)).toFixed(1)}" y="${(h - bh).toFixed(1)}"
      width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5">
      <title>${esc(d.date)} — ${usd(d.usd)}</title></rect>`;
  }).join("");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${bars}</svg>
    <div class="usage-caption">Daily Apify spend this billing cycle · peak ${usd(max)}</div>`;
}

function usageCard() {
  const u = APIFY_USAGE;
  if (!u) return `<div class="modal-note">Couldn't reach Apify for credit info —
    searches may still work. Check the server log.</div>`;
  const pct = u.maxUsd ? Math.min(100, (u.usedUsd / u.maxUsd) * 100) : 0;
  const resets = u.cycleEndsAt ? new Date(u.cycleEndsAt)
    .toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null;
  return `<div class="usage-card">
    <div class="usage-row"><span>Apify credits</span>
      <strong>${usd(u.usedUsd)} used${u.maxUsd != null ? ` of ${usd(u.maxUsd)}` : ""}</strong></div>
    <div class="usage-bar"><div class="usage-fill${pct > 85 ? " hot" : ""}"
      style="width:${pct.toFixed(1)}%"></div></div>
    <div class="usage-row usage-sub">
      <span>${u.remainingUsd != null ? usd(u.remainingUsd) + " remaining" : ""}</span>
      <span>${resets ? "resets " + resets : ""}</span></div>
    ${spendSparkline(u.daily)}
  </div>`;
}

/* ---- settings (the ⚙ gear) */
function openJobSearchSettings() {
  const s = jsSettings();
  const check = (group, value, label, on) =>
    `<label class="check"><input type="checkbox" data-g="${group}"
       value="${esc(value)}"${on ? " checked" : ""}> ${esc(label)}</label>`;
  const advancedUsed = s.arrangement.length || s.employment.length ||
    s.seniority.length || s.hasSalary || s.description || s.recruiterOnly;
  $("modal-title").textContent = "Job search settings";
  document.querySelector(".modal").classList.add("wide");
  $("modal-body").innerHTML = `
    ${usageCard()}
    <form id="js-form"${s.scraper === "indeed" ? ' class="indeed"' : ""}>
      <div class="js-group-label">Job Board Settings</div>
      <div class="board-picker">${JS_BOARDS.map((b) => `
        <label class="board-card board-${b.key}${b.key === s.scraper ? " on" : ""}">
          <input type="radio" name="js-scraper" value="${b.key}"
                 ${b.key === s.scraper ? " checked" : ""}>
          <span class="board-head">
            ${JS_MARK[b.key]}
            <span class="board-name">${b.label}</span>
            <span class="board-tick" aria-hidden="true">✓</span>
          </span>
          <span class="board-price">${usd(jsRates(b.key).perResultUsd * 1000)}
            <small>per 1,000 jobs</small></span>
          <span class="board-tag">${b.tag}</span>
        </label>`).join("")}</div>
      <label>Job titles — comma-separated, blank = any
        <input id="js-titles" value="${esc(s.titles)}"
               placeholder="Insurance Adjuster, Claims Adjuster">
      </label>
      <label>Locations — one per line, written as “City, State, Country”
        <textarea id="js-locations" rows="2"
          placeholder="Miami, Florida, United States">${esc(s.locations)}</textarea>
      </label>
      <div class="js-two">
        <label class="li-only">Posted within
          <select id="js-time">${JS_TIME_RANGES.map(([v, l]) =>
            `<option value="${v}"${v === s.timeRange ? " selected" : ""}>${l}</option>`).join("")}
          </select>
        </label>
        <label>Max results (${jsRates().limitMin}–${jsRates().limitMax})
          <input id="js-limit" type="number" min="${jsRates().limitMin}"
                 max="${jsRates().limitMax}" value="${s.limit}">
        </label>
      </div>
      <details class="js-adv li-only"${advancedUsed ? " open" : ""}>
        <summary>Advanced filters</summary>
        <div class="js-group-label">Work arrangement</div>
        <div class="check-grid">${JS_ARRANGEMENTS.map((a) =>
          check("arr", a, a, s.arrangement.includes(a))).join("")}</div>
        <div class="js-group-label">Employment type</div>
        <div class="check-grid">${JS_EMPLOYMENT.map(([v, l]) =>
          check("emp", v, l, s.employment.includes(v))).join("")}</div>
        <div class="js-group-label">Seniority</div>
        <div class="check-grid">${JS_SENIORITY.map((v) =>
          check("sen", v, v, s.seniority.includes(v))).join("")}</div>
        <div class="js-group-label">Options</div>
        <label class="check"><input type="checkbox" id="js-salary"
          ${s.hasSalary ? " checked" : ""}> Only jobs with salary data</label>
        <label class="check"><input type="checkbox" id="js-agency"
          ${s.removeAgency ? " checked" : ""}> Hide staffing agencies</label>
        <label class="check"><input type="checkbox" id="js-recruiter"
          ${s.recruiterOnly ? " checked" : ""}> Include recruiter contacts
          <span class="js-price-warn">≈${Math.round(jsRates().recruiterPerResultUsd /
            jsRates().perResultUsd)}× cost</span></label>
        <label class="modal-field">Description keywords (ignored on “All active jobs”)
          <input id="js-desc" value="${esc(s.description)}" placeholder="restoration, Xactimate">
        </label>
        <label class="modal-field">Max company size, employees — blank = any
          <input id="js-maxemp" type="number" min="1"
                 value="${s.maxEmployees ?? ""}" placeholder="200">
        </label>
      </details>
      <div class="js-estimate" id="js-estimate"></div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="js-reset"
                title="Back to the standard prospecting search">Reset</button>
        <button type="button" class="btn-secondary" id="modal-cancel">Cancel</button>
        <button type="button" class="btn-secondary" id="js-save">Save</button>
        <button type="submit" class="btn-primary">Save &amp; search</button>
      </div>
    </form>`;
  $("modal-backdrop").classList.remove("hidden");

  const collect = () => ({
    scraper: (document.querySelector('#js-form [name="js-scraper"]:checked')
      || {}).value === "indeed" ? "indeed" : "linkedin",
    titles: $("js-titles").value.trim(),
    locations: $("js-locations").value.trim(),
    timeRange: $("js-time").value,
    limit: Math.min(Math.max(+$("js-limit").value || jsRates().limitDefault,
      jsRates().limitMin), jsRates().limitMax),
    arrangement: [...document.querySelectorAll('#js-form [data-g="arr"]:checked')].map((i) => i.value),
    employment: [...document.querySelectorAll('#js-form [data-g="emp"]:checked')].map((i) => i.value),
    seniority: [...document.querySelectorAll('#js-form [data-g="sen"]:checked')].map((i) => i.value),
    hasSalary: $("js-salary").checked,
    removeAgency: $("js-agency").checked,
    recruiterOnly: $("js-recruiter").checked,
    description: $("js-desc").value.trim(),
    maxEmployees: +$("js-maxemp").value || null,
    saved: true,
  });
  const estimate = () => {
    const c = collect();
    // the picker doubles as a mode switch: Indeed hides the LinkedIn-only rows
    $("js-form").classList.toggle("indeed", c.scraper === "indeed");
    document.querySelectorAll("#js-form .board-card").forEach((el) =>
      el.classList.toggle("on", el.classList.contains("board-" + c.scraper)));
    const recruiter = c.scraper === "linkedin" && c.recruiterOnly;
    const rate = recruiter
      ? jsRates(c.scraper).recruiterPerResultUsd : jsRates(c.scraper).perResultUsd;
    const per1k = "$" + (rate * 1000).toFixed(2) + " per 1,000";
    $("js-estimate").innerHTML = `Maximum cost on
      <span class="board-chip board-chip-${c.scraper}">${jsBoard(c)}</span>:
      <strong>${usd(jsMaxCost(c))}</strong>
      for up to ${c.limit} jobs${recruiter
        ? ` <span class="js-price-warn">recruiter rate — ${per1k}</span>`
        : ` · ${per1k}`}`;
  };
  estimate();
  $("js-form").addEventListener("input", estimate);
  $("modal-cancel").addEventListener("click", closeModal);
  $("js-reset").addEventListener("click", () => {
    localStorage.removeItem(JS_LS);
    paintBoardTag();
    toast("Search settings reset to defaults");
    openJobSearchSettings();
  });
  $("js-save").addEventListener("click", () => {
    const c = collect();
    saveJsSettings(c);
    paintBoardTag();
    toast(`Job search settings saved — searching ${jsBoard(c)}`);
    closeModal();
  });
  $("js-form").onsubmit = (e) => {
    e.preventDefault();
    saveJsSettings(collect());
    paintBoardTag();
    openJobSearchConfirm();
  };
}

/* ---- confirm (the 🔎 button) — nothing is spent without passing this */
function openJobSearchConfirm() {
  const s = jsSettings();
  if (!s.saved) { openJobSearchSettings(); return; }
  const indeed = s.scraper === "indeed";
  // Indeed runs one search — confirm exactly what will be sent, not the list
  const titles = indeed
    ? splitCommas(s.titles).slice(0, 1) : splitCommas(s.titles);
  const locations = indeed
    ? splitLines(s.locations).slice(0, 1) : splitLines(s.locations);
  if (indeed && !titles.length) {   // the server 400s on a blank position
    toast("Indeed needs a job title — add one in settings");
    openJobSearchSettings();
    return;
  }
  const keywords = splitCommas(s.description);
  const timeLabel = (JS_TIME_RANGES.find(([v]) => v === s.timeRange) || [, "?"])[1];
  const max = jsMaxCost(s);
  // 18 default titles would swallow the popup — show a few and count the rest
  const brief = (arr, n) => arr.length > n
    ? `${arr.slice(0, n).join(", ")} +${arr.length - n} more` : arr.join(", ");
  const row = (label, val) => val
    ? `<div class="ir-row"><span>${label}</span><strong>${esc(val)}</strong></div>` : "";
  $("modal-title").textContent = `Search ${jsBoard(s)} jobs?`;
  $("modal-body").innerHTML = `
    <div class="board-banner board-${s.scraper}">
      ${JS_MARK[s.scraper]}
      <div>
        <div class="board-banner-name">${jsBoard(s)}</div>
        <div class="board-banner-sub">${indeed
          ? "One title, one location, jobs only — no company records"
          : "Full filters — organizations also land as company leads"}</div>
      </div>
      <button type="button" class="board-swap" id="js-swap">Use ${indeed
        ? "LinkedIn" : "Indeed"} instead</button>
    </div>
    <div class="import-report">
      ${row("Job titles", brief(titles, 3) || "Any")}
      ${row("Locations", brief(locations, 2) || "Anywhere")}
      ${indeed ? "" : row("Company keywords", brief(keywords, 3))}
      ${indeed ? "" : row("Posted within", timeLabel)}
      ${!indeed && s.maxEmployees ? row("Company size", `≤ ${s.maxEmployees} employees`) : ""}
      ${row("Max results", String(s.limit))}
      ${!indeed && s.recruiterOnly ? row("Recruiter contacts", "On — higher rate") : ""}
    </div>
    <p class="modal-note">Costs at most <strong>${usd(max)}</strong> — you only pay
      for jobs actually returned.${APIFY_USAGE?.remainingUsd != null
        ? ` You have <strong>${usd(APIFY_USAGE.remainingUsd)}</strong> in Apify credits.` : ""}</p>
    <div class="modal-actions">
      <button type="button" class="btn-secondary" id="js-edit">⚙ Edit</button>
      <button type="button" class="btn-secondary" id="modal-cancel">Cancel</button>
      <button type="button" class="btn-primary" id="js-go">Search · up to ${usd(max)}</button>
    </div>`;
  $("modal-backdrop").classList.remove("hidden");
  $("modal-cancel").addEventListener("click", closeModal);
  $("js-edit").addEventListener("click", openJobSearchSettings);
  // one click to flip boards from the confirm step — the settings are otherwise
  // identical, and Indeed simply ignores what it can't use
  $("js-swap").addEventListener("click", () => {
    saveJsSettings({ ...s, scraper: indeed ? "linkedin" : "indeed" });
    paintBoardTag();
    openJobSearchConfirm();
  });
  $("js-go").addEventListener("click", runJobSearch);
}

async function runJobSearch() {
  const s = jsSettings();
  $("modal-title").textContent = `Searching ${jsBoard(s)}`;
  $("modal-body").innerHTML = `
    <div class="import-busy">
      <div class="spinner"></div>
      <div><strong>Searching ${jsBoard(s)} jobs…</strong></div>
      <div class="dz-sub">Usually 10–60 seconds. New jobs land in the Job board tab.</div>
    </div>`;
  $("modal-backdrop").classList.remove("hidden");
  try {
    const out = await api("/api/job-search", {
      method: "POST",
      body: JSON.stringify({
        scraper: s.scraper,
        titleSearch: splitCommas(s.titles),
        locationSearch: splitLines(s.locations),
        timeRange: s.timeRange,
        limit: +s.limit,
        aiWorkArrangementFilter: s.arrangement,
        aiEmploymentTypeFilter: s.employment,
        seniorityFilter: s.seniority,
        hasSalary: s.hasSalary,
        removeAgency: s.removeAgency,
        descriptionSearch: splitCommas(s.description),
        organizationEmployeesLte: s.maxEmployees || undefined,
        recruiterOnly: s.recruiterOnly,
      }),
    });
    renderJobSearchResult(out);
    loadApifyUsage();                       // refresh the credits line + graph data
    setTimeout(loadApifyUsage, 15000);      // …again once Apify's stats catch up
    refreshCounts();
    if (out.inserted && S.tab === "jobs") loadList(true);
  } catch (e) {
    const msg = (String(e.message).match(/"error"\s*:\s*"([^"]+)/) || [])[1] || e.message;
    $("modal-body").innerHTML = `
      <div class="import-error">
        <div class="dz-art">⚠️</div>
        <p><strong>Search failed</strong></p>
        <p class="dz-sub">${esc(msg)}</p>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="modal-cancel">Close</button>
        <button type="button" class="btn-primary" id="js-retry">Try again</button>
      </div>`;
    $("modal-cancel").addEventListener("click", closeModal);
    $("js-retry").addEventListener("click", openJobSearchConfirm);
  }
}

function renderJobSearchResult(o) {
  const line = (label, n) => n
    ? `<div class="ir-row"><span>${label}</span><strong>${(+n).toLocaleString()}</strong></div>` : "";
  const cost = o.cost?.usd != null ? usd(o.cost.usd) : "unavailable";
  $("modal-title").textContent = "Job search complete";
  $("modal-body").innerHTML = `
    <div class="import-done">
      <div class="dz-art">${o.inserted ? "✅" : "🤔"}</div>
      <p><strong>${o.inserted.toLocaleString()} new job${o.inserted === 1 ? "" : "s"} added</strong>
        to the Job board</p>
      <p class="dz-sub">${o.found.toLocaleString()} matched the search</p>
    </div>
    <div class="import-report">
      ${line("Jobs found", o.found)}
      ${line("Added to Job board", o.inserted)}
      ${line("Skipped — already in the base", o.duplicates)}
      ${line("New companies added", o.companies?.inserted)}
      ${line("Companies enriched (logo, website…)", o.companies?.updated)}
      <div class="ir-row"><span>Actual cost charged</span><strong>${cost}</strong></div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn-secondary" id="js-again">Search again</button>
      <button type="button" class="btn-primary" id="modal-cancel">Done</button>
    </div>`;
  $("modal-cancel").addEventListener("click", closeModal);
  $("js-again").addEventListener("click", openJobSearchConfirm);
  if (o.inserted) toast(`${o.inserted.toLocaleString()} jobs added · cost ${cost}`);
}

/* ---------------- remove / ban ---------------- */
async function openRemoveModal(r) {
  const name = displayName(r, r._t);
  const key = r["Phone Key"];
  const phone = r.Phone;
  // count the blast radius before asking — shared/toll-free numbers hit many leads
  let n = 1;
  if (key) {
    try { n = (await api(`/api/leads/${r.Id}/remove-preview`)).affected || 1; }
    catch { /* preview is best-effort; the modal still warns generically */ }
  }
  $("modal-title").textContent = "Remove lead";
  $("modal-body").innerHTML = `<form id="remove-form">
    <p class="modal-note">
      ${key
        ? `This bans <b>${esc(phone)}</b> and removes
           <b>${n} lead${n === 1 ? "" : "s"}</b> sharing that number, across
           Companies, People and Job board. Future imports of that number stay
           out too.${n > 3 ? ` <b>Note:</b> that number is on ${n} records — check
           it isn't a shared switchboard before banning.` : ""}`
        : `<b>${esc(name)}</b> has no usable phone number on file, so only this
           one record is removed — nothing is added to the blocklist.`}
    </p>
    <label>Reason (optional)
      <input name="reason" placeholder="e.g. asked not to be contacted">
    </label>
    <div class="modal-actions">
      <button type="button" class="btn-secondary" id="modal-cancel">Cancel</button>
      <button type="submit" class="btn-danger">Remove${key ? " & ban number" : ""}</button>
    </div>
  </form>`;
  $("modal-backdrop").classList.remove("hidden");
  $("modal-cancel").addEventListener("click", closeModal);
  $("remove-form").onsubmit = async (e) => {
    e.preventDefault();
    const reason = new FormData(e.target).get("reason");
    const btn = e.target.querySelector(".btn-danger");
    btn.disabled = true; btn.textContent = "Removing…";
    try {
      const out = await removeLead(r, reason);
      closeModal();
      const msg = `Removed ${out.affected} lead${out.affected === 1 ? "" : "s"}${key ? ` · ${phone} banned` : ""}`;
      // a member has no DNC tab to dig a slip out of — give them 5s to undo
      if (S.me?.role === "admin") toast(msg);
      else showUndo(msg, r.Id, out.ids);
      S.sel = null;
      $("detail").classList.add("hidden");
      $("detail-empty").classList.remove("hidden");
      loadList(); refreshCounts();
    } catch (ex) {
      btn.disabled = false; btn.textContent = "Remove";
      toast("Could not remove: " + ex.message);
    }
  };
}

async function doRestore(r) {
  await restoreLead(r);
  toast("Lead restored" + (r["Phone Key"] ? " and number un-banned" : ""));
  S.sel = null;
  $("detail").classList.add("hidden");
  $("detail-empty").classList.remove("hidden");
  loadList(); refreshCounts();
}

/* ---------------- delete / trash bin (admin) ----------------
   Delete is not the DNC ban. Remove blocklists a phone number and keeps the
   lead under Manage → DNC; delete takes the lead out of the app and parks it
   in the bin, where it is destroyed for good after 30 days (or the moment the
   admin empties it). Deleting a company takes its job postings with it — a
   posting with no employer is noise — but deleting a job never touches the
   company the scrape built. The bin lives in the user menu, not the sidebar:
   it is a recovery hatch, not a view anyone works from. */
const TRASH_DAYS = 30;

async function openDeleteModal(r) {
  const name = displayName(r, r._t);
  let pv = { jobs: 0, purgeAfterDays: TRASH_DAYS };
  try { pv = await api(`/api/leads/${r.Id}/delete-preview`); }
  catch { /* best effort — the modal still states the rule */ }
  const jobs = pv.jobs || 0;
  $("modal-title").textContent = "Delete lead";
  $("modal-body").innerHTML = `
    <p class="modal-note">
      <b>${esc(name)}</b> goes to the trash bin${jobs
        ? `, and so do its <b>${jobs} job posting${jobs === 1 ? "" : "s"}</b>`
        : ""}. It disappears from every list, count and search straight away.
    </p>
    <div class="import-report">
      <div class="ir-row"><span>Recoverable from</span>
        <strong>Trash — in the user menu</strong></div>
      <div class="ir-row"><span>Destroyed for good</span>
        <strong>${pv.purgeAfterDays || TRASH_DAYS} days after deletion</strong></div>
      <div class="ir-row"><span>Phone number</span>
        <strong>Not banned — that's 🚫 Remove</strong></div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn-secondary" id="modal-cancel">Cancel</button>
      <button type="button" class="btn-danger" id="delete-go">Delete${
        jobs ? ` ${jobs + 1} leads` : ""}</button>
    </div>`;
  $("modal-backdrop").classList.remove("hidden");
  $("modal-cancel").addEventListener("click", closeModal);
  $("delete-go").addEventListener("click", async (e) => {
    const btn = e.target;
    btn.disabled = true; btn.textContent = "Deleting…";
    try {
      const out = await api(`/api/leads/${r.Id}`, { method: "DELETE" });
      closeModal();
      toast(`Moved ${out.affected} lead${out.affected === 1 ? "" : "s"} to the trash`);
      S.sel = null;
      $("detail").classList.add("hidden");
      $("detail-empty").classList.remove("hidden");
      loadList(); refreshCounts();
    } catch (ex) {
      btn.disabled = false; btn.textContent = "Delete";
      toast("Could not delete: " + ex.message);
    }
  });
}

async function openTrashModal() {
  $("modal-title").textContent = "Trash";
  document.querySelector(".modal").classList.add("wide");
  $("modal-body").innerHTML = `
    <p class="modal-sub">Deleted leads wait here for <b>${TRASH_DAYS} days</b>,
      then they are destroyed for good — the lead and its notes with it.
      Restoring puts a lead back exactly where it was.</p>
    <div id="trash-list" class="trash-list"><div class="modal-sub">Loading…</div></div>
    <div id="trash-error" class="login-error hidden"></div>
    <div class="modal-actions">
      <button type="button" class="btn-danger" id="trash-empty">Empty trash now</button>
      <button type="button" class="btn-secondary" id="modal-cancel">Close</button>
    </div>`;
  $("modal-backdrop").classList.remove("hidden");
  $("modal-cancel").addEventListener("click", closeModal);
  // two clicks, not a second modal: the first arms it, the second destroys
  $("trash-empty").addEventListener("click", async (e) => {
    const btn = e.target;
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1";
      btn.textContent = "Click again to destroy everything";
      setTimeout(() => {
        if (!btn.isConnected || btn.dataset.armed !== "1") return;
        btn.dataset.armed = "";
        btn.textContent = "Empty trash now";
      }, 5000);
      return;
    }
    btn.disabled = true; btn.textContent = "Emptying…";
    try {
      const out = await api("/api/trash", { method: "DELETE" });
      toast(`Destroyed ${out.destroyed} lead${out.destroyed === 1 ? "" : "s"}`);
      closeModal();
      refreshCounts();
    } catch (ex) {
      btn.disabled = false; btn.dataset.armed = "";
      btn.textContent = "Empty trash now";
      trashError(ex.message);
    }
  });
  await renderTrashList();
}

function trashError(msg) {
  const err = $("trash-error");
  if (!err) return;
  err.textContent = msg;
  err.classList.remove("hidden");
}

const KIND_LABEL = { company: "Company", person: "Person", job: "Job" };

async function renderTrashList() {
  const el = $("trash-list");
  if (!el) return;
  let d;
  try { d = await api("/api/trash"); }
  catch (ex) { el.innerHTML = ""; trashError(ex.message); return; }
  const days = d.purgeAfterDays || TRASH_DAYS;
  const rows = d.list.map((t) => {
    const left = Math.max(0, Math.ceil(
      (new Date(t.deleted_at).getTime() + days * 864e5 - Date.now()) / 864e5));
    const sub = [t.company && t.company !== t.name ? t.company : null,
      [t.city, t.state].filter(Boolean).join(", ") || null,
      t.deleted_by ? `deleted by ${t.deleted_by}` : null,
      relTime(t.deleted_at)].filter(Boolean).join(" · ");
    return `
    <div class="trash-row">
      <span class="trash-kind tk-${t.kind}">${KIND_LABEL[t.kind] || t.kind}</span>
      <div class="user-id">
        <div class="user-name">${esc(t.name || "(no name)")}</div>
        <div class="user-sub">${esc(sub)}</div>
      </div>
      <span class="trash-left${left <= 3 ? " soon" : ""}">${left === 0
        ? "purges today" : `${left}d left`}</span>
      <button type="button" class="btn-ghost trash-restore" data-id="${t.id}">↩ Restore</button>
    </div>`;
  }).join("");
  el.innerHTML = rows || `<div class="modal-sub">The trash is empty.</div>`;
  if (d.total > d.shown)
    el.insertAdjacentHTML("beforeend",
      `<div class="modal-sub">Showing the newest ${d.shown} of
        ${d.total.toLocaleString()} deleted leads.</div>`);
  const btn = $("trash-empty");
  if (btn) {
    btn.disabled = !d.total;
    btn.textContent = d.total
      ? `Empty trash now (${d.total.toLocaleString()})` : "Trash is empty";
  }
  el.querySelectorAll(".trash-restore").forEach((b) =>
    b.addEventListener("click", async () => {
      b.disabled = true; b.textContent = "…";
      try {
        const out = await api(`/api/trash/${b.dataset.id}/restore`, { method: "POST" });
        toast(`Restored ${out.affected} lead${out.affected === 1 ? "" : "s"}`);
        await renderTrashList();
        loadList(); refreshCounts();
      } catch (ex) {
        b.disabled = false; b.textContent = "↩ Restore";
        trashError(ex.message);
      }
    }));
}

/* ---------------- bulk action modals (admin) ----------------
   Three modals over server/bulk.js, one per action in the filter row. They
   deliberately mirror their single-lead twins above: the same words, the same
   blast-radius line before the same destructive click. The only new idea is
   the owner search — assigning is a pick from a list (the team, plus the
   owners already on leads), never a free-text box, because leads.owner is
   matched on equality and "Maria", "maria" and "maria@karmastaff.com" are
   three different work queues. */

const pickedIds = () => [...S.picked.keys()];

/* name the first few: a destructive confirm should be about leads someone
   recognises, not about a number */
function pickedNames(max = 3) {
  const names = [...S.picked.values()].map((p) => p.name);
  const head = names.slice(0, max).join(", ");
  return names.length > max
    ? `${head} and ${(names.length - max).toLocaleString()} more` : head;
}

function bulkError(msg) {
  const err = $("bulk-error");
  if (!err) return;
  err.textContent = msg;
  err.classList.remove("hidden");
}

/* one call answers both destructive modals; a failed preview must not block
   the action, so it falls back to what we already know */
async function bulkPreview(ids) {
  try {
    return await api("/api/bulk/preview",
      { method: "POST", body: JSON.stringify({ ids }) });
  } catch {
    return { leads: ids.length, dnc: ids.length, jobs: 0 };
  }
}

const leadsWord = (n) => `${n.toLocaleString()} lead${n === 1 ? "" : "s"}`;

async function openAssignModal() {
  const ids = pickedIds();
  if (!ids.length) return;
  let chosen = null;                     // an /api/owners row, or {clear:true}
  $("modal-title").textContent = `Assign ${leadsWord(ids.length)}`;
  $("modal-body").innerHTML = `
    <p class="modal-sub">Search the team and the owners already on leads —
      picking an existing name keeps one person from becoming three owner
      filters.<br>Selected: ${esc(pickedNames())}</p>
    <input id="owner-q" class="owner-q" type="search" autocomplete="off"
           placeholder="Search a name or email…">
    <div id="owner-results" class="owner-results">
      <div class="modal-sub">Loading…</div></div>
    <div id="bulk-error" class="login-error hidden"></div>
    <div class="modal-actions">
      <button type="button" class="btn-secondary" id="modal-cancel">Cancel</button>
      <button type="button" class="btn-primary" id="assign-go" disabled>Assign</button>
    </div>`;
  $("modal-backdrop").classList.remove("hidden");
  $("modal-cancel").addEventListener("click", closeModal);
  const go = $("assign-go");

  const paintChoice = () => {
    go.disabled = !chosen;
    go.textContent = !chosen ? "Assign"
      : chosen.clear ? `Unassign ${leadsWord(ids.length)}`
        : `Assign to ${chosen.label}`;
  };
  const mark = (btn) => {
    $("owner-results").querySelectorAll(".owner-row")
      .forEach((x) => x.classList.toggle("on", x === btn));
    paintChoice();
  };
  const render = (list) => {
    const el = $("owner-results");
    el.innerHTML = list.map((o, i) => {
      /* the value is always shown when it isn't the label: it is the string
         that lands in the owner column and drives the owner filter */
      const sub = [o.label === o.value ? null : o.value,
        o.team ? "team member" : "already on leads",
        o.leads ? `${leadsWord(o.leads)} owned` : null].filter(Boolean).join(" · ");
      return `
      <button type="button" class="owner-row" data-o="${i}">
        ${avatarHtml(o.label, null, "avatar avatar-sm")}
        <span class="owner-id">
          <span class="owner-name">${esc(o.label)}</span>
          <span class="owner-sub">${esc(sub)}</span>
        </span>
      </button>`;
    }).join("") || `<div class="modal-sub">Nobody matches. Teammates appear
      here once they have signed in at least once.</div>`;
    // unassigning is a real answer to "who owns these", so it is a row too
    el.insertAdjacentHTML("beforeend", `
      <button type="button" class="owner-row" data-clear="1">
        <span class="avatar avatar-sm owner-none">–</span>
        <span class="owner-id">
          <span class="owner-name">Leave unassigned</span>
          <span class="owner-sub">clears the owner on the selected leads</span>
        </span>
      </button>`);
    el.querySelectorAll("[data-o]").forEach((b) =>
      b.addEventListener("click", () => { chosen = list[+b.dataset.o]; mark(b); }));
    el.querySelectorAll("[data-clear]").forEach((b) =>
      b.addEventListener("click", () => { chosen = { clear: true }; mark(b); }));
  };
  const search = async (q) => {
    try { render((await api(`/api/owners?q=${encodeURIComponent(q)}`)).list || []); }
    catch (ex) { $("owner-results").innerHTML = ""; bulkError(ex.message); }
  };

  let debounce;
  $("owner-q").addEventListener("input", (e) => {
    chosen = null;
    paintChoice();
    clearTimeout(debounce);
    const q = e.target.value.trim();
    debounce = setTimeout(() => search(q), 200);
  });
  go.addEventListener("click", async () => {
    if (!chosen) return;
    go.disabled = true;
    go.textContent = "Saving…";
    try {
      const out = await api("/api/bulk/assign", {
        method: "POST",
        body: JSON.stringify({ ids, owner: chosen.clear ? "" : chosen.value }),
      });
      toast(out.affected
        ? `${leadsWord(out.affected)} ${chosen.clear
          ? "unassigned" : `assigned to ${chosen.label}`}`
        : "Nothing to change — they already had that owner");
      await afterBulk(ids);
    } catch (ex) {
      paintChoice();
      bulkError(ex.message);
    }
  });
  await search("");
  $("owner-q").focus();
}

async function openBulkDncModal() {
  const ids = pickedIds();
  if (!ids.length) return;
  const pv = await bulkPreview(ids);
  const extra = Math.max(0, pv.dnc - pv.leads);
  $("modal-title").textContent = `DNC ${leadsWord(ids.length)}`;
  $("modal-body").innerHTML = `
    <p class="modal-note">
      This bans the phone numbers on the selected leads and removes
      <b>${leadsWord(pv.dnc)}</b>${extra
        ? ` — the ${pv.leads} selected plus <b>${leadsWord(extra)}</b> sharing
            those numbers, across Companies, People and Job board`
        : ""}. Future imports of those numbers stay out too.
      ${extra > pv.leads ? `<br><b>Note:</b> that is far more than you picked —
        check none of these are shared switchboards.` : ""}
    </p>
    <p class="modal-sub">Selected: ${esc(pickedNames())}</p>
    <label>Reason (optional)
      <input id="dnc-reason" placeholder="e.g. asked not to be contacted">
    </label>
    <div id="bulk-error" class="login-error hidden"></div>
    <div class="modal-actions">
      <button type="button" class="btn-secondary" id="modal-cancel">Cancel</button>
      <button type="button" class="btn-danger" id="dnc-go">Remove &amp; ban</button>
    </div>`;
  $("modal-backdrop").classList.remove("hidden");
  $("modal-cancel").addEventListener("click", closeModal);
  $("dnc-go").addEventListener("click", async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = "Removing…";
    try {
      const out = await api("/api/bulk/dnc", {
        method: "POST",
        body: JSON.stringify({ ids, reason: $("dnc-reason").value }),
      });
      toast(`Removed ${leadsWord(out.affected)}` +
        (out.numbers ? ` · ${out.numbers} number${out.numbers === 1 ? "" : "s"} banned` : ""));
      await afterBulk(ids, { closeDetail: true });
    } catch (ex) {
      btn.disabled = false;
      btn.textContent = "Remove & ban";
      bulkError(ex.message);
    }
  });
}

async function openBulkDeleteModal() {
  const ids = pickedIds();
  if (!ids.length) return;
  const pv = await bulkPreview(ids);
  const total = pv.leads + (pv.jobs || 0);
  $("modal-title").textContent = `Delete ${leadsWord(ids.length)}`;
  $("modal-body").innerHTML = `
    <p class="modal-note">
      <b>${leadsWord(pv.leads)}</b> go to the trash bin${pv.jobs
        ? `, and so do <b>${pv.jobs} job posting${pv.jobs === 1 ? "" : "s"}</b>
           belonging to the companies you picked` : ""}. They disappear from
      every list, count and search straight away.
    </p>
    <p class="modal-sub">Selected: ${esc(pickedNames())}</p>
    <div class="import-report">
      <div class="ir-row"><span>Recoverable from</span>
        <strong>Trash — in the user menu</strong></div>
      <div class="ir-row"><span>Destroyed for good</span>
        <strong>${TRASH_DAYS} days after deletion</strong></div>
      <div class="ir-row"><span>Phone numbers</span>
        <strong>Not banned — that's DNC</strong></div>
    </div>
    <div id="bulk-error" class="login-error hidden"></div>
    <div class="modal-actions">
      <button type="button" class="btn-secondary" id="modal-cancel">Cancel</button>
      <button type="button" class="btn-danger" id="bulk-delete-go">Delete ${
        leadsWord(total)}</button>
    </div>`;
  $("modal-backdrop").classList.remove("hidden");
  $("modal-cancel").addEventListener("click", closeModal);
  $("bulk-delete-go").addEventListener("click", async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = "Deleting…";
    try {
      const out = await api("/api/bulk/delete", {
        method: "POST", body: JSON.stringify({ ids }),
      });
      toast(`Moved ${leadsWord(out.affected)} to the trash`);
      await afterBulk(ids, { closeDetail: true });
    } catch (ex) {
      btn.disabled = false;
      btn.textContent = `Delete ${leadsWord(total)}`;
      bulkError(ex.message);
    }
  });
}

/* ---------------- Team activity (admin) ----------------
   Reads /api/activity — the append-only log the API writes on every mutation.
   The default view counts status changes only — the number the manager
   actually watches; opens, notes and favorites drowned it out. The Logs
   button flips the same two blocks (daily bars split per person, live feed
   with click-through to the lead) to the unfiltered log. The log starts
   at the migration cutover, and the empty state says so plainly rather than
   showing a convincing-looking flat chart. */
const ACT_SLOTS = 8;                     // --cat-1..8, validated in both themes
let actFull = false;                     // false = status changes, true = Logs

async function loadStats() {
  const el = $("stats-body");
  if (!el) return;
  $("act-logs")?.setAttribute("aria-pressed", String(actFull));
  el.innerHTML = `<p class="act-empty">Loading the log…</p>`;
  try {
    renderStats(await api(
      `/api/activity?days=${$("act-days")?.value || 30}${actFull ? "&full=1" : ""}`));
  } catch (e) {
    el.innerHTML = `<p class="act-empty">Could not load activity (${esc(e.message)})</p>`;
  }
}

/* stable person -> colour slot, by share of the window's activity; past 8
   people the tail folds into a grey "Other" rather than inventing hues */
function actSlots(perPerson) {
  const map = new Map();
  perPerson.slice(0, ACT_SLOTS).forEach((p, i) => map.set(p.who, i + 1));
  return map;
}
const actColor = (slot) => slot ? `var(--cat-${slot})` : "var(--ink-3)";

function actChart(d, slots) {
  const days = d.perDay;
  const w = 720, h = 120, gap = days.length > 45 ? 1 : 2;
  const max = Math.max(...days.map((x) => x.total), 1);
  const bw = Math.max(2, (w - gap * (days.length - 1)) / days.length);
  let bars = "";
  days.forEach((day, i) => {
    const x = (i * (bw + gap)).toFixed(1);
    let y = h;                            // stack up from the baseline
    const entries = Object.entries(day.by_who)
      .sort((a, b) => (slots.get(a[0]) || 99) - (slots.get(b[0]) || 99));
    for (const [who, n] of entries) {
      const bh = (n / max) * (h - 6);
      y -= bh;
      bars += `<rect x="${x}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}"
        height="${Math.max(bh - 1, 0.5).toFixed(1)}"
        fill="${actColor(slots.get(who))}"
        ><title>${esc(day.date)} — ${esc(who)}: ${n} ${d.full ? "action" : "status change"}${n === 1 ? "" : "s"}</title></rect>`;
    }
  });
  return `<div class="act-chart">
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${bars}</svg>
    <div class="act-axis"><span>${esc(days[0]?.date || "")}</span>
      <span>peak ${max.toLocaleString()} / day</span>
      <span>${esc(days[days.length - 1]?.date || "")}</span></div>
  </div>`;
}

function actLegend(perPerson, slots) {
  if (!perPerson.length) return "";
  const item = (p) => {
    const acts = Object.entries(p.by_action)
      .map(([a, n]) => `${a} ${n}`).join(" · ");
    return `<span class="fact" title="${esc(acts)}">
      <i class="dot" style="background:${actColor(slots.get(p.who))}"></i>
      ${esc(p.who)} <b>${p.total.toLocaleString()}</b></span>`;
  };
  return `<div class="act-legend">${perPerson.map(item).join("")}</div>`;
}

/* one feed line: who did what to which lead, in words */
function feedLine(f) {
  const name = f.lead_name ? `<b>${esc(f.lead_name)}</b>` : "a lead";
  const m = f.meta || {};
  /* A bulk action is one log row for the whole selection (server/bulk.js) —
     writing 300 of them would push every other line off this feed. lead_name
     is already "300 leads", so these read as sentences; there is no single
     lead to click through to, which .no-lead handles. */
  if (m.bulk) {
    switch (f.action) {
      case "owner": return `assigned ${name} to <b>${esc(f.to_value)}</b>` +
        ` <span class="feed-what">(in bulk)</span>`;
      case "remove": return `banned ${m.numbers ?? "?"} number${m.numbers === 1 ? "" : "s"}` +
        ` and removed ${name}` +
        (f.to_value ? ` <span class="feed-what">(${esc(f.to_value)})</span>` : "");
      case "delete": return `deleted ${name} to the trash` +
        (m.jobs > 0 ? ` <span class="feed-what">including ${m.jobs} job posting${
          m.jobs === 1 ? "" : "s"}</span>` : "");
      default: break;
    }
  }
  switch (f.action) {
    case "open": return `opened ${name}`;
    case "status": return `set ${name} to <b>${esc(f.to_value)}</b>` +
      (f.from_value ? ` <span class="feed-what">(was ${esc(f.from_value)})</span>` : "");
    case "owner": return `assigned ${name} to <b>${esc(f.to_value)}</b>`;
    case "favorite": return `favorited ${name}`;
    case "unfavorite": return `unfavorited ${name}`;
    case "note": return `noted on ${name}<span class="feed-what">: ${esc(f.to_value || "")}</span>`;
    case "remove": return `removed ${name}` +
      (m.affected > 1 ? ` <span class="feed-what">and ${m.affected - 1} more sharing its number</span>` : "") +
      (f.to_value ? ` <span class="feed-what">(${esc(f.to_value)})</span>` : "");
    case "restore": return `restored ${name}`;
    case "delete": return `deleted ${name} to the trash` +
      (m.jobs > 0 ? ` <span class="feed-what">with ${m.jobs} job posting${m.jobs === 1 ? "" : "s"}</span>` : "");
    case "undelete": return `restored ${name} from the trash` +
      (m.affected > 1 ? ` <span class="feed-what">with ${m.affected - 1} more</span>` : "");
    case "purge": return `emptied the trash <span class="feed-what">(${
      m.count ?? "?"} lead${m.count === 1 ? "" : "s"} destroyed)</span>`;
    case "import": return `imported <b>${esc(f.to_value || "a file")}</b>` +
      (m.inserted ? ` <span class="feed-what">(${JSON.stringify(m.inserted).replace(/[{}"]/g, "")})</span>` : "");
    case "jobsearch": return `ran a${m.scraper === "indeed" ? "n Indeed" : " LinkedIn"} job search <span class="feed-what">(${m.found ?? "?"} found, ${m.inserted ?? "?"} new${
      m.companies ? `, ${m.companies} compan${m.companies === 1 ? "y" : "ies"}` : ""})</span>`;
    default: return esc(f.action);
  }
}

function renderStats(d) {
  const el = $("stats-body");
  const slots = actSlots(d.perPerson);
  if (!d.total) {
    el.innerHTML = `<div class="act-card"><p class="act-empty">${d.full
      ? `Nothing in the log for this window. Activity is recorded from the
         moment the new system went live — as the team opens leads, sets
         statuses and writes notes, it shows up here.`
      : `No status changes in this window. The Logs button shows everything
         else the team did — opens, notes, favorites, imports.`}</p></div>`;
    return;
  }
  el.innerHTML = `
    <div class="act-card">
      <h4>${d.full ? "Actions" : "Status changes"} per day — ${d.total.toLocaleString()} in the last ${d.days} days</h4>
      ${actChart(d, slots)}
      ${actLegend(d.perPerson, slots)}
    </div>
    <div class="act-card">
      <h4>${d.full ? "Latest activity" : "Latest status changes"}</h4>
      ${d.feed.map((f, i) => `
        <div class="feed-row${f.lead_id && f.lead_kind ? "" : " no-lead"}" data-fi="${i}">
          <span class="avatar avatar-sm" style="background:${avColor(f.actor)}">${esc(initials(f.actor))}</span>
          <div class="feed-main"><b>${esc(f.actor)}</b> ${feedLine(f)}</div>
          <span class="feed-when">${esc(relTime(f.at))}</span>
        </div>`).join("")}
    </div>`;
  el.querySelectorAll(".feed-row:not(.no-lead)").forEach((row) =>
    row.addEventListener("click", () => {
      const f = d.feed[+row.dataset.fi];
      const tab = KIND_TAB[f.lead_kind];
      if (!tab) return;
      setTab(tab);                       // leaves the stats pane, shows the list
      select({ Id: f.lead_id, _t: tab });
    }));
}

let toastTimer;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3500);
}

/* Undo toast (bottom right, 5 seconds): restores exactly the id set the
   remove swept — ban lifted too. The window is deliberately short; after it
   closes the lead is the manager's to restore from the DNC tab. */
let undoTimer;
function showUndo(msg, anchorId, ids) {
  const el = $("undo-toast");
  $("undo-msg").textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => el.classList.add("hidden"), 5000);
  $("undo-btn").onclick = async () => {
    clearTimeout(undoTimer);
    el.classList.add("hidden");
    try {
      await api(`/api/leads/${anchorId}/restore`, {
        method: "POST", body: JSON.stringify({ ids: ids || [] }),
      });
      toast("Removal undone");
      loadList(); refreshCounts();
    } catch (ex) {
      toast("Could not undo: " + ex.message);
    }
  };
}

/* ---------------- boot + events ---------------- */
function setTab(tab) {
  // an admin tab reached without the role — a stale deep link, say — lands on
  // Companies instead of an empty pane. The endpoint 403s regardless.
  if (TABS[tab]?.admin && S.me?.role !== "admin") tab = "companies";
  S.tab = tab;
  S.segment = null;                     // any sidebar tab leaves segment browsing
  $("segment-back")?.classList.add("hidden");
  $("seg-eyebrow")?.classList.add("hidden");
  $("list-head")?.classList.remove("in-segment");
  document.querySelectorAll(".nav-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === tab));
  $("clear-recents")?.classList.toggle("hidden", !TABS[tab].activity);
  /* Team activity is not a list of leads: it takes the whole width instead of
     leaving an empty reading pane beside a chart */
  const isStats = !!TABS[tab].stats;
  $("stats-pane")?.classList.toggle("hidden", !isStats);
  document.querySelector(".list-pane")?.classList.toggle("hidden", isStats);
  $("detail-pane")?.classList.toggle("hidden", isStats);
  renderSortOptions();
  loadList(true);
}

/* only offer sorts the current tab can actually do — no "certifications" on
   People, no "revenue" on the job board */
function renderSortOptions() {
  const sel = $("sort-by");
  if (!sel) return;
  if (TABS[S.tab].stats) return;         // its own controls live in the stats pane
  if (TABS[S.tab].activity) {
    // the trail has exactly one meaningful order; leave S.sort alone so the
    // last real choice is still there when the user goes back to a lead tab
    sel.innerHTML = `<option value="">Last interacted</option>`;
    sel.disabled = true;
    return;
  }
  // (segments sort like any other list now — the old "Segment order" lockout
  //  existed because NocoDB's link endpoint silently ignored `sort`)
  sel.disabled = false;
  const mixed = !TABS[S.tab].kind;         // favorites/removed span all kinds
  const keys = mixed ? UNION_KEYS : [S.tab];
  const usable = SORTS.filter((s) => keys.every((k) => sortUsable(s.key, k)));
  if (!usable.some((s) => s.key === S.sort)) S.sort = "recent";
  sel.innerHTML = usable.map((s) =>
    `<option value="${s.key}"${s.key === S.sort ? " selected" : ""}>${s.label}</option>`).join("");
}

function renderStateOptions() {
  const sel = $("filter-state");
  if (!sel) return;
  const states = Object.entries(STATE_NAME).sort((a, b) => a[1].localeCompare(b[1]));
  // value stays the abbreviation (that's what buildWhere matches on); only the
  // visible label is spelled out
  sel.innerHTML = `<option value="">All states</option>` + states.map(([ab, full]) =>
    `<option value="${ab}"${ab === S.state ? " selected" : ""}>${full}</option>`).join("");
}

/* ---------------- density + resizable panes ---------------- */
const DENSITIES = ["compact", "cozy", "comfortable"];
function setDensity(d) {
  if (!DENSITIES.includes(d)) d = "compact";
  document.body.classList.remove(...DENSITIES.map((x) => "d-" + x));
  document.body.classList.add("d-" + d);
  localStorage.setItem("kl_density", d);
  document.querySelectorAll("[data-density]").forEach((b) =>
    b.classList.toggle("on", b.dataset.density === d));
}

function setDetailWidth(px) {
  const w = Math.min(Math.max(px, 320), Math.max(360, window.innerWidth - 640));
  document.documentElement.style.setProperty("--detail-w", w + "px");
  localStorage.setItem("kl_detail_w", w);
}

function wireSplitter() {
  const handle = $("splitter");
  if (!handle) return;
  let dragging = false;
  const move = (e) => {
    if (!dragging) return;
    e.preventDefault();
    setDetailWidth(window.innerWidth - e.clientX - 20);   // 20px page padding
  };
  handle.addEventListener("mousedown", (e) => {
    dragging = true;
    document.body.classList.add("resizing");
    e.preventDefault();
  });
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", () => {
    dragging = false;
    document.body.classList.remove("resizing");
  });
  handle.addEventListener("dblclick", () => setDetailWidth(460));  // reset
}

/* One stale cached file used to blank the whole app: a missing element threw
   out of wire(), init() stopped, and nothing was ever shown. Wiring is
   best-effort now — a mismatched control goes dead, the app still loads. */
function on(id, ev, fn) {
  const el = $(id);
  if (el) el.addEventListener(ev, fn);
  else console.warn(`[karma] #${id} missing — stale index.html? hard-refresh`);
}

function wire() {
  document.querySelectorAll(".nav-item").forEach((b) =>
    b.addEventListener("click", () => setTab(b.dataset.tab)));
  document.querySelectorAll("[data-density]").forEach((b) =>
    b.addEventListener("click", () => setDensity(b.dataset.density)));
  // the KPI tiles are the filter control for the queues they count
  document.querySelectorAll(".stat[data-focus]").forEach((b) =>
    b.addEventListener("click", () => toggleFocus(b.dataset.focus)));
  wireSplitter();
  let debounce;
  on("search", "input", (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { S.q = e.target.value.trim(); loadList(true); }, 300);
  });
  on("filter-status", "change", (e) => { S.status = e.target.value; loadList(true); });
  on("filter-state", "change", (e) => { S.state = e.target.value; loadList(true); });
  on("sort-by", "change", (e) => {
    S.sort = e.target.value;
    localStorage.setItem("kl_sort", S.sort);
    loadList(true);
  });
  on("pager-first", "click", () => goToPage(1));
  on("pager-prev", "click", () => goToPage(S.page - 1));
  on("pager-next", "click", () => goToPage(S.page + 1));
  on("pager-last", "click", () => goToPage(pageCount()));
  on("page-size", "change", (e) => {
    // keep the first row of the current page visible after the size changes
    const anchor = (S.page - 1) * S.pageSize;
    S.pageSize = +e.target.value;
    localStorage.setItem("kl_page_size", S.pageSize);
    S.page = Math.floor(anchor / S.pageSize) + 1;
    loadList();
  });
  on("theme-toggle", "click", () => {
    const dark = document.documentElement.dataset.theme !== "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "";
    localStorage.setItem("kl_theme", dark ? "dark" : "");
  });
  on("user-avatar", "click", (e) => {
    e.stopPropagation();
    $("user-dropdown").classList.toggle("hidden");
  });
  document.addEventListener("click", () => $("user-dropdown")?.classList.add("hidden"));
  on("logout-btn", "click", logout);
  on("manage-users-btn", "click", () => {
    $("user-dropdown").classList.add("hidden");
    openUsersModal();
  });
  on("trash-btn", "click", () => {
    $("user-dropdown").classList.add("hidden");
    openTrashModal();
  });
  on("clear-recents", "click", async () => {
    // only forgets the trail — the leads themselves are untouched
    S.recents = [];
    recentsBadge();
    loadList(true);
    try { await api("/api/recents", { method: "DELETE" }); }
    catch (e) { console.warn("[karma] could not clear recents", e); }
    toast("Recent activity cleared");
  });
  // the bulk half of the filter row — admin-only in the markup, and on the routes
  on("bulk-toggle", "click", () => setSelectMode(!S.selectMode));
  on("bulk-all", "change", (e) => {
    S.list.forEach((r) => setPick(r, e.target.checked));
    lastPick = null;
    if (e.target.checked && S.picked.size >= BULK_MAX)
      toast(`${BULK_MAX} leads is the most one action can take`);
    paintPicks();
  });
  on("bulk-assign", "click", openAssignModal);
  on("bulk-dnc", "click", openBulkDncModal);
  on("bulk-delete", "click", openBulkDeleteModal);
  on("segment-back", "click", exitSegment);
  on("act-days", "change", loadStats);
  on("act-refresh", "click", loadStats);
  on("act-logs", "click", () => { actFull = !actFull; loadStats(); });
  on("import-btn", "click", openImportModal);
  on("job-search-btn", "click", openJobSearchConfirm);
  on("job-search-settings", "click", openJobSearchSettings);
  wireGlobalDrop();
  on("modal-backdrop", "click", (e) => {
    if (e.target === $("modal-backdrop")) closeModal();
  });
}

async function boot() {
  await discover();          // must succeed before we take the login screen away,
  $("login-screen").classList.add("hidden");   // or a no-access account gets an
  $("app").classList.remove("hidden");         // empty shell with no explanation
  $("user-avatar").textContent = initials(S.me.display_name || S.me.email);
  $("menu-name").textContent = S.me.display_name || S.me.email.split("@")[0];
  $("menu-email").textContent = S.me.email;
  renderStateOptions();
  /* Admin surfaces ship hidden in the markup and are revealed here, once the
     role is known — a member never sees them flash. This is presentation only:
     job-search, import, apify-usage, users and activity all check the role
     server-side and 403. */
  if (S.me.role === "admin") {
    document.querySelectorAll(".admin-only").forEach((el) =>
      el.classList.remove("hidden"));
    // Select stays where it was left, like density and sort. renderBulkTools()
    // paints the toggle when the first list renders.
    S.selectMode = !!localStorage.getItem("kl_select_mode");
    loadApifyUsage();       // admin surface — a member asking would just 403
  }
  await loadRecents();       // the Recent tab is served from this, so fetch it first
  const saved = localStorage.getItem("kl_sort");
  if (saved && SORTS.some((s) => s.key === saved)) S.sort = saved;
  const dl = S.deepLink || {};
  setTab(TABS[dl.tab] ? dl.tab : "companies");
  // only the three real lead tabs can open a record by id
  if (dl.open && TABS[dl.tab]?.kind && !TABS[dl.tab].segment) {
    select({ Id: +dl.open, _t: dl.tab });
  }
  refreshCounts();
  S.booted = true;             // from here on, a 401 means the session died
}

async function init() {
  const usp = new URLSearchParams(location.search);
  // a failed hosted-login bounce lands back here with the reason in the URL
  const authError = usp.get("authError");
  if (authError) {
    usp.delete("authError");
    history.replaceState(null, "",
      location.pathname + (usp.toString() ? "?" + usp.toString() : ""));
  }
  if (usp.get("theme") !== null) localStorage.setItem("kl_theme", usp.get("theme"));
  // compact is the default now; browsers that saved the old "cozy" default flip once
  if (!localStorage.getItem("kl_density_default2")) {
    localStorage.setItem("kl_density", "compact");
    localStorage.setItem("kl_density_default2", "1");
  }
  if (usp.get("density")) localStorage.setItem("kl_density", usp.get("density"));
  S.deepLink = { tab: usp.get("tab"), open: usp.get("open") };
  document.documentElement.dataset.theme = localStorage.getItem("kl_theme") || "";
  const savedSize = +localStorage.getItem("kl_page_size");
  if (PAGE_SIZES.includes(savedSize)) S.pageSize = savedSize;
  setDensity(localStorage.getItem("kl_density") || "compact");
  setDetailWidth(+localStorage.getItem("kl_detail_w") || 460);
  try { wire(); } catch (e) { console.error("[karma] wiring failed", e); }
  $("login-workos")?.addEventListener("click",
    () => { location.href = "/api/auth/login"; });
  let stored = authError;
  // always attempt boot: the WorkOS session lives in a cookie
  try { await boot(); return; } catch (ex) { stored = stored || ex.message; }
  $("login-screen").classList.remove("hidden");
  $("app").classList.add("hidden");
  if (stored && !/unauthorized|invalid|Not signed in/i.test(stored)) {
    const err = $("login-error");                 // say why, don't just bounce
    err.textContent = stored;
    err.classList.remove("hidden");
  }
}

init();
