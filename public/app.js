/* Karma Leads — email-style client over the NocoDB API */
"use strict";

const $ = (id) => document.getElementById(id);
const S = {
  token: localStorage.getItem("kl_token") || null,
  me: null,
  baseId: null,
  tables: {},          // key -> {id, title, cols: {title: colId}, linkCols: {title: colId}}
  tab: "companies",
  q: "",
  status: "",
  state: "",           // two-letter code, "" = everywhere
  sort: "recent",
  list: [],
  page: 1,             // 1-based
  pageSize: 50,
  total: 0,
  sel: null,           // {row, tkey}
  recents: [],         // [{t, id, at, kind}] newest first — see loadRecents()
  segment: null,       // {id, label} while browsing one Category × State bucket
};
const PAGE_SIZES = [25, 50, 100, 200];

const TABS = {
  companies: { title: "Companies", table: "Companies", pv: "Company", dateField: "Date Added" },
  people:    { title: "People",    table: "People",    pv: "Name",    dateField: "Date Added" },
  jobs:      { title: "Job board", table: "Job Board", pv: "Job Title", dateField: "Posted" },
  // "Recent" is an activity trail, not a date filter: the last 25 leads this
  // account actually touched, newest first. Starts empty for a new account.
  recent:    { title: "Recent activity", activity: true },
  favorites: { title: "Favorites", union: true },
  removed:   { title: "Removed",   union: true },
  // not in the sidebar: entered by clicking a segment tag in the reading pane.
  // Rows come from the Segments↔Companies link, so it reads Companies' columns.
  segment:   { title: "Segment", table: "Companies", pv: "Company",
               dateField: "Date Added", segment: true },
};
const UNION_KEYS = ["companies", "people", "jobs"];

const SRC_CHIP = {
  "Job board": "job", "Excel import": "excel", "Apollo export": "apollo",
  "Bitrix CRM": "bitrix", "Master DB": "master",
};
const STATUSES = ["New", "Contacted", "Responded", "Qualified", "Not interested"];

/* Sort options. "@date" and "@name" resolve per table (Date Added vs Posted,
   Company vs Name vs Job Title); the rest are real column titles, and an
   option is only offered when the table actually has that column. */
const SORTS = [
  { key: "recent", label: "Newest first", field: "@date", dir: "desc" },
  { key: "oldest", label: "Oldest first", field: "@date", dir: "asc" },
  { key: "name", label: "Name A–Z", field: "@name", dir: "asc" },
  { key: "name_z", label: "Name Z–A", field: "@name", dir: "desc" },
  { key: "size", label: "Biggest company", field: "Employees", dir: "desc" },
  { key: "size_asc", label: "Smallest company", field: "Employees", dir: "asc" },
  { key: "certs", label: "Most certifications", field: "Certs", dir: "desc" },
  { key: "revenue", label: "Highest revenue", field: "Revenue", dir: "desc" },
  { key: "state", label: "State A–Z", field: "State", dir: "asc" },
  { key: "city", label: "City A–Z", field: "City", dir: "asc" },
  { key: "status", label: "Status", field: "Status", dir: "asc" },
];
const sortDef = (key) => SORTS.find((s) => s.key === key) || SORTS[0];
function sortField(key, tkey) {
  const s = sortDef(key);
  if (s.field === "@date") return TABS[tkey].dateField;
  if (s.field === "@name") return TABS[tkey].pv;
  return s.field;
}
const sortUsable = (key, tkey) =>
  !!S.tables[tkey]?.cols?.[sortField(key, tkey)];

/* ---------------- api ---------------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(S.token ? { "xc-auth": S.token } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) { logout(); throw new Error("unauthorized"); }
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
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
async function login(email, password) {
  // Sign in with the real NocoDB account. There is no admin/admin shorthand
  // any more — it mapped to an account with no access to the base, so it
  // signed in fine and then showed an empty app.
  const r = await fetch("/api/v1/auth/user/signin", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: email.trim(), password }),
  });
  if (!r.ok) {
    const msg = (await r.json().catch(() => ({}))).msg || "Sign-in failed";
    throw new Error(email.includes("@") ? msg : `${msg} — sign in with your full email address`);
  }
  S.token = (await r.json()).token;
  localStorage.setItem("kl_token", S.token);
}
function logout() {
  localStorage.removeItem("kl_token");
  S.token = null;
  location.reload();
}

/* ---------------- meta discovery ---------------- */
async function discover() {
  S.me = await api("/api/v1/auth/user/me");
  const bases = (await api("/api/v2/meta/bases")).list || [];
  const base = bases.find((b) => b.title === "Karma Leads");
  // signing in is not the same as having access — say so instead of showing nothing
  if (!base) throw new Error(
    `${S.me.email} has no access to the Karma Leads base. Ask an admin to invite this account as an Editor.`);
  S.baseId = base.id;
  const tables = (await api(`/api/v2/meta/bases/${base.id}/tables`)).list || [];
  for (const [key, cfg] of Object.entries(TABS)) {
    if (!cfg.table) continue;
    const t = tables.find((x) => x.title === cfg.table);
    if (!t) throw new Error(`Table ${cfg.table} missing`);
    const meta = await api(`/api/v2/meta/tables/${t.id}`);
    const cols = {}, linkCols = {};
    for (const c of meta.columns) {
      cols[c.title] = c.id;
      if (c.uidt === "Links" || c.uidt === "LinkToAnotherRecord") linkCols[c.title] = c.id;
    }
    S.tables[key] = { id: t.id, title: t.title, cols, linkCols };
  }
  const bl = tables.find((x) => x.title === "Blocklist");
  if (bl) S.tables.blocklist = { id: bl.id };
  const seg = tables.find((x) => x.title === "Segments");
  if (seg) {
    const meta = await api(`/api/v2/meta/tables/${seg.id}`);
    const linkCols = {};
    for (const c of meta.columns)
      if (c.uidt === "Links" || c.uidt === "LinkToAnotherRecord") linkCols[c.title] = c.id;
    S.tables.segments = { id: seg.id, title: "Segments", linkCols };
  }
}

/* ---------------- counts + stats ---------------- */
async function count(tkey, where) {
  const t = S.tables[tkey];
  const qs = where ? `?where=${encodeURIComponent(where)}` : "";
  return (await api(`/api/v2/tables/${t.id}/records/count${qs}`)).count;
}
const LIVE = "(Removed,notchecked)";
const sum = (a) => a.reduce((x, y) => x + y, 0);
/* count across all three tables, excluding removed leads unless asked */
async function countAll(where) {
  const w = where ? `${where}~and${LIVE}` : LIVE;
  return sum(await Promise.all(UNION_KEYS.map((k) => count(k, w))));
}

/* count over only the tables that actually have the column — Job Board has an
   Email but no Phone, and asking for a missing column is a 400 */
async function countAllWith(col, where) {
  const keys = UNION_KEYS.filter((k) => S.tables[k]?.cols?.[col]);
  if (!keys.length) return 0;
  return sum(await Promise.all(keys.map((k) => count(k, `${where}~and${LIVE}`))));
}

/* 35,271 -> "35.3k"; small numbers stay exact. The tile carries the precise
   figure in its title attribute. */
function compact(n) {
  if (n < 10000) return n.toLocaleString();
  if (n < 1e6) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
}
const pct = (n, total) => total > 0 ? (n / total) * 100 : 0;

function setStat(id, value, vizHtml, note) {
  const v = $("stat-" + id);
  if (v) {
    v.textContent = compact(value);
    v.title = value.toLocaleString() + " leads";
  }
  const z = $("viz-" + id);
  if (z) z.innerHTML = (vizHtml || "") +
    (note ? `<div class="stat-note">${note}</div>` : "");
}

/* a ratio against the whole, as a meter + its own written-out label (the
   percentage is never carried by bar length alone) */
function meterStat(id, value, total, noun) {
  const p = pct(value, total);
  setStat(id, value,
    `<div class="meter${value ? "" : " is-empty"}"><span style="width:${p.toFixed(1)}%"></span></div>`,
    `<b>${p < 1 && p > 0 ? "<1" : Math.round(p)}%</b> of ${noun}`);
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
  const [nc, np, nj] = await Promise.all(UNION_KEYS.map((k) => count(k, LIVE)));
  const total = nc + np + nj;
  $("count-companies").textContent = nc.toLocaleString();
  $("count-people").textContent = np.toLocaleString();
  $("count-jobs").textContent = nj.toLocaleString();

  // everything below is independent — one round trip, not six in series
  // ("Recent" is the activity trail, not a date window: its badge comes from
  // S.recents via cacheRecents, so there is nothing to count for it here)
  const dateW = (tkey, days) =>
    `(${TABS[tkey].dateField},isWithin,pastNumberOfDays,${days})~and${LIVE}`;
  const spread = (w) => Promise.all(UNION_KEYS.map((k) => count(k, w(k)))).then(sum);
  const [wk, wk2, favorites, removed, newTotal, qualified, phone, email] =
    await Promise.all([
      spread((k) => dateW(k, 7)),
      spread((k) => dateW(k, 14)),
      countAll("(Favorite,checked)"),
      spread(() => "(Removed,checked)"),
      countAll("(Status,eq,New)"),
      countAll("(Status,eq,Qualified)"),
      countAllWith("Phone", "(Phone,notblank)"),
      countAllWith("Email", "(Email,notblank)"),
    ]);

  $("count-favorites").textContent = favorites.toLocaleString();
  $("count-removed").textContent = removed.toLocaleString();

  // total: what the base is made of, as one composition bar
  const seg = (n, hue, label) => n
    ? `<span style="width:${pct(n, total).toFixed(2)}%; background:var(--${hue})"
        title="${n.toLocaleString()} ${label}"></span>` : "";
  setStat("total", total,
    `<div class="compo">${seg(nc, "cat-1", "companies")}${seg(np, "cat-2", "people")}${seg(nj, "cat-3", "jobs")}</div>`,
    `<i class="dot" style="background:var(--cat-1)"></i>${compact(nc)}
     <i class="dot" style="background:var(--cat-2)"></i>${compact(np)}
     <i class="dot" style="background:var(--cat-3)"></i>${compact(nj)}`);

  meterStat("phone", phone, total, "leads");
  meterStat("email", email, total, "leads");
  meterStat("contacted", total - newTotal, total, "leads worked");
  meterStat("qualified", qualified, total, "leads");

  // new-this-week carries a delta against the 7 days before it, not a meter:
  // a week's intake as a share of 35k would be a permanently empty bar
  // a percentage off a near-zero prior week is noise ("↑8000%" for 1 -> 81),
  // so only show one when the baseline is big enough to mean anything
  const prev = Math.max(0, wk2 - wk);
  const change = prev >= 10 ? Math.round(((wk - prev) / prev) * 100) : null;
  setStat("week", wk, "",
    change !== null
      ? `<span class="delta${change > 0 ? " up" : ""}">${change > 0 ? "↑" : "↓"}
         ${Math.abs(change)}%</span> vs previous 7 days`
      : wk
        ? `prior 7 days: <b>${prev.toLocaleString()}</b>`
        : "nothing added in 7 days");
}

/* ---------------- recents (the leads this account touched) ----------------
   The trail is kept per account by the server (/app-api/recents) so it follows
   the person between browsers. localStorage is only a paint-first cache — and
   the fallback if the endpoint is down. */
const RECENT_CACHE = "kl_recents";
const RECENT_MAX = 25;                   // keep in step with MAX in recents.js

function cacheRecents() {
  try { localStorage.setItem(RECENT_CACHE, JSON.stringify(S.recents)); } catch { /* full/private */ }
  const el = $("count-recent");
  if (el) el.textContent = S.recents.length.toLocaleString();
}

async function loadRecents() {
  try {
    const cached = JSON.parse(localStorage.getItem(RECENT_CACHE) || "[]");
    if (Array.isArray(cached)) S.recents = cached;
  } catch { /* ignore a mangled cache */ }
  try {
    S.recents = (await api("/app-api/recents")).list || [];
    cacheRecents();
  } catch (e) {
    console.warn("[karma] recents unavailable, using the local cache", e);
    cacheRecents();
  }
}

/* Record an interaction. Fire-and-forget on purpose — nothing the user does
   should ever wait on the trail being written. */
function touchLead(item, kind) {
  if (!item || !UNION_KEYS.includes(item._t) || !item.Id) return;
  S.recents = [
    { t: item._t, id: item.Id, at: new Date().toISOString(), kind: kind || "open" },
    ...S.recents.filter((x) => !(x.t === item._t && x.id === item.Id)),
  ].slice(0, RECENT_MAX);
  cacheRecents();
  api("/app-api/recents", {
    method: "POST",
    body: JSON.stringify({ t: item._t, id: item.Id, kind: kind || "open" }),
  }).then((r) => {
    // the list is deliberately not re-rendered here: reshuffling rows under
    // the pointer while someone is reading a lead is worse than being stale
    if (r && r.list) { S.recents = r.list; cacheRecents(); }
  }).catch((e) => console.warn("[karma] could not save recent", e));
}

/* Look the recorded rows back up, one request per table (25 ids at most, so an
   ~or chain is short), then return them in interaction order. */
async function fetchRecentRows() {
  const byTable = {};
  for (const e of S.recents) (byTable[e.t] ||= []).push(e.id);
  const found = new Map();                       // "tkey:id" -> row
  await Promise.all(Object.entries(byTable).map(async ([tkey, ids]) => {
    const t = S.tables[tkey];
    if (!t) return;
    const where = ids.map((id) => `(Id,eq,${id})`).join("~or");
    const r = await api(`/api/v2/tables/${t.id}/records` +
      `?limit=${RECENT_MAX}&where=${encodeURIComponent(where)}`);
    for (const row of r.list || []) found.set(`${tkey}:${row.Id}`, { ...row, _t: tkey });
  }));
  const rows = [];
  for (const e of S.recents) {
    const row = found.get(`${e.t}:${e.id}`);
    // gone from the base, or banned since it was touched — don't resurface it
    if (!row || row.Removed) continue;
    rows.push({ ...row, _touchedAt: e.at });
  }
  return rows;
}

/* The trail is 25 rows and already in the right order, so its search, status
   and state filters run here instead of as a where clause. */
function matchesFilters(r) {
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

/* ---------------- list ---------------- */
function buildWhere(tkey) {
  const parts = [];
  if (S.q) {
    const q = S.q.replace(/[(),]/g, " ").trim();
    const fields = tkey === "companies" ? ["Company", "Email", "City"]
      : tkey === "people" ? ["Name", "Company", "Email"]
      : ["Job Title", "Company", "Contact"];
    parts.push("(" + fields.map((f) => `(${f},like,%${q}%)`).join("~or") + ")");
  }
  if (S.status) parts.push(`(Status,eq,${S.status})`);
  if (S.state) {
    // the sources disagree — "FL" in one file, "Florida" in the next — so match
    // both spellings. `like` (no wildcard) is exact but case-insensitive.
    const full = STATE_NAME[S.state];
    parts.push(`((State,like,${S.state})${full ? `~or(State,like,${full})` : ""})`);
  }
  if (S.tab === "favorites") parts.push(`(Favorite,checked)`);
  // banned numbers stay out of every view except Removed itself
  parts.push(S.tab === "removed" ? "(Removed,checked)" : "(Removed,notchecked)");
  return parts.join("~and");
}

async function fetchPage(tkey, limit, offset) {
  const t = S.tables[tkey];
  const key = sortUsable(S.sort, tkey) ? S.sort : "recent";
  const s = sortDef(key);
  const params = new URLSearchParams({
    limit, offset,
    sort: (s.dir === "desc" ? "-" : "") + sortField(key, tkey),
  });
  const w = buildWhere(tkey);
  if (w) params.set("where", w);
  const r = await api(`/api/v2/tables/${t.id}/records?${params}`);
  return { rows: (r.list || []).map((x) => ({ ...x, _t: tkey })), page: r.pageInfo || {} };
}

/* One segment's companies, straight off the Segments↔Companies link. The link
   endpoint honours `where`, `fields`, `limit` and `offset` — so search, state
   and status filters keep working here — but it silently ignores `sort`, which
   is why the sort control is disabled in this view rather than lying. */
/* unlike /records, the link endpoint projects down to Id + the primary value
   unless asked otherwise, which would strip every row of its city, certs and
   date. Ask for what renderList() draws, intersected with the columns this
   base actually has so a schema change can't 400 the whole view. */
const SEGMENT_FIELDS = ["Id", "Company", "Category", "City", "State", "Employees",
  "Revenue", "Certs", "Industry", "Email", "Phone", "Status", "Favorite",
  "Removed", "Source", "Date Added"];

async function fetchSegmentPage(limit, offset) {
  const segT = S.tables.segments;
  const lc = segT?.linkCols?.["Companies"];
  if (!lc) return { rows: [], page: {} };
  const params = new URLSearchParams({ limit, offset });
  const cols = S.tables.companies?.cols || {};
  const fields = SEGMENT_FIELDS.filter((f) => f === "Id" || cols[f]);
  params.set("fields", fields.join(","));
  const w = buildWhere("companies");
  if (w) params.set("where", w);
  const r = await api(
    `/api/v2/tables/${segT.id}/links/${lc}/records/${S.segment.id}?${params}`);
  return {
    rows: (r.list || []).map((x) => ({ ...x, _t: "companies" })),
    page: r.pageInfo || {},
  };
}

function openSegment(id, label) {
  S.segment = { id, label };
  S.tab = "segment";
  S.page = 1;
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

/* union tabs have no server-side merge: pull enough of each table to cover the
   requested page, merge-sort, then cut the window out of the middle */
const UNION_MAX = 1000;                     // NocoDB's per-request ceiling

/* re-apply the chosen sort across the three tables once they're merged.
   Rows with nothing in the sort column always sink to the bottom. */
function unionComparator(key) {
  const s = sortDef(key);
  const dir = s.dir === "desc" ? -1 : 1;
  const val = (r) => r[sortField(key, r._t)];
  return (a, b) => {
    const va = val(a), vb = val(b);
    const ea = va === null || va === undefined || va === "";
    const eb = vb === null || vb === undefined || vb === "";
    if (ea || eb) return ea && eb ? 0 : ea ? 1 : -1;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
    return String(va).localeCompare(String(vb)) * dir;
  };
}

async function loadList(resetPage = false) {
  if (resetPage) S.page = 1;
  const cfg = TABS[S.tab];
  $("list-title").textContent = cfg.segment
    ? (S.segment?.label || "Segment") : cfg.title;
  const start = (S.page - 1) * S.pageSize;

  if (cfg.segment) {
    if (!S.segment) return exitSegment();
    const { rows, page } = await fetchSegmentPage(S.pageSize, start);
    S.list = rows;
    S.total = page.totalRows ?? rows.length;
    const eb = $("seg-eyebrow");
    if (eb) eb.textContent =
      `Segment · ${S.total.toLocaleString()} compan${S.total === 1 ? "y" : "ies"}`;
  } else if (cfg.activity) {
    // 25 rows at most: pull them all, filter and page locally
    const live = await fetchRecentRows();
    // the badge normally counts the trail; now that we know how many of those
    // rows still exist, correct it (a lead removed after you touched it is
    // remembered but not shown)
    const badge = $("count-recent");
    if (badge) badge.textContent = live.length.toLocaleString();
    const rows = live.filter(matchesFilters);
    S.total = rows.length;
    S.list = rows.slice(start, start + S.pageSize);
  } else if (cfg.union) {
    const need = Math.min(start + S.pageSize, UNION_MAX);
    const [results, counts] = await Promise.all([
      Promise.all(UNION_KEYS.map((k) => fetchPage(k, need, 0))),
      Promise.all(UNION_KEYS.map((k) => count(k, buildWhere(k)))),
    ]);
    const rows = results.flatMap((r) => r.rows);
    rows.sort(unionComparator(S.sort));
    S.total = Math.min(sum(counts), UNION_MAX);
    S.list = rows.slice(start, start + S.pageSize);
  } else {
    const { rows, page } = await fetchPage(S.tab, S.pageSize, start);
    S.list = rows;
    S.total = page.totalRows ?? rows.length;
  }
  // the page can fall off the end when rows leave the view (unfavorited, removed)
  if (!S.list.length && S.page > pageCount()) {
    S.page = pageCount();
    return loadList();
  }
  renderList();
  renderPager();
}

function pageCount() {
  return Math.max(1, Math.ceil(S.total / S.pageSize));
}

function goToPage(n) {
  const p = Math.min(Math.max(1, n), pageCount());
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
  $("pager-next").disabled = $("pager-last").disabled = S.page >= pages;
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
  const reach = [];
  if (r.Email) reach.push('<span title="has email">✉</span>');
  if (r.Phone) reach.push('<span title="has phone">☎</span>');
  if (reach.length) out.push(`<span class="fact fact-reach">${reach.join("")}</span>`);
  return out.length ? `<div class="lead-facts">${out.join("")}</div>` : "";
}

function renderList() {
  const el = $("lead-list");
  el.innerHTML = S.list.map((r, i) => {
    const name = displayName(r, r._t);
    // jobs carry the company in the subtitle instead, so the title stays readable
    const co = r._t === "people" && r.Company && r.Company !== name
      ? ` <span class="co">· ${esc(r.Company)}</span>` : "";
    // in the activity trail the useful timestamp is when it was touched,
    // not when it was imported
    const date = r._touchedAt || r[TABS[r._t].dateField];
    const sel = S.sel && S.sel.row.Id === r.Id && S.sel.tkey === r._t ? " selected" : "";
    return `
    <div class="lead-row${sel}" data-i="${i}">
      <span class="avatar" style="background:${avColor(name)}">${esc(initials(name))}</span>
      <div class="lead-row-main">
        <div class="lead-name"><span class="status-dot ${statusDotCls(r.Status)}" title="${esc(r.Status || "New")}"></span>${esc(name)}${co}</div>
        ${rowSubtitle(r) ? `<div class="lead-sub">${esc(rowSubtitle(r))}</div>` : ""}
        ${factsHtml(r)}
        <div class="lead-meta">${sourceChip(r.Source || (r._t === "jobs" ? "Job board" : ""))}${statusChip(r.Status)}</div>
      </div>
      <div class="lead-side">
        <button class="fav-star${r.Favorite ? " on" : ""}" data-fav="${i}"
                title="${r.Favorite ? "Remove from favorites" : "Add to favorites"}">★</button>
        <span class="lead-date">${relTime(date)}</span>
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
    const t = S.tables[item._t];
    const row = await api(`/api/v2/tables/${t.id}/records/${item.Id}`);
    row._t = item._t;
    S.sel = { row, tkey: item._t };
    renderDetail(row);
    touchLead(row, "open");     // only once the lead really loaded
    loadComments(row);
    loadRelated(row);
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
      <span class="avatar" style="width:44px;height:44px;font-size:16px;background:${avColor(name)}">${esc(initials(name))}</span>
      <div class="detail-headings">
        <div class="detail-name">${esc(name)}</div>
        <div class="detail-co">${esc(sub)}</div>
        <div class="lead-meta" style="margin-top:8px">${sourceChip(r.Source || (tkey === "jobs" ? "Job board" : ""))}</div>
      </div>
      <div class="detail-actions">
        <select class="status-select" id="d-status">${opts}</select>
        <button class="fav-btn" id="d-fav" title="Favorite">
          <span class="fav-star${r.Favorite ? " on" : ""}" style="font-size:20px">★</span>
        </button>
        <button class="fav-btn" id="d-remove"
                title="${r.Removed ? "Restore this lead" : "Remove — banned from calling"}">${r.Removed ? "↩" : "🚫"}</button>
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
      ${dgItem("Added", esc(r[dateField] || ""))}
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

    <div class="detail-section" id="related-section"></div>`;

  $("d-status").addEventListener("change", async (e) => {
    await patchRow(tkey, r.Id, { Status: e.target.value });
    r.Status = e.target.value;
    const li = S.list.find((x) => x.Id === r.Id && x._t === tkey);
    if (li) li.Status = r.Status;
    touchLead(r, "status");
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
  $("d-owner").addEventListener("change", async (e) => {
    await patchRow(tkey, r.Id, { Owner: e.target.value || null });
    r.Owner = e.target.value;
    touchLead(r, "owner");
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
    await patchRow(item._t, item.Id, { Favorite: next });
    touchLead(item, next ? "favorite" : "unfavorite");
    if (S.tab === "favorites") loadList();
    refreshCounts();
  } catch (e) {
    item.Favorite = !next;                       // put it back if the save failed
    renderList();
  }
}

/* ban a number: removes this lead and every lead sharing its phone */
async function removeLead(r, reason) {
  const key = r["Phone Key"];
  let affected = 0;
  if (key) {
    const bl = S.tables.blocklist;
    if (bl) {
      await api(`/api/v2/tables/${bl.id}/records`, {
        method: "POST",
        body: JSON.stringify([{
          "Phone": r.Phone || "", "Phone Key": key,
          "Company": r.Company || displayName(r, r._t),
          "Reason": reason || "", "Added By": S.me?.email || "",
          "Date Added": new Date().toISOString().slice(0, 10),
        }]),
      });
    }
    for (const k of UNION_KEYS) {                // sweep all three tables
      const t = S.tables[k];
      const res = await api(
        `/api/v2/tables/${t.id}/records?limit=500&where=` +
        encodeURIComponent(`(Phone Key,eq,${key})~and(Removed,notchecked)`));
      const rows = res.list || [];
      for (let i = 0; i < rows.length; i += 100) {
        await api(`/api/v2/tables/${t.id}/records`, {
          method: "PATCH",
          body: JSON.stringify(rows.slice(i, i + 100)
            .map((x) => ({ Id: x.Id, Removed: true }))),
        });
      }
      affected += rows.length;
    }
  }
  if (!affected) {                               // no phone on file: just this one
    await patchRow(r._t, r.Id, { Removed: true });
    affected = 1;
  }
  return affected;
}

async function restoreLead(r) {
  const key = r["Phone Key"];
  await patchRow(r._t, r.Id, { Removed: false });
  if (key && S.tables.blocklist) {
    const bl = S.tables.blocklist;
    const res = await api(`/api/v2/tables/${bl.id}/records?limit=100&where=` +
      encodeURIComponent(`(Phone Key,eq,${key})`));
    for (const b of res.list || [])
      await api(`/api/v2/tables/${bl.id}/records`,
        { method: "DELETE", body: JSON.stringify([{ Id: b.Id }]) });
  }
}

async function patchRow(tkey, id, fields) {
  const t = S.tables[tkey];
  await api(`/api/v2/tables/${t.id}/records`, {
    method: "PATCH", body: JSON.stringify([{ Id: id, ...fields }]),
  });
}

/* ---------------- related ----------------
   People get an initials avatar — that reads as a person. Companies and job
   postings don't: an initials circle beside a company name looks like a logo
   we don't have, so those rows are plain text. */
function relatedRow(name, sub, onclickIdx, avatar = true) {
  return `
  <div class="related-row${avatar ? "" : " no-avatar"}" data-rel="${onclickIdx}">
    ${avatar
      ? `<span class="avatar avatar-sm" style="background:${avColor(name)}">${esc(initials(name))}</span>`
      : ""}
    <div class="related-main">
      <div class="related-name">${esc(name)}</div>
      ${sub ? `<div class="related-sub">${esc(sub)}</div>` : ""}
    </div>
  </div>`;
}

async function loadRelated(r) {
  const el = $("related-section");
  if (!el) return;
  const tkey = r._t;
  const actions = [];   // parallel to data-rel indices
  let html = "";
  try {
    if (tkey === "companies") {
      const t = S.tables.companies;
      if (r["People here"] > 0) {
        const lc = t.linkCols["People here"];
        const linked = await api(`/api/v2/tables/${t.id}/links/${lc}/records/${r.Id}?limit=6`);
        html += `<h4>People at ${esc(r.Company)}</h4>`;
        for (const p of linked.list || []) {
          html += relatedRow(p.Name || "?", "", actions.length);
          actions.push(() => select({ Id: p.Id, _t: "people" }));
        }
      }
      if (r["Job postings"] > 0) {
        const lc = t.linkCols["Job postings"];
        const linked = await api(`/api/v2/tables/${t.id}/links/${lc}/records/${r.Id}?limit=4`);
        html += `<h4 style="margin-top:14px">Open jobs</h4>`;
        for (const j of linked.list || []) {
          html += relatedRow(j["Job Title"] || "?", "", actions.length, false);
          actions.push(() => select({ Id: j.Id, _t: "jobs" }));
        }
      }
      const segRef = r["Similar companies"];
      if (segRef && segRef.Id && S.tables.segments) {
        const segT = S.tables.segments;
        const lc = segT.linkCols["Companies"];
        // ask for the location too: with the avatar gone these rows need
        // something to tell two identically-named restoration firms apart
        const linked = await api(`/api/v2/tables/${segT.id}/links/${lc}/records/${segRef.Id}` +
          `?limit=7&fields=${encodeURIComponent("Id,Company,City,State")}`);
        const others = (linked.list || []).filter((x) => x.Id !== r.Id).slice(0, 6);
        const total = (linked.pageInfo?.totalRows || others.length + 1) - 1;
        if (others.length) {
          const label = fullSegmentLabel(segRef.Segment) || "this segment";
          // the segment name is the way into the full list — a preview of six
          // out of a few hundred is a teaser, not an answer
          html += `<h4 style="margin-top:14px">Similar companies
            <button class="seg-tag" data-seg="${segRef.Id}"
              data-seg-label="${esc(label)}"
              title="Browse all ${total.toLocaleString()} companies in ${esc(label)}"
              >${esc(label)}</button>
            <span class="seg-count">${total.toLocaleString()}</span></h4>`;
          for (const c of others) {
            html += relatedRow(c.Company || "?", locationLabel(c), actions.length, false);
            actions.push(() => select({ Id: c.Id, _t: "companies" }));
          }
          html += `<button class="seg-all" data-seg="${segRef.Id}"
            data-seg-label="${esc(label)}">See all ${total.toLocaleString()} in ${esc(label)} →</button>`;
        }
      }
    } else {
      const ref = r["Company record"];
      if (ref && ref.Id) {
        html += `<h4>Company</h4>`;
        html += relatedRow(ref.Company || "?", "View company record →", actions.length, false);
        actions.push(() => select({ Id: ref.Id, _t: "companies" }));
        // colleagues
        const t = S.tables.companies;
        const lc = t.linkCols["People here"];
        if (lc && tkey === "people") {
          const linked = await api(`/api/v2/tables/${t.id}/links/${lc}/records/${ref.Id}?limit=6`);
          const others = (linked.list || []).filter((x) => x.Id !== r.Id);
          if (others.length) {
            html += `<h4 style="margin-top:14px">Also at ${esc(ref.Company)}</h4>`;
            for (const p of others) {
              html += relatedRow(p.Name || "?", "", actions.length);
              actions.push(() => select({ Id: p.Id, _t: "people" }));
            }
          }
        }
      }
    }
  } catch (e) { /* related info is best-effort */ }
  el.innerHTML = html;
  el.querySelectorAll(".related-row").forEach((row) =>
    row.addEventListener("click", () => actions[+row.dataset.rel]()));
  el.querySelectorAll("[data-seg]").forEach((b) =>
    b.addEventListener("click", () => openSegment(+b.dataset.seg, b.dataset.segLabel)));
}

/* ---------------- comments ---------------- */
async function loadComments(r) {
  const el = $("comments");
  if (!el) return;
  try {
    const t = S.tables[r._t];
    const res = await api(`/api/v2/meta/comments?row_id=${r.Id}&fk_model_id=${t.id}`);
    const list = res.list || [];
    if (!list.length) {
      el.innerHTML = `<p style="color:var(--ink-3);font-size:13px">No notes yet — be the first.</p>`;
      return;
    }
    el.innerHTML = list.map((c) => {
      const who = c.created_display_name || c.created_by_email || c.created_by || "someone";
      const text = c.comment || "";
      return `
      <div class="comment">
        <span class="avatar avatar-sm" style="background:${avColor(who)}">${esc(initials(who))}</span>
        <div class="comment-body">
          <div class="comment-head"><b>${esc(who)}</b> · ${esc(relTime(c.created_at))}</div>
          <div class="comment-text">${esc(text)}</div>
        </div>
      </div>`;
    }).join("");
  } catch (e) {
    el.innerHTML = `<p style="color:var(--ink-3);font-size:13px">Notes unavailable</p>`;
  }
}

async function sendNote(r) {
  const input = $("note-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  const t = S.tables[r._t];
  await api("/api/v2/meta/comments", {
    method: "POST",
    body: JSON.stringify({ row_id: String(r.Id), fk_model_id: t.id, comment: text }),
  });
  touchLead(r, "note");
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
    const res = await fetch("/app-api/import", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "xc-auth": S.token,
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
  const line = (label, n) => n
    ? `<div class="ir-row"><span>${label}</span><strong>${n.toLocaleString()}</strong></div>` : "";
  $("modal-body").innerHTML = `
    <div class="import-done">
      <div class="dz-art">${o.total ? "✅" : "🤔"}</div>
      <p><strong>${o.total.toLocaleString()} lead${o.total === 1 ? "" : "s"} added</strong>
         from ${esc(o.file)}</p>
      <p class="dz-sub">${o.rows.toLocaleString()} rows read · detected as a ${esc(o.detected)}</p>
    </div>
    <div class="import-report">
      ${line("Companies", o.inserted.companies)}
      ${line("People", o.inserted.people)}
      ${line("Job board", o.inserted.jobs)}
      ${line("Skipped — already in the base", o.duplicates)}
      ${line("Added but hidden — blocked number", o.blocked)}
    </div>
    ${o.partialDedupe ? `<p class="dz-sub">⚠️ The base was too large to scan in full, so a few of these may duplicate existing leads.</p>` : ""}
    ${o.unmapped?.length ? `<p class="dz-sub">Columns ignored: ${esc(o.unmapped.slice(0, 12).join(", "))}${o.unmapped.length > 12 ? "…" : ""}</p>` : ""}
    <div class="modal-actions">
      <button type="button" class="btn-secondary" id="import-again">Import another</button>
      <button type="button" class="btn-primary" id="modal-cancel">Done</button>
    </div>`;
  $("modal-cancel").addEventListener("click", closeModal);
  $("import-again").addEventListener("click", openImportModal);
  if (o.total) toast(`Imported ${o.total.toLocaleString()} leads from ${o.file}`);
}

/* dropping a file anywhere in the app opens the importer */
function wireGlobalDrop() {
  const hasFile = (e) => Array.from(e.dataTransfer?.types || []).includes("Files");
  window.addEventListener("dragover", (e) => {
    if (!hasFile(e)) return;
    e.preventDefault();
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
    const f = e.dataTransfer.files[0];
    if (f && $("dropzone")) runImport(f);
  });
}

function closeModal() {
  $("modal-backdrop").classList.add("hidden");
  document.querySelector(".modal")?.classList.remove("wide");
}

/* ---------------- LinkedIn job search (Apify) ----------------
   The 🔎 button runs a search with the saved settings (confirm step first,
   with a hard max-cost figure); the ⚙ gear edits them. Settings live in
   localStorage — they're personal defaults, not shared state. The Apify
   token never reaches the browser: everything goes through /app-api. */
const JS_LS = "kl_jobsearch";
const JS_RATES_FALLBACK = { perResultUsd: 0.005, recruiterPerResultUsd: 0.015,
  limitMin: 10, limitMax: 500, limitDefault: 100 };
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

const jsRates = () => APIFY_USAGE?.rates || JS_RATES_FALLBACK;
/* results are billed per job actually returned, so limit × rate is a ceiling */
const jsMaxCost = (s) => (+s.limit || jsRates().limitDefault) *
  (s.recruiterOnly ? jsRates().recruiterPerResultUsd : jsRates().perResultUsd);
const usd = (n) => n == null ? "—"
  : "$" + (+n >= 0.1 || +n === 0 ? (+n).toFixed(2) : (+n).toFixed(3));
const splitCommas = (s) => String(s || "").split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
const splitLines = (s) => String(s || "").split(/[\n;]/).map((x) => x.trim()).filter(Boolean);

function jsSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(JS_LS)) || {}; } catch (e) { /* fresh */ }
  // ?? not || — a deliberately emptied-and-saved field must stay empty
  return {
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

async function loadApifyUsage() {
  try { APIFY_USAGE = await api("/app-api/apify-usage"); }
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
    <form id="js-form">
      <label>Job titles — comma-separated, blank = any
        <input id="js-titles" value="${esc(s.titles)}"
               placeholder="Insurance Adjuster, Claims Adjuster">
      </label>
      <label>Locations — one per line, written as “City, State, Country”
        <textarea id="js-locations" rows="2"
          placeholder="Miami, Florida, United States">${esc(s.locations)}</textarea>
      </label>
      <div class="js-two">
        <label>Posted within
          <select id="js-time">${JS_TIME_RANGES.map(([v, l]) =>
            `<option value="${v}"${v === s.timeRange ? " selected" : ""}>${l}</option>`).join("")}
          </select>
        </label>
        <label>Max results (${jsRates().limitMin}–${jsRates().limitMax})
          <input id="js-limit" type="number" min="${jsRates().limitMin}"
                 max="${jsRates().limitMax}" value="${s.limit}">
        </label>
      </div>
      <details class="js-adv"${advancedUsed ? " open" : ""}>
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
    const rate = c.recruiterOnly ? jsRates().recruiterPerResultUsd : jsRates().perResultUsd;
    const per1k = "$" + (rate * 1000).toFixed(2) + " per 1,000";
    $("js-estimate").innerHTML = `Maximum cost: <strong>${usd(jsMaxCost(c))}</strong>
      for up to ${c.limit} jobs${c.recruiterOnly
        ? ` <span class="js-price-warn">recruiter rate — ${per1k}</span>`
        : ` · ${per1k}`}`;
  };
  estimate();
  $("js-form").addEventListener("input", estimate);
  $("modal-cancel").addEventListener("click", closeModal);
  $("js-reset").addEventListener("click", () => {
    localStorage.removeItem(JS_LS);
    toast("Search settings reset to defaults");
    openJobSearchSettings();
  });
  $("js-save").addEventListener("click", () => {
    saveJsSettings(collect());
    toast("Job search settings saved");
    closeModal();
  });
  $("js-form").onsubmit = (e) => {
    e.preventDefault();
    saveJsSettings(collect());
    openJobSearchConfirm();
  };
}

/* ---- confirm (the 🔎 button) — nothing is spent without passing this */
function openJobSearchConfirm() {
  const s = jsSettings();
  if (!s.saved) { openJobSearchSettings(); return; }
  const titles = splitCommas(s.titles), locations = splitLines(s.locations);
  const keywords = splitCommas(s.description);
  const timeLabel = (JS_TIME_RANGES.find(([v]) => v === s.timeRange) || [, "?"])[1];
  const max = jsMaxCost(s);
  // 18 default titles would swallow the popup — show a few and count the rest
  const brief = (arr, n) => arr.length > n
    ? `${arr.slice(0, n).join(", ")} +${arr.length - n} more` : arr.join(", ");
  const row = (label, val) => val
    ? `<div class="ir-row"><span>${label}</span><strong>${esc(val)}</strong></div>` : "";
  $("modal-title").textContent = "Search LinkedIn jobs?";
  $("modal-body").innerHTML = `
    <div class="import-report">
      ${row("Job titles", brief(titles, 3) || "Any")}
      ${row("Locations", brief(locations, 2) || "Anywhere")}
      ${row("Company keywords", brief(keywords, 3))}
      ${row("Posted within", timeLabel)}
      ${s.maxEmployees ? row("Company size", `≤ ${s.maxEmployees} employees`) : ""}
      ${row("Max results", String(s.limit))}
      ${s.recruiterOnly ? row("Recruiter contacts", "On — higher rate") : ""}
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
  $("js-go").addEventListener("click", runJobSearch);
}

async function runJobSearch() {
  const s = jsSettings();
  $("modal-title").textContent = "Searching LinkedIn";
  $("modal-body").innerHTML = `
    <div class="import-busy">
      <div class="spinner"></div>
      <div><strong>Searching LinkedIn jobs…</strong></div>
      <div class="dz-sub">Usually 10–60 seconds. New jobs land in the Job board tab.</div>
    </div>`;
  $("modal-backdrop").classList.remove("hidden");
  try {
    const out = await api("/app-api/job-search", {
      method: "POST",
      body: JSON.stringify({
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
      <div class="ir-row"><span>Actual cost charged</span><strong>${cost}</strong></div>
    </div>
    ${o.partialDedupe ? `<p class="dz-sub">⚠️ The Job board was too large to scan
      in full, so a few of these may duplicate existing rows.</p>` : ""}
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
    const counts = await Promise.all(UNION_KEYS.map((k) =>
      count(k, `(Phone Key,eq,${key})~and(Removed,notchecked)`)));
    n = counts.reduce((a, b) => a + b, 0) || 1;
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
      const removed = await removeLead(r, reason);
      closeModal();
      toast(`Removed ${removed} lead${removed === 1 ? "" : "s"}${key ? ` · ${phone} banned` : ""}`);
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

let toastTimer;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3500);
}

/* ---------------- boot + events ---------------- */
function setTab(tab) {
  S.tab = tab;
  S.segment = null;                     // any sidebar tab leaves segment browsing
  $("segment-back")?.classList.add("hidden");
  $("seg-eyebrow")?.classList.add("hidden");
  $("list-head")?.classList.remove("in-segment");
  document.querySelectorAll(".nav-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === tab));
  $("clear-recents")?.classList.toggle("hidden", !TABS[tab].activity);
  renderSortOptions();
  loadList(true);
}

/* only offer sorts the current tab can actually do — no "certifications" on
   People, no "revenue" on the job board */
function renderSortOptions() {
  const sel = $("sort-by");
  if (!sel) return;
  if (TABS[S.tab].activity) {
    // the trail has exactly one meaningful order; leave S.sort alone so the
    // last real choice is still there when the user goes back to a lead tab
    sel.innerHTML = `<option value="">Last interacted</option>`;
    sel.disabled = true;
    return;
  }
  if (TABS[S.tab].segment) {
    // NocoDB ignores `sort` on the links endpoint, so offering the control
    // here would be a button that does nothing. S.sort is left untouched.
    sel.innerHTML = `<option value="">Segment order</option>`;
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  const keys = TABS[S.tab].union ? UNION_KEYS : [S.tab];
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
  on("clear-recents", "click", async () => {
    // only forgets the trail — the leads themselves are untouched
    S.recents = [];
    cacheRecents();
    loadList(true);
    try { await api("/app-api/recents", { method: "DELETE" }); }
    catch (e) { console.warn("[karma] could not clear recents", e); }
    toast("Recent activity cleared");
  });
  on("segment-back", "click", exitSegment);
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
  loadApifyUsage();          // fire-and-forget: fills the credits line when it lands
  await loadRecents();       // the Recent tab is served from this, so fetch it first
  const saved = localStorage.getItem("kl_sort");
  if (saved && SORTS.some((s) => s.key === saved)) S.sort = saved;
  const dl = S.deepLink || {};
  setTab(TABS[dl.tab] ? dl.tab : "companies");
  // only the three real lead tabs can open a record by id
  if (dl.open && TABS[dl.tab]?.table) {
    select({ Id: +dl.open, _t: dl.tab });
  }
  refreshCounts();
}

async function init() {
  const usp = new URLSearchParams(location.search);
  if (usp.get("token")) {
    S.token = usp.get("token");
    localStorage.setItem("kl_token", S.token);
    usp.delete("token");
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
  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("login-error");
    err.classList.add("hidden");
    try {
      await login($("login-email").value, $("login-password").value);
      await boot();
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove("hidden");
    }
  });
  let stored = null;
  if (S.token) {
    try { await boot(); return; } catch (ex) { stored = ex.message; }
  }
  $("login-screen").classList.remove("hidden");
  $("app").classList.add("hidden");
  if (stored && !/unauthorized|invalid/i.test(stored)) {   // say why, don't just bounce
    const err = $("login-error");
    err.textContent = stored;
    err.classList.remove("hidden");
  }
}

init();
