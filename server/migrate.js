"use strict";
/* The application's migration system — the ONLY thing that changes the schema.
   (NocoDB's database role has no CREATE; the old "drop the base and rebuild"
   model from setup_v2.py is retired in favour of this.)

   Plain sequential SQL files, no framework:

     migrations/001_core.sql, 002_whatever.sql, ...
     node server/migrate.js          # apply everything new
     node server/migrate.js --status # show applied vs pending

   Each file runs once, inside its own transaction, recorded in
   schema_migrations. An advisory lock keeps two concurrent runs (say, two
   deploys) from racing. Files are ordered by name — zero-pad the prefix. */

const fs = require("fs");
const path = require("path");
const { pool } = require("./db");

const DIR = path.join(__dirname, "..", "migrations");
const LOCK = 74_2001;                   // arbitrary app-wide advisory lock id

async function main() {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set(
      (await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));

    if (process.argv.includes("--status")) {
      for (const f of files) console.log(`${done.has(f) ? "applied" : "PENDING"}  ${f}`);
      return;
    }

    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(DIR, f), "utf-8");
      process.stdout.write(`applying ${f} ... `);
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
        await client.query("COMMIT");
        console.log("ok");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        console.log("FAILED");
        throw new Error(`${f}: ${e.message}`);
      }
    }
    console.log("schema up to date");
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK]).catch(() => {});
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
