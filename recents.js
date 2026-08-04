"use strict";
/* Per-account "recently interacted" trail for the leads app.

   The Recent tab used to mean "added in the last 30 days" — a property of the
   data, not of anything anyone did. It now means "the last 25 leads this
   account touched": opened, favourited, re-statused, re-assigned, noted. That
   trail lives in recents.json next to noco.db, keyed by the signed-in email,
   so it follows the person rather than the browser and never crosses accounts.

   Everything here is per user and disposable — delete recents.json and every
   trail simply starts empty again. */

const fsp = require("fs").promises;
const path = require("path");

const FILE = path.join(__dirname, "recents.json");
const MAX = 25;                       // entries kept per account
const KEYS = ["companies", "people", "jobs"];
const NOCO = "http://localhost:8080";
const WHO_TTL = 5 * 60 * 1000;        // how long a token -> email answer is reused

/* ---------------- who is calling ----------------
   The trail is written with the caller's own JWT, not the API token, so an
   entry can only ever land under the account that actually signed in. */
const whoCache = new Map();           // token -> {email, at}

async function whoami(auth) {
  if (!auth) return null;
  const hit = whoCache.get(auth);
  if (hit && Date.now() - hit.at < WHO_TTL) return hit.email;
  let me;
  try {
    const r = await fetch(`${NOCO}/api/v1/auth/user/me`, { headers: { "xc-auth": auth } });
    if (!r.ok) return null;
    me = await r.json();
  } catch { return null; }
  const email = String(me?.email || "").trim().toLowerCase();
  if (!email) return null;
  if (whoCache.size > 500) whoCache.clear();   // signed-out tokens pile up otherwise
  whoCache.set(auth, { email, at: Date.now() });
  return email;
}

/* ---------------- the file ---------------- */
async function readAll() {
  try {
    const parsed = JSON.parse(await fsp.readFile(FILE, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};                         // missing or unreadable = nobody has a trail yet
  }
}

async function writeAll(all) {
  const tmp = `${FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(all, null, 2), "utf-8");
  await fsp.rename(tmp, FILE);         // never leave a half-written file behind
}

/* Two clicks in the same second would otherwise read the same file and one
   would clobber the other, so every write goes through one chain. */
let chain = Promise.resolve();
function queue(fn) {
  const run = chain.then(fn, fn);      // a failed write must not poison the queue
  chain = run.catch(() => {});
  return run;
}

/* ---------------- api ---------------- */
async function list(email) {
  const all = await readAll();
  const rows = all[email];
  return Array.isArray(rows) ? rows.slice(0, MAX) : [];
}

/* Record one interaction and return the account's trail, newest first.
   Touching a lead that is already in the list moves it to the top rather
   than duplicating it. */
function touch(email, entry) {
  const t = String(entry?.t || "");
  const id = Number(entry?.id);
  if (!KEYS.includes(t)) throw new Error(`unknown table "${t}"`);
  if (!Number.isInteger(id) || id <= 0) throw new Error("bad lead id");
  const kind = String(entry?.kind || "open").slice(0, 16);
  const at = new Date().toISOString();
  return queue(async () => {
    const all = await readAll();
    const cur = (Array.isArray(all[email]) ? all[email] : [])
      .filter((x) => !(x.t === t && Number(x.id) === id));
    cur.unshift({ t, id, at, kind });
    all[email] = cur.slice(0, MAX);
    await writeAll(all);
    return all[email];
  });
}

function clear(email) {
  return queue(async () => {
    const all = await readAll();
    delete all[email];
    await writeAll(all);
    return [];
  });
}

module.exports = { whoami, list, touch, clear, MAX };
