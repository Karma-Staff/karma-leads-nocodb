"use strict";
/* Phone backfill for job-scraped companies.

   The job boards hand over name / city / state / website and never a phone,
   while Bitrix and the Master DB hold ~30k phone-carrying companies. This
   module finds a donor among the companies we already own and fills the
   blank. Matching is deliberately NARROWER than dedupe.js: dedupe decides
   whether two rows are the same business before merging; here a wrong match
   means calling the wrong branch, so a donor only gives when the answer is
   unambiguous:

     domain    — same website domain. Franchises share brand domains
                 (servpro.com backs hundreds of branches), so the domain only
                 donates when every donor behind it agrees on ONE number.
     namecity  — aliases() overlap (the franchise-safe normalization from
                 dedupe.js) AND the same city AND no state contradiction —
                 again with all candidate donors agreeing on one number.

   A blocklisted number never donates: a DNC ban must not resurface on a
   fresh lead. Fills only ever land in a blank phone (the import invariant).

   Used two ways:
     - jobsearch.js calls fillPhone() for every company a scrape inserts
     - `node server/enrich.js` sweeps the backlog: every phone-less Job board
       company. Dry run by default; --apply writes. */

const { aliases } = require("./dedupe");
const { STATE_NAME } = require("./leads");

/* "https://www.Acme-FL.com/contact" -> "acme-fl.com"; null when it doesn't
   read as a domain at all */
function domainOf(website) {
  const s = String(website || "").trim().toLowerCase();
  if (!s) return null;
  const host = s.replace(/^https?:\/\//, "").replace(/^www\./, "")
    .split(/[/?#:]/)[0];
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host) ? host : null;
}

/* the data holds both "FL" and "Florida" — compare on the abbreviation */
const FULL_TO_AB = Object.fromEntries(
  Object.entries(STATE_NAME).map(([ab, full]) => [full.toLowerCase(), ab]));
function stAb(state) {
  const s = String(state || "").trim();
  if (!s) return null;
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return FULL_TO_AB[s.toLowerCase()] || null;
}

const DONOR_COLS = `id, name, phone, phone_key, website, city, state`;
/* NOT removed already keeps swept leads out; the blocklist join is the belt
   to those braces — a ban whose every lead was later deleted still holds */
const DONOR_WHERE = `kind = 'company' AND deleted_at IS NULL AND NOT removed
  AND phone_key IS NOT NULL AND id <> $1
  AND NOT EXISTS (SELECT 1 FROM blocklist b WHERE b.phone_key = leads.phone_key)`;

/* one company in, one donor out (or null). q is any query function —
   the pool's or a transaction client's. */
async function findPhoneDonor(q, co) {
  const dom = domainOf(co.website);
  if (dom) {
    const rows = (await q(
      `SELECT ${DONOR_COLS} FROM leads
       WHERE ${DONOR_WHERE} AND website ILIKE $2`,
      [co.id, `%${dom}%`])).rows.filter((d) => domainOf(d.website) === dom);
    const keys = new Set(rows.map((d) => d.phone_key));
    if (rows.length && keys.size === 1) return { donor: rows[0], how: "domain" };
    // several numbers behind one domain = a brand site; fall through to city
  }
  const al = aliases(co.name).set;
  const city = String(co.city || "").trim().toLowerCase();
  if (al.size && city) {
    const ab = stAb(co.state);
    const rows = (await q(
      `SELECT ${DONOR_COLS} FROM leads
       WHERE ${DONOR_WHERE} AND lower(btrim(city)) = $2`,
      [co.id, city])).rows.filter((d) => {
      const dal = aliases(d.name).set;
      if (![...al].some((a) => dal.has(a))) return false;
      const dab = stAb(d.state);            // same-named city, other state
      return !(ab && dab && ab !== dab);
    });
    const keys = new Set(rows.map((d) => d.phone_key));
    if (rows.length && keys.size === 1) return { donor: rows[0], how: "namecity" };
  }
  return null;
}

/* find + write, blank-guarded twice (the WHERE re-checks under concurrency) */
async function fillPhone(q, co) {
  const hit = await findPhoneDonor(q, co);
  if (!hit) return null;
  const r = await q(
    `UPDATE leads SET phone = $1, phone_key = $2, updated_at = now()
     WHERE id = $3 AND nullif(btrim(phone), '') IS NULL`,
    [hit.donor.phone, hit.donor.phone_key, co.id]);
  return r.rowCount ? hit : null;
}

module.exports = { findPhoneDonor, fillPhone, domainOf };

/* ---------------- backlog sweep ----------------
     node server/enrich.js            report what would be filled (dry run)
     node server/enrich.js --apply    write the fills
   Runs against DATABASE_URL like every server script — run it where the real
   database is reachable (see migrate.js). */
if (require.main === module) {
  (async () => {
    const apply = process.argv.includes("--apply");
    const { query, pool } = require("./db");
    const backlog = (await query(
      `SELECT id, name, website, city, state FROM leads
       WHERE kind = 'company' AND source = 'Job board' AND deleted_at IS NULL
         AND NOT removed AND nullif(btrim(phone), '') IS NULL
       ORDER BY id`)).rows;
    const by = { domain: 0, namecity: 0 };
    for (const co of backlog) {
      const hit = apply
        ? await fillPhone(query, co)
        : await findPhoneDonor(query, co);
      if (!hit) continue;
      by[hit.how]++;
      console.log(
        `${apply ? "filled" : "match"}  #${co.id} ${co.name}` +
        ` (${co.city || "?"}, ${co.state || "?"})` +
        `  <- ${hit.donor.phone}  from #${hit.donor.id} ${hit.donor.name}` +
        `  [${hit.how}]`);
    }
    const filled = by.domain + by.namecity;
    console.log(`\n${filled} of ${backlog.length} phone-less Job board ` +
      `companies matched (${by.domain} by domain, ${by.namecity} by ` +
      `name+city)${apply ? "" : " — dry run, add --apply to write"}`);
    /* one summary row in the team log per APPLY run — same restraint as the
       bulk actions; a dry run changes nothing and logs nothing */
    if (apply && filled)
      await require("./activity").log({ actor: "phone-backfill",
        action: "enrich",
        meta: { scanned: backlog.length, filled, ...by } });
    await pool.end();
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
