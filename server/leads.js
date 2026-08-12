"use strict";
/* Leads: the list every tab reads, the detail pane, and every mutation.

   One table, one endpoint. The old client fetched three NocoDB tables and
   merged them in the browser (capped at 1,000 rows per table — Favorites
   could not page past it); here a union tab is just the same query without a
   kind filter. Sorting is keyset ("cursor"), not offset: page 400 costs the
   same as page 1, and rows shifting underneath a reader can't duplicate or
   swallow entries mid-pagination.

   Every mutation writes activity_log inside the same transaction — the
   manager's Team activity tab is fed by the API, not by the browser's
   honesty. Mutations also touch the caller's recents trail, so the Recent
   tab no longer depends on a separate fire-and-forget client call. */

const express = require("express");
const { query, tx } = require("./db");
const { requireUser } = require("./auth");
const activity = require("./activity");
const counts = require("./counts");
const { STATUSES } = require("./dedupe");

const router = express.Router();
/* path-scoped, not bare router.use(requireUser): every feature router is
   mounted at "/", so an unscoped guard here would intercept OTHER routers'
   requests too — it 401'd the service-token import routes before they were
   ever reached */
router.use(["/api/leads", "/api/comments"], requireUser);

/* the state filter accepts the two-letter code but the data holds both
   spellings ("FL" and "Florida") — a known data issue the query absorbs */
const STATE_NAME = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin",
  WY: "Wyoming", DC: "District of Columbia",
};

/* sort key -> [column, direction]; always NULLS LAST with id as tiebreaker */
const SORTS = {
  recent: ["date_added", "DESC"], oldest: ["date_added", "ASC"],
  name: ["name", "ASC"], name_z: ["name", "DESC"],
  size: ["employees", "DESC"], size_asc: ["employees", "ASC"],
  certs: ["certs", "DESC"], revenue: ["revenue", "DESC"],
  state: ["state", "ASC"], city: ["city", "ASC"], status: ["status", "ASC"],
};

/* The KPI tiles are work queues, not decoration: each one is clickable and
   lands here as ?focus=. Keep these predicates identical to the FILTER clauses
   in counts.js — a tile that says 412 and opens 380 rows is worse than no tile.
   Blank strings count as missing (importers write '' as readily as NULL). */
const FOCUS = {
  ready:      "status = 'New' AND nullif(btrim(phone), '') IS NOT NULL",
  enrich:     "nullif(btrim(phone), '') IS NULL AND nullif(btrim(email), '') IS NULL",
  unassigned: "nullif(btrim(owner), '') IS NULL",
  week:       "date_added >= current_date - 6",
};

const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const dec = (s) => { try { return JSON.parse(Buffer.from(s, "base64url").toString()); } catch { return null; } };

function buildFilters(p) {
  const where = [], params = [];
  const add = (sql, ...vals) => {
    where.push(sql.replace(/\?/g, () => `$${params.push(vals.shift())}`));
  };
  if (["company", "person", "job"].includes(p.kind)) add("kind = ?", p.kind);
  // removed=true is the DNC tab; everything else excludes banned leads
  add(p.removed === "true" ? "removed" : "NOT removed");
  // a deleted lead is in the admin's trash bin: no tab, DNC included, shows it
  add("deleted_at IS NULL");
  if (p.favorite === "true") add("favorite");
  if (STATUSES.includes(p.status)) add("status = ?", p.status);
  if (p.owner) add("owner = ?", p.owner);
  if (FOCUS[p.focus]) add(FOCUS[p.focus]);          // a KPI tile was clicked
  if (p.state && STATE_NAME[p.state.toUpperCase()]) {
    const ab = p.state.toUpperCase();
    add("(upper(state) = ? OR state ILIKE ?)", ab, STATE_NAME[ab]);
  }
  if (p.category) add("category = ?", p.category);   // with state = a segment
  if (p.q) {
    const q = `%${String(p.q).slice(0, 100)}%`;
    add(`(name ILIKE ? OR company ILIKE ? OR email ILIKE ?
          OR city ILIKE ? OR contact ILIKE ?)`, q, q, q, q, q);
  }
  return { where: where.join(" AND "), params };
}

/* keyset predicate for (col dir NULLS LAST, id dir): three cases because the
   cursor value may itself be in the NULL tail */
function keyset(col, dir, cursor, params) {
  const cmp = dir === "DESC" ? "<" : ">";
  if (cursor.v === null)
    return `(${col} IS NULL AND id ${cmp} $${params.push(cursor.id)})`;
  const pv = `$${params.push(cursor.v)}`;
  return `(${col} ${cmp} ${pv}
           OR (${col} = ${pv} AND id ${cmp} $${params.push(cursor.id)})
           OR ${col} IS NULL)`;
}

router.get("/api/leads", async (req, res, next) => {
  try {
    const p = req.query;
    // the Removed tab is a Manage surface: members never list banned leads
    // (their remove slip-ups are covered by the 5-second undo instead)
    if (p.removed === "true" && req.user.role !== "admin")
      return res.status(403).json({ error: "admins only" });
    const [col, dir] = SORTS[p.sort] || SORTS.recent;
    const limit = Math.min(Math.max(+p.limit || 50, 1), 200);
    const { where, params } = buildFilters(p);
    let cursorSql = "";
    if (p.cursor) {
      const c = dec(p.cursor);
      if (!c || !("v" in c) || !Number.isInteger(c.id))
        return res.status(400).json({ error: "bad cursor" });
      cursorSql = " AND " + keyset(col, dir, c, params);
    }
    const rows = (await query(
      `SELECT * FROM leads WHERE ${where}${cursorSql}
       ORDER BY ${col} ${dir} NULLS LAST, id ${dir} LIMIT $${params.push(limit + 1)}`,
      params)).rows;
    const more = rows.length > limit;
    if (more) rows.pop();
    const last = rows[rows.length - 1];
    // total only on the first page — it's identical on every later one
    let total = null;
    if (!p.cursor) {
      const f = buildFilters(p);
      total = +(await query(
        `SELECT count(*)::int n FROM leads WHERE ${f.where}`, f.params)).rows[0].n;
    }
    res.json({
      list: rows, total,
      nextCursor: more ? enc({ v: last[col] ?? null, id: last.id }) : null,
    });
  } catch (e) { next(e); }
});

/* one lead plus everything the reading pane shows beside it */
router.get("/api/leads/:key", async (req, res, next) => {
  try {
    const row = await findLead(req.params.key);
    if (!row) return res.status(404).json({ error: "no such lead" });
    const related = { company: null, people: [], jobs: [], similar: null };
    const coId = row.kind === "company" ? row.id : row.company_lead_id;
    if (coId) {
      if (row.kind !== "company")
        related.company = (await query(
          `SELECT id, lead_code, name, city, state, logo_url FROM leads
           WHERE id = $1 AND deleted_at IS NULL`, [coId])).rows[0] || null;
      related.people = (await query(
        `SELECT id, lead_code, name, title, email, phone FROM leads
         WHERE kind = 'person' AND company_lead_id = $1 AND NOT removed
           AND deleted_at IS NULL AND id <> $2 ORDER BY id LIMIT 6`,
        [coId, row.id])).rows;
      related.jobs = (await query(
        `SELECT id, lead_code, name, city, state, job_url FROM leads
         WHERE kind = 'job' AND company_lead_id = $1 AND NOT removed
           AND deleted_at IS NULL AND id <> $2
         ORDER BY date_added DESC NULLS LAST LIMIT 4`, [coId, row.id])).rows;
    }
    if (row.kind === "company" && row.category && row.state) {
      const seg = (await query(
        `SELECT count(*)::int n FROM leads
         WHERE kind = 'company' AND NOT removed AND deleted_at IS NULL
           AND category = $1 AND state = $2 AND id <> $3`,
        [row.category, row.state, row.id])).rows[0];
      related.similar = { category: row.category, state: row.state, count: seg.n };
    }
    res.json({ ...row, related });
  } catch (e) { next(e); }
});

/* a lead in the trash bin is not findable — a stale link 404s rather than
   opening a record the app is meant to have stopped showing */
async function findLead(key) {
  if (/^\d+$/.test(key))
    return (await query(
      "SELECT * FROM leads WHERE id = $1 AND deleted_at IS NULL", [+key])).rows[0];
  const code = String(key).toUpperCase();
  const direct = (await query(
    "SELECT * FROM leads WHERE lead_code = $1 AND deleted_at IS NULL", [code])).rows[0];
  if (direct) return direct;
  // a tombstoned code from an old bookmark still resolves
  return (await query(
    `SELECT l.* FROM lead_code_aliases a JOIN leads l ON l.id = a.lead_id
     WHERE a.code = $1 AND l.deleted_at IS NULL`, [code])).rows[0];
}

const touchRecent = (client, userId, leadId, kind) => client.query(
  `INSERT INTO recents (user_id, lead_id, kind) VALUES ($1, $2, $3)
   ON CONFLICT (user_id, lead_id) DO UPDATE SET touched_at = now(), kind = $3`,
  [userId, leadId, kind]);

/* status / owner / favorite — the three judgement fields the UI edits */
router.patch("/api/leads/:id", express.json({ limit: "8kb" }), async (req, res, next) => {
  try {
    const id = +req.params.id;
    const b = req.body || {};
    if ("status" in b && !STATUSES.includes(b.status))
      return res.status(400).json({ error: "unknown status" });
    const row = await tx(async (client) => {
      const cur = (await client.query(
        `SELECT * FROM leads WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [id])).rows[0];
      if (!cur) return null;
      const sets = [], params = [];
      const logs = [];
      const change = (col, val, action, from, to) => {
        sets.push(`${col} = $${params.push(val)}`);
        logs.push({ action, from_value: from, to_value: to });
      };
      if ("status" in b && b.status !== cur.status)
        change("status", b.status, "status", cur.status, b.status);
      if ("owner" in b) {
        const owner = b.owner ? String(b.owner).slice(0, 120) : null;
        if (owner !== cur.owner)
          change("owner", owner, "owner",
            cur.owner || "unassigned", owner || "unassigned");
      }
      if ("favorite" in b && !!b.favorite !== cur.favorite)
        change("favorite", !!b.favorite, b.favorite ? "favorite" : "unfavorite");
      if (!sets.length) return cur;
      sets.push("updated_at = now()");
      const updated = (await client.query(
        `UPDATE leads SET ${sets.join(", ")} WHERE id = $${params.push(id)}
         RETURNING *`, params)).rows[0];
      for (const l of logs)
        await activity.log({ actor: req.user.email, user_id: req.user.id,
          lead_id: id, lead_code: cur.lead_code, lead_name: cur.name, ...l }, client);
      await touchRecent(client, req.user.id, id, logs[0]?.action || "open");
      return updated;
    });
    if (!row) return res.status(404).json({ error: "no such lead" });
    // the KPI tiles are work queues now: taking a lead off New, or giving it an
    // owner, empties one of them. A 30s stale read would look like a lost click.
    counts.invalidate();
    res.json(row);
  } catch (e) { next(e); }
});

/* how many leads a ban would take down — the modal's blast radius line */
router.get("/api/leads/:id/remove-preview", async (req, res, next) => {
  try {
    const row = (await query(
      `SELECT phone_key FROM leads WHERE id = $1 AND deleted_at IS NULL`,
      [+req.params.id])).rows[0];
    if (!row) return res.status(404).json({ error: "no such lead" });
    if (!row.phone_key) return res.json({ affected: 1 });
    const n = (await query(
      `SELECT count(*)::int n FROM leads
       WHERE phone_key = $1 AND NOT removed AND deleted_at IS NULL`,
      [row.phone_key])).rows[0].n;
    res.json({ affected: Math.max(n, 1) });
  } catch (e) { next(e); }
});

/* removal is a phone ban: blocklist the number, sweep every lead sharing it */
router.post("/api/leads/:id/remove", express.json({ limit: "8kb" }), async (req, res, next) => {
  try {
    const id = +req.params.id;
    const reason = String(req.body?.reason || "").slice(0, 300);
    const out = await tx(async (client) => {
      const cur = (await client.query(
        `SELECT * FROM leads WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [id])).rows[0];
      if (!cur) return null;
      let ids = [];
      if (cur.phone_key) {
        await client.query(
          `INSERT INTO blocklist (phone, phone_key, company, reason, added_by)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (phone_key) DO NOTHING`,
          [cur.phone, cur.phone_key, cur.company || cur.name, reason, req.user.email]);
        ids = (await client.query(
          `UPDATE leads SET removed = true, updated_at = now()
           WHERE phone_key = $1 AND NOT removed AND deleted_at IS NULL
           RETURNING id`,
          [cur.phone_key])).rows.map((r) => r.id);
      }
      if (!ids.length) {
        await client.query(
          "UPDATE leads SET removed = true, updated_at = now() WHERE id = $1", [id]);
        ids = [id];
      }
      await activity.log({ actor: req.user.email, user_id: req.user.id,
        action: "remove", lead_id: id, lead_code: cur.lead_code,
        lead_name: cur.name, to_value: reason || "no reason given",
        meta: { affected: ids.length } }, client);
      await touchRecent(client, req.user.id, id, "remove");
      // ids let the client's undo toast hand back exactly this sweep
      return { affected: ids.length, ids };
    });
    if (!out) return res.status(404).json({ error: "no such lead" });
    counts.invalidate();                 // a sweep moves every tile at once
    res.json(out);
  } catch (e) { next(e); }
});

router.post("/api/leads/:id/restore", express.json({ limit: "8kb" }), async (req, res, next) => {
  try {
    const id = +req.params.id;
    // the undo toast hands back the exact id set its remove swept — a plain
    // restore (no body) still un-removes just the one lead
    const extra = Array.isArray(req.body?.ids)
      ? req.body.ids.filter(Number.isInteger).slice(0, 500) : [];
    const ids = [...new Set([id, ...extra])];
    const out = await tx(async (client) => {
      const cur = (await client.query(
        `SELECT * FROM leads WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [id])).rows[0];
      if (!cur) return null;
      const affected = (await client.query(
        `UPDATE leads SET removed = false, updated_at = now()
         WHERE id = ANY($1) AND deleted_at IS NULL`, [ids])).rowCount;
      if (cur.phone_key)
        await client.query("DELETE FROM blocklist WHERE phone_key = $1",
          [cur.phone_key]);
      await activity.log({ actor: req.user.email, user_id: req.user.id,
        action: "restore", lead_id: id, lead_code: cur.lead_code,
        lead_name: cur.name, meta: { affected } }, client);
      await touchRecent(client, req.user.id, id, "restore");
      return { ok: true, affected };
    });
    if (!out) return res.status(404).json({ error: "no such lead" });
    counts.invalidate();
    res.json(out);
  } catch (e) { next(e); }
});

/* ---------------- notes (first-class, with edit/delete metadata) */
router.get("/api/leads/:id/comments", async (req, res, next) => {
  try {
    const rows = (await query(
      `SELECT id, author_email, author_user_id, body, created_at, updated_at
       FROM lead_comments
       WHERE lead_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
      [+req.params.id])).rows;
    res.json({ list: rows });
  } catch (e) { next(e); }
});

router.post("/api/leads/:id/comments", express.json({ limit: "16kb" }), async (req, res, next) => {
  try {
    const id = +req.params.id;
    const body = String(req.body?.body || "").trim().slice(0, 4000);
    if (!body) return res.status(400).json({ error: "empty note" });
    const out = await tx(async (client) => {
      const cur = (await client.query(
        "SELECT lead_code, name FROM leads WHERE id = $1", [id])).rows[0];
      if (!cur) return null;
      const row = (await client.query(
        `INSERT INTO lead_comments (lead_id, author_user_id, author_email, body)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [id, req.user.id, req.user.email, body])).rows[0];
      await activity.log({ actor: req.user.email, user_id: req.user.id,
        action: "note", lead_id: id, lead_code: cur.lead_code,
        lead_name: cur.name, to_value: body.slice(0, 200) }, client);
      await touchRecent(client, req.user.id, id, "note");
      return row;
    });
    if (!out) return res.status(404).json({ error: "no such lead" });
    res.json(out);
  } catch (e) { next(e); }
});

/* author edits their own note; an admin can edit or delete anyone's */
const canTouch = (req, c) =>
  c.author_user_id === req.user.id || req.user.role === "admin";

router.patch("/api/comments/:id", express.json({ limit: "16kb" }), async (req, res, next) => {
  try {
    const body = String(req.body?.body || "").trim().slice(0, 4000);
    if (!body) return res.status(400).json({ error: "empty note" });
    const c = (await query(
      "SELECT * FROM lead_comments WHERE id = $1 AND deleted_at IS NULL",
      [+req.params.id])).rows[0];
    if (!c) return res.status(404).json({ error: "no such note" });
    if (!canTouch(req, c)) return res.status(403).json({ error: "not your note" });
    const row = (await query(
      `UPDATE lead_comments SET body = $1, updated_at = now()
       WHERE id = $2 RETURNING *`, [body, c.id])).rows[0];
    res.json(row);
  } catch (e) { next(e); }
});

router.delete("/api/comments/:id", async (req, res, next) => {
  try {
    const c = (await query(
      "SELECT * FROM lead_comments WHERE id = $1 AND deleted_at IS NULL",
      [+req.params.id])).rows[0];
    if (!c) return res.status(404).json({ error: "no such note" });
    if (!canTouch(req, c)) return res.status(403).json({ error: "not your note" });
    await query("UPDATE lead_comments SET deleted_at = now() WHERE id = $1", [c.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = { router, STATE_NAME, findLead };
