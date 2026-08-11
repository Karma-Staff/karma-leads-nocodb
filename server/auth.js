"use strict";
/* Who is calling the domain API.

   One way in: WORKOS — a sealed AuthKit session in the `kl_session` cookie.
   Sign-in happens on WorkOS's hosted page — we store no passwords, run no
   reset flows, and validate the sealed session locally (it's an encrypted
   cookie; no network call except a refresh when it expires). Being able to
   sign in is NOT being invited: the email must exist in app_users, which the
   domain API owns. WorkOS's stable user id lands on app_users.oidc_sub at
   first login. (The NocoDB xc-auth adapter that bridged the migration was
   retired 2026-08-11.)

   Authorization comes from app_users + organization_memberships —
   'admin' | 'member' — never from the identity provider. */

const { query } = require("./db");

const APP_URL = "/app/";
const COOKIE = "kl_session";

/* ---------------- WorkOS ---------------- */
const WORKOS_ON = !!(process.env.WORKOS_API_KEY && process.env.WORKOS_CLIENT_ID
  && process.env.SESSION_SECRET && process.env.WORKOS_REDIRECT_URI);
let workos = null;
if (WORKOS_ON) {
  const { WorkOS } = require("@workos-inc/node");
  workos = new WorkOS(process.env.WORKOS_API_KEY,
    { clientId: process.env.WORKOS_CLIENT_ID });
} else {
  console.warn("[karma] WorkOS env incomplete (.env.server) — nobody can sign in");
}
const PASSWORD = process.env.SESSION_SECRET;

function getCookie(req, name) {
  for (const part of (req.get("cookie") || "").split(/; */)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name)
      return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

function setSession(res, sealed) {
  res.append("Set-Cookie",
    `${COOKIE}=${encodeURIComponent(sealed)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=34560000`);
}
const clearSession = (res) => res.append("Set-Cookie",
  `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);

/* the sealed cookie -> a WorkOS user, refreshing (and re-setting the cookie)
   when the access token inside has expired. null = not signed in this way. */
async function workosUser(req, res) {
  const sealed = getCookie(req, COOKIE);
  if (!workos || !sealed) return null;
  try {
    let session = workos.userManagement.loadSealedSession(
      { sessionData: sealed, cookiePassword: PASSWORD });
    let auth = await session.authenticate();
    if (!auth.authenticated) {
      const r = await session.refresh({ cookiePassword: PASSWORD });
      if (!r.authenticated || !r.sealedSession) return null;
      if (res) setSession(res, r.sealedSession);
      session = workos.userManagement.loadSealedSession(
        { sessionData: r.sealedSession, cookiePassword: PASSWORD });
      auth = await session.authenticate();
      if (!auth.authenticated) return null;
    }
    return auth.user || null;
  } catch { return null; }
}

/* ---------------- shared ---------------- */
async function userByEmail(email) {
  const r = await query(
    `SELECT u.id, u.email, u.display_name, m.role
     FROM app_users u
     LEFT JOIN organization_memberships m ON m.user_id = u.id
     WHERE u.email = $1 AND NOT u.disabled`, [email]);
  return r.rows[0] || null;
}

/* resolve the caller, or null. {id: null} = authenticated but not invited. */
async function resolve(req, res) {
  let email = null;
  const wu = await workosUser(req, res);
  if (wu) email = String(wu.email || "").trim().toLowerCase();
  if (!email) return null;
  const u = await userByEmail(email);
  if (!u) return { email, id: null, role: null };
  return { id: u.id, email: u.email, name: u.display_name, role: u.role || "member" };
}

function requireUser(req, res, next) {
  resolve(req, res).then((user) => {
    if (!user) return res.status(401).json({ error: "Not signed in" });
    if (!user.id) return res.status(403).json({
      error: `${user.email} is not invited to Karma Leads — ask your manager.` });
    req.user = user;
    next();
  }).catch(next);
}

function requireAdmin(req, res, next) {
  requireUser(req, res, () => {
    if (req.user.role !== "admin")
      return res.status(403).json({ error: "Admins only — ask your manager." });
    next();
  });
}

/* ---------------- routes (mounted by index.js) ---------------- */
function mountAuthRoutes(app) {
  if (WORKOS_ON) {
    app.get("/api/auth/login", (req, res) => {
      res.redirect(workos.userManagement.getAuthorizationUrl({
        provider: "authkit",
        clientId: process.env.WORKOS_CLIENT_ID,
        redirectUri: process.env.WORKOS_REDIRECT_URI,
      }));
    });

    app.get("/api/auth/callback", async (req, res) => {
      const back = (msg) =>
        res.redirect(`${APP_URL}?authError=${encodeURIComponent(msg)}`);
      try {
        const code = String(req.query.code || "");
        if (!code) return back(String(req.query.error_description ||
          req.query.error || "sign-in was cancelled"));
        const out = await workos.userManagement.authenticateWithCode({
          clientId: process.env.WORKOS_CLIENT_ID,
          code,
          session: { sealSession: true, cookiePassword: PASSWORD },
        });
        const email = String(out.user?.email || "").trim().toLowerCase();
        const u = await userByEmail(email);
        if (!u) {                       // authenticated, but not invited
          clearSession(res);
          return back(`${email} is not invited to Karma Leads — ask your manager.`);
        }
        // remember the provider's stable id and a display name, once known
        const name = [out.user.firstName, out.user.lastName]
          .filter(Boolean).join(" ") || null;
        await query(
          `UPDATE app_users SET oidc_sub = $1,
             display_name = COALESCE(display_name, $2) WHERE id = $3`,
          [out.user.id, name, u.id]);
        setSession(res, out.sealedSession);
        res.redirect(APP_URL);
      } catch (e) {
        console.error("[karma] auth callback failed:", e.message);
        back("sign-in failed — try again");
      }
    });

    app.post("/api/auth/logout", async (req, res) => {
      let url = APP_URL;
      try {
        const sealed = getCookie(req, COOKIE);
        if (sealed) {
          const session = workos.userManagement.loadSealedSession(
            { sessionData: sealed, cookiePassword: PASSWORD });
          url = await session.getLogoutUrl();   // revokes the WorkOS session too
        }
      } catch { /* fall back to a plain local sign-out */ }
      clearSession(res);
      res.json({ url });
    });
  }
}

module.exports = { requireUser, requireAdmin, resolve, mountAuthRoutes, WORKOS_ON };
