"use strict";
/* Import jobs — the ONLY write path for bulk data, shared by the drop zone
   (an admin's browser posts the raw file) and the Python pipeline (a service
   token uploads validated batches). The contract:

     POST /api/import-jobs                  begin; returns {id}. Idempotent by
                                            idempotency_key — a retry gets the
                                            SAME job back, never a duplicate.
                                            With a file body it also stages,
                                            commits and returns the result.
     POST /api/import-jobs/:id/records     {seq_start, records[]} — ≤500
                                            records / ~5 MB per batch, schema-
                                            validated, idempotent by (job,seq).
     POST /api/import-jobs/:id/commit      process the staged rows. Replay-safe:
                                            a committed job returns its counts.
     GET  /api/import-jobs/:id             status + counts.
     POST /api/import-jobs/:id/abort
     GET  /api/identity-lookup             TEMPORARY (phase 6a): lets the Python
                                            pipeline keep its client-side dedupe
                                            until that moves server-side. Gone
                                            in 6b — do not build on it.
     POST /api/dnc-import                  bulk 🚫: numbers[] + dry_run.

   Dedupe on commit is the same identity model as everywhere else (dedupe.js —
   the setup_v2.py port): candidates are fetched by indexed key lookups sized
   to the IMPORT, not scans sized to the base, then the franchise guards
   decide. Records carrying a lead_code (the pipeline) skip dedupe: the code
   IS the identity, and a blank field never overwrites a populated one. */

const express = require("express");
const path = require("path");
const { Worker } = require("worker_threads");
const { query, tx } = require("./db");
const { requireAdmin } = require("./auth");
const { requireScope } = require("./service-auth");
const activity = require("./activity");
const counts = require("./counts");
const D = require("./dedupe");

const router = express.Router();
const gate = requireScope("imports:write", requireAdmin);

const MAX_BATCH = 500;
const FIELD_KEYS = new Set(["name", "company", "title", "contact",
  "contact_title", "website", "job_url", "category", "industry", "employees",
  "revenue", "certs", "city", "state", "phone", "email", "phone_key",
  "source", "source_file", "date_added", "notes"]);
const INT_KEYS = new Set(["employees", "revenue", "certs"]);
const KINDS = new Set(["company", "person", "job"]);

function validateRecord(r) {
  if (!r || typeof r !== "object") return "record is not an object";
  if (r.lead_code != null && !/^KL-[0-9A-Z]{10}$/.test(String(r.lead_code).toUpperCase()))
    return `bad lead_code ${r.lead_code}`;
  if (!KINDS.has(r.kind)) return `bad kind ${r.kind}`;
  if (!r.fields || typeof r.fields !== "object") return "missing fields";
  for (const [k, v] of Object.entries(r.fields)) {
    if (!FIELD_KEYS.has(k)) return `unknown field ${k}`;
    if (v === null) continue;
    if (INT_KEYS.has(k)) {
      if (!Number.isFinite(+v)) return `${k} is not a number`;
    } else if (typeof v === "number" && Number.isFinite(v)) {
      continue;         // spreadsheets type numeric cells; stored as text below
    } else if (typeof v !== "string" || v.length > 2000) {
      // 2000, not tighter: the master sheet's Industry cells are legitimate
      // 800-char trade lists and the columns are text — this guards payload
      // abuse, not data shape
      return `${k} must be a string ≤2000 chars`;
    }
  }
  return null;
}

/* the storage value for a validated field: ints rounded, text stringified —
   a numeric Industry cell becomes "3", never a type error at insert time */
const fieldVal = (k, v) => (INT_KEYS.has(k) ? Math.round(+v) : String(v));

/* ---------------- job lifecycle */
router.post("/api/import-jobs", gate,
  express.json({ limit: "64kb", type: "application/json" }),
  express.raw({ limit: "80mb", type: "*/*" }),
  async (req, res, next) => {
    try {
      const isFile = Buffer.isBuffer(req.body) && req.body.length;
      const filename = isFile
        ? safeName(req.get("x-filename") || "upload.xlsx")
        : String(req.body?.filename || "").slice(0, 200) || null;
      const category = isFile
        ? (req.get("x-category") || "Other")
        : String(req.body?.category || "Other");
      const idem = !isFile && req.body?.idempotency_key
        ? String(req.body.idempotency_key).slice(0, 120) : null;

      if (idem) {
        const dup = (await query(
          "SELECT * FROM import_jobs WHERE idempotency_key = $1", [idem])).rows[0];
        if (dup) return res.json(shape(dup));   // the retry contract
      }
      const job = (await query(
        `INSERT INTO import_jobs (created_by, filename, category, idempotency_key)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [req.actor, filename, category, idem])).rows[0];

      if (!isFile) return res.json(shape(job));

      /* drop-zone path: parse off-thread, stage, commit, answer when done —
         the browser's UX has always been "wait for the result" */
      const parsed = await runWorker({
        buffer: req.body, filename, category });
      const records = parsed.records;
      for (let i = 0; i < records.length; i += MAX_BATCH) {
        const chunk = records.slice(i, i + MAX_BATCH);
        await stageBatch(job.id, i, chunk);
      }
      const out = await commitJob(job.id, req.actor, req.user?.id ?? null);
      res.json({ ...shape(out), file: filename, sheets: parsed.sheets,
        rows: parsed.rows, detected: parsed.detected, unmapped: parsed.unmapped });
    } catch (e) { next(e); }
  });

const safeName = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

function runWorker(data) {
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, "import-worker.js"), { workerData: data });
    w.once("message", (m) => (m.ok ? resolve(m.result) : reject(new Error(m.error))));
    w.once("error", reject);
  });
}

const shape = (j) => ({ id: j.id, status: j.status, filename: j.filename,
  counts: j.counts, error: j.error, created_at: j.created_at,
  committed_at: j.committed_at });

async function jobOr404(req, res) {
  const j = (await query("SELECT * FROM import_jobs WHERE id = $1",
    [req.params.id])).rows[0];
  if (!j) res.status(404).json({ error: "no such import job" });
  return j || null;
}

async function stageBatch(jobId, seqStart, records) {
  const params = [];
  const tuples = records.map((r, i) =>
    `($${params.push(jobId)}, $${params.push(seqStart + i)}, $${params.push(JSON.stringify(r))})`);
  // idempotent by (job, seq): a retried batch overwrites itself, never doubles
  await query(
    `INSERT INTO import_rows (job_id, seq, payload) VALUES ${tuples.join(",")}
     ON CONFLICT (job_id, seq) DO UPDATE SET payload = EXCLUDED.payload`, params);
}

router.post("/api/import-jobs/:id/records", gate,
  express.json({ limit: "6mb" }), async (req, res, next) => {
    try {
      const j = await jobOr404(req, res);
      if (!j) return;
      if (j.status !== "open")
        return res.status(409).json({ error: `job is ${j.status}` });
      const seqStart = Math.max(0, Math.trunc(+req.body?.seq_start) || 0);
      const records = req.body?.records;
      if (!Array.isArray(records) || !records.length)
        return res.status(400).json({ error: "records[] required" });
      if (records.length > MAX_BATCH)
        return res.status(413).json({ error: `max ${MAX_BATCH} records per batch` });
      for (let i = 0; i < records.length; i++) {
        const bad = validateRecord(records[i]);
        if (bad) return res.status(422).json({ error: `record ${seqStart + i}: ${bad}` });
      }
      await stageBatch(j.id, seqStart, records);
      res.json({ ok: true, staged: records.length });
    } catch (e) { next(e); }
  });

router.post("/api/import-jobs/:id/commit", gate, async (req, res, next) => {
  try {
    const j = await jobOr404(req, res);
    if (!j) return;
    if (j.status === "committed") return res.json(shape(j));   // replay-safe
    if (j.status !== "open")
      return res.status(409).json({ error: `job is ${j.status}` });
    const out = await commitJob(j.id, req.actor, req.user?.id ?? null);
    res.json(shape(out));
  } catch (e) { next(e); }
});

router.get("/api/import-jobs/:id", gate, async (req, res) => {
  const j = await jobOr404(req, res);
  if (j) res.json(shape(j));
});

router.post("/api/import-jobs/:id/abort", gate, async (req, res, next) => {
  try {
    const j = await jobOr404(req, res);
    if (!j) return;
    if (j.status !== "open")
      return res.status(409).json({ error: `job is ${j.status}` });
    const row = (await query(
      `UPDATE import_jobs SET status = 'aborted' WHERE id = $1 RETURNING *`,
      [j.id])).rows[0];
    res.json(shape(row));
  } catch (e) { next(e); }
});

/* ---------------- the commit: dedupe + upsert, sized to the import */
async function commitJob(jobId, actor, userId) {
  await query("UPDATE import_jobs SET status = 'processing' WHERE id = $1", [jobId]);
  try {
    const out = await tx(async (client) => {
      const staged = (await client.query(
        "SELECT payload FROM import_rows WHERE job_id = $1 ORDER BY seq",
        [jobId])).rows.map((r) => r.payload);

      /* candidate prefetch: every phone key and email THIS IMPORT mentions,
         resolved in two indexed queries — proportional to the file, never a
         scan of the base (the old SCAN_CAP world) */
      const pks = [...new Set(staged.map((r) => r.fields.phone_key ||
        D.pk(r.fields.phone)).filter(Boolean))];
      const emails = [...new Set(staged.map((r) =>
        (r.fields.email || "").toLowerCase()).filter(Boolean))];
      const byPhone = new Map(), byEmail = new Map();
      const indexRow = (row) => {
        const id = D.ident({ email: row.email, city: row.city },
          row.company || row.name);
        id.phone = row.phone_key || null;
        if (id.phone) (byPhone.get(id.phone) || byPhone.set(id.phone, []).get(id.phone)).push(id);
        if (id.email) (byEmail.get(id.email) || byEmail.set(id.email, []).get(id.email)).push(id);
      };
      if (pks.length)
        for (const row of (await client.query(
          `SELECT name, company, email, city, phone_key FROM leads
           WHERE phone_key = ANY($1)`, [pks])).rows) indexRow(row);
      if (emails.length)
        for (const row of (await client.query(
          `SELECT name, company, email, city, phone_key FROM leads
           WHERE lower(email) = ANY($1)`, [emails])).rows) indexRow(row);

      const banned = new Set((await client.query(
        "SELECT phone_key FROM blocklist")).rows.map((r) => r.phone_key));

      const kept = { alias: new Map() };
      const c = { inserted: { company: 0, person: 0, job: 0 },
        updated: 0, duplicates: 0, blocked: 0, skipped: 0 };

      for (const rec of staged) {
        const f = rec.fields;
        if (rec.lead_code) {                       // pipeline: code IS identity
          const code = String(rec.lead_code).toUpperCase();
          const hit = (await client.query(
            `SELECT id FROM leads WHERE lead_code = $1
             UNION SELECT lead_id FROM lead_code_aliases WHERE code = $1`,
            [code])).rows[0];
          if (hit) {
            /* facts win from files, but blanks never blank a populated cell
               (only non-null fields are applied), and a row where nothing
               actually moved is a skip, not an update — the WHERE clause
               makes the no-op visible in rowCount */
            const sets = [], checks = [], params = [];
            for (const [k, v] of Object.entries(f)) {
              if (v === null || v === undefined || k === "notes") continue;
              const pv = `$${params.push(fieldVal(k, v))}`;
              sets.push(`${k} = ${pv}`);
              checks.push(`leads.${k} IS DISTINCT FROM ${pv}`);
            }
            if (sets.length) {
              sets.push("updated_at = now()");
              const r = await client.query(
                `UPDATE leads SET ${sets.join(", ")}
                 WHERE id = $${params.push(hit.id)} AND (${checks.join(" OR ")})`,
                params);
              r.rowCount ? c.updated++ : c.skipped++;
            } else c.skipped++;
          } else {
            await insertLead(client, code, rec.kind, f, banned, c);
          }
          continue;
        }

        /* file record: identity dedupe with the franchise guards */
        const id = D.ident({ email: f.email, phone: f.phone, city: f.city },
          f.company || f.name);
        if (!id.phone) id.phone = f.phone_key || null;
        const inBase =
          (id.phone && (byPhone.get(id.phone) || []).some((o) => D.phoneAgrees(id, o))) ||
          (id.email && (byEmail.get(id.email) || []).some((o) => D.emailAgrees(id, o)));
        let dupOfFile = false;
        if (!inBase) {
          dupOfFile =
            (id.phone && (byPhone.get(`file:${id.phone}`) || []).some((o) => D.phoneAgrees(id, o))) ||
            (id.email && (byEmail.get(`file:${id.email}`) || []).some((o) => D.emailAgrees(id, o)));
          if (!dupOfFile && id.city)
            for (const a of id.set) {
              const bucket = kept.alias.get(`${a}|${id.city}`) || [];
              if (bucket.some((o) => D.nameAgrees(id, o))) { dupOfFile = true; break; }
            }
        }
        if (inBase || dupOfFile) { c.duplicates++; continue; }
        const push = (m, k) => {
          if (!k) return;
          if (!m.has(k)) m.set(k, []);
          m.get(k).push(id);
        };
        push(byPhone, id.phone && `file:${id.phone}`);
        push(byEmail, id.email && `file:${id.email}`);
        if (id.city) for (const a of id.set) push(kept.alias, `${a}|${id.city}`);
        await insertLead(client, D.mintCode(), rec.kind, f, banned, c);
      }

      const countsJson = JSON.stringify(c);
      const job = (await client.query(
        `UPDATE import_jobs SET status = 'committed', counts = $1,
           committed_at = now() WHERE id = $2 RETURNING *`,
        [countsJson, jobId])).rows[0];
      await activity.log({ actor, user_id: userId, action: "import",
        to_value: job.filename, meta: c }, client);
      return job;
    });
    counts.invalidate();
    return out;
  } catch (e) {
    await query(
      `UPDATE import_jobs SET status = 'failed', error = $1 WHERE id = $2`,
      [String(e.message || e).slice(0, 500), jobId]).catch(() => {});
    throw e;
  }
}

async function insertLead(client, code, kind, f, banned, c) {
  const phoneKey = f.phone_key || D.pk(f.phone);
  const isBanned = !!phoneKey && banned.has(phoneKey);
  if (isBanned) c.blocked++;
  const cols = ["lead_code", "kind", "removed", "phone_key"];
  const vals = [code, kind, isBanned, phoneKey];
  for (const [k, v] of Object.entries(f)) {
    if (v === null || v === undefined || k === "phone_key") continue;
    cols.push(k);
    vals.push(fieldVal(k, v));
  }
  if (!cols.includes("name")) { cols.push("name"); vals.push(f.company || "(no name)"); }
  const row = (await client.query(
    `INSERT INTO leads (${cols.join(",")})
     VALUES (${vals.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`, vals)).rows[0];
  c.inserted[kind]++;
  /* register the natural keys, INSERT OR IGNORE semantics — a key that
     already belongs to another lead was claimed first (registry rule) */
  const keys = [];
  if (phoneKey) keys.push(["phone", phoneKey]);
  if (f.email) keys.push(["email", String(f.email).toLowerCase()]);
  const nc = D.normCo(f.company || f.name);
  if (nc && f.city) keys.push(["namecity", `${nc}|${String(f.city).toLowerCase()}`]);
  for (const [kt, kv] of keys)
    await client.query(
      `INSERT INTO lead_keys (kind, key_type, key_value, lead_id)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [kind, kt, kv, row.id]);
}

/* ---------------- identity lookup (TEMPORARY — phase 6a only) */
router.get("/api/identity-lookup", gate, async (req, res, next) => {
  try {
    const after = Math.max(0, Math.trunc(+req.query.cursor) || 0);
    const limit = Math.min(Math.max(+req.query.limit || 1000, 1), 2000);
    const rows = (await query(
      `SELECT id, lead_code, kind, email, phone_key, name, company, city, state
       FROM leads WHERE id > $1 ORDER BY id LIMIT $2`, [after, limit])).rows;
    res.json({
      list: rows,
      nextCursor: rows.length === limit ? rows[rows.length - 1].id : null,
      deprecated: "phase-6a shim; dedupe moves server-side in 6b",
    });
  } catch (e) { next(e); }
});

/* ---------------- bulk do-not-call (was dashboard/import_dnc.py's writes) */
router.post("/api/dnc-import", gate, express.json({ limit: "2mb" }), async (req, res, next) => {
  try {
    const raw = Array.isArray(req.body?.numbers) ? req.body.numbers : [];
    const dryRun = req.body?.dry_run !== false;      // dry run unless told otherwise
    const label = req.body?.source
      ? `DNC list (${String(req.body.source).slice(0, 120)})` : "DNC import";
    const keys = [...new Set(raw.map((n) => D.pk(n)).filter(Boolean))];
    const already = new Set((await query(
      "SELECT phone_key FROM blocklist WHERE phone_key = ANY($1)", [keys]))
      .rows.map((r) => r.phone_key));
    const fresh = keys.filter((k) => !already.has(k));
    const toRemove = fresh.length ? +(await query(
      `SELECT count(*)::int n FROM leads
       WHERE phone_key = ANY($1) AND NOT removed`, [fresh])).rows[0].n : 0;
    const plan = { rows: raw.length, usable: keys.length,
      alreadyBanned: already.size, newBans: fresh.length, leadsToRemove: toRemove };
    if (dryRun) return res.json({ dryRun: true, ...plan });

    await tx(async (client) => {
      for (const k of fresh)
        await client.query(
          `INSERT INTO blocklist (phone_key, reason, added_by)
           VALUES ($1, $2, $3) ON CONFLICT (phone_key) DO NOTHING`,
          [k, label, req.actor]);
      if (fresh.length)
        await client.query(
          `UPDATE leads SET removed = true, updated_at = now()
           WHERE phone_key = ANY($1) AND NOT removed`, [fresh]);
      await activity.log({ actor: req.actor,
        user_id: req.user?.id ?? null, action: "import",
        to_value: label, meta: { type: "dnc", ...plan } }, client);
    });
    counts.invalidate();
    res.json({ dryRun: false, ...plan });
  } catch (e) { next(e); }
});

module.exports = { router };
