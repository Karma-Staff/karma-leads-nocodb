/* Super-admin seed credentials. Only used the first time NocoDB initialises an
   empty noco.db — on an existing database they are ignored — but they must not
   live in the repo, so they come from admin_credentials.json (gitignored, see
   admin_credentials.example.json) or the environment. Missing file is fine. */
try {
  const creds = JSON.parse(
    require("fs").readFileSync(
      require("path").join(__dirname, "admin_credentials.json"), "utf8"
    ).replace(/^﻿/, "")
  );
  if (creds.email) process.env.NC_ADMIN_EMAIL ||= creds.email;
  if (creds.password) process.env.NC_ADMIN_PASSWORD ||= creds.password;
} catch { /* no seed file — existing DB, or env vars are set */ }

process.env.NC_DISABLE_TELE = "true";
/* NocoDB logs every insert and every link to nc_audit_v2 with the whole row's
   JSON embedded. A rebuild inserts ~35k rows and links every one of them, so a
   single run wrote ~180 MB of audit for 7 MB of leads — the file had reached
   1.3 GB, 99% of it audit. Nothing here reads that table (the Recent tab is
   recents.json), so it is switched off outright. */
process.env.NC_DISABLE_AUDIT = "true";

(async () => {
  const { Noco } = require("nocodb");
  const express = require("express");
  const path = require("path");
  const app = express();
  const httpServer = app.listen(8080, () =>
    console.log("NocoDB ready on http://localhost:8080 — leads app at /app")
  );
  // no-cache (revalidate, don't blind-serve): a half-cached app.js/index.html
  // pair breaks the page, and this is localhost — the round trip is free
  app.use("/app", express.static(path.join(__dirname, "public"), {
    etag: true,
    setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
  }));

  // spreadsheet drop-zone import — registered before Noco takes over routing
  const { importLeads } = require("./import-leads");
  app.post("/app-api/import",
    express.raw({ type: "*/*", limit: "80mb" }),
    async (req, res) => {
      const auth = req.get("xc-auth");
      if (!auth) return res.status(401).json({ error: "Not signed in" });
      if (!req.body || !req.body.length)
        return res.status(400).json({ error: "Empty upload" });
      try {
        res.json(await importLeads({
          buffer: req.body,
          filename: req.get("x-filename") || "upload.xlsx",
          category: req.get("x-category") || "Other",
          auth,
        }));
      } catch (e) {
        console.error("import failed:", e);
        res.status(400).json({ error: String(e.message || e) });
      }
    });

  // LinkedIn job search via Apify — the token stays server-side and the
  // input is rebuilt from a whitelist in job-search.js. Registered before
  // Noco.init like every /app-api route.
  const { searchJobs, apifyUsage } = require("./job-search");
  app.post("/app-api/job-search", express.json({ limit: "64kb" }), async (req, res) => {
    const auth = req.get("xc-auth");
    if (!auth) return res.status(401).json({ error: "Not signed in" });
    try {
      res.json(await searchJobs({ params: req.body || {}, auth }));
    } catch (e) {
      console.error("job search failed:", e);
      res.status(400).json({ error: String(e.message || e) });
    }
  });
  app.get("/app-api/apify-usage", async (req, res) => {
    if (!req.get("xc-auth")) return res.status(401).json({ error: "Not signed in" });
    try {
      res.json(await apifyUsage());
    } catch (e) {
      console.error("apify usage failed:", e);
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // per-account "recently interacted" trail behind the Recent tab — also
  // registered before Noco.init, or the requests never reach it
  const recents = require("./recents");
  const caller = async (req, res) => {
    const email = await recents.whoami(req.get("xc-auth"));
    if (!email) res.status(401).json({ error: "Not signed in" });
    return email;
  };
  app.get("/app-api/recents", async (req, res) => {
    const email = await caller(req, res);
    if (!email) return;
    try {
      res.json({ list: await recents.list(email), max: recents.MAX });
    } catch (e) {
      console.error("recents read failed:", e);
      res.status(500).json({ error: String(e.message || e) });
    }
  });
  app.post("/app-api/recents", express.json({ limit: "8kb" }), async (req, res) => {
    const email = await caller(req, res);
    if (!email) return;
    try {
      res.json({ list: await recents.touch(email, req.body || {}), max: recents.MAX });
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });
  app.delete("/app-api/recents", async (req, res) => {
    const email = await caller(req, res);
    if (!email) return;
    try {
      res.json({ list: await recents.clear(email), max: recents.MAX });
    } catch (e) {
      console.error("recents clear failed:", e);
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  app.use(await Noco.init({}, httpServer, app));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
