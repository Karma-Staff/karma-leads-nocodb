"use strict";
/* The team's action log — written BY THE API on every mutation, which is what
   makes the manager's Team activity tab trustworthy: a browser can't skip it,
   because the browser never writes it. (The one client-reported event is
   'open', logged via the recents route — it's a read; the server can't see it
   otherwise.)

   Append-only. Nothing here is ever updated or deleted; the Removed tab's
   Clear button clears a user's recents trail, never this. */

const { query } = require("./db");

/* fire-and-forget from the caller's point of view: a failed log line must
   never fail the user's action. Call sites inside a transaction pass their
   client instead so the log commits atomically with the change. */
function log(entry, client) {
  const q = client ? client.query.bind(client) : query;
  return q(
    `INSERT INTO activity_log
       (actor, user_id, action, lead_id, lead_code, lead_name,
        from_value, to_value, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [entry.actor, entry.user_id ?? null, entry.action,
     entry.lead_id ?? null, entry.lead_code ?? null, entry.lead_name ?? null,
     entry.from_value ?? null, entry.to_value ?? null,
     entry.meta ? JSON.stringify(entry.meta) : null],
  ).catch((e) => console.warn("[karma] activity log failed:", e.message));
}

/* everything the Team activity tab needs, in three queries over the window */
async function summary(days) {
  const n = Math.min(Math.max(Math.round(+days) || 30, 1), 365);
  const perDay = (await query(
    `SELECT to_char(d, 'YYYY-MM-DD') AS date,
            coalesce(jsonb_object_agg(a.actor, a.n) FILTER (WHERE a.actor IS NOT NULL),
                     '{}'::jsonb) AS by_who,
            coalesce(sum(a.n), 0)::int AS total
     FROM generate_series(current_date - ($1::int - 1), current_date, '1 day') d
     LEFT JOIN (SELECT at::date AS day, actor, count(*)::int AS n
                FROM activity_log
                WHERE at >= current_date - ($1::int - 1)
                GROUP BY 1, 2) a ON a.day = d
     GROUP BY d ORDER BY d`, [n])).rows;
  const perPerson = (await query(
    `SELECT actor AS who, sum(n)::int AS total,
            jsonb_object_agg(action, n) AS by_action, max(last) AS last
     FROM (SELECT actor, action, count(*)::int AS n, max(at) AS last
           FROM activity_log
           WHERE at >= current_date - ($1::int - 1)
           GROUP BY actor, action) x
     GROUP BY actor ORDER BY total DESC`, [n])).rows;
  const feed = (await query(
    `SELECT at, actor, action, lead_id, lead_code, lead_name,
            from_value, to_value, meta,
            (SELECT kind FROM leads WHERE leads.id = a.lead_id) AS lead_kind
     FROM activity_log a
     WHERE at >= current_date - ($1::int - 1)
     ORDER BY at DESC LIMIT 100`, [n])).rows;
  const total = perDay.reduce((s, d) => s + d.total, 0);
  return { days: n, total, perDay, perPerson, feed };
}

module.exports = { log, summary };
