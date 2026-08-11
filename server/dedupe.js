"use strict";
/* Lead identity, cleaning and spreadsheet parsing — extracted verbatim from
   import-leads.js, which was itself a deliberate port of dashboard/setup_v2.py.
   This file is now THE JavaScript implementation; import-leads.js (the NocoDB
   path) is retired at the frontend cutover, and the Python copies follow when
   the pipeline moves onto the import API. Until then the usual rule applies:
   change the guards here and in setup_v2.py together.

   Nothing in this file talks to a database or the network — pure functions,
   so the import worker, the API routes, and any future test can share it. */

const crypto = require("crypto");

const CATEGORIES = ["Restoration", "Independent Adjuster", "Public Adjuster",
  "Insurance", "Vendor", "Other"];
const STATUSES = ["New", "Contacted", "Responded", "Qualified", "Not interested"];

/* ---------------- cleaning (ports of the helpers in setup_and_import.py) */
const clean = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/^'+/, "").trim();
  return s === "" || ["nan", "none", "null", "n/a", "-"].includes(s.toLowerCase())
    ? null : s;
};
/* Bitrix exports put numeric ID codes in City/State/Industry — useless */
const cleanPlace = (v) => {
  const s = clean(v);
  return s && /^\d{3,}$/.test(s) ? null : s;
};
const toInt = (v) => {
  const s = clean(v);
  if (!s) return null;
  const n = parseFloat(s.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : null;
};
const CODE_LIKE = /^[A-Z0-9\-/ ]{1,7}$/;
/* a licence class is only worth showing if it reads as a trade, not "HIC" */
function tradeLabel(v) {
  let s = clean(v);
  if (!s || s.includes(";")) return null;
  s = s.replace(/\([^)]*\)/g, "").trim()
    .replace(/^\d{4,}\s*-\s*/, "")
    .replace(/(\s+(LICENSE|CERTIFICATE)S?)+$/i, "").trim();
  return s.length < 8 || CODE_LIKE.test(s) ? null : s;
}
const certCount = (v) => {
  const s = clean(v);
  if (!s) return null;
  const n = s.split(";").filter((p) => p.trim()).length;
  return n || null;
};
/* Bannable phone key, or null — same rejections as pk() in setup_v2.py:
   Bitrix placeholders like +119000000000 are shared by dozens of unrelated
   companies, so they must never become a key. Do not loosen this. */
function pk(phone) {
  let d = String(phone || "").replace(/\D/g, "");
  if (d.length > 10) d = d.slice(-10);
  if (d.length !== 10) return null;
  if (d[0] === "0" || d[0] === "1") return null;
  if (new Set(d).size <= 2 || d.slice(3) === "0000000") return null;
  return d;
}
const today = () => new Date().toISOString().slice(0, 10);
function isoDate(v) {
  const s = clean(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/* Lead Codes exactly as dashboard/registry.py mints them: KL- + 10 Crockford
   base32 characters (no I, L, O, U). Opaque surrogate keys on purpose. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function mintCode() {
  const bytes = crypto.randomBytes(10);
  let s = "";
  for (const b of bytes) s += CROCKFORD[b % 32];
  return "KL-" + s;
}

/* ---------------- header mapping */
const norm = (h) => String(h ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

const HEADERS = {
  firstname: "first", givenname: "first",
  lastname: "last", surname: "last", familyname: "last",
  fullname: "name", contactname: "name", leadname: "name", personname: "name",
  contact: "name", recruitername: "name", aihiringmanagername: "name",
  company: "company", companyname: "company", organization: "company",
  organizationname: "company", accountname: "company", businessname: "company",
  employer: "company",
  title: "title", jobtitle: "title", position: "title", contacttitle: "title",
  recruitertitle: "title",
  email: "email", emailaddress: "email", workemail: "email",
  contactemail: "email", primaryemail: "email",
  aihiringmanageremailaddress: "email",
  city: "city", companycity: "city", citiesderived0: "city", town: "city",
  state: "state", stateregion: "state", companystate: "state",
  region: "state", regionsderived0: "state", province: "state",
  website: "website", domainname: "website", domain: "website",
  companywebsite: "website", orglinkedinwebsite: "website",
  employees: "employees", numemployees: "employees", employeecount: "employees",
  headcount: "employees", orglinkedinheadcount: "employees",
  companysize: "employees",
  annualrevenue: "revenue", revenue: "revenue",
  industry: "industry", industrygroup: "industry", sector: "industry",
  orglinkedinindustry: "industry", trade: "industry",
  licensespecialty: "license", licenseclass: "license",
  certifications: "certs",
  joburl: "joburl", joblink: "joburl", postingurl: "joburl",
  dateposted: "posted", datetimeposted: "posted", posted: "posted",
};

/* Apollo ships six phone columns; take them in the order it prefers */
const PHONE_PRIORITY = ["mobilephone", "workdirectphone", "corporatephone",
  "companyphone", "phonenumber", "phone", "workphone", "otherphone",
  "homephone", "telephone", "primaryphone", "directphone", "mobile",
  "cell", "cellphone"];

/* A job export is recognised by its shape, not its filename */
function looksLikeJobs(headers) {
  const n = headers.map(norm);
  return n.includes("organization") || n.includes("dateposted") ||
    (n.includes("url") && n.includes("title") && !n.includes("companyname"));
}

function mapHeaders(headers) {
  const isJob = looksLikeJobs(headers);
  const n = headers.map(norm);
  // "Name" means the company only when nothing else claims that role
  const nameIsCompany = !n.some((h) =>
    ["company", "companyname", "organization", "organizationname",
      "accountname", "businessname"].includes(h));
  const map = {}, phones = [], unmapped = [];
  for (const h of headers) {
    const k = norm(h);
    if (!k) continue;
    const pi = PHONE_PRIORITY.indexOf(k);
    if (pi >= 0) { phones.push([pi, h]); continue; }
    let f = HEADERS[k];
    if (k === "name") f = nameIsCompany ? "company" : "name";
    if (isJob) {
      if (k === "title") f = "jobtitle";
      else if (k === "recruitertitle" || k === "contacttitle") f = "title";
      else if (k === "url") f = "joburl";
    } else if (k === "url") {
      f = "website";
    }
    if (f) map[h] = f;
    else unmapped.push(h);
  }
  phones.sort((a, b) => a[0] - b[0]);
  return { map, phoneCols: phones.map((p) => p[1]), isJob, unmapped };
}

/* ---------------- rows -> lead dicts */
function rowToLead(row, map, phoneCols) {
  const v = {};
  for (const [h, f] of Object.entries(map)) {
    const val = clean(row[h]);
    if (val && !v[f]) v[f] = val;          // first non-empty column wins
  }
  let phone = null;
  for (const h of phoneCols) {
    phone = clean(row[h]);
    if (phone) break;
  }
  const name = v.name || [v.first, v.last].filter(Boolean).join(" ") || null;
  return {
    name,
    company: v.company || null,
    title: v.title || null,
    email: v.email ? v.email.toLowerCase() : null,
    phone,
    city: cleanPlace(v.city),
    state: cleanPlace(v.state),
    website: v.website || null,
    employees: toInt(v.employees),
    revenue: toInt(v.revenue),
    industry: cleanPlace(v.industry) || tradeLabel(v.license),
    certs: certCount(v.certs),
    jobTitle: v.jobtitle || null,
    jobUrl: v.joburl || null,
    posted: isoDate(v.posted),
  };
}

/* ---- identity matching: the port of dedupe()/aliases() in setup_v2.py ----
   A lead is the same business as another when they agree on a key AND nothing
   contradicts it — franchises share brands, share a regional manager's email,
   and are still separate businesses. When changing any of this, re-check the
   per-brand counts (stanley steemer, servpro, puroclean, rainbow international):
   a drop means franchises are being eaten. */
const SUFFIXES = new Set(["llc", "inc", "co", "corp", "ltd", "llp", "pc", "pa",
  "the", "company", "corporation", "incorporated"]);
/* a trade word alone names half the industry — never merge two rows on it */
const GENERIC = new Set(["restoration", "restorations", "cleaning", "cleaners",
  "construction", "services", "service", "roofing", "adjusters", "adjuster",
  "plumbing", "contracting", "contractors", "builders", "remodeling", "damage",
  "emergency", "recovery", "mitigation", "environmental", "disaster"]);
const DBA = /\bd\s*[/.]?\s*b\s*[/.]?\s*a\b\.?/i;

function normCo(name) {
  if (!name) return null;
  const words = String(name).toLowerCase().replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/).filter((w) => w && !SUFFIXES.has(w));
  return words.join(" ") || null;
}

/* 'Brc Construction, Inc. Dba Pc Restorations' -> both halves plus the whole,
   so it can meet a bare 'PC Restorations' from another export. */
function aliases(name) {
  if (!name) return { set: new Set(), isDba: false };
  const parts = String(name).split(DBA);
  const isDba = parts.length > 1;
  const out = new Set([normCo(isDba ? parts.join(" ") : name)]);
  if (isDba) for (const p of parts) out.add(normCo(p));
  return {
    set: new Set([...out].filter((a) => a && !GENERIC.has(a))),
    isDba,
  };
}

const disjoint = (a, b) => a.size && b.size && ![...a].some((x) => b.has(x));

/* identity of a lead, precomputed once */
function ident(l, name) {
  return {
    email: (l.email || "").trim().toLowerCase() || null,
    phone: pk(l.phone),
    city: (l.city || "").trim().toLowerCase() || null,
    ...aliases(name !== undefined ? name : (l.company || l.name)),
  };
}

/* Would merging these two erase a real business? */
const phoneAgrees = (a, b) =>
  !((a.email && b.email && a.email !== b.email) && disjoint(a.set, b.set));
const emailAgrees = (a, b) =>
  !disjoint(a.set, b.set) && !(a.city && b.city && a.city !== b.city);
const nameAgrees = (a, b) =>
  !(a.email && b.email && a.email !== b.email) &&
  !(a.phone && b.phone && a.phone !== b.phone && !(a.isDba || b.isDba));

module.exports = {
  CATEGORIES, STATUSES,
  clean, cleanPlace, toInt, tradeLabel, certCount, pk, today, isoDate, mintCode,
  mapHeaders, rowToLead, looksLikeJobs,
  normCo, aliases, ident, phoneAgrees, emailAgrees, nameAgrees,
};
