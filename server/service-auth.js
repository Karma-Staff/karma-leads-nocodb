"use strict";
/* Service identities — how the Python pipeline authenticates.

   A service token is `klsvc_` + 40 random chars, stored ONLY as a sha256 hash
   in service_tokens with an explicit scope list. Revocation is a timestamp;
   rotation is mint-new-revoke-old. A service identity is NOT a user: it can
   reach exactly the routes its scope names (imports:write covers the import
   endpoints and nothing else), so a leaked pipeline credential cannot manage
   users, change roles, or touch the rest of the API.

   Mint / revoke via the CLI:
     node server/cli.js token:create pipeline imports:write
     node server/cli.js token:revoke pipeline                                 */

const crypto = require("crypto");
const { query } = require("./db");

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

async function resolveService(req) {
  const raw = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!raw.startsWith("klsvc_")) return null;
  const r = await query(
    `SELECT id, name, scopes FROM service_tokens
     WHERE token_hash = $1 AND revoked_at IS NULL`, [sha256(raw)]);
  return r.rows[0] || null;
}

/* admin session OR a service token holding the scope — the import routes
   accept both (drop-zone uploads come from an admin's browser, pipeline
   uploads from the service identity). */
function requireScope(scope, requireAdmin) {
  return (req, res, next) => {
    resolveService(req).then((svc) => {
      if (svc) {
        if (!svc.scopes.includes(scope))
          return res.status(403).json({ error: `token lacks scope ${scope}` });
        req.service = { name: svc.name, scopes: svc.scopes };
        req.actor = `service:${svc.name}`;
        return next();
      }
      // not a service token — fall through to the admin-user path
      requireAdmin(req, res, () => {
        req.actor = req.user.email;
        next();
      });
    }).catch(next);
  };
}

function mintToken() {
  return "klsvc_" + crypto.randomBytes(30).toString("base64url");
}

module.exports = { requireScope, resolveService, mintToken, sha256 };
