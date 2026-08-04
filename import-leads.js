"use strict";
/* Parse an uploaded spreadsheet (xlsx/xls/csv) into Companies / People /
   Job Board rows and push them into the Karma Leads base.

   This deliberately mirrors dashboard/setup_v2.py: same person-vs-company
   split, the same pk() phone-key rules, the same blocklist behaviour. An
   import and a full rebuild must not disagree about where a row belongs. */
const XLSX = require("xlsx");

const NOCO = "http://localhost:8080";
const BATCH = 100;                    // NocoDB's bulk-insert ceiling
const PAGE = 500;                     // read window for the dedupe scan
const SCAN_CAP = 120000;              // stop scanning rather than hammer the server
const CATEGORIES = ["Restoration", "Independent Adjuster", "Public Adjuster",
  "Insurance", "Vendor", "Other"];

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
   companies, so they must never become a key. */
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

/* ---------------- rows -> leads */
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
   Keep the two in step. A lead is the same business as another when they agree
   on a key AND nothing contradicts it — franchises share brands, share a
   regional manager's email, and are still separate businesses. */
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

/* ---------------- NocoDB access (as the signed-in user, not the API token) */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* the dedupe scan makes dozens of calls in a row; a dropped socket mid-scan
   shouldn't throw away the whole import */
async function nc(auth, path, opts = {}, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(NOCO + path, {
        ...opts,
        headers: { "Content-Type": "application/json", "xc-auth": auth, ...(opts.headers || {}) },
      });
    } catch (e) {                       // network-level failure: retry
      if (attempt >= tries) throw new Error(`${path} -> ${e.message}`);
      await sleep(400 * attempt);
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      if (res.status >= 500 && attempt < tries) { await sleep(400 * attempt); continue; }
      throw new Error(`${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  }
}

async function discover(auth) {
  const bases = (await nc(auth, "/api/v2/meta/bases")).list || [];
  const base = bases.find((b) => b.title === "Karma Leads");
  if (!base) throw new Error("Base 'Karma Leads' not found for this account");
  const tables = (await nc(auth, `/api/v2/meta/bases/${base.id}/tables`)).list || [];
  const byTitle = (t) => (tables.find((x) => x.title === t) || {}).id || null;
  return {
    companies: byTitle("Companies"), people: byTitle("People"),
    jobs: byTitle("Job Board"), blocklist: byTitle("Blocklist"),
  };
}

/* every email + phone key already in the base, so an import can't re-add them */
/* Index the base by email and by phone key. The names and cities come along
   because a bare key match is not enough to call two rows the same business —
   see the guards above. */
async function existingKeys(auth, tables) {
  const emails = new Map(), phones = new Map();
  const FIELDS = "Email,Phone Key,Company,Name,City";
  let scanned = 0, complete = true;
  for (const tid of [tables.companies, tables.people, tables.jobs]) {
    if (!tid) continue;
    for (let offset = 0; ; offset += PAGE) {
      if (scanned >= SCAN_CAP) { complete = false; break; }
      const r = await nc(auth, `/api/v2/tables/${tid}/records` +
        `?limit=${PAGE}&offset=${offset}&fields=${encodeURIComponent(FIELDS)}`);
      for (const row of r.list || []) {
        const id = ident({
          email: row.Email, city: row.City,
        }, row.Company || row.Name);
        id.phone = row["Phone Key"] || null;
        if (id.email) {
          if (!emails.has(id.email)) emails.set(id.email, []);
          emails.get(id.email).push(id);
        }
        if (id.phone) {
          if (!phones.has(id.phone)) phones.set(id.phone, []);
          phones.get(id.phone).push(id);
        }
      }
      scanned += (r.list || []).length;
      if (!r.list || r.list.length < PAGE || r.pageInfo?.isLastPage) break;
    }
  }
  return { emails, phones, complete };
}

async function bannedNumbers(auth, tables) {
  const banned = new Set();
  if (!tables.blocklist) return banned;
  for (let offset = 0; ; offset += PAGE) {
    const r = await nc(auth, `/api/v2/tables/${tables.blocklist}/records` +
      `?limit=${PAGE}&offset=${offset}&fields=${encodeURIComponent("Phone Key")}`);
    for (const row of r.list || []) if (row["Phone Key"]) banned.add(row["Phone Key"]);
    if (!r.list || r.list.length < PAGE || r.pageInfo?.isLastPage) break;
  }
  return banned;
}

async function insertAll(auth, tid, rows) {
  let n = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    await nc(auth, `/api/v2/tables/${tid}/records`,
      { method: "POST", body: JSON.stringify(rows.slice(i, i + BATCH)) });
    n += Math.min(BATCH, rows.length - i);
  }
  return n;
}

/* ---------------- main entry */
async function importLeads({ buffer, filename, category, auth }) {
  const cat = CATEGORIES.includes(category) ? category : "Other";
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: false, raw: false });
  if (!wb.SheetNames.length) throw new Error("that file has no sheets");

  // read every sheet — the vendor workbooks keep a "Review Queue" alongside "Master"
  let raw = [], headers = [];
  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null, raw: false });
    if (!rows.length) continue;
    raw = raw.concat(rows);
    for (const h of Object.keys(rows[0])) if (!headers.includes(h)) headers.push(h);
  }
  if (!raw.length) throw new Error("that file has no rows");

  const { map, phoneCols, isJob, unmapped } = mapHeaders(headers);
  if (!Object.keys(map).length && !phoneCols.length)
    throw new Error("no recognisable columns — expected headers like Company, Name, Email, Phone");

  const leads = raw.map((r) => rowToLead(r, map, phoneCols))
    .filter((l) => l.company || l.name || l.email || l.phone);

  // dedupe inside the file first, then against what is already in the base
  const tables = await discover(auth);
  const banned = await bannedNumbers(auth, tables);
  const { emails, phones, complete } = await existingKeys(auth, tables);
  let duplicates = 0, blocked = 0;
  const fresh = [];
  const keptByEmail = new Map(), keptByPhone = new Map(), keptByAlias = new Map();
  const push = (map, k, v) => {
    if (!k) return;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(v);
  };

  for (const l of leads) {
    const id = ident(l);
    // already in the base?
    const inBase =
      (id.phone && (phones.get(id.phone) || []).some((o) => phoneAgrees(id, o))) ||
      (id.email && (emails.get(id.email) || []).some((o) => emailAgrees(id, o)));
    // already seen earlier in this same file?
    let dupOfFile = false;
    if (!inBase) {
      dupOfFile =
        (id.phone && (keptByPhone.get(id.phone) || []).some((o) => phoneAgrees(id, o))) ||
        (id.email && (keptByEmail.get(id.email) || []).some((o) => emailAgrees(id, o)));
      if (!dupOfFile && id.city) {
        for (const a of id.set) {
          const bucket = keptByAlias.get(`${a}|${id.city}`) || [];
          if (bucket.some((o) => nameAgrees(id, o))) { dupOfFile = true; break; }
        }
      }
    }
    if (inBase || dupOfFile) { duplicates++; continue; }
    push(keptByEmail, id.email, id);
    push(keptByPhone, id.phone, id);
    if (id.city) for (const a of id.set) push(keptByAlias, `${a}|${id.city}`, id);
    fresh.push(l);
  }

  const src = "Excel import";
  const stamp = today();
  const companies = [], people = [], jobs = [];
  for (const l of fresh) {
    const key = pk(l.phone);
    const isBanned = !!key && banned.has(key);
    if (isBanned) blocked++;
    const common = {
      "Phone Key": key, Removed: isBanned, Status: "New",
      "Source File": filename,
    };
    if (isJob) {
      jobs.push({
        ...common,
        "Job Title": l.jobTitle || l.title || "Job posting",
        Company: l.company, Contact: l.name !== l.company ? l.name : null,
        "Contact Title": l.title, Email: l.email, Industry: l.industry,
        Employees: l.employees, City: l.city, State: l.state,
        "Job URL": l.jobUrl, Posted: l.posted || stamp,
      });
    } else if (l.name && l.company &&
               l.name.toLowerCase() !== l.company.toLowerCase()) {
      people.push({
        ...common, Name: l.name, Title: l.title, Company: l.company,
        Email: l.email, Phone: l.phone, Category: cat, Industry: l.industry,
        Employees: l.employees, Revenue: l.revenue, City: l.city,
        State: l.state, "Date Added": stamp, Source: src,
      });
    } else {
      companies.push({
        ...common, Company: l.company || l.name, Category: cat,
        Industry: l.industry, Employees: l.employees, Revenue: l.revenue,
        Certs: l.certs, City: l.city, State: l.state, Phone: l.phone,
        Email: l.email, Website: l.website, "Date Added": stamp, Source: src,
      });
    }
  }

  const inserted = {
    companies: companies.length ? await insertAll(auth, tables.companies, companies) : 0,
    people: people.length ? await insertAll(auth, tables.people, people) : 0,
    jobs: jobs.length ? await insertAll(auth, tables.jobs, jobs) : 0,
  };
  return {
    file: filename,
    sheets: wb.SheetNames,
    rows: raw.length,
    detected: isJob ? "job board export" : "lead list",
    inserted,
    total: inserted.companies + inserted.people + inserted.jobs,
    duplicates,
    blocked,
    unmapped,
    partialDedupe: !complete,     // base too large to scan fully
  };
}

module.exports = { importLeads, mapHeaders, rowToLead, pk, tradeLabel, CATEGORIES,
  // shared NocoDB plumbing, reused by job-search.js — one retry/discovery
  // implementation, not two that drift apart
  nc, discover, insertAll, toInt };
