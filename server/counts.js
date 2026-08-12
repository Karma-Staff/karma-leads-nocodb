"use strict";
/* The KPI row and sidebar badges. The old client issued ~26 count requests per
   refresh (and every login); this is one SQL pass over leads, cached for 30
   seconds because at ten users the numbers cannot meaningfully drift faster,
   and a burst of logins should not become a burst of scans. */

const express = require("express");
const { query } = require("./db");
const { requireUser } = require("./auth");

const router = express.Router();
const TTL = 30_000;
let cached = null, cachedAt = 0;

router.get("/api/counts", requireUser, async (req, res, next) => {
  try {
    if (cached && Date.now() - cachedAt < TTL) return res.json(cached);
    const r = (await query(`
      SELECT
        count(*) FILTER (WHERE kind = 'company' AND NOT removed)::int AS companies,
        count(*) FILTER (WHERE kind = 'person'  AND NOT removed)::int AS people,
        count(*) FILTER (WHERE kind = 'job'     AND NOT removed)::int AS jobs,
        count(*) FILTER (WHERE favorite AND NOT removed)::int          AS favorites,
        count(*) FILTER (WHERE removed)::int                           AS removed,
        count(*) FILTER (WHERE status = 'New' AND NOT removed)::int    AS status_new,
        count(*) FILTER (WHERE status = 'Qualified' AND NOT removed)::int AS qualified,
        count(*) FILTER (WHERE phone IS NOT NULL AND NOT removed)::int AS with_phone,
        count(*) FILTER (WHERE email IS NOT NULL AND NOT removed)::int AS with_email,
        count(*) FILTER (WHERE date_added >= current_date - 6
                         AND NOT removed)::int                         AS week,
        count(*) FILTER (WHERE date_added >= current_date - 13
                         AND date_added < current_date - 6
                         AND NOT removed)::int                         AS prev_week
      FROM leads
      WHERE deleted_at IS NULL`)).rows[0];   // the trash bin counts as gone
    cached = { ...r, total: r.companies + r.people + r.jobs, at: new Date().toISOString() };
    cachedAt = Date.now();
    res.json(cached);
  } catch (e) { next(e); }
});

/* mutations call this so a status change is visible in the KPI row promptly */
const invalidate = () => { cached = null; };

module.exports = { router, invalidate };
