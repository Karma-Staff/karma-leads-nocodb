"use strict";
/* Bulk actions on a selection (admin only).

   The list pane lets an admin tick rows and then do one of three things to the
   whole selection: assign an owner, ban the numbers (DNC), or move them to the
   trash. Nothing here is a new kind of mutation — each route is the loop-free
   version of the single-lead route it mirrors, and every invariant those
   routes carry is repeated here rather than routed around:

     assign  -> PATCH /api/leads/:id  {owner}
     dnc     -> POST  /api/leads/:id/remove   (phone ban + sweep, blocklist)
     delete  -> DELETE /api/leads/:id         (trash bin, company takes its jobs)

   Mounted under /api/bulk, NOT /api/leads/bulk: leads.js owns
   POST /api/leads/:id/remove, and "bulk" would land there as :id.

   Activity: one summary row per action, not one per lead. The log is what the
   manager reads, and a 300-lead assign written 300 times would push everything
   else off the feed; the summary carries the affected ids in meta, so nothing
   about who-did-what-to-which-lead is actually lost. The action names stay
   inside activity_log's CHECK list ('owner', 'remove', 'delete') — the feed
   renders them with a bulk branch keyed off meta.bulk.

   Recents are deliberately NOT touched: the Recent tab is a trail of leads a
   person actually worked, and one bulk action would flood all 50 slots. */

const express = require("express");
const { query, tx } = require("./db");
const { requireAdmin, requireUser } = require("./auth");
const activity = require("./activity");
const counts = require("./counts");

const router = express.Router();
/* the ceiling is the front end's too — a selection is something a person
   ticked, not a whole filtered view */
const MAX_IDS = 500;

router.use("/api/bulk", requireAdmin, express.json({ limit: "64kb" }));

const idsOf = (body) => [...new Set(
  (Array.isArray(body?.ids) ? body.ids : [])
    .map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, MAX_IDS);

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/* ---------------- preview: the blast radius, before the modal asks

   One pass answers both destructive modals: how many leads a DNC would ban
   (the selection plus everything else sharing its numbers) and how many extra
   job postings a delete would sweep in behind the selected companies. */
router.post("/api/bulk/preview", async (req, res, next) => {
  try {
    const ids = idsOf(req.body);
    if (!ids.length) return res.json({ leads: 0, dnc: 0, jobs: 0 });
    const r = (await query(
      `WITH sel AS (
         SELECT id, kind, phone_key, removed FROM leads
         WHERE id = ANY($1) AND deleted_at IS NULL)
       SELECT
         (SELECT count(*)::int FROM sel)                            AS leads,
         (SELECT count(*)::int FROM leads l
           WHERE l.deleted_at IS NULL AND NOT l.removed
             AND (l.id IN (SELECT id FROM sel)
                  OR l.phone_key IN
                     (SELECT phone_key FROM sel WHERE phone_key IS NOT NULL)))
                                                                    AS dnc,
         (SELECT count(*)::int FROM leads j
           WHERE j.kind = 'job' AND j.deleted_at IS NULL
             AND j.company_lead_id IN (SELECT id FROM sel WHERE kind = 'company')
             AND j.id NOT IN (SELECT id FROM sel))                  AS jobs
      `, [ids])).rows[0];
    res.json({ leads: r.leads, dnc: r.dnc, jobs: r.jobs });
  } catch (e) { next(e); }
});

/* ---------------- assign an owner

   The owner column is free text (it holds email addresses today, but the old
   system wrote plain names too), so this takes a string exactly like the
   single-lead PATCH does — the search in the modal is there to stop one person
   being spelled three ways, not to turn owner into a foreign key. An empty
   owner unassigns. */
router.post("/api/bulk/assign", async (req, res, next) => {
  try {
    const ids = idsOf(req.body);
    if (!ids.length) return res.status(400).json({ error: "nothing selected" });
    const raw = String(req.body?.owner ?? "").trim();
    const owner = raw ? raw.slice(0, 120) : null;
    const out = await tx(async (client) => {
      const changed = (await client.query(
        `UPDATE leads SET owner = $1, updated_at = now()
         WHERE id = ANY($2) AND deleted_at IS NULL
           AND owner IS DISTINCT FROM $1
         RETURNING id`, [owner, ids])).rows.map((r) => r.id);
      // re-assigning leads to the owner they already had is not an event
      if (changed.length)
        await activity.log({
          actor: req.user.email, user_id: req.user.id, action: "owner",
          lead_name: plural(changed.length, "lead"),
          to_value: owner || "unassigned",
          meta: { bulk: true, count: changed.length, selected: ids.length,
            owner, ids: changed },
        }, client);
      return { affected: changed.length, owner };
    });
    counts.invalidate();          // the Unassigned tile is one of the queues
    res.json(out);
  } catch (e) { next(e); }
});

/* ---------------- DNC: ban every number in the selection

   Same contract as the single-lead ban: the number goes on the blocklist so
   future imports stay out, and EVERY lead sharing it is swept — not just the
   ones that were ticked. A selected lead with no usable phone_key is still
   removed on its own (pk() refuses Bitrix placeholder numbers, and those leads
   must not drag 46 strangers down with them). */
router.post("/api/bulk/dnc", async (req, res, next) => {
  try {
    const ids = idsOf(req.body);
    if (!ids.length) return res.status(400).json({ error: "nothing selected" });
    const reason = String(req.body?.reason || "").slice(0, 300);
    const out = await tx(async (client) => {
      const sel = (await client.query(
        `SELECT id, name, company, phone, phone_key FROM leads
         WHERE id = ANY($1) AND deleted_at IS NULL
         ORDER BY id FOR UPDATE`, [ids])).rows;
      if (!sel.length) return null;
      // one row per distinct number, not per lead
      const keys = [...new Map(sel.filter((r) => r.phone_key)
        .map((r) => [r.phone_key, r])).values()];
      if (keys.length)
        await client.query(
          `INSERT INTO blocklist (phone, phone_key, company, reason, added_by)
           SELECT * FROM unnest($1::text[], $2::text[], $3::text[],
                                $4::text[], $5::text[])
           ON CONFLICT (phone_key) DO NOTHING`,
          [keys.map((k) => k.phone), keys.map((k) => k.phone_key),
            keys.map((k) => k.company || k.name), keys.map(() => reason),
            keys.map(() => req.user.email)]);
      const swept = (await client.query(
        `UPDATE leads SET removed = true, updated_at = now()
         WHERE NOT removed AND deleted_at IS NULL
           AND (id = ANY($1) OR phone_key = ANY($2))
         RETURNING id`,
        [sel.map((r) => r.id), keys.map((k) => k.phone_key)])).rows.map((r) => r.id);
      await activity.log({
        actor: req.user.email, user_id: req.user.id, action: "remove",
        lead_name: plural(swept.length, "lead"),
        to_value: reason || "no reason given",
        meta: { bulk: true, count: swept.length, selected: sel.length,
          numbers: keys.length, affected: swept.length, ids: swept },
      }, client);
      return { affected: swept.length, selected: sel.length,
        numbers: keys.length, ids: swept };
    });
    if (!out) return res.status(404).json({ error: "nothing to remove" });
    counts.invalidate();          // a sweep moves every tile at once
    res.json(out);
  } catch (e) { next(e); }
});

/* ---------------- delete: the whole selection to the trash bin

   The cascade rule from trash.js, unchanged: a company takes its job postings
   with it, a job never touches its company. now() is transaction-stable, so
   the batch shares one deleted_at — and that shared stamp is what lets the
   bin's per-lead restore put back exactly one company and its own jobs. */
router.post("/api/bulk/delete", async (req, res, next) => {
  try {
    const ids = idsOf(req.body);
    if (!ids.length) return res.status(400).json({ error: "nothing selected" });
    const out = await tx(async (client) => {
      const rows = (await client.query(
        `UPDATE leads SET deleted_at = now(), deleted_by = $2, updated_at = now()
         WHERE deleted_at IS NULL
           AND (id = ANY($1)
                OR (kind = 'job' AND company_lead_id = ANY(
                      SELECT id FROM leads
                      WHERE id = ANY($1) AND kind = 'company')))
         RETURNING id, kind, (id = ANY($1)) AS picked`,
        [ids, req.user.email])).rows;
      if (!rows.length) return null;
      const jobs = rows.filter((r) => !r.picked).length;   // swept in behind
      await activity.log({
        actor: req.user.email, user_id: req.user.id, action: "delete",
        lead_name: plural(rows.length, "lead"),
        to_value: `to trash${jobs ? ` with ${plural(jobs, "job posting")}` : ""}`,
        meta: { bulk: true, count: rows.length, selected: ids.length, jobs,
          ids: rows.map((r) => r.id) },
      }, client);
      return { affected: rows.length, jobs };
    });
    if (!out) return res.status(404).json({ error: "nothing to delete" });
    counts.invalidate();
    res.json(out);
  } catch (e) { next(e); }
});

/* ---------------- who a lead can be assigned to

   Two populations, one list: the team's accounts (who you'd normally hand work
   to) and the owner strings already on leads (imports and the old system wrote
   this column for years). Matching an existing spelling exactly is the point —
   ?owner= filters on equality, so "Maria" and "maria@karmastaff.com" would be
   two different work queues.

   Which is why an account's assignable VALUE is its email, never its display
   name: that is what the column already holds (every owned lead in the base
   carries an @karmastaff.com address). The display name is only a label. */
router.get("/api/owners", requireUser, async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim().slice(0, 60);
    const like = `%${q}%`;
    const used = (await query(
      `SELECT btrim(owner) AS value, count(*)::int AS leads
       FROM leads
       WHERE deleted_at IS NULL AND nullif(btrim(owner), '') IS NOT NULL
         AND ($1 = '' OR owner ILIKE $2)
       GROUP BY 1 ORDER BY leads DESC, value LIMIT 25`, [q, like])).rows;
    const team = (await query(
      `SELECT u.email, u.display_name FROM app_users u
       WHERE NOT u.disabled
         AND ($1 = '' OR u.email ILIKE $2 OR coalesce(u.display_name, '') ILIKE $2)
       ORDER BY coalesce(u.display_name, u.email) LIMIT 25`, [q, like])).rows;
    const counted = new Map(used.map((r) => [r.value, r.leads]));
    const out = [];
    const seen = new Set();
    for (const u of team) {
      if (seen.has(u.email)) continue;
      seen.add(u.email);
      out.push({ value: u.email, label: u.display_name || u.email,
        leads: counted.get(u.email) || 0, team: true });
    }
    /* an owner string that is nobody's account — a name typed in the old
       system, or someone who has left — stays offered so a re-assign can be
       made to match what is already there */
    for (const r of used) {
      if (seen.has(r.value)) continue;
      seen.add(r.value);
      out.push({ value: r.value, label: r.value, leads: r.leads, team: false });
    }
    res.json({ list: out.slice(0, 30) });
  } catch (e) { next(e); }
});

module.exports = { router, MAX_IDS };
