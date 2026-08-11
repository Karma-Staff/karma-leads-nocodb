"use strict";
/* The Recent tab's per-account trail (was recents.json). A trail, not a log:
   50 leads, deduped by lead via the primary key, newest interaction first.
   Most touches now happen server-side inside the mutation routes; the one the
   client still reports is 'open', because opening a lead is a read.

   Clearing is per-account and touches ONLY this table — the activity log is
   append-only and not the user's to edit. */

const express = require("express");
const { query } = require("./db");
const { requireUser } = require("./auth");
const activity = require("./activity");

const router = express.Router();
router.use("/api/recents", requireUser);   // path-scoped: routers share "/"

const MAX = 50;

router.get("/api/recents", async (req, res, next) => {
  try {
    const rows = (await query(
      `SELECT l.*, r.touched_at, r.kind AS touch_kind
       FROM recents r JOIN leads l ON l.id = r.lead_id
       WHERE r.user_id = $1 AND NOT l.removed
       ORDER BY r.touched_at DESC LIMIT ${MAX}`, [req.user.id])).rows;
    res.json({ list: rows, max: MAX });
  } catch (e) { next(e); }
});

router.post("/api/recents", express.json({ limit: "4kb" }), async (req, res, next) => {
  try {
    const leadId = +req.body?.lead_id;
    if (!Number.isInteger(leadId) || leadId <= 0)
      return res.status(400).json({ error: "bad lead id" });
    const lead = (await query(
      "SELECT id, lead_code, name FROM leads WHERE id = $1", [leadId])).rows[0];
    if (!lead) return res.status(404).json({ error: "no such lead" });
    await query(
      `INSERT INTO recents (user_id, lead_id, kind) VALUES ($1, $2, 'open')
       ON CONFLICT (user_id, lead_id) DO UPDATE SET touched_at = now(), kind = 'open'`,
      [req.user.id, leadId]);
    // opens are worth having in the team log even though they're client-reported
    activity.log({ actor: req.user.email, user_id: req.user.id, action: "open",
      lead_id: lead.id, lead_code: lead.lead_code, lead_name: lead.name });
    // keep the table tidy: everything past the newest MAX entries can go
    await query(
      `DELETE FROM recents WHERE user_id = $1 AND lead_id NOT IN
         (SELECT lead_id FROM recents WHERE user_id = $1
          ORDER BY touched_at DESC LIMIT ${MAX})`, [req.user.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete("/api/recents", async (req, res, next) => {
  try {
    await query("DELETE FROM recents WHERE user_id = $1", [req.user.id]);
    res.json({ list: [], max: MAX });
  } catch (e) { next(e); }
});

module.exports = { router };
