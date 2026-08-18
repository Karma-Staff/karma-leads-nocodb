"use strict";
/* The domain API — the only process the dashboard talks to, on the same
   http://localhost:8080/app the team has always used. NocoDB survives only
   as the admin-grid container on :8082; it is never in the request path. */

const express = require("express");
const path = require("path");
const auth = require("./auth");

const PORT = +process.env.PORT || 8080;
const app = express();

/* same no-cache policy as the old server: revalidate, don't blind-serve — a
   half-cached app.js/index.html pair breaks the page and the round trip is
   cheap on localhost.

   The app is served at BOTH / and /app: the root is the front door
   (https://<host>/ just works), /app keeps years of bookmarks and the
   health-check path alive. Assets are referenced relatively so the same
   files work from either mount; /api, /dashboard and unknown paths fall
   straight through the static handler to the routes below. */
const statics = express.static(path.join(__dirname, "..", "public"), {
  etag: true,
  setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
});
app.use("/app", statics);
app.use("/", statics);

/* the user-menu's "Open NocoDB admin" link — the admin container lives on
   its own port, so bounce the browser there against whatever host it used
   for us. In prod it sits behind Caddy on its own hostname instead: set
   NOCODB_ADMIN_URL (docker-compose.prod.yml does, to https://admin.<domain>) */
app.get("/dashboard", (req, res) =>
  res.redirect(process.env.NOCODB_ADMIN_URL ||
    `http://${req.hostname}:8082/dashboard`));

/* ---------------- auth: WorkOS AuthKit */
auth.mountAuthRoutes(app);

app.get("/api/me", auth.requireUser, (req, res) => {
  res.json({ id: req.user.id, email: req.user.email,
    display_name: req.user.name, role: req.user.role });
});

/* ---------------- feature routers */
app.use(require("./leads").router);
app.use(require("./counts").router);
app.use(require("./recents").router);
app.use(require("./users").router);
app.use(require("./jobsearch").router);
app.use(require("./imports").router);
/* bulk actions on a ticked selection (admin) — mounted at /api/bulk, clear of
   leads.js's /api/leads/:id routes */
app.use(require("./bulk").router);
/* the Team activity pane's phone-refresh button (admin) */
app.use(require("./webphone").router);

/* the trash bin, plus its 30-day sweep — mounted after leads so the leads
   router's requireUser has already run for /api/leads/:id paths */
const trash = require("./trash");
app.use(trash.router);
trash.startSweeper();

const activity = require("./activity");
app.get("/api/activity", auth.requireAdmin, async (req, res, next) => {
  try { res.json(await activity.summary(req.query.days, req.query.full === "1")); }
  catch (e) { next(e); }
});

/* ---------------- errors */
app.use("/api", (req, res) => res.status(404).json({ error: "no such endpoint" }));
app.use((err, req, res, next) => {         // eslint-disable-line no-unused-vars
  console.error("[karma]", req.method, req.path, "->", err.message);
  res.status(500).json({ error: "server error" });
});

app.listen(PORT, () =>
  console.log(`Karma Leads API on http://localhost:${PORT} — app at / (and /app)`));
