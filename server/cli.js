"use strict";
/* Small admin CLI — the things that need a terminal, not an endpoint.

     node server/cli.js token:create <name> [scope ...]   mint a service token
     node server/cli.js token:revoke <name>               revoke by name
     node server/cli.js token:list
     node server/cli.js user:add <email> [admin|member]   invite / promote

   The minted token is printed ONCE and stored only as a hash — copy it into
   the pipeline's environment (KARMA_API_TOKEN) right away. */

const { query, pool } = require("./db");
const { mintToken, sha256 } = require("./service-auth");

async function main() {
  const [cmd, a, ...rest] = process.argv.slice(2);
  if (cmd === "token:create") {
    if (!a) throw new Error("usage: token:create <name> [scope ...]");
    const scopes = rest.length ? rest : ["imports:write"];
    const token = mintToken();
    await query(
      `INSERT INTO service_tokens (name, token_hash, scopes) VALUES ($1, $2, $3)`,
      [a, sha256(token), scopes]);
    console.log(`service token for "${a}" (scopes: ${scopes.join(", ")}):\n\n  ${token}\n`);
    console.log("shown once — set it as KARMA_API_TOKEN now.");
  } else if (cmd === "token:revoke") {
    const r = await query(
      `UPDATE service_tokens SET revoked_at = now()
       WHERE name = $1 AND revoked_at IS NULL`, [a]);
    console.log(`revoked ${r.rowCount} token(s) named "${a}"`);
  } else if (cmd === "token:list") {
    for (const t of (await query(
      `SELECT name, scopes, created_at, revoked_at FROM service_tokens
       ORDER BY created_at`)).rows)
      console.log(`${t.revoked_at ? "REVOKED " : "active  "} ${t.name}  ` +
        `[${t.scopes.join(",")}]  since ${t.created_at.toISOString().slice(0, 10)}`);
  } else if (cmd === "user:add") {
    if (!a) throw new Error("usage: user:add <email> [admin|member]");
    const role = rest[0] === "admin" ? "admin" : "member";
    const email = a.trim().toLowerCase();
    const u = (await query(
      `INSERT INTO app_users (email) VALUES ($1)
       ON CONFLICT (email) DO UPDATE SET disabled = false RETURNING id`,
      [email])).rows[0];
    const org = (await query(
      "SELECT id FROM organizations ORDER BY id LIMIT 1")).rows[0];
    await query(
      `INSERT INTO organization_memberships (org_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (org_id, user_id) DO UPDATE SET role = $3`,
      [org.id, u.id, role]);
    console.log(`${email} is now a ${role}`);
  } else {
    console.log("commands: token:create, token:revoke, token:list, user:add");
  }
  await pool.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
