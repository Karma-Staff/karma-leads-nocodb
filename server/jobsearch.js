"use strict";
/* Job search via Apify actors — the port of job-search.js onto Postgres.
   The Apify half (token handling, input whitelist, live rates, cost math) is
   carried over unchanged; the storage half is now one INSERT.

   Two boards, one endpoint: the client picks a scraper key ("linkedin" or
   "indeed") and everything else — input shape, rates, item mapping — is
   resolved from the SCRAPERS registry below. Unknown keys fall back to
   LinkedIn, so old clients keep working.

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
    actor: "misceres~indeed-scraper",
    label: "Indeed",
    sourceFile: "Indeed search",
  },
};
const scraperKey = (v) => (SCRAPERS[v] ? v : "linkedin");

/* fallback pay-per-result rates, used only when the live lookup fails.
   limitMax is our spend ceiling on both boards, not an actor limit. */
const RATES = {
  linkedin: {
    perResultUsd: 0.005,
    recruiterPerResultUsd: 0.015,
    limitMin: 10,
    limitMax: 500,
    limitDefault: 100,
  },
  indeed: {
    perResultUsd: 0.003,            // $3 / 1,000 job listings
    limitMin: 10,
    limitMax: 500,
    limitDefault: 100,
  },
};

const ratesCache = {};               // scraper key -> { rates, at }
async function actorRates(key) {
  const hit = ratesCache[key];
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.rates;
  const a = await apify(`/acts/${SCRAPERS[key].actor}`);
  const infos = a?.data?.pricingInfos || [];
  const ev = infos[infos.length - 1]?.pricingPerEvent?.actorChargeEvents || {};
  /* each actor names its per-result event differently — take the standard
     dataset-item event when present, else the first priced event */
  const per = ev["apify-default-dataset-item"]?.eventPriceUsd
    ?? Object.values(ev).find((e) => typeof e?.eventPriceUsd === "number")?.eventPriceUsd;
  const rates = { ...RATES[key] };
  if (typeof per === "number") rates.perResultUsd = per;
  if (key === "linkedin") {
    const rec = ev["recruiter-url-filtered-result"]?.eventPriceUsd;
    rates.recruiterPerResultUsd = typeof per === "number" && typeof rec === "number"
      ? per + rec : RATES.linkedin.recruiterPerResultUsd;
  }
  ratesCache[key] = { rates, at: Date.now() };
  return rates;
}

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

/* misceres~indeed-scraper takes ONE search, not lists: the first title is the
   position, the first location line the locality. Indeed wants the country as
   its own field, so a trailing "United States" is stripped off the location
   (a bare "United States" line means nationwide — no location at all). */
function buildIndeedInput(p = {}) {
  const titles = strList(p.titleSearch, 40);
  const input = {
    position: titles[0] || "",
    country: "US",
    maxItemsPerSearch: clampLimit(p.limit, RATES.indeed),
    parseCompanyDetails: false,
    saveOnlyUniqueItems: true,
    followApplyRedirects: false,
  };
  const loc = (strList(p.locationSearch)[0] || "")
    .replace(/,?\s*(united states|usa|us)\.?$/i, "").trim();
  if (loc) input.location = loc;
  return input;
}

/* ---------------- dedupe keys (jobs have no phones — URL is the identity) */
const urlKey = (u) => {
  const s = String(u || "").trim().toLowerCase();
  return s ? s.split(/[?#]/)[0].replace(/\/+$/, "") : null;
};
const titleOrgKey = (title, org, city) =>
  title && org ? [title, org, city || ""].map((s) =>
    String(s).trim().toLowerCase()).join("|") : null;

/* one indexed read replaces the paged NocoDB scan (and its SCAN_CAP) */
async function existingJobKeys() {
  const urls = new Set(), titleOrgs = new Set();
  const rows = (await query(
    "SELECT job_url, name, company, city FROM leads WHERE kind = 'job'")).rows;
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

/* Indeed's location is one display string — "Miami, FL 33130", "Remote", or
   "Remote in Tampa, FL". Zip codes are noise for our columns. */
function indeedLocation(s) {
  const str = String(s || "").replace(/^remote(\s+in\s+)?/i, "").trim();
  if (!str) return { city: null, state: null };
  const parts = str.split(",").map((x) => x.replace(/\d{5}(-\d{4})?/g, "").trim())
    .filter(Boolean);
  return { city: parts[0] || null, state: parts[1] || null };
}

/* Indeed reports postedAt as relative text ("Just posted", "Active 3 days
   ago", "30+ days ago") — turn it into a date, else fall back to today */
function indeedPostedDate(s, stamp) {
  const str = String(s || "");
  if (/just posted|today/i.test(str)) return stamp;
  const m = /(\d+)\+?\s*day/i.exec(str);
  if (!m) return null;
  const d = new Date(stamp + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - +m[1]);
  return d.toISOString().slice(0, 10);
}

/* one lead-shaped record per raw actor item, whatever the board */
function normalizeItem(key, it, stamp) {
  if (key === "indeed") {
    const { city, state } = indeedLocation(it.location);
    return {
      title: it.positionName || "Job posting", org: clean(it.company),
      contact: null, contactTitle: null, industry: null, employees: null,
      city, state, url: it.url || null,
      date: indeedPostedDate(it.postedAt, stamp) || stamp,
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

   Indeed skips this on purpose: its items carry only a display name — no HQ,
   logo, website or industry — and the "name alone within the Job board
   source" rule above assumes one LinkedIn entity per name. Mixing a second
   board into it would let a bare "SERVPRO" posting swallow franchises. */

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
  const out = { ids: new Map(), inserted: 0, updated: 0 };
  if (!orgs.size) return out;

  /* two indexed reads sized to the scrape, never a scan of the base */
  const byName = new Map();
  for (const r of (await query(
    `SELECT id, lower(name) AS k, logo_url, website, industry, employees,
            city, state
     FROM leads WHERE kind = 'company' AND source = 'Job board'
       AND lower(name) = ANY($1)`, [[...orgs.keys()]])).rows)
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
         AND k.key_value = ANY($1)`, [wantKeys])).rows)
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
  const r = await apify(`/acts/${actor}/runs/last`);
  const d = r?.data || {};
  const counts2 = d.chargedEventCounts || {};
  const prices = d.pricingInfo?.pricingPerEvent?.actorChargeEvents || {};
  let eventUsd = 0, priced = false;
  for (const [k, n] of Object.entries(counts2)) {
    const p = prices[k]?.eventPriceUsd;
    if (typeof p === "number") { eventUsd += p * (+n || 0); priced = true; }
  }
  return {
    usd: priced ? eventUsd : null,
    usageTotalUsd: typeof d.usageTotalUsd === "number" ? d.usageTotalUsd : null,
    status: d.status || null,
  };
}

router.post("/api/job-search", express.json({ limit: "64kb" }), async (req, res, next) => {
  try {
    const key = scraperKey(req.body?.scraper);
    const scraper = SCRAPERS[key];
    const input = key === "indeed"
      ? buildIndeedInput(req.body || {}) : buildLinkedinInput(req.body || {});
    if (key === "indeed" && !input.position)
      return res.status(400).json({ error: "Indeed needs a job title to search for" });
    const limit = key === "indeed" ? input.maxItemsPerSearch : input.limit;
    const known = await existingJobKeys();

    const items = await apify(
      `/acts/${scraper.actor}/run-sync-get-dataset-items?timeout=280&format=json&clean=true`,
      { method: "POST", body: JSON.stringify(input) });
    /* misceres reports "no matches" as one item with an error field */
    const found = (Array.isArray(items) ? items : [])
      .filter((it) => it && !it.error);

    const stamp = new Date().toISOString().slice(0, 10);

    /* employers first — even a duplicate posting can bring a logo or an org
       we have never stored, so this runs over everything the search found */
    const companies = key === "linkedin"
      ? await resolveCompanies(found, stamp)
      : { ids: new Map(), inserted: 0, updated: 0 };

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
      const rates = await actorRates(key).catch(() => RATES[key]);
      const perJob = key === "linkedin" && input.recruiterOnly
        ? rates.recruiterPerResultUsd : rates.perResultUsd;
      const computed = found.length * perJob + 0.0001;
      const last = await lastRunCost(scraper.actor).catch(() => ({}));
      const known2 = [computed, last.usd, last.usageTotalUsd]
        .filter((v) => typeof v === "number");
      cost = { usd: Math.max(...known2), status: last.status || null };
    } catch (e) { console.warn("could not compute run cost:", e.message); }

    activity.log({ actor: req.user.email, user_id: req.user.id, action: "jobsearch",
      meta: { scraper: key, found: found.length, inserted, duplicates,
        companies: companies.inserted, costUsd: cost?.usd ?? null } });

    res.json({
      scraper: key,
      input: { limit, timeRange: input.timeRange },
      found: found.length, inserted, duplicates,
      companies: { inserted: companies.inserted, updated: companies.updated },
      cost,
    });
  } catch (e) { next(e); }
});

router.get("/api/apify-usage", async (req, res, next) => {
  try {
    const [limits, monthly, linkedinRates, indeedRates] = await Promise.all([
      apify("/users/me/limits"),
      apify("/users/me/usage/monthly"),
      actorRates("linkedin").catch(() => RATES.linkedin),
      actorRates("indeed").catch(() => RATES.indeed),
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
      scraperRates: { linkedin: linkedinRates, indeed: indeedRates },
    });
  } catch (e) { next(e); }
});

module.exports = { router, resolveCompanies };   // resolveCompanies: for tests
