// ============================================================================
// Shell — landing + auth wrapper for Perfin and Per-sistant
// ============================================================================
// Scaffolding only. Mount points for the two sub-apps are commented out;
// uncomment once you've co-located the per-sistant codebase (e.g. under
// apps/per-sistant/ or alongside teller/) AND refactored its server.js to
// `module.exports = { app }` instead of calling app.listen() at the
// bottom. Same for teller/server.js.
//
// Run with:        node shell/index.js
// Required env:    SHELL_PIN          — the unified PIN
//                  SHELL_SECRET       — random string used to sign cookies
// Optional env:    SHELL_PORT         — defaults to PORT or 3000
//                  NODE_ENV=production — enables Secure cookie flag

require("dotenv").config();

const express = require("express");
const cookieParser = require("cookie-parser");
const path = require("path");
const auth = require("./middleware/auth");

const app = express();
app.set("trust proxy", 1);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(cookieParser());
app.use(express.urlencoded({ extended: false, limit: "64kb" }));

// Shell-only static assets are scoped under /shell-static so they can't
// collide with either sub-app's /public namespace once those are mounted.
app.use("/shell-static", express.static(path.join(__dirname, "public"), {
  maxAge: process.env.NODE_ENV === "production" ? "1d" : 0,
}));

// --- Public routes (no auth) ------------------------------------------------
// PWA manifest at /manifest.json so the spec-required reference from
// the login/landing <head> resolves. Sub-app manifests live under
// their mount prefix (/perfin/manifest.json, /per-sistant/manifest.json)
// and don't collide with this one.
app.get("/manifest.json", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "manifest.json"));
});

app.get("/login", (req, res) => {
  if (auth.isValidSession(req.cookies[auth.COOKIE_NAME])) return res.redirect("/");
  res.render("login", { error: null });
});
app.post("/login", auth.handleLogin);
app.post("/logout", auth.handleLogout);

// --- Auth gate --------------------------------------------------------------
// Everything past this point requires a valid signed session cookie. The
// sub-apps trust this gate and should not run their own login flows; their
// existing /login routes will be shadowed by ours since we mount them
// under prefix paths (/perfin/login, /per-sistant/login) that never get
// hit organically.
app.use(auth.requireAuth);

// --- Landing tile picker ----------------------------------------------------
app.get("/", (_req, res) => res.render("landing"));

// --- Sub-app mounts (wired in Phase 6) --------------------------------------
// const perfinApp = require("../teller/server").app;
// const persistentApp = require("../apps/per-sistant/server").app;
// app.use("/perfin", perfinApp);
// app.use("/per-sistant", persistentApp);

// 404 fallback for authenticated users hitting an unknown path
app.use((_req, res) => res.status(404).send("Not found"));

const PORT = parseInt(process.env.SHELL_PORT || process.env.PORT || "3000", 10);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Shell listening on http://localhost:${PORT}`);
  if (!process.env.SHELL_PIN || !process.env.SHELL_SECRET) {
    console.warn("WARNING: SHELL_PIN and SHELL_SECRET must both be set for login to work.");
  }
});
