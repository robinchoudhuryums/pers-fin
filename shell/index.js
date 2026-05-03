// ============================================================================
// Shell — landing + auth wrapper for Perfin and Per-sistant
// ============================================================================
// Single Node process that:
//   - Authenticates via PIN at /login (cookie session signed with SHELL_SECRET).
//   - Renders a tile picker at /.
//   - Mounts Perfin at /perfin and Per-sistant at /per-sistant.
//   - Triggers each sub-app's migrations + cron jobs in embedded mode so
//     the sub-app's own listener doesn't fire (the shell owns the port).
//
// Run with:        node shell/index.js
// Required env:    SHELL_PIN                — the unified PIN
//                  SHELL_SECRET             — random string used to sign cookies
//                  NEON_DATABASE_URL        — Perfin's Neon DB
//                  PERSISTENT_DATABASE_URL  — Per-sistant's Neon DB
// Optional env:    SHELL_PORT               — defaults to PORT or 3000
//                  NODE_ENV=production      — enables Secure cookie flag
//                  + every env var the two sub-apps already consume.

require("dotenv").config();

const express = require("express");
const cookieParser = require("cookie-parser");
const path = require("path");
const auth = require("./middleware/auth");
const webauthn = require("./middleware/webauthn");
const { startKeepAlive } = require("../teller/services/keep-alive");

const app = express();
app.set("trust proxy", 1);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(cookieParser());
app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: false, limit: "64kb" }));

// Shell-only static assets are scoped under /shell-static so they can't
// collide with either sub-app's /public namespace once those are mounted.
// `maxAge: 0` + ETag means the browser always revalidates but a 304 keeps
// the request cheap (~100B). Earlier we used `1d`, which caused stale
// transition.css / transition.js to stick around on production after edits;
// short cache + ETag avoids needing manual ?v= bumps on every change.
app.use("/shell-static", express.static(path.join(__dirname, "public"), {
  maxAge: 0,
  etag: true,
  lastModified: true,
}));

// --- Sub-app modules -------------------------------------------------------
// Loaded here (before requireAuth) so the shell-side WebAuthn endpoints can
// share Perfin's pg Pool — they need to read `webauthn_credentials`, which
// only Perfin's database has. require() loads the modules without firing
// their listeners (server.js wraps that in `if (require.main === module)`).
const perfin = require("../teller/server");
const persistent = require("../apps/per-sistant/server");

// --- Public routes (no auth) ------------------------------------------------
// Manifest is served pre-auth so install prompts work on the login page.
app.get("/manifest.json", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "manifest.json"));
});

// PWA icons served at root so iOS's "Add to Home Screen" auto-discovers
// /apple-touch-icon.png from /login (pre-auth) and from the landing page.
// Same artwork as the Per-sistant PWA — sourced from apps/per-sistant/ to
// avoid duplicating the bytes. Mounted before requireAuth so iOS's icon
// fetch (which can happen out-of-band, without the session cookie) doesn't
// hit the PIN gate.
const ICON_SRC_DIR = path.join(__dirname, "..", "apps", "per-sistant");
function sendShellIcon(filename) {
  return (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
    res.sendFile(path.join(ICON_SRC_DIR, filename), (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  };
}
app.get("/apple-touch-icon.png", sendShellIcon("apple-touch-icon.png"));
// Older iOS versions also probe -precomposed; serve the same file.
app.get("/apple-touch-icon-precomposed.png", sendShellIcon("apple-touch-icon.png"));
app.get("/android-chrome-192x192.png", sendShellIcon("android-chrome-192x192.png"));
app.get("/android-chrome-512x512.png", sendShellIcon("android-chrome-512x512.png"));

app.get("/login", (req, res) => {
  if (auth.isValidSession(req.cookies[auth.COOKIE_NAME])) return res.redirect("/");
  res.render("login", { error: null });
});
app.post("/login", auth.handleLogin);
app.post("/logout", auth.handleLogout);

// Biometric login — mounted BEFORE requireAuth so users can authenticate via
// FaceID / passkey without first entering the PIN. The endpoints query
// Perfin's webauthn_credentials table directly via the wired pool. On
// successful verify, the shell session cookie is set and the client can
// proceed to the landing page like a regular PIN login.
webauthn.attach(app, perfin.pool);

// --- Auth gate --------------------------------------------------------------
// Everything past this point requires a valid signed session cookie. Sub-apps
// trust this gate and don't run their own login flows; their /login routes
// are shadowed by ours since the shell owns / and /login.
app.use(auth.requireAuth);

// --- Landing tile picker ----------------------------------------------------
app.get("/", (_req, res) => res.render("landing"));

// --- Sub-app mounts ---------------------------------------------------------
// We then call start({ standalone: false }) so migrations and cron jobs
// run, but the sub-app doesn't bind a port or install signal handlers —
// we own those at the shell level.

// Tell each sub-app it's running embedded so its own auth middleware
// can bail early. The shell's PIN gate above is the sole authentication
// checkpoint when running this way; sub-apps would otherwise demand a
// per-app session that nobody ever creates and bounce the user back to
// /login (which the shell shadows, producing an infinite redirect loop
// that manifests as "clicking the tile does nothing").
perfin.app.set("embedded", true);
persistent.app.set("embedded", true);

// Cross-pool wiring: the cross-app integration endpoints used to fetch
// http://localhost:PORT/api/... at the OTHER sub-app, which 401s through the
// shell auth gate (the in-process fetch carries no shell session cookie).
// Hand each sub-app a reference to the other's pg Pool so they can query
// directly when running embedded. Standalone deployments leave these unset
// and the routes fall back to HTTP fetches.
perfin.app.set("persistentPool", persistent.pool);
persistent.app.set("perfinPool", perfin.pool);

app.use("/perfin", perfin.app);
app.use("/per-sistant", persistent.app);

// 404 fallback for authenticated users hitting an unknown path
app.use((_req, res) => res.status(404).send("Not found"));

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
async function start() {
  // Sub-app startup tasks (migrations + cron) run before we begin accepting
  // requests so a hot-restart doesn't briefly serve traffic against an
  // un-migrated DB. Each sub-app exports start() — see teller/startup.js
  // and apps/per-sistant/server.js for what runs in embedded mode.
  console.log("Starting Perfin (embedded)…");
  await perfin.start(perfin.app, { standalone: false });
  console.log("Starting Per-sistant (embedded)…");
  await persistent.start({ standalone: false });

  const PORT = parseInt(process.env.SHELL_PORT || process.env.PORT || "3000", 10);
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Shell listening on http://localhost:${PORT}`);
    if (!process.env.SHELL_PIN || !process.env.SHELL_SECRET) {
      console.warn("WARNING: SHELL_PIN and SHELL_SECRET must both be set for login to work.");
    }
    // Start keep-alive at the shell layer. Sub-apps in embedded mode no longer
    // own the listener, so their startup.js skips startKeepAlive — without this
    // the keep_alive_enabled setting was wired to nothing and scheduled jobs
    // never fired on Render free tier between user sessions. Keep-alive reads
    // its enable flag and active-hours from Perfin's user_settings each tick,
    // so settings changes still take effect immediately.
    startKeepAlive(PORT);
  });

  // Graceful shutdown — close the listener, then drain both DB pools.
  function shutdown(signal) {
    console.log(`\n${signal} received — shutting down gracefully…`);
    server.close(async () => {
      try {
        await perfin.pool.end().catch(() => null);
        await persistent.pool.end().catch(() => null);
        console.log("Database pools closed.");
        process.exit(0);
      } catch {
        process.exit(1);
      }
    });
    setTimeout(() => { console.error("Forced shutdown after timeout."); process.exit(1); }, 10000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch(err => {
  console.error("Shell startup failed:", err);
  process.exit(1);
});
