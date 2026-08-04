"use strict";
/* LinkedIn job search via the Apify actor
   fantastic-jobs/advanced-linkedin-job-search-api ($1.50 per 1,000 results;
   ~10x that with recruiterOnly). The actor queries a pre-built index, so a
   sync run returns in seconds — no start-and-poll needed.

   The browser never sees the Apify token: index.js exposes two routes that
   land here, and the input is rebuilt from a whitelist so a crafted request
   can't raise the spend cap or smuggle extra actor options. */
const fs = require("fs");
const path = require("path");
const { nc, discover, insertAll, toInt } = require("./import-leads");

const APIFY = "https://api.apify.com/v2";
const ACTOR = "fantastic-jobs~advanced-linkedin-job-search-api";
const PAGE = 500;                 // read window for the dedupe scan
const SCAN_CAP = 60000;           // stop scanning rather than hammer the server

/* fallback pay-per-result rates, used only when the live lookup fails —
   actorRates() reads the real prices off the actor so a vendor price change
   never silently breaks the cost estimates. LIMIT_MAX is our own spend
   ceiling, not an actor limit. */
const RATES = {
  perResultUsd: 0.005,
  recruiterPerResultUsd: 0.015,
  limitMin: 10,                   // actor minimum
  limitMax: 500,
  limitDefault: 100,
};

let cachedRates = null, cachedRatesAt = 0;
async function actorRates() {
  if (cachedRates && Date.now() - cachedRatesAt < 6 * 3600e3) return cachedRates;
  const a = await apify(`/acts/${ACTOR}`);
  const infos = a?.data?.pricingInfos || [];
  const ev = infos[infos.length - 1]?.pricingPerEvent?.actorChargeEvents || {};
  const per = ev["apify-default-dataset-item"]?.eventPriceUsd;
  const rec = ev["recruiter-url-filtered-result"]?.eventPriceUsd;
  cachedRates = {
    ...RATES,
    perResultUsd: typeof per === "number" ? per : RATES.perResultUsd,
    recruiterPerResultUsd: typeof per === "number" && typeof rec === "number"
      ? per + rec : RATES.recruiterPerResultUsd,
  };
  cachedRatesAt = Date.now();
  return cachedRates;
}

function apifyToken() {
  const p = path.join(__dirname, "apify_token.json");
  const raw = fs.readFileSync(p, "utf8").replace(/^﻿/, "");   // BOM-tolerant
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

/* ---------------- input whitelist */
const TIME_RANGES = ["1h", "24h", "7d", "6m"];
const SENIORITIES = ["Internship", "Entry level", "Associate",
  "Mid-Senior level", "Director", "Executive"];
const ARRANGEMENTS = ["On-site", "Hybrid", "Remote OK", "Remote Solely"];
const EMPLOYMENT = ["FULL_TIME", "PART_TIME", "CONTRACTOR", "TEMPORARY", "INTERN"];

const strList = (v, max = 15) => (Array.isArray(v) ? v : [])
  .map((s) => String(s).trim()).filter(Boolean).slice(0, max);
const pickAllowed = (v, allowed) => strList(v).filter((s) => allowed.includes(s));

function buildInput(p = {}) {
  const limit = Math.min(Math.max(Math.round(+p.limit) || RATES.limitDefault,
    RATES.limitMin), RATES.limitMax);
  const input = {
    limit,
    timeRange: TIME_RANGES.includes(p.timeRange) ? p.timeRange : "7d",
    descriptionType: "text",
  };
  const titles = strList(p.titleSearch, 40);
  if (titles.length) input.titleSearch = titles;
  const locations = strList(p.locationSearch);
  if (locations.length) input.locationSearch = locations;
  // description search is unsupported on the 6m (all active) range
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

/* ---------------- dedupe keys (jobs have no phones — URL is the identity) */
const urlKey = (u) => {
  const s = String(u || "").trim().toLowerCase();
  return s ? s.split(/[?#]/)[0].replace(/\/+$/, "") : null;
};
/* LinkedIn reposts the same opening under several job ids, so URL identity
   alone leaks near-duplicates — title|company|city catches those */
const titleOrgKey = (title, org, city) =>
  title && org ? [title, org, city || ""].map((s) =>
    String(s).trim().toLowerCase()).join("|") : null;

async function existingJobKeys(auth, jobsTid) {
  const urls = new Set(), titleOrgs = new Set();
  let scanned = 0, complete = true;
  const fields = encodeURIComponent("Job URL,Job Title,Company,City");
  for (let offset = 0; ; offset += PAGE) {
    if (scanned >= SCAN_CAP) { complete = false; break; }
    const r = await nc(auth, `/api/v2/tables/${jobsTid}/records` +
      `?limit=${PAGE}&offset=${offset}&fields=${fields}`);
    for (const row of r.list || []) {
      const u = urlKey(row["Job URL"]);
      if (u) urls.add(u);
      const k = titleOrgKey(row["Job Title"], row.Company, row.City);
      if (k) titleOrgs.add(k);
    }
    scanned += (r.list || []).length;
    if (!r.list || r.list.length < PAGE || r.pageInfo?.isLastPage) break;
  }
  return { urls, titleOrgs, complete };
}

/* ---------------- actor items -> Job Board rows */
function itemLocation(it) {
  const loc = Array.isArray(it.locations_derived) ? it.locations_derived[0] : null;
  if (!loc) return { city: null, state: null };
  if (typeof loc === "string") {                 // "Miami, Florida, United States"
    const parts = loc.split(",").map((s) => s.trim()).filter(Boolean);
    return { city: parts[0] || null, state: parts[1] || null };
  }
  return { city: loc.city || null, state: loc.admin || loc.admin_area || null };
}

function itemToRow(it, stamp) {
  const { city, state } = itemLocation(it);
  const posted = it.date_posted ? String(it.date_posted).slice(0, 10) : null;
  return {
    "Phone Key": null, Removed: false, Status: "New",
    "Source File": "LinkedIn search",
    "Job Title": it.title || "Job posting",
    Company: it.organization || null,
    Contact: it.recruiter_name || null,
    "Contact Title": it.recruiter_title || null,
    Industry: it.org_linkedin_industry || null,
    Employees: toInt(it.org_linkedin_headcount),
    City: city, State: state,
    "Job URL": it.url || null,
    Posted: posted || stamp,
  };
}

/* what the last run actually charged. The exact number is charged events ×
   the run's own event prices; usageTotalUsd lags by several seconds and is
   only a fallback. Best-effort: a race with a teammate's concurrent run just
   mislabels the cost line. */
async function lastRunCost() {
  const r = await apify(`/acts/${ACTOR}/runs/last`);
  const d = r?.data || {};
  const counts = d.chargedEventCounts || {};
  const prices = d.pricingInfo?.pricingPerEvent?.actorChargeEvents || {};
  let eventUsd = 0, priced = false;
  for (const [k, n] of Object.entries(counts)) {
    const p = prices[k]?.eventPriceUsd;
    if (typeof p === "number") { eventUsd += p * (+n || 0); priced = true; }
  }
  return {
    usd: priced ? eventUsd : null,
    usageTotalUsd: typeof d.usageTotalUsd === "number" ? d.usageTotalUsd : null,
    status: d.status || null,
  };
}

/* ---------------- entry: run a search and insert the results */
async function searchJobs({ params, auth }) {
  // discover() first — it fails on a bad JWT / no base access, so we never
  // spend Apify credits for a request that couldn't insert anything
  const tables = await discover(auth);
  if (!tables.jobs) throw new Error("Job Board table not found");
  const input = buildInput(params);
  const known = await existingJobKeys(auth, tables.jobs);

  const items = await apify(
    `/acts/${ACTOR}/run-sync-get-dataset-items?timeout=280&format=json&clean=true`,
    { method: "POST", body: JSON.stringify(input) });
  const found = Array.isArray(items) ? items : [];

  /* note: the actor's ats_duplicate flag marks overlap with the vendor's
     OTHER dataset, not duplication inside these results — don't drop on it */
  const stamp = new Date().toISOString().slice(0, 10);
  const rows = [];
  let duplicates = 0;
  const seenUrls = new Set(), seenTitleOrgs = new Set();
  for (const it of found) {
    const u = urlKey(it.url);
    const { city } = itemLocation(it);
    const k = titleOrgKey(it.title, it.organization, city);
    if ((u && (known.urls.has(u) || seenUrls.has(u))) ||
        (k && (known.titleOrgs.has(k) || seenTitleOrgs.has(k)))) {
      duplicates++;
      continue;
    }
    if (u) seenUrls.add(u);
    if (k) seenTitleOrgs.add(k);
    rows.push(itemToRow(it, stamp));
  }

  const inserted = rows.length ? await insertAll(auth, tables.jobs, rows) : 0;

  /* the actor bills per job returned, so the charge is known the moment the
     items arrive: found × live rate (+ the flat actor-start event). Apify's
     own run/usage numbers lag by 5-15s, so they only serve as an upward
     cross-check — e.g. a bigger-memory run charging extra start events. */
  let cost = null;
  try {
    const rates = await actorRates().catch(() => RATES);
    const perJob = input.recruiterOnly ? rates.recruiterPerResultUsd : rates.perResultUsd;
    const computed = found.length * perJob + 0.0001;
    const last = await lastRunCost().catch(() => ({}));
    const known2 = [computed, last.usd, last.usageTotalUsd]
      .filter((v) => typeof v === "number");
    cost = { usd: Math.max(...known2), status: last.status || null };
  } catch (e) { console.warn("could not compute run cost:", e.message); }

  return {
    input: { limit: input.limit, timeRange: input.timeRange },
    found: found.length,
    inserted,
    duplicates,
    cost,
    partialDedupe: !known.complete,
  };
}

/* ---------------- account credits + daily spend, for the settings modal */
async function apifyUsage() {
  const [limits, monthly, rates] = await Promise.all([
    apify("/users/me/limits"),
    apify("/users/me/usage/monthly"),
    actorRates().catch(() => RATES),
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
  return {
    usedUsd,
    maxUsd,
    remainingUsd: maxUsd != null && usedUsd != null
      ? Math.max(0, maxUsd - usedUsd) : null,
    cycleEndsAt: cycle.endAt || null,
    daily,
    rates,
  };
}

module.exports = { searchJobs, apifyUsage };
