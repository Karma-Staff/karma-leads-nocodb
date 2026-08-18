"use strict";
/* Layer 2 phone backfill: read the number off the company's own website.

   Layer 1 (enrich.js) borrows from companies we already know; this one is for
   the rest — job-scraped companies whose website we have but whose phone we
   don't. It fetches the homepage (and the contact page when the homepage
   doesn't hand-link a number), extracts US phone numbers, and keeps the one
   the site itself is most committed to:

     tel: links first — a hand-coded dial link is the site saying "this is
     our number"; then the most-repeated number in the page text. No tel: and
     a tie for most-repeated = ambiguous, take nothing.

   Same guards as layer 1: pk() validation (dedupe.js) so placeholders never
   land, blocklisted numbers never land, and a fill only ever lands in a
   blank. Two pages per site, one pass, 10s timeout, honest User-Agent.

     node server/webphone.js               dry run (prints every would-be fill)
     node server/webphone.js --apply       write the fills
     node server/webphone.js --limit 50    first 50 of the backlog only

   Runs against DATABASE_URL like migrate.js — run it where the real database
   is reachable. Logs ONE 'enrich' summary row per apply run, like layer 1. */

const express = require("express");
const { query } = require("./db");
const { requireAdmin } = require("./auth");
const activity = require("./activity");
const counts = require("./counts");
const { pk } = require("./dedupe");
const { domainOf, fillPhone } = require("./enrich");

const UA = "KarmaLeadsBot/1.0 (looking up the phone number of our own leads)";
const TIMEOUT = 10_000;
const CONCURRENCY = 4;

/* -> html string, "blocked", or null (dead / not html). Big-brand sites sit
   behind bot protection that 403s any non-browser TLS stack — we do NOT try
   to sneak past it; those get counted honestly and skipped. */
async function get(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: "follow",
      headers: { "User-Agent": UA, Accept: "text/html" } });
    if (res.status === 403 || res.status === 429) return "blocked";
    if (!res.ok) return null;
    if (!(res.headers.get("content-type") || "").includes("html")) return null;
    return (await res.text()).slice(0, 1_500_000);
  } catch { return null; }
  finally { clearTimeout(t); }
}

/* every plausible US number on the page, best first */
function extractPhones(html) {
  const tally = new Map();               // pk -> {key, n, tel}
  const add = (raw, tel) => {
    const key = pk(raw);
    if (!key) return;
    const cur = tally.get(key) || { key, n: 0, tel: false };
    cur.n++;
    cur.tel = cur.tel || tel;
    tally.set(key, cur);
  };
  for (const m of html.matchAll(/href\s*=\s*["']tel:([^"']+)["']/gi))
    add(decodeURIComponent(m[1]), true);
  // separators required: a bare 10-digit run is usually an id, not a phone
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ");
  for (const m of text.matchAll(
    /(?:\+?1[\s.\-]*)?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}(?!\d)/g))
    add(m[0], false);
  return [...tally.values()].sort((a, b) => (b.tel - a.tel) || (b.n - a.n));
}

/* first same-host link that mentions "contact" */
function contactUrl(html, base) {
  const m = html.match(/href\s*=\s*["']([^"']*contact[^"']*)["']/i);
  if (!m) return null;
  try {
    const u = new URL(m[1], base);
    return /^https?:$/.test(u.protocol) && u.host.replace(/^www\./, "") ===
      new URL(base).host.replace(/^www\./, "") ? u.href : null;
  } catch { return null; }
}

/* -> { phone, key, tel, url } on a hit, { miss: reason } otherwise.
   Exported for the day this runs from a route instead of a terminal. */
async function scrapePhone(website) {
  const dom = domainOf(website);
  if (!dom) return { miss: "nosite" };
  let blocked = false;
  for (const proto of ["https://", "http://"]) {
    const base = proto + dom;
    const home = await get(base);
    if (home === "blocked") { blocked = true; continue; }
    if (home == null) continue;          // unreachable this way — try http
    const pages = [home];
    let url = base;
    if (!extractPhones(home).some((c) => c.tel)) {
      const cu = contactUrl(home, base);
      const contact = cu && await get(cu);
      if (contact && contact !== "blocked") { pages.push(contact); url = cu; }
    }
    const cands = extractPhones(pages.join(" "));
    if (!cands.length) return { miss: "nophone" };
    const [top, second] = cands;
    // no dial link and a tie for most-shown: the page names several numbers
    // and nothing says which is theirs — take nothing
    if (!top.tel && second && second.n === top.n) return { miss: "ambiguous" };
    return { phone: "+1" + top.key, key: top.key, tel: top.tel, url };
  }
  return { miss: blocked ? "blocked" : "unreachable" };
}

/* ---------------- the button ----------------
   POST /api/phone-refresh (admin): both layers over the backlog in one click.
   Layer 1 (match into our own data) covers everything — it's just SQL. The
   web pass is capped per click so the request stays minutes, not hours; the
   response says how many sites are left and the client offers to go again. */
const WEB_CAP = 60;

const router = express.Router();
router.use("/api/phone-refresh", requireAdmin);

router.post("/api/phone-refresh", async (req, res, next) => {
  try {
    const backlog = (await query(
      `SELECT id, name, website, city, state FROM leads
       WHERE kind = 'company' AND source = 'Job board' AND deleted_at IS NULL
         AND NOT removed AND nullif(btrim(phone), '') IS NULL
       ORDER BY id`)).rows;

    const by = { domain: 0, namecity: 0 };
    const still = [];
    for (const co of backlog) {
      const hit = await fillPhone(query, co);
      if (hit) by[hit.how]++;
      else still.push(co);
    }

    const sites = still.filter((c) => domainOf(c.website));
    const noSite = still.length - sites.length;
    const work = sites.slice(0, WEB_CAP);
    const banned = new Set((await query(
      `SELECT phone_key FROM blocklist`)).rows.map((r) => r.phone_key));
    let web = 0, hitBan = 0;
    const miss = { nophone: 0, ambiguous: 0, unreachable: 0, blocked: 0 };
    let i = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (i < work.length) {
        const co = work[i++];
        const hit = await scrapePhone(co.website);
        if (!hit.phone) { miss[hit.miss]++; continue; }
        if (banned.has(hit.key)) { hitBan++; continue; }
        await query(
          `UPDATE leads SET phone = $1, phone_key = $2, updated_at = now()
           WHERE id = $3 AND nullif(btrim(phone), '') IS NULL`,
          [hit.phone, hit.key, co.id]);
        web++;
      }
    }));

    const filled = by.domain + by.namecity + web;
    if (filled) {
      counts.invalidate();               // filled phones move the tiles
      activity.log({ actor: req.user.email, user_id: req.user.id,
        action: "enrich",
        meta: { scanned: backlog.length, filled, ...by, web } });
    }
    res.json({
      scanned: backlog.length, filled, matched: by, web,
      miss, banned: hitBan, noSite,
      webRemaining: sites.length - work.length,
      stillMissing: backlog.length - filled,
    });
  } catch (e) { next(e); }
});

module.exports = { scrapePhone, extractPhones, router };

/* ---------------- the sweep ---------------- */
if (require.main === module) {
  (async () => {
    const apply = process.argv.includes("--apply");
    const li = process.argv.indexOf("--limit");
    const limit = li > -1 ? Math.max(1, +process.argv[li + 1] || 0) : Infinity;
    const { pool } = require("./db");

    const backlog = (await query(
      `SELECT id, name, website, city, state FROM leads
       WHERE kind = 'company' AND source = 'Job board' AND deleted_at IS NULL
         AND NOT removed AND nullif(btrim(phone), '') IS NULL
       ORDER BY id`)).rows;
    const noSite = backlog.filter((c) => !domainOf(c.website)).length;
    const work = backlog.filter((c) => domainOf(c.website)).slice(0, limit);
    const blocked = new Set((await query(
      `SELECT phone_key FROM blocklist`)).rows.map((r) => r.phone_key));

    let filled = 0, banned = 0;
    const miss = { nophone: 0, ambiguous: 0, unreachable: 0, blocked: 0, nosite: 0 };
    let i = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (i < work.length) {
        const co = work[i++];
        const hit = await scrapePhone(co.website);
        if (!hit.phone) { miss[hit.miss]++; continue; }
        if (blocked.has(hit.key)) { banned++; continue; }
        if (apply)
          await query(
            `UPDATE leads SET phone = $1, phone_key = $2, updated_at = now()
             WHERE id = $3 AND nullif(btrim(phone), '') IS NULL`,
            [hit.phone, hit.key, co.id]);
        filled++;
        console.log(`${apply ? "filled" : "found"}  #${co.id} ${co.name}` +
          ` (${co.city || "?"}, ${co.state || "?"})  <- ${hit.phone}` +
          `  [${hit.tel ? "tel: link" : "page text"}]  ${hit.url}`);
      }
    }));

    console.log(`\n${filled} of ${work.length} sites gave a number` +
      ` (${miss.nophone} listed none, ${miss.ambiguous} listed several,` +
      ` ${miss.unreachable} unreachable, ${miss.blocked} behind bot protection` +
      `${banned ? `, ${banned} hit the DNC list` : ""})` +
      `${noSite ? `\n${noSite} more companies have no website at all —` +
        ` those need a Places-style lookup (layer 3)` : ""}` +
      `${apply ? "" : "\ndry run — add --apply to write"}`);

    if (apply && filled)
      await activity.log({ actor: "phone-backfill", action: "enrich",
        meta: { scanned: work.length, filled, web: filled } });
    await pool.end();
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
