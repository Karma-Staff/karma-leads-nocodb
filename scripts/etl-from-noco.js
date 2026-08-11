"use strict";
/* One-off ETL: noco.db + lead_registry.db + recents.json  ->  PostgreSQL.

   Idempotent: every destination table it owns is truncated and reloaded, so
   it can be re-run freely during development. The REAL cutover run happens
   with the old server stopped, so nothing writes noco.db mid-read.

   Sources are opened read-only. sqlite3 rides on nocodb's transitive install —
   fine here, because this script only matters while noco.db still exists.

   Usage:  node scripts/etl-from-noco.js            # load + report
*/

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const sqlite3 = require("sqlite3");
const { pool } = require("../server/db");

const ROOT = path.join(__dirname, "..");
const NOCO = path.join(ROOT, "noco.db");
const REGISTRY = path.join(ROOT, "lead_registry.db");
const RECENTS = path.join(ROOT, "recents.json");

/* ---------------- tiny promise wrapper over sqlite3 ---------------- */
function openRO(file) {
  const db = new sqlite3.Database(`file:${file.replace(/\\/g, "/")}?mode=ro`,
    sqlite3.OPEN_READONLY | sqlite3.OPEN_URI);
  return {
    all: (sql, params = []) => new Promise((res, rej) =>
      db.all(sql, params, (e, rows) => (e ? rej(e) : res(rows)))),
    get: (sql, params = []) => new Promise((res, rej) =>
      db.get(sql, params, (e, row) => (e ? rej(e) : res(row)))),
    close: () => new Promise((res) => db.close(res)),
  };
}

/* mint a Lead Code exactly the way dashboard/registry.py does: KL- + 10
   Crockford base32 chars (no I, L, O, U). Needed because LinkedIn-search jobs
   were inserted by job-search.js without codes. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function mintCode() {
  const bytes = crypto.randomBytes(10);
  let s = "";
  for (const b of bytes) s += CROCKFORD[b % 32];
  return "KL-" + s;
}

/* batched INSERT ... VALUES ... RETURNING id — row order is preserved for
   plain VALUES inserts, which is what the old-id -> new-id mapping rides on */
async function insertBatch(client, table, cols, rows, returning) {
  const out = [];
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const params = [];
    const tuples = chunk.map((row) =>
      "(" + cols.map((_, c) => `$${params.push(row[c])}`).join(",") + ")");
    const sql = `INSERT INTO ${table} (${cols.join(",")}) VALUES ${tuples.join(",")}` +
      (returning ? ` RETURNING ${returning}` : "");
    const r = await client.query(sql, params);
    if (returning) out.push(...r.rows);
  }
  return out;
}

const clean = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};
const bool = (v) => v === 1 || v === true || v === "1" || v === "true";
const intOr = (v) => (Number.isFinite(+v) && v !== null && v !== "" ? Math.trunc(+v) : null);

async function main() {
  const noco = openRO(NOCO);
  const reg = openRO(REGISTRY);
  const client = await pool.connect();
  const report = [];
  const say = (s) => { console.log(s); report.push(s); };

  try {
    /* ---------------- locate the live base ---------------- */
    const base = await noco.get(
      "SELECT id, prefix FROM nc_bases_v2 WHERE deleted = 0 OR deleted IS NULL");
    if (!base) throw new Error("no live base in noco.db");
    const P = base.prefix;                      // e.g. nc_ess5__
    say(`live base ${base.id}, prefix ${P}`);

    await client.query("BEGIN");
    await client.query(`TRUNCATE organizations, app_users, organization_memberships,
      leads, lead_code_aliases, lead_keys, lead_comments, blocklist, recents
      RESTART IDENTITY CASCADE`);

    /* ---------------- users ---------------- */
    const users = await noco.all(
      "SELECT email, display_name FROM nc_users_v2 WHERE email IS NOT NULL");
    const [{ id: orgId }] = await insertBatch(client, "organizations",
      ["name"], [["Karma Staff"]], "id");
    const userRows = users.map((u) => {
      const email = String(u.email).trim().toLowerCase();
      return [email, clean(u.display_name), email.endsWith("@karmaleads.local")];
    });
    const userIds = await insertBatch(client, "app_users",
      ["email", "display_name", "disabled"], userRows, "id");
    const userIdByEmail = new Map(userRows.map((r, i) => [r[0], userIds[i].id]));
    await insertBatch(client, "organization_memberships",
      ["org_id", "user_id", "role"],
      userRows.map((r, i) => [orgId, userIds[i].id,
        r[0] === "pema@karmastaff.com" ? "admin" : "member"]));
    say(`app_users: ${userRows.length} (admin: pema@karmastaff.com)`);

    /* ---------------- leads ---------------- */
    // shared column tail in source order; per-kind head handled per table
    const idMap = new Map();          // "companies:12" -> new lead id
    let minted = 0, dupCodes = 0;
    const seenCodes = new Set();
    const code = (v) => {
      let c = clean(v);
      if (c) c = c.toUpperCase();
      if (!c || seenCodes.has(c)) { if (c) dupCodes++; c = mintCode(); minted++; }
      seenCodes.add(c);
      return c;
    };
    const DEST = ["lead_code", "kind", "name", "company", "title", "contact",
      "contact_title", "website", "job_url", "category", "industry", "employees",
      "revenue", "certs", "city", "state", "phone", "email", "phone_key",
      "status", "owner", "favorite", "removed", "notes", "source", "source_file",
      "date_added", "created_at", "updated_at"];

    const shared = (r) => [
      clean(r.category), clean(r.industry), intOr(r.employees), intOr(r.revenue),
      intOr(r.certs), clean(r.city), clean(r.state), clean(r.phone),
      clean(r.email), clean(r.phone_key), clean(r.status) || "New",
      clean(r.owner), bool(r.favorite), bool(r.removed), clean(r.notes),
      clean(r.source), clean(r.source_file), clean(r.date_added),
      r.created_at || new Date().toISOString(), r.updated_at || new Date().toISOString(),
    ];
    // splice shared() into DEST order: category..certs sit before city; build explicitly
    const rowFor = (kind, head, r) => {
      const [category, industry, employees, revenue, certs, city, state, phone,
        email, phone_key, status, owner, favorite, removed, notes, source,
        source_file, date_added, created_at, updated_at] = shared(r);
      return [code(r.lead_code), kind, head.name, head.company, head.title,
        head.contact, head.contact_title, head.website, head.job_url,
        category, industry, employees, revenue, certs, city, state, phone, email,
        phone_key, status, owner, favorite, removed, notes, source, source_file,
        date_added, created_at, updated_at];
    };

    const load = async (table, kind, mapKey, headFn, extra = {}) => {
      const rows = await noco.all(`SELECT * FROM ${P}_${table}`);
      const data = rows.map((r) => rowFor(kind, headFn(r), r));
      const ids = await insertBatch(client, "leads", DEST, data, "id");
      rows.forEach((r, i) => idMap.set(`${mapKey}:${r.id}`, ids[i].id));
      if (extra.after) await extra.after(rows);
      say(`leads<${kind}>: ${rows.length}`);
      return rows;
    };

    const coRows = await load("companies", "company", "companies", (r) => ({
      name: clean(r.company) || "(no name)", company: clean(r.company),
      title: null, contact: null, contact_title: null,
      website: clean(r.website), job_url: null,
    }));
    const peRows = await load("people", "person", "people", (r) => ({
      name: clean(r.name) || clean(r.company) || "(no name)",
      company: clean(r.company), title: clean(r.title),
      contact: null, contact_title: null, website: null, job_url: null,
    }));
    const jbRows = await load("job_board", "job", "jobs", (r) => ({
      name: clean(r.job_title) || "(no title)", company: clean(r.company),
      title: null, contact: clean(r.contact), contact_title: clean(r.contact_title),
      website: null, job_url: clean(r.job_url),
    }));
    // jobs had no source column; the UI's chip logic keys on this value
    await client.query("UPDATE leads SET source = 'Job board' WHERE kind = 'job' AND source IS NULL");

    /* company_lead_id from the old FK columns */
    let linked = 0;
    for (const [rows, key, fk] of [
      [peRows, "people", `${P}_companies_id`], [jbRows, "jobs", `${P}_companies_id`]]) {
      const pairs = rows
        .map((r) => [idMap.get(`${key}:${r.id}`), idMap.get(`companies:${r[fk]}`)])
        .filter(([, co]) => co);
      for (let i = 0; i < pairs.length; i += 500) {
        const chunk = pairs.slice(i, i + 500);
        await client.query(
          `UPDATE leads SET company_lead_id = v.co FROM
           (SELECT (x->>0)::bigint AS id, (x->>1)::bigint AS co
            FROM jsonb_array_elements($1::jsonb) x) v WHERE leads.id = v.id`,
          [JSON.stringify(chunk)]);
        linked += chunk.length;
      }
    }
    say(`company links: ${linked}`);

    /* ---------------- registry: aliases + keys ---------------- */
    const regLeads = await reg.all("SELECT lead_code, merged_into FROM lead");
    const mergedInto = new Map(regLeads.filter((r) => r.merged_into)
      .map((r) => [r.lead_code, r.merged_into]));
    const follow = (c) => {
      const seen = new Set();
      while (mergedInto.has(c) && !seen.has(c)) { seen.add(c); c = mergedInto.get(c); }
      return c;
    };
    const leadIdByCode = new Map();
    for (const r of await client.query("SELECT id, lead_code FROM leads")
      .then((x) => x.rows)) leadIdByCode.set(r.lead_code, r.id);

    const aliases = [];
    let aliasOrphans = 0;
    for (const [dead, ] of mergedInto) {
      const lid = leadIdByCode.get(follow(dead));
      if (lid && !leadIdByCode.has(dead)) aliases.push([dead, lid]);
      else if (!lid) aliasOrphans++;
    }
    await insertBatch(client, "lead_code_aliases", ["code", "lead_id"], aliases);
    const regOrphans = regLeads.filter((r) =>
      !r.merged_into && !leadIdByCode.get(r.lead_code)).length;
    say(`aliases: ${aliases.length} (unresolvable tombstones: ${aliasOrphans}; ` +
        `registry codes with no live row: ${regOrphans})`);

    /* ---------------- registry judgement backfill ----------------
       Discovered during migration: the 2026-08-04 rebuild dropped ~2,010 owner
       assignments that lead_work still holds. The repo's own rule is that the
       registry wins on judgement — so registry fills any live field that is
       still blank/default. A live value always wins where one exists. */
    const work = await reg.all(
      "SELECT lead_code, status, owner, favorite, notes FROM lead_work");
    const workRows = work
      .map((w) => [leadIdByCode.get(follow(w.lead_code)),
        clean(w.status), clean(w.owner), bool(w.favorite), clean(w.notes)])
      .filter(([lid]) => lid);
    let backfilled = 0;
    for (let i = 0; i < workRows.length; i += 500) {
      const chunk = workRows.slice(i, i + 500);
      const r = await client.query(
        `UPDATE leads SET
           status   = CASE WHEN leads.status = 'New' AND v.status IS NOT NULL
                           AND v.status <> 'New' THEN v.status ELSE leads.status END,
           owner    = COALESCE(leads.owner, v.owner),
           favorite = leads.favorite OR v.favorite,
           notes    = COALESCE(leads.notes, v.notes)
         FROM (SELECT (x->>0)::bigint id, x->>1 status, x->>2 owner,
                      (x->>3)::boolean favorite, x->>4 notes
               FROM jsonb_array_elements($1::jsonb) x) v
         WHERE leads.id = v.id AND (
           (leads.status = 'New' AND v.status IS NOT NULL AND v.status <> 'New') OR
           (leads.owner IS NULL AND v.owner IS NOT NULL) OR
           (NOT leads.favorite AND v.favorite) OR
           (leads.notes IS NULL AND v.notes IS NOT NULL))`,
        [JSON.stringify(chunk)]);
      backfilled += r.rowCount;               // rows the registry actually improved
    }
    say(`registry judgement backfill: ${backfilled} rows updated ` +
        `(of ${workRows.length} lead_work rows)`);

    const T = { company: "company", person: "person", job: "job" };
    const regKeys = await reg.all(
      "SELECT entity_type, key_type, key_value, lead_code FROM lead_key");
    const keyRows = [];
    const seenKeys = new Set();
    let keyOrphans = 0;
    for (const k of regKeys) {
      const lid = leadIdByCode.get(follow(k.lead_code));
      if (!lid) { keyOrphans++; continue; }
      const uniq = `${T[k.entity_type]}|${k.key_type}|${k.key_value}`;
      if (seenKeys.has(uniq)) continue;         // merged codes can collide post-follow
      seenKeys.add(uniq);
      keyRows.push([T[k.entity_type], k.key_type, String(k.key_value), lid]);
    }
    await insertBatch(client, "lead_keys",
      ["kind", "key_type", "key_value", "lead_id"], keyRows);
    say(`lead_keys: ${keyRows.length} (orphaned: ${keyOrphans})`);

    /* ---------------- comments ---------------- */
    const models = await noco.all(
      "SELECT id, table_name FROM nc_models_v2 WHERE base_id = ?", [base.id]);
    const tableByModel = new Map(models.map((m) => [m.id,
      m.table_name === `${P}_companies` ? "companies" :
      m.table_name === `${P}_people` ? "people" :
      m.table_name === `${P}_job_board` ? "jobs" : null]));
    const comments = await noco.all(
      "SELECT fk_model_id, row_id, comment, created_by_email, created_at " +
      "FROM nc_comments WHERE is_deleted IS NOT 1");
    const cRows = [];
    let cOrphans = 0;
    for (const c of comments) {
      const t = tableByModel.get(c.fk_model_id);
      const lid = t && idMap.get(`${t}:${+c.row_id}`);
      if (!lid) { cOrphans++; continue; }
      const email = String(c.created_by_email || "unknown").toLowerCase();
      cRows.push([lid, userIdByEmail.get(email) ?? null, email,
        c.comment, c.created_at]);
    }
    await insertBatch(client, "lead_comments",
      ["lead_id", "author_user_id", "author_email", "body", "created_at"], cRows);
    say(`lead_comments: ${cRows.length} (orphaned: ${cOrphans}; ` +
        `source had ${comments.length} live of 13 total)`);

    /* ---------------- blocklist ---------------- */
    const bl = await noco.all(`SELECT * FROM ${P}_blocklist WHERE phone_key IS NOT NULL`);
    const blSeen = new Set();
    const blRows = bl.filter((r) => {
      if (blSeen.has(r.phone_key)) return false;
      blSeen.add(r.phone_key);
      return true;
    }).map((r) => [clean(r.phone), String(r.phone_key), clean(r.company),
      clean(r.reason), clean(r.added_by), r.date_added || r.created_at]);
    await insertBatch(client, "blocklist",
      ["phone", "phone_key", "company", "reason", "added_by", "created_at"], blRows);
    say(`blocklist: ${blRows.length} (source ${bl.length}, deduped by phone_key)`);

    /* ---------------- recents.json ---------------- */
    let recCount = 0, recOrphans = 0;
    try {
      const all = JSON.parse(fs.readFileSync(RECENTS, "utf-8"));
      const rows = [];
      for (const [email, list] of Object.entries(all)) {
        const uid = userIdByEmail.get(email.toLowerCase());
        if (!uid || !Array.isArray(list)) continue;
        const per = new Map();                   // dedupe by lead, newest wins
        for (const e of list) {
          const lid = idMap.get(`${e.t}:${e.id}`);
          if (!lid) { recOrphans++; continue; }
          if (!per.has(lid)) per.set(lid, [uid, lid, e.kind || "open", e.at]);
        }
        rows.push(...per.values());
      }
      await insertBatch(client, "recents",
        ["user_id", "lead_id", "kind", "touched_at"], rows);
      recCount = rows.length;
    } catch { /* no recents.json — nothing to carry */ }
    say(`recents: ${recCount} (orphaned: ${recOrphans})`);
    say(`minted codes: ${minted} (duplicate source codes remapped: ${dupCodes})`);

    await client.query("COMMIT");

    /* ---------------- verification ---------------- */
    say("\n--- verification ---");
    const q = async (label, sql) => {
      const r = await client.query(sql);
      say(`${label}: ${JSON.stringify(r.rows[0] ?? r.rows.length)}`);
    };
    const src = {
      companies: (await noco.get(`SELECT COUNT(*) n FROM ${P}_companies`)).n,
      people: (await noco.get(`SELECT COUNT(*) n FROM ${P}_people`)).n,
      jobs: (await noco.get(`SELECT COUNT(*) n FROM ${P}_job_board`)).n,
    };
    const dst = (await client.query(
      "SELECT kind, count(*)::int n FROM leads GROUP BY kind")).rows;
    const d = Object.fromEntries(dst.map((r) => [r.kind, r.n]));
    const ok = d.company === src.companies && d.person === src.people && d.job === src.jobs;
    say(`counts src {co:${src.companies}, pe:${src.people}, jb:${src.jobs}} ` +
        `dst {co:${d.company}, pe:${d.person}, jb:${d.job}}  ${ok ? "MATCH" : "** MISMATCH **"}`);
    await q("favorites", "SELECT count(*)::int favorites FROM leads WHERE favorite");
    await q("removed", "SELECT count(*)::int removed FROM leads WHERE removed");
    await q("statuses", `SELECT jsonb_object_agg(status, n) s FROM
      (SELECT status, count(*)::int n FROM leads GROUP BY status) x`);
    await q("null phone_key on removed sweep base",
      "SELECT count(*)::int n FROM leads WHERE phone_key IS NULL");
    await q("segments view", "SELECT count(*)::int segments FROM segments");
    // spot-check: 3 random live codes + up to 2 tombstoned aliases round-trip
    const spots = (await client.query(
      "SELECT lead_code, kind, name FROM leads ORDER BY random() LIMIT 3")).rows;
    for (const s of spots) say(`spot ${s.lead_code} -> ${s.kind} "${s.name}"`);
    const al = (await client.query(
      `SELECT a.code, l.lead_code, l.name FROM lead_code_aliases a
       JOIN leads l ON l.id = a.lead_id LIMIT 2`)).rows;
    for (const a of al) say(`alias ${a.code} -> ${a.lead_code} "${a.name}"`);
    // orphan FK sanity
    await q("company_lead_id orphans", `SELECT count(*)::int n FROM leads c
      LEFT JOIN leads p ON p.id = c.company_lead_id
      WHERE c.company_lead_id IS NOT NULL AND p.id IS NULL`);

    fs.writeFileSync(path.join(ROOT, "scripts", "etl-report.txt"),
      report.join("\n") + "\n");
    say("\nreport written to scripts/etl-report.txt");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
    await Promise.all([noco.close(), reg.close()]);
    await pool.end();
  }
}

main().catch((e) => { console.error("ETL failed:", e); process.exit(1); });
