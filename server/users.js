"use strict";
/* Admin user management — the domain API is the source of truth for who may
   sign in and what they may do. NocoDB has no say in this, and a service
   token cannot reach these routes at all (requireAdmin only accepts users).

   'Inviting' here means creating the app_users row; in the adapter phase the
   person also needs a NocoDB account to sign in with, and after the WorkOS
   cutover the hosted login handles the rest. */

const express = require("express");
const { query, tx } = require("./db");
const { requireAdmin } = require("./auth");

const router = express.Router();
router.use("/api/users", requireAdmin);    // path-scoped: routers share "/"

router.get("/api/users", async (req, res, next) => {
  try {
    const rows = (await query(
      `SELECT u.id, u.email, u.display_name, u.disabled, u.created_at, m.role,
              (SELECT max(at) FROM activity_log a WHERE a.user_id = u.id) AS last_active
       FROM app_users u
       LEFT JOIN organization_memberships m ON m.user_id = u.id
       ORDER BY u.email`)).rows;
    res.json({ list: rows });
  } catch (e) { next(e); }
});

router.post("/api/users", express.json({ limit: "4kb" }), async (req, res, next) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const role = req.body?.role === "admin" ? "admin" : "member";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      return res.status(400).json({ error: "bad email" });
    const row = await tx(async (client) => {
      const u = (await client.query(
        `INSERT INTO app_users (email, display_name) VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET disabled = false
         RETURNING *`, [email, req.body?.display_name || null])).rows[0];
      const org = (await client.query(
        "SELECT id FROM organizations ORDER BY id LIMIT 1")).rows[0];
      await client.query(
        `INSERT INTO organization_memberships (org_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (org_id, user_id) DO UPDATE SET role = $3`,
        [org.id, u.id, role]);
      return { ...u, role };
    });
    res.json(row);
  } catch (e) { next(e); }
});

router.patch("/api/users/:id", express.json({ limit: "4kb" }), async (req, res, next) => {
  try {
    const id = +req.params.id;
    const b = req.body || {};
    // the last admin cannot demote or disable themselves into a lockout
    if ((b.role === "member" || b.disabled === true)) {
      const admins = (await query(
        `SELECT count(*)::int n FROM organization_memberships m
         JOIN app_users u ON u.id = m.user_id
         WHERE m.role = 'admin' AND NOT u.disabled`)).rows[0].n;
      const target = (await query(
        `SELECT m.role FROM organization_memberships m WHERE m.user_id = $1`,
        [id])).rows[0];
      if (admins <= 1 && target?.role === "admin")
        return res.status(400).json({ error: "cannot remove the last admin" });
    }
    await tx(async (client) => {
      if ("disabled" in b)
        await client.query("UPDATE app_users SET disabled = $1 WHERE id = $2",
          [!!b.disabled, id]);
      if (b.role === "admin" || b.role === "member")
        await client.query(
          "UPDATE organization_memberships SET role = $1 WHERE user_id = $2",
          [b.role, id]);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = { router };
