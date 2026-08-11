"use strict";
/* One pg pool for the whole domain API.

   Configuration comes from the environment; in dev the .env.server file in the
   repo root supplies it (process.loadEnvFile is built into Node ≥20.12 — no
   dotenv dependency). A missing file is fine: production sets real env vars.

   Why .env.SERVER and not .env: NocoDB auto-loads `.env` from its working
   directory, and while the legacy `node index.js` server still runs from this
   folder, a DATABASE_URL in `.env` sends NocoDB's metadata schema into the
   app database (it happened — see scripts/cleanup-nocodb-pollution.sql).
   `.env` holds only the compose passwords; everything the API needs is here. */

const path = require("path");

try { process.loadEnvFile(path.join(__dirname, "..", ".env.server")); }
catch { /* no .env.server — env vars must be set for real */ }

if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL is not set — copy .env.example to .env/.env.server");

const { Pool, types } = require("pg");

/* bigint columns (every id here) come back as strings by default; nothing in
   this app will ever exceed 2^53, and the front end does arithmetic on ids */
types.setTypeParser(20, (v) => parseInt(v, 10));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,                       // single instance, ~12 concurrent users — plenty
  idleTimeoutMillis: 30_000,
});

pool.on("error", (e) => console.error("[karma] idle pg client error:", e.message));

/* the two shapes every route uses */
const query = (text, params) => pool.query(text, params);
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, tx };
