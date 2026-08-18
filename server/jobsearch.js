"use strict";
/* Job search via Apify actors — the port of job-search.js onto Postgres.
   The Apify half (token handling, input whitelist, live rates, cost math) is
   carried over unchanged; the storage half is now one INSERT.

   Three boards, one endpoint: the client picks a scraper key ("linkedin",
   "indeed" or "google") and everything else — input shape, rates, item
   mapping — is resolved from the SCRAPERS registry below. Unknown keys fall
   back to LinkedIn, so old clients keep working.

   Indeed is one run per *query*, not per title: the actor's `title` field is
   handed straight to Indeed's q, so one string can carry a whole boolean
   search. The client sends a short list of them and they run concurrently
   into one merged, deduped result set — see buildIndeedInputs().

   Admin-only at the route level in index.js: this endpoint spends the org's
   Apify balance per result, which is the one thing a base user must not be
   able to trigger. The whitelist rebuild below is the second lock — a crafted
   request can't raise the spend cap even with an admin session. */

const fs = require("fs");
const path = require("path");
const express = require("express");
const { query } = require("./db");
const { requireAdmin } = require("./auth");
const activity = require("./activity");
const counts = require("./counts");
const { mintCode, isoDate, aliases, clean, cleanPlace } = require("./dedupe");
const { fillPhone } = require("./enrich");

const router = express.Router();
// path-scoped: routers share "/"
router.use(["/api/job-search", "/api/apify-usage"], requireAdmin);

const APIFY = "https://api.apify.com/v2";

const SCRAPERS = {
  linkedin: {
    actor: "fantastic-jobs~advanced-linkedin-job-search-api",
    label: "LinkedIn",
    sourceFile: "LinkedIn search",
  },
  indeed: {
    actor: "valig~indeed-jobs-scraper",
    label: "Indeed",
    sourceFile: "Indeed search",
    /* the actor's own default is 128 MB, which truncates or dies on a broad
       nationwide pull. 1 GB is the sweet spot: the start event is charged one
       per GB, so 2 GB would double that fee for no measured gain. */
    memoryMbytes: 1024,
  },
  google: {
    actor: "johnvc~google-jobs-scraper",
    label: "Google Jobs",
    sourceFile: "Google Jobs search",
  },
};
const scraperKey = (v) => (SCRAPERS[v] ? v : "linkedin");

/* fallback rates, used only when the live lookup fails. limitMax is our spend
   ceiling — on Indeed it happens to be the actor's own too (its schema caps
   `limit` at 1000). startUsd is the per-run start event: negligible alone, but
   Indeed pays it once per batched query.

   Google is the odd one out: it is billed per PAGE of search results fetched
   (~10 jobs a page), not per job, and a page half full of results costs the
   same as a full one. perResultUsd is that page price spread over a full page
   so the shared "limit x rate" ceiling still holds — pagePriceUsd/resultsPerPage
   are what the real arithmetic uses. */
const RATES = {
  linkedin: {
    perResultUsd: 0.005,
    recruiterPerResultUsd: 0.015,
    startUsd: 0,
    limitMin: 10,
    limitMax: 500,
    limitDefault: 100,
  },
  indeed: {
    perResultUsd: 0.0001,           // $0.10 / 1,000 job listings
    startUsd: 0.001,                // one Actor Start event per GB of memory
    limitMin: 10,
    limitMax: 1000,
    limitDefault: 250,
  },
  google: {
    pagePriceUsd: 0.11,             // $0.11 / page on our paid plan, $0.15 free
    resultsPerPage: 10,
    perResultUsd: 0.011,
    limitMin: 10,
    limitMax: 500,
    limitDefault: 100,
  },
};

/* an actor charge event's price: flat when the actor prices it flatly, else the
   row for our Apify plan tier. Both boards that came after LinkedIn price per
   tier — Google's page fee ($0.15 free, $0.11 on ours) carries no flat price
   at all, so reading only eventPriceUsd would quote a $5 search at nothing,
   and valig~indeed-jobs-scraper uses the same tiered shape. */
function eventPrice(ev, tier) {
  if (!ev) return null;
  if (typeof ev.eventPriceUsd === "number") return ev.eventPriceUsd;
  const row = ev.eventTieredPricingUsd?.[tier] || ev.eventTieredPricingUsd?.FREE;
  return typeof row?.tieredEventPriceUsd === "number" ? row.tieredEventPriceUsd : null;
}

let tierCache = { tier: null, at: 0 };
async function accountTier() {
  if (tierCache.tier && Date.now() - tierCache.at < 6 * 3600e3) return tierCache.tier;
  // FREE is the dearest tier — quoting it when the lookup fails never under-quotes
  const me = await apify("/users/me").catch(() => null);
  tierCache = { tier: me?.data?.plan?.tier || "FREE", at: Date.now() };
  return tierCache.tier;
}

const ratesCache = {};               // scraper key -> { rates, at }
async function actorRates(key) {
  const hit = ratesCache[key];
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.rates;
  const [a, tier] = await Promise.all([
    apify(`/acts/${SCRAPERS[key].actor}`),
    accountTier(),
  ]);
  const infos = a?.data?.pricingInfos || [];
  const ev = infos[infos.length - 1]?.pricingPerEvent?.actorChargeEvents || {};
  const rates = { ...RATES[key] };
  if (key === "google") {
    /* the dataset-item event exists here too, at $0.00001 — three orders of
       magnitude under the real price. Price the page, not the row. */
    const page = eventPrice(ev.page_processed, tier);
    const item = eventPrice(ev["apify-default-dataset-item"], tier) || 0;
    if (typeof page === "number") {
      rates.pagePriceUsd = page;
      rates.perResultUsd = page / rates.resultsPerPage + item;
    }
    ratesCache[key] = { rates, at: Date.now() };
    return rates;
  }
  /* each actor names its per-result event differently — take the standard
     dataset-item event when present, else the first priced event */
  const per = eventPrice(ev["apify-default-dataset-item"], tier)
    ?? Object.values(ev).map((e) => eventPrice(e, tier))
      .find((v) => typeof v === "number");
  if (typeof per === "number") rates.perResultUsd = per;
  const start = eventPrice(ev["apify-actor-start"], tier);
  if (typeof start === "number")
    rates.startUsd = start * Math.max(1, (SCRAPERS[key].memoryMbytes || 0) / 1024);
  if (key === "linkedin") {
    const rec = eventPrice(ev["recruiter-url-filtered-result"], tier);
    rates.recruiterPerResultUsd = typeof per === "number" && typeof rec === "number"
      ? per + rec : RATES.linkedin.recruiterPerResultUsd;
  }
  ratesCache[key] = { rates, at: Date.now() };
  return rates;
}

/* pages are the billed unit on Google, and a search for 55 jobs still pays for
   six whole pages — round the ask up so the quote can never come in under */
const googlePages = (limit) => {
  const n = Number.isFinite(+limit) ? Math.max(0, +limit) : RATES.google.limitDefault;
  // a search that finds nothing still pays for the one page inquiry it made
  return Math.max(1, Math.ceil(n / RATES.google.resultsPerPage));
};

function apifyToken() {
  const env = (process.env.APIFY_TOKEN || "").trim();
  if (env) return env;
  const p = path.join(__dirname, "..", "apify_token.json");
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8").replace(/^﻿/, "");
  } catch {
    // on a hosted box there is no token file — say what to actually do
    throw new Error("Apify token not configured — set the APIFY_TOKEN "
      + "environment variable (or apify_token.json beside the repo in dev)");
  }
  const t = JSON.parse(raw).token;
  if (!t) throw new Error("apify_token.json has no \"token\" field");
  return t;
}

async function apify(pathname, opts = {}) {
  const res = await fetch(APIFY + pathname, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apifyToken(),
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`Apify ${pathname.split("?")[0]} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/* ---------------- input whitelists */
const TIME_RANGES = ["1h", "24h", "7d", "6m"];
const SENIORITIES = ["Internship", "Entry level", "Associate",
  "Mid-Senior level", "Director", "Executive"];
const ARRANGEMENTS = ["On-site", "Hybrid", "Remote OK", "Remote Solely"];
const EMPLOYMENT = ["FULL_TIME", "PART_TIME", "CONTRACTOR", "TEMPORARY", "INTERN"];

/* Indeed side, straight off the actor's input schema. DATE_POSTED is a count
   of days as a string; "" means any time. COUNTRIES is the actor's own enum —
   it rejects anything else, so this is a whitelist, not decoration. */
const DATE_POSTED = ["", "1", "3", "7", "14"];
const COUNTRIES = ["ar", "au", "at", "bh", "be", "br", "ca", "cl", "cn", "co",
  "cr", "cz", "dk", "ec", "eg", "fi", "fr", "de", "gr", "hk", "hu", "in", "id",
  "ie", "il", "it", "jp", "kw", "lu", "my", "mx", "ma", "nl", "nz", "ng", "no",
  "om", "pk", "pa", "pe", "ph", "pl", "pt", "qa", "ro", "sa", "sg", "za", "kr",
  "es", "se", "ch", "tw", "th", "tr", "ua", "ae", "uk", "us", "uy", "ve", "vn"];
/* each query is its own actor run, its own start fee and its own `limit`, so
   this cap is a spend guard: the confirm step quotes queries × limit × rate */
const MAX_QUERIES = 5;
const MAX_QUERY_CHARS = 500;

const strList = (v, max = 15) => (Array.isArray(v) ? v : [])
  .map((s) => String(s).trim()).filter(Boolean).slice(0, max);
const pickAllowed = (v, allowed) => strList(v).filter((s) => allowed.includes(s));
const clampLimit = (v, r) =>
  Math.min(Math.max(Math.round(+v) || r.limitDefault, r.limitMin), r.limitMax);

function buildLinkedinInput(p = {}) {
  const input = {
    limit: clampLimit(p.limit, RATES.linkedin),
    timeRange: TIME_RANGES.includes(p.timeRange) ? p.timeRange : "7d",
    descriptionType: "text",
  };
  const titles = strList(p.titleSearch, 40);
  if (titles.length) input.titleSearch = titles;
  const locations = strList(p.locationSearch);
  if (locations.length) input.locationSearch = locations;
  const desc = strList(p.descriptionSearch, 40);
  if (desc.length && input.timeRange !== "6m") input.descriptionSearch = desc;
  const maxEmp = Math.round(+p.organizationEmployeesLte);
  if (maxEmp > 0) input.organizationEmployeesLte = maxEmp;
  const seniority = pickAllowed(p.seniorityFilter, SENIORITIES);
  if (seniority.length) input.seniorityFilter = seniority;
  const arrangement = pickAllowed(p.aiWorkArrangementFilter, ARRANGEMENTS);
  if (arrangement.length) input.aiWorkArrangementFilter = arrangement;
  const employment = pickAllowed(p.aiEmploymentTypeFilter, EMPLOYMENT);
  if (employment.length) input.aiEmploymentTypeFilter = employment;
  if (p.hasSalary === true) input.hasSalary = true;
  if (p.removeAgency === true) input.removeAgency = true;
  if (p.recruiterOnly === true) input.recruiterOnly = true;
  return input;
}

/* valig~indeed-jobs-scraper takes ONE free-text search per run and passes it
   to Indeed's own q parameter — verified against the live actor, quotes and
   all. That means a query is a whole Indeed search, not a job title: boolean
   operators (AND / OR / NOT), parentheses, and the title:/company: operators
   all work, so seventeen job titles are three runs, not seventeen.

   Hence a list of queries, each becoming its own run, merged and deduped on
   the posting URL downstream. Everything else on the actor is one flat field:
   country (its enum), location (blank = nationwide, so a bare "United States"
   line is stripped) and datePosted in days. */
function buildIndeedInputs(p = {}) {
  const queries = strList(p.indeedQueries ?? p.titleSearch, MAX_QUERIES);
  const country = String(p.country || "").trim().toLowerCase();
  /* "" is a real choice here (any time) so it survives, but anything the actor
     would reject falls back to 7 days rather than to the widest, priciest
     setting — an unrecognised value must never quietly buy a full backlog */
  const asked = p.datePosted === undefined ? "7" : String(p.datePosted);
  const datePosted = DATE_POSTED.includes(asked) ? asked : "7";
  const base = {
    country: COUNTRIES.includes(country) ? country : "us",
    limit: clampLimit(p.limit, RATES.indeed),
  };
  const loc = (strList(p.locationSearch)[0] || "")
    .replace(/,?\s*(united states|usa|us)\.?$/i, "").trim();
  if (loc) base.location = loc;
  if (datePosted) base.datePosted = datePosted;
  return queries.map((title) => ({ ...base, title }));
}

/* johnvc~google-jobs-scraper takes ONE query line — no title list, no keyword
   list, no company-size or posted-within filter. So the LinkedIn shape has to
   collapse into a string: the titles quoted and OR'd decide the role, the
   description keywords quoted and OR'd decide the industry, and the two groups
   sit side by side (Google ANDs them). The client normally sends its own
   `query`; composing from the shared title/keyword fields is the fallback that
   keeps a client which only knows the LinkedIn fields working.

   Only the leading few of each list survive. Google Jobs answers a focused
   line and returns noise for a 300-character one — and every extra page of
   noise is another $0.11. */
const quoted = (s) => (/\s/.test(s) ? `"${s}"` : s);
const orGroup = (list, n) => list.slice(0, n).map(quoted).join(" OR ");

function googleQuery(p = {}) {
  const explicit = String(p.query || "").trim();
  if (explicit) return explicit.slice(0, 400);
  const titles = orGroup(strList(p.titleSearch, 40), 6);
  const keywords = orGroup(strList(p.descriptionSearch, 40), 4);
  return [titles && `(${titles})`, keywords && `(${keywords})`]
    .filter(Boolean).join(" ").slice(0, 400);
}

function buildGoogleInput(p = {}) {
  const r = RATES.google;
  const pages = googlePages(clampLimit(p.limit, r));
  const input = {
    query: googleQuery(p),
    country: "us",
    language: "en",
    google_domain: "google.com",
    num_results: pages * r.resultsPerPage,
    max_pagination: pages,          // the page cap IS the cost cap on this actor
    max_delay: 1,
  };
  /* one location, same as Indeed. A blank location is deliberate: with
     country=us the actor searches the United States nationwide, which is what
     the standard "United States" line means everywhere else in this app. */
  const loc = (strList(p.locationSearch)[0] || "")
    .replace(/,?\s*(united states|usa|us)\.?$/i, "").trim();
  if (loc) input.location = loc;
  return input;
}

/* ---------------- dedupe keys (jobs have no phones — URL is the identity)
   The query string is tracking noise on LinkedIn and gets dropped, but on
   Indeed it IS the posting: every URL is /viewjob?jk=<id>, so stripping it
   would collapse the whole board onto one key and every posting after the
   first would be filed as a duplicate. Keep jk (and its vjk alias). */
const urlKey = (u) => {
  const s = String(u || "").trim().toLowerCase();
  if (!s) return null;
  const [addr, qs] = s.split("#")[0].split("?");
  const path = addr.replace(/\/+$/, "");
  const jk = qs && /(?:^|&)v?jk=([^&]+)/.exec(qs);
  return jk ? `${path}?jk=${jk[1]}` : path;
};
const titleOrgKey = (title, org, city) =>
  title && org ? [title, org, city || ""].map((s) =>
    String(s).trim().toLowerCase()).join("|") : null;

/* one indexed read replaces the paged NocoDB scan (and its SCAN_CAP) */
async function existingJobKeys() {
  const urls = new Set(), titleOrgs = new Set();
  const rows = (await query(
    `SELECT job_url, name, company, city FROM leads
     WHERE kind = 'job' AND deleted_at IS NULL`)).rows;
  for (const r of rows) {
    const u = urlKey(r.job_url);
    if (u) urls.add(u);
    const k = titleOrgKey(r.name, r.company, r.city);
    if (k) titleOrgs.add(k);
  }
  return { urls, titleOrgs };
}

function itemLocation(it) {
  const loc = Array.isArray(it.locations_derived) ? it.locations_derived[0] : null;
  if (!loc) return { city: null, state: null };
  if (typeof loc === "string") {
    const parts = loc.split(",").map((s) => s.trim()).filter(Boolean);
    return { city: parts[0] || null, state: parts[1] || null };
  }
  return { city: loc.city || null, state: loc.admin || loc.admin_area || null };
}

/* Indeed's employer.industry is an internal code — "Iv1_CONSUMER_GOODS_AND_
   SERVICES" — not a label anyone would want to read in a table cell */
function indeedIndustry(v) {
  const s = String(v || "").replace(/^iv\d+_/i, "").replace(/_+/g, " ")
    .trim().toLowerCase();
  return s ? s.replace(/\b[a-z]/g, (c) => c.toUpperCase()) : null;
}

/* employer.employeesCount is a bracket ("11 to 50", "201 to 500"), never an
   actual headcount. Store the floor: a size filter that reads "≤ 200" should
   let a "201 to 500" company fail, and the floor never overstates the org. */
function indeedHeadcount(v) {
  const m = /(\d[\d,]*)/.exec(String(v || ""));
  return m ? +m[1].replace(/,/g, "") : null;
}

/* Google Jobs is an aggregator: the posting itself lives on LinkedIn, Indeed,
   a company's own careers page… apply_options carries those real links, and the
   first is the one Google ranks highest. share_link (a google.com/search URL)
   is the fallback — it still resolves to the posting, and jobs dedupe on URL,
   so leaving it null would let one posting land again on every scrape. */
function googleUrl(it) {
  const opts = Array.isArray(it.apply_options) ? it.apply_options : [];
  for (const o of opts) if (httpUrl(o?.link)) return httpUrl(o.link);
  return httpUrl(it.share_link);
}

/* one lead-shaped record per raw actor item, whatever the board */
function normalizeItem(key, it, stamp) {
  if (key === "google") {
    /* city/state stay NULL on purpose. The actor's `location` is the location
       we SEARCHED, stamped onto every row — not the job's own: a "Tampa, FL"
       search comes back with Paul Davis of North Dallas, ServiceMaster of
       Euless TX and SERVPRO of Duncanville, all three labelled "Tampa, FL"
       (Google Jobs targets location loosely, and the actor never carries a
       per-item place). Writing that in would invent a city for every Google
       lead — worse than the blank, and worse than the inferred states we
       already apologise for. Blank is the honest answer. */
    return {
      title: it.title || "Job posting", org: clean(it.company_name),
      contact: null, contactTitle: null, industry: null, employees: null,
      city: null, state: null, url: googleUrl(it),
      // "3 days ago" / "Just posted" — the same relative text Indeed sends
      date: indeedPostedDate(it.detected_extensions?.posted_at, stamp) || stamp,
    };
  }
  if (key === "indeed") {
    const loc = (it.location && typeof it.location === "object") ? it.location : {};
    const emp = (it.employer && typeof it.employer === "object") ? it.employer : {};
    return {
      title: clean(it.title) || "Job posting", org: clean(emp.name),
      contact: null, contactTitle: null,
      industry: indeedIndustry(emp.industry),
      employees: indeedHeadcount(emp.employeesCount),
      // admin1Code is the two-letter state; city is already a bare city name
      city: cleanPlace(loc.city), state: cleanPlace(loc.admin1Code),
      url: it.url || (it.key ? `https://www.indeed.com/viewjob?jk=${it.key}` : null),
      date: isoDate(it.datePublished || it.dateOnIndeed) || stamp,
    };
  }
  const { city, state } = itemLocation(it);
  return {
    title: it.title || "Job posting", org: clean(it.organization),
    contact: it.recruiter_name || null, contactTitle: it.recruiter_title || null,
    industry: it.org_linkedin_industry || null,
    employees: Number.isFinite(+it.org_linkedin_headcount)
      ? Math.round(+it.org_linkedin_headcount) : null,
    city, state, url: it.url || null,
    date: isoDate(it.date_posted) || stamp,
  };
}

/* ---------------- employers -> company leads (LinkedIn only)
   Every scrape also upserts the company behind each posting, so the org lands
   on the Companies tab — logo included — the moment we see it hiring.
   Identity keeps the franchise guards: the base is matched on the name+city
   key (the org's LinkedIn HQ city, never the posting's location), while
   companies this source created earlier match on the organization name alone —
   within one job board the org name IS one LinkedIn entity, which keeps
   repeat scrapes idempotent without risking a cross-source franchise merge.

   Indeed still skips this on purpose. Its employer object does carry a logo,
   website and headcount bracket, but the "name alone within the Job board
   source" rule above assumes one LinkedIn entity per name, and Indeed employer
   names are per-franchise ("Servpro Phoenix") with no HQ to key on — feeding a
   second board into that rule is exactly how franchises get merged. Those
   employer facts land on the job row instead (see normalizeItem). */

const httpUrl = (u) => {
  const s = String(u || "").trim();
  return /^https?:\/\//i.test(s) && s.length <= 500 ? s : null;
};

/* the company's own HQ ("Denver, Colorado") beats the posting's location —
   a remote job's city says nothing about where the employer is */
function orgLocation(it) {
  const hq = clean(it.org_linkedin_headquarters);
  if (hq && hq.includes(",")) {
    const [c, s] = hq.split(",").map((x) => x.trim());
    return { city: cleanPlace(c), state: cleanPlace(s) };
  }
  return itemLocation(it);
}

function orgFacts(it) {
  const { city, state } = orgLocation(it);
  return {
    logo_url: httpUrl(it.organization_logo),
    website: clean(it.org_linkedin_website),
    industry: clean(it.org_linkedin_industry),
    employees: Number.isFinite(+it.org_linkedin_headcount)
      ? Math.round(+it.org_linkedin_headcount) : null,
    city, state,
  };
}

async function resolveCompanies(items, stamp) {
  const orgs = new Map();                 // lower(name) -> { name, it }
  for (const it of items) {
    const name = clean(it.organization);
    if (!name) continue;
    const k = name.toLowerCase();
    // several postings per org: keep the one that actually carries the logo
    if (!orgs.has(k) || (!orgs.get(k).it.organization_logo && it.organization_logo))
      orgs.set(k, { name, it });
  }
  const out = { ids: new Map(), inserted: 0, updated: 0, phonesFilled: 0 };
  if (!orgs.size) return out;

  /* two indexed reads sized to the scrape, never a scan of the base */
  const byName = new Map();
  for (const r of (await query(
    `SELECT id, lower(name) AS k, logo_url, website, industry, employees,
            city, state
     FROM leads WHERE kind = 'company' AND source = 'Job board'
       AND deleted_at IS NULL AND lower(name) = ANY($1)`, [[...orgs.keys()]])).rows)
    if (!byName.has(r.k)) byName.set(r.k, r);

  const wantKeys = [];
  for (const o of orgs.values()) {
    const { city } = orgLocation(o.it);
    if (!city) continue;
    for (const a of aliases(o.name).set)
      wantKeys.push(`${a}|${city.toLowerCase()}`);
  }
  const byKey = new Map();
  if (wantKeys.length)
    for (const r of (await query(
      `SELECT k.key_value, l.id, l.logo_url, l.website, l.industry,
              l.employees, l.city, l.state
       FROM lead_keys k JOIN leads l ON l.id = k.lead_id
       WHERE k.kind = 'company' AND k.key_type = 'namecity'
         AND l.deleted_at IS NULL AND k.key_value = ANY($1)`, [wantKeys])).rows)
      if (!byKey.has(r.key_value)) byKey.set(r.key_value, r);

  for (const [k, o] of orgs) {
    const facts = orgFacts(o.it);
    let hit = null;
    if (facts.city)
      for (const a of aliases(o.name).set) {
        hit = byKey.get(`${a}|${facts.city.toLowerCase()}`);
        if (hit) break;
      }
    if (!hit) hit = byName.get(k);
    if (hit) {
      out.ids.set(k, hit.id);
      // enrich blanks only — a scrape never overwrites curated data
      const sets = [], params = [];
      for (const [f, v] of Object.entries(facts))
        if (v != null && hit[f] == null) sets.push(`${f} = $${params.push(v)}`);
      if (sets.length) {
        sets.push("updated_at = now()");
        await query(`UPDATE leads SET ${sets.join(", ")}
                     WHERE id = $${params.push(hit.id)}`, params);
        out.updated++;
      }
      continue;
    }
    const row = (await query(
      `INSERT INTO leads (lead_code, kind, name, company, website, industry,
         employees, city, state, logo_url, source, source_file, date_added)
       VALUES ($1, 'company', $2, $2, $3, $4, $5, $6, $7, $8,
               'Job board', 'LinkedIn search', $9)
       RETURNING id`,
      [mintCode(), o.name, facts.website, facts.industry, facts.employees,
       facts.city, facts.state, facts.logo_url, stamp])).rows[0];
    out.ids.set(k, row.id);
    out.inserted++;
    /* the boards never send a phone, but Bitrix/Master usually already know
       this company — borrow the number when the match is unambiguous
       (server/enrich.js). Best-effort: a miss just leaves the blank. */
    try {
      if (await fillPhone(query, { id: row.id, name: o.name,
        website: facts.website, city: facts.city, state: facts.state }))
        out.phonesFilled++;
    } catch (e) { console.warn("phone backfill failed:", e.message); }
    // claim the name+city keys so the next import meets this company
    if (facts.city)
      for (const a of aliases(o.name).set)
        await query(
          `INSERT INTO lead_keys (kind, key_type, key_value, lead_id)
           VALUES ('company', 'namecity', $1, $2) ON CONFLICT DO NOTHING`,
          [`${a}|${facts.city.toLowerCase()}`, row.id]);
  }
  return out;
}

async function lastRunCost(actor) {
  const [r, tier] = await Promise.all([
    apify(`/acts/${actor}/runs/last`),
    accountTier(),
  ]);
  const d = r?.data || {};
  const counts2 = d.chargedEventCounts || {};
  const prices = d.pricingInfo?.pricingPerEvent?.actorChargeEvents || {};
  let total = 0, priced = false;
  for (const [k, n] of Object.entries(counts2)) {
    const p = eventPrice(prices[k], tier);
    if (typeof p === "number") { total += p * (+n || 0); priced = true; }
  }
  return {
    usd: priced ? total : null,
    usageTotalUsd: typeof d.usageTotalUsd === "number" ? d.usageTotalUsd : null,
    status: d.status || null,
  };
}

router.post("/api/job-search", express.json({ limit: "64kb" }), async (req, res, next) => {
  try {
    const key = scraperKey(req.body?.scraper);
    const scraper = SCRAPERS[key];
    /* One list for every board. Indeed is the only one that batches: it sends
       one input per boolean query and they run concurrently (buildIndeedInputs);
       LinkedIn and Google each describe a whole search in one input. */
    const inputs = key === "indeed"
      ? buildIndeedInputs(req.body || {})
      : [(key === "google" ? buildGoogleInput : buildLinkedinInput)(req.body || {})];
    if (key === "indeed") {
      if (!inputs.length)
        return res.status(400).json({ error: "Indeed needs a search query to run" });
      /* refuse an over-long query rather than truncating it: a boolean cut
         mid-quote still runs, still bills, and quietly searches for the wrong
         thing — which is worse than being told to shorten it */
      const tooLong = inputs.find((i) => (i.title || "").length > MAX_QUERY_CHARS);
      if (tooLong)
        return res.status(400).json({ error: `Indeed searches are capped at `
          + `${MAX_QUERY_CHARS} characters — shorten “${tooLong.title.slice(0, 60)}…”` });
    }
    if (key === "google" && !inputs[0].query)
      return res.status(400).json({ error: "Google Jobs needs a search query" });
    const limit = key === "google" ? inputs[0].num_results : inputs[0].limit;
    const known = await existingJobKeys();
    const rates = await actorRates(key).catch(() => RATES[key]);

    /* Google bills per page as it goes, so the page cap in the input is already
       the cost cap; maxTotalChargeUsd is the belt to that pair of braces — if
       the actor ever paginated past it, Apify stops the run instead of billing */
    const chargeCap = key === "google"
      ? `&maxTotalChargeUsd=${(googlePages(limit) * rates.pagePriceUsd + 0.01).toFixed(2)}`
      : "";
    /* one sync run per input, concurrently: a batch of three costs the wall
       clock of the slowest, not the sum. 280s keeps each run inside Apify's
       300s sync window, so a run that overruns still hands back what it got. */
    const runOne = (input) => apify(
      `/acts/${scraper.actor}/run-sync-get-dataset-items?timeout=280&format=json&clean=true${chargeCap}`
      + (scraper.memoryMbytes ? `&memory=${scraper.memoryMbytes}` : ""),
      { method: "POST", body: JSON.stringify(input) });

    // one bad query must not sink the batch — only an all-failed batch throws
    const settled = await Promise.allSettled(inputs.map(runOne));
    const failed = settled.filter((r) => r.status === "rejected");
    if (failed.length === settled.length) throw failed[0].reason;
    for (const f of failed) console.warn("job-search batch failed:", f.reason?.message);
    const items = settled.flatMap((r) =>
      r.status === "fulfilled" && Array.isArray(r.value) ? r.value : []);

    /* billing is per dataset item, so the cost math counts everything the
       actors returned — including the rows dropped just below */
    const billable = items.length;
    /* an expired Indeed posting is not a lead anyone can act on; an actor that
       hit trouble reports it as a single row carrying an error field */
    const found = items.filter((it) =>
      it && !it.error && !(key === "indeed" && it.expired));

    const stamp = new Date().toISOString().slice(0, 10);

    /* employers first — even a duplicate posting can bring a logo or an org
       we have never stored, so this runs over everything the search found */
    const companies = key === "linkedin"
      ? await resolveCompanies(found, stamp)
      : { ids: new Map(), inserted: 0, updated: 0, phonesFilled: 0 };

    /* LinkedIn's ats_duplicate flag marks overlap with the vendor's OTHER
       dataset, not duplication inside these results — don't drop on it */
    let duplicates = 0, inserted = 0;
    const seenUrls = new Set(), seenTitleOrgs = new Set();
    for (const it of found) {
      const rec = normalizeItem(key, it, stamp);
      const u = urlKey(rec.url);
      const k = titleOrgKey(rec.title, rec.org, rec.city);
      if ((u && (known.urls.has(u) || seenUrls.has(u))) ||
          (k && (known.titleOrgs.has(k) || seenTitleOrgs.has(k)))) {
        duplicates++;
        continue;
      }
      if (u) seenUrls.add(u);
      if (k) seenTitleOrgs.add(k);
      await query(
        `INSERT INTO leads (lead_code, kind, name, company, contact, contact_title,
           industry, employees, city, state, job_url, source, source_file, date_added,
           company_lead_id)
         VALUES ($1, 'job', $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 'Job board', $11, $12, $13)`,
        [mintCode(), rec.title, rec.org, rec.contact, rec.contactTitle,
         rec.industry, rec.employees, rec.city, rec.state, rec.url,
         scraper.sourceFile, rec.date,
         rec.org ? companies.ids.get(rec.org.toLowerCase()) ?? null : null]);
      inserted++;
    }
    counts.invalidate();

    let cost = null;
    try {
      const perJob = key === "linkedin" && inputs[0].recruiterOnly
        ? rates.recruiterPerResultUsd : rates.perResultUsd;
      /* On Google the bill counts pages fetched, not rows returned: eight jobs
         back is still one whole page paid for. Everywhere else it is per
         dataset item, and every batched query is its own run — so the start fee
         is paid once per query, and lastRunCost only ever sees one of those
         runs, which is why the computed figure wins the max() below. */
      const computed = key === "google"
        ? googlePages(billable) * rates.pagePriceUsd + 0.00006
        : billable * perJob + (rates.startUsd || 0) * inputs.length + 0.0001;
      const last = await lastRunCost(scraper.actor).catch(() => ({}));
      const known2 = [computed, last.usd, last.usageTotalUsd]
        .filter((v) => typeof v === "number");
      cost = { usd: Math.max(...known2), status: last.status || null };
    } catch (e) { console.warn("could not compute run cost:", e.message); }

    activity.log({ actor: req.user.email, user_id: req.user.id, action: "jobsearch",
      meta: { scraper: key, found: found.length, inserted, duplicates,
        queries: inputs.length, companies: companies.inserted,
        phonesFilled: companies.phonesFilled, costUsd: cost?.usd ?? null } });

    res.json({
      scraper: key,
      input: key === "indeed"
        ? { limit, queries: inputs.length, datePosted: inputs[0].datePosted ?? "",
            country: inputs[0].country, location: inputs[0].location ?? null }
        : key === "google"
          ? { limit, query: inputs[0].query, location: inputs[0].location ?? null,
              pages: googlePages(limit) }
          : { limit, timeRange: inputs[0].timeRange },
      queriesFailed: failed.length,
      found: found.length, inserted, duplicates,
      companies: { inserted: companies.inserted, updated: companies.updated,
        phonesFilled: companies.phonesFilled },
      cost,
    });
  } catch (e) { next(e); }
});

router.get("/api/apify-usage", async (req, res, next) => {
  try {
    const [limits, monthly, linkedinRates, indeedRates, googleRates] = await Promise.all([
      apify("/users/me/limits"),
      apify("/users/me/usage/monthly"),
      actorRates("linkedin").catch(() => RATES.linkedin),
      actorRates("indeed").catch(() => RATES.indeed),
      actorRates("google").catch(() => RATES.google),
    ]);
    const L = limits?.data || limits || {};
    const M = monthly?.data || monthly || {};
    const maxUsd = L.limits?.maxMonthlyUsageUsd ?? L.maxMonthlyUsageUsd ?? null;
    const usedUsd = L.current?.monthlyUsageUsd ?? L.monthlyUsageUsd ?? null;
    const cycle = L.monthlyUsageCycle || M.usageCycle || {};
    const daily = (M.dailyServiceUsages || []).map((d) => ({
      date: d.date ? String(d.date).slice(0, 10) : null,
      usd: +(d.totalUsageCreditsUsd ?? d.totalUsageCreditsUsdAfterVolumeDiscount ?? 0) || 0,
    })).filter((d) => d.date);
    res.json({
      usedUsd, maxUsd,
      remainingUsd: maxUsd != null && usedUsd != null
        ? Math.max(0, maxUsd - usedUsd) : null,
      cycleEndsAt: cycle.endAt || null,
      daily,
      rates: linkedinRates,       // legacy shape — pre-scraper clients read this
      scraperRates: {
        linkedin: linkedinRates, indeed: indeedRates, google: googleRates,
      },
    });
  } catch (e) { next(e); }
});

// everything past `router` is exported for tests only
module.exports = {
  router, resolveCompanies,
  buildIndeedInputs, normalizeItem, urlKey,
  _test: { buildGoogleInput, googleQuery, googlePages, googleUrl, normalizeItem,
    buildIndeedInputs, urlKey, actorRates, accountTier },
};
