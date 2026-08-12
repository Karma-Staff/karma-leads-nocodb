"use strict";
/* The trash bin — the admin's delete, and the only path in the system that
   destroys lead data.

   Two different things are called "removing" a lead, and they must not be
   confused:

     remove  (server/leads.js, any member) — the do-not-call ban. The phone
             number goes on the blocklist, every lead sharing it is swept, and
             the rows stay in the database under Manage → DNC.
     delete  (here, admins only)           — the lead leaves the app. It sits
             in the bin for 30 days so a mistake is recoverable, then the row
             and everything hanging off it (keys, aliases, notes, recents) is
             gone for good.

   Cascade rule, deliberately asymmetric: deleting a company takes its job
   postings with it (a posting without its employer is noise), but deleting a
   job never touches the company the scrape created — the company is the
   valuable half. Because now() is transaction-stable, a company and the jobs
   it swept share one deleted_at, and that shared timestamp is what lets one
   restore put back exactly that sweep and nothing else. */

const express = require("express");
const { query, tx } = require("./db");
const { requireAdmin } = require("./auth");
const activity = require("./activity");
const counts = require("./counts");

const router = express.Router();
const PURGE_AFTER_DAYS = 30;
const LIST_CAP = 500;

/* Hard delete, for real. Everything that references a lead cascades on its own
   (lead_keys, lead_code_aliases, lead_comments, recents) and activity_log
   deliberately has no FK — it outlives its leads. The one exception is
   leads.company_lead_id, which has no ON DELETE clause: a surviving person or
   job still pointing at a purged company would refuse the delete, so cut those
   links first. Returns how many leads were destroyed. */
async function purge(cutoff, actor) {
  return tx(async (client) => {
    const ids = (await client.query(
      `SELECT id FROM leads
       WHERE deleted_at IS NOT NULL AND deleted_at <= $1
       ORDER BY id FOR UPDATE`, [cutoff])).rows.map((r) => r.id);
    if (!ids.length) return 0;
    await client.query(
      "UPDATE leads SET company_lead_id = NULL WHERE company_lead_id = ANY($1)",
      [ids]);
    await client.query("DELETE FROM leads WHERE id = ANY($1)", [ids]);
    await activity.log({ actor, action: "purge",
      to_value: `${ids.length} lead${ids.length === 1 ? "" : "s"} destroyed`,
      meta: { count: ids.length } }, client);
    return ids.length;
  });
}

const cutoffDate = (days) => new Date(Date.now() - days * 86400e3);

/* the 30-day sweep: once at boot (a box that was off over the weekend still
   catches up) and once a day after that */
async function sweep() {
  try {
    const n = await purge(cutoffDate(PURGE_AFTER_DAYS), "system");
    if (n) {
      counts.invalidate();
      console.log(`[karma] trash sweep: destroyed ${n} lead(s) older than ${PURGE_AFTER_DAYS} days`);
    }
  } catch (e) {
    console.warn("[karma] trash sweep failed:", e.message);
  }
}

function startSweeper() {
  sweep();
  const t = setInterval(sweep, 24 * 3600e3);
  t.unref?.();                       // never hold the process open on its own
  return t;
}

/* ---------------- delete (admin) */

/* what the confirm modal shows before the click: the jobs a company takes down */
router.get("/api/leads/:id/delete-preview", requireAdmin, async (req, res, next) => {
  try {
    const cur = (await query(
      "SELECT id, kind FROM leads WHERE id = $1 AND deleted_at IS NULL",
      [+req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ error: "no such lead" });
    let jobs = 0;
    if (cur.kind === "company")
      jobs = (await query(
        `SELECT count(*)::int n FROM leads
         WHERE kind = 'job' AND company_lead_id = $1 AND deleted_at IS NULL`,
        [cur.id])).rows[0].n;
    res.json({ kind: cur.kind, jobs, purgeAfterDays: PURGE_AFTER_DAYS });
  } catch (e) { next(e); }
});

router.delete("/api/leads/:id", requireAdmin, async (req, res, next) => {
  try {
    const id = +req.params.id;
    const out = await tx(async (client) => {
      const cur = (await client.query(
        "SELECT * FROM leads WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
        [id])).rows[0];
      if (!cur) return null;
      const where = cur.kind === "company"
        ? "(id = $1 OR (kind = 'job' AND company_lead_id = $1))"
        : "id = $1";
      const ids = (await client.query(
        `UPDATE leads SET deleted_at = now(), deleted_by = $2, updated_at = now()
         WHERE ${where} AND deleted_at IS NULL RETURNING id`,
        [id, req.user.email])).rows.map((r) => r.id);
      await activity.log({ actor: req.user.email, user_id: req.user.id,
        action: "delete", lead_id: id, lead_code: cur.lead_code,
        lead_name: cur.name,
        to_value: `to trash${ids.length > 1 ? ` with ${ids.length - 1} job posting${ids.length === 2 ? "" : "s"}` : ""}`,
        meta: { affected: ids.length, jobs: ids.length - 1 } }, client);
      /* the recents rows stay: the Recent tab's query skips trashed leads, so
         they simply vanish from the trail and come back with a restore */
      return { affected: ids.length, jobs: ids.length - 1 };
    });
    if (!out) return res.status(404).json({ error: "no such lead" });
    counts.invalidate();
    res.json(out);
  } catch (e) { next(e); }
});

/* ---------------- the bin (admin) */

router.get("/api/trash", requireAdmin, async (req, res, next) => {
  try {
    const rows = (await query(
      `SELECT id, lead_code, kind, name, company, city, state, phone,
              source, deleted_at, deleted_by
       FROM leads WHERE deleted_at IS NOT NULL
       ORDER BY deleted_at DESC, id DESC LIMIT $1`, [LIST_CAP])).rows;
    const total = (await query(
      "SELECT count(*)::int n FROM leads WHERE deleted_at IS NOT NULL")).rows[0].n;
    res.json({ list: rows, total, shown: rows.length,
      cap: LIST_CAP, purgeAfterDays: PURGE_AFTER_DAYS });
  } catch (e) { next(e); }
});

router.post("/api/trash/:id/restore", requireAdmin, async (req, res, next) => {
  try {
    const id = +req.params.id;
    const out = await tx(async (client) => {
      const cur = (await client.query(
        "SELECT * FROM leads WHERE id = $1 AND deleted_at IS NOT NULL FOR UPDATE",
        [id])).rows[0];
      if (!cur) return null;
      /* Only the jobs THIS delete swept come back — matched on the shared
         stamp. The comparison stays in SQL on purpose: timestamptz is stored
         to the microsecond and a JS Date only holds milliseconds, so handing
         cur.deleted_at back as a parameter matches nothing. The subquery reads
         the statement's snapshot, i.e. the value before this UPDATE clears it. */
      const where = cur.kind === "company"
        ? `(id = $1 OR (kind = 'job' AND company_lead_id = $1
             AND deleted_at = (SELECT deleted_at FROM leads WHERE id = $1)))`
        : "id = $1";
      const ids = (await client.query(
        `UPDATE leads SET deleted_at = NULL, deleted_by = NULL, updated_at = now()
         WHERE ${where} AND deleted_at IS NOT NULL RETURNING id`, [id]))
        .rows.map((r) => r.id);
      await activity.log({ actor: req.user.email, user_id: req.user.id,
        action: "undelete", lead_id: id, lead_code: cur.lead_code,
        lead_name: cur.name, meta: { affected: ids.length } }, client);
      return { affected: ids.length };
    });
    if (!out) return res.status(404).json({ error: "not in the trash" });
    counts.invalidate();
    res.json(out);
  } catch (e) { next(e); }
});

/* empty it now — this is the destructive one */
router.delete("/api/trash", requireAdmin, async (req, res, next) => {
  try {
    const destroyed = await purge(new Date(), req.user.email);
    counts.invalidate();
    res.json({ destroyed });
  } catch (e) { next(e); }
});

module.exports = { router, startSweeper, PURGE_AFTER_DAYS };
