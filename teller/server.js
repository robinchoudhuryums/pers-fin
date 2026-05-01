// ============================================================================
// Teller Server — Perfin (Personal Finance Tracker)
// ============================================================================
// Express server that uses the Teller API (https://api.teller.io) instead of
// Plaid.  Teller uses mTLS (client certificate) + HTTP Basic Auth (access
// token) — no SDK required.
//
// Modular architecture:
//   data/reference-data.js    — static lookup tables, category rules, AI model config
//   data/csv-formats.js       — CSV format detection and parsing
//   services/database.js      — Postgres pool + auto-migrations
//   services/teller-api.js    — mTLS HTTP client for Teller API
//   services/keep-alive.js    — self-ping to prevent Render free tier sleep
//   routes/enrollments.js     — enrollment, sync, items, accounts, balances
//   routes/subscriptions.js   — subscription CRUD, transactions, detection, CSV import
//   routes/goals.js           — financial goals, net worth, context export
//   routes/settings.js        — user settings, sheets sync, CSV export
//   routes/insights.js        — AI insights (Claude), tax deductions
//   pages/*.js                — HTML page generators (dashboard, subscriptions, etc.)
//
// Run with:  node server.js
// Requires:  .env file in repo root (see .env.example)
// ============================================================================

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const path = require("path");
const express = require("express");
const crypto = require("crypto");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const morgan = require("morgan");

// --- Services ---
const { pool, runMigrations } = require("./services/database");
const { TELLER_APP_ID, TELLER_ENV } = require("./services/teller-api");
const { startKeepAlive, loadKeepAliveConfig } = require("./services/keep-alive");

// --- Auth config ---
const SESSION_PASSWORD = process.env.SESSION_PASSWORD;
const SESSION_PIN = process.env.SESSION_PIN;
const AUTH_SECRET = SESSION_PASSWORD || SESSION_PIN || null;
const AUTH_MODE = SESSION_PIN ? "pin" : (SESSION_PASSWORD ? "password" : null);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

// --- Express app setup ---
const app = express();
// EJS template engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
// Disable ETags for HTML pages so browsers always revalidate
app.set("etag", false);
// Cache-busting version for static assets (changes on each deploy/restart)
const BUILD_VERSION = Date.now().toString(36);
app.locals.v = BUILD_VERSION;
// Trust first proxy (Render/Fly.io load balancer) so secure cookies work behind TLS termination
app.set("trust proxy", 1);
app.use(morgan("short"));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Sub-app mount awareness. When this app is mounted under the unified
// shell (e.g. app.use("/perfin", subapp)), Express sets req.baseUrl to
// the mount path. Templates read `<%= basePath %>` to prefix URLs so
// nav links + asset paths + form actions resolve correctly. Standalone
// runs leave req.baseUrl as "" and basePath is a no-op.
//
// `embedded` mirrors the app-level flag the shell sets when mounting;
// templates (e.g. nav.ejs) can read it to show cross-app navigation.
app.use((req, res, next) => {
  res.locals.basePath = req.baseUrl || "";
  res.locals.embedded = !!req.app.get("embedded");
  next();
});

// Serve shared static assets (CSS, JS) — before auth so login page can use them
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));
// Serve Chart.js from the committed copy in teller/public/. Earlier this
// route used require.resolve("chart.js/...") to find the npm-installed
// version, but with workspaces the hoisting destination was inconsistent
// across deploys and the page kept reporting "Chart library failed to
// load." The committed file always exists at a known path, so just send
// that. (Trade-off: the in-repo binary needs a manual refresh when chart.js
// is upgraded, but it's been stable for a long time.)
app.get("/vendor/chart.umd.js", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "chart.umd.js"));
});

// ---------------------------------------------------------------------------
// Session middleware
// ---------------------------------------------------------------------------
// Only use the pg-backed store when this app actually authenticates users
// itself (AUTH_SECRET set means SESSION_PASSWORD or SESSION_PIN is configured).
// Under the unified shell, the shell's PIN gate handles auth and the per-app
// session never gets a value written — the pgSession 'session' table was
// dead weight, and the Plaid table-create migration was an unnecessary side
// effect. Standalone deployments without auth configured (AUTH_SECRET null)
// are similarly read-only on the session, so the in-memory default suffices.
const sessionConfig = {
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
};
if (AUTH_SECRET) {
  sessionConfig.store = new pgSession({
    pool,
    tableName: "session",
    createTableIfMissing: true,
  });
}
app.use(session(sessionConfig));

function requireAuth(req, res, next) {
  // Embedded under the unified shell — the shell's PIN gate has already
  // verified the user. Skip our per-app session check entirely; otherwise
  // every request would redirect to /login (which the shell shadows) and
  // produce an infinite bounce back to the landing page.
  if (req.app.get("embedded")) return next();
  if (!AUTH_SECRET) return next();
  if (["/login", "/api/login", "/api/webauthn/authenticate-options", "/api/webauthn/authenticate", "/manifest.json", "/sw.js", "/health", "/api/keep-alive-schedule", "/apple-touch-icon.svg", "/apple-touch-icon.png", "/logo.svg", "/api/sso/validate"].includes(req.path)) return next();
  if (req.path.endsWith(".css") || req.path.endsWith(".js")) return next();
  // Allow API key authenticated requests through (validated later in API key middleware)
  if (req.path.startsWith("/api/") && req.headers["x-api-key"]) return next();
  if (req.session && req.session.authenticated) {
    const timeout = (req.session.timeoutMinutes || 15) * 60 * 1000;
    if (Date.now() - req.session.lastActivity < timeout) {
      req.session.lastActivity = Date.now();
      return next();
    }
    req.session.authenticated = false;
  }
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Session expired. Please log in." });
  }
  return res.redirect("/login");
}
app.use(requireAuth);

// ---------------------------------------------------------------------------
// CSRF protection — require custom header on state-changing API requests
// Browsers block cross-origin custom headers without CORS preflight approval
// ---------------------------------------------------------------------------
app.use("/api", (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  if (req.path === "/login" || req.path === "/logout" || req.path === "/sso/validate") return next();
  if (req.headers["x-requested-with"] === "XMLHttpRequest") return next();
  // Also allow requests with JSON content type (also triggers CORS preflight)
  if ((req.headers["content-type"] || "").startsWith("application/json")) return next();
  // Allow API key authenticated requests (e.g., external tools)
  if (req.headers["x-api-key"]) return next();
  return res.status(403).json({ error: "CSRF validation failed. Include X-Requested-With header." });
});

// ---------------------------------------------------------------------------
// Security middleware — CSP with per-request nonces (no 'unsafe-inline')
// ---------------------------------------------------------------------------
// Generate a unique nonce per request and make it available to EJS templates.
// All inline <script> tags must include nonce="<%= nonce %>" to execute.
app.use((req, res, next) => {
  res.locals.nonce = crypto.randomBytes(16).toString("base64");
  next();
});
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`, "https://cdn.teller.io", "https://*.teller.io", "https://cdn.jsdelivr.net", "https://*.jsdelivr.net", "https://cdn.plaid.com"],
      connectSrc: ["'self'", "https://teller.io", "https://*.teller.io", "https://*.plaid.com", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
      frameSrc: ["https://teller.io", "https://*.teller.io", "https://cdn.plaid.com"],
      // Style policy is split (CSP Level 3): <style> blocks require the
      // per-request nonce so an XSS-injected <style> can't smuggle CSS that
      // exfiltrates data via background-image fetches; inline `style=""`
      // attributes still need 'unsafe-inline' because hundreds of templates
      // use them and migrating each one is out of scope for this round.
      // styleSrc remains as a fallback for browsers that don't honor the
      // split directives.
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      styleSrcElem: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`, "https://fonts.googleapis.com"],
      styleSrcAttr: ["'unsafe-inline'"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      workerSrc: ["'self'"],
    },
  },
  // Disable COEP and CORP — they block cross-origin resources (Teller Connect, Plaid, CDN
  // scripts/iframes) unless the remote server sends specific headers, which most CDNs don't
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(s => s.trim())
  : [];
app.use((req, res, next) => {
  cors({
    origin: (origin, cb) => {
      // Allow requests with no origin header (same-origin in older browsers, curl, server-to-server)
      if (!origin) return cb(null, true);
      // Same-origin: browser sends Origin on POST/PATCH/DELETE even for same-origin requests.
      // Compare origin's host to the request Host header to auto-allow.
      try {
        const originHost = new URL(origin).host;
        if (originHost === req.headers.host) return cb(null, true);
      } catch {}
      // Explicit allowlist
      if (ALLOWED_ORIGINS.length > 0 && ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })(req, res, next);
});

// Rate limiting
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: "Too many requests, please try again later." },
});
const tightLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: "Too many requests, please try again later." },
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many login attempts, please try again later." },
});
app.use("/api/", generalLimiter);
app.use("/api/login", loginLimiter);
app.use("/api/sync", tightLimiter);
app.use("/api/detect", tightLimiter);
app.use("/api/cleanup", tightLimiter);
app.use("/api/enroll", tightLimiter);

// API key authentication
const API_KEY = process.env.API_KEY;
app.use("/api", (req, res, next) => {
  // Embedded mode: shell auth has already gated this request, so skip
  // the API_KEY requirement that would otherwise fire for browser fetches
  // (which carry shell_session cookies, not x-api-key headers).
  if (req.app.get("embedded")) return next();
  if (!API_KEY) return next();
  if (req.path === "/login" || req.path === "/logout") return next();
  if (req.session && req.session.authenticated) return next();
  const provided = req.headers["x-api-key"];
  const providedBuf = Buffer.from(provided || "");
  const keyBuf = Buffer.from(API_KEY);
  if (!provided || providedBuf.length !== keyBuf.length || !crypto.timingSafeEqual(providedBuf, keyBuf)) {
    return res.status(401).json({ error: "Unauthorized: invalid or missing API key" });
  }
  next();
});

// ---------------------------------------------------------------------------
// Mount API route modules
// ---------------------------------------------------------------------------
app.use(require("./routes/enrollments"));
app.use(require("./routes/subscriptions"));
app.use(require("./routes/goals"));
app.use(require("./routes/settings"));
app.use(require("./routes/insights"));
app.use(require("./routes/budgets"));
app.use(require("./routes/categorize"));
app.use(require("./routes/notifications"));
app.use(require("./routes/investments"));
app.use(require("./routes/persistent"));

// ---------------------------------------------------------------------------
// Prevent browser caching of HTML pages and API mutation responses
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  // HTML pages: never cache so deploys take effect immediately
  if (!req.path.startsWith("/api/") && !req.path.endsWith(".js") && !req.path.endsWith(".css") && !req.path.endsWith(".json")) {
    res.set("Cache-Control", "no-store");
  }
  // API mutations: never cache responses
  if (req.path.startsWith("/api/") && req.method !== "GET" && req.method !== "HEAD") {
    res.set("Cache-Control", "no-store");
  }
  next();
});

// ---------------------------------------------------------------------------
// Mount HTML page modules
// ---------------------------------------------------------------------------
const pageConfig = { API_KEY: API_KEY || "", TELLER_APP_ID, TELLER_ENV };
const authConfig = { AUTH_MODE, AUTH_SECRET, SESSION_PASSWORD, SESSION_PIN };

app.use(require("./pages/dashboard")(pageConfig));
app.use(require("./pages/subscriptions")(pageConfig));
app.use(require("./pages/accounts")(pageConfig));
app.use(require("./pages/goals")(pageConfig));
app.use(require("./pages/budgets")(pageConfig));
app.use(require("./pages/login")(authConfig));
app.use(require("./pages/settings")(pageConfig));
app.use(require("./pages/transactions")(pageConfig));
app.use(require("./pages/calendar")(pageConfig));
app.use(require("./pages/account-history")(pageConfig));
app.use(require("./pages/pwa"));

// ---------------------------------------------------------------------------
// Health check (exempt from auth + API key)
// ---------------------------------------------------------------------------
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: Math.floor(process.uptime()) });
});

// Keep-alive schedule (public, no auth — used by external cron to check hours)
app.get("/api/keep-alive-schedule", async (_req, res) => {
  try {
    const config = await loadKeepAliveConfig();
    res.json({
      enabled: config.keep_alive_enabled,
      start: config.keep_alive_start,
      end: config.keep_alive_end,
      timezone: config.keep_alive_timezone,
    });
  } catch {
    res.json({ enabled: false });
  }
});


// ---------------------------------------------------------------------------
// Lifecycle / exports
// ---------------------------------------------------------------------------
// Migrations, cron jobs, listener, and shutdown handlers live in
// ./startup.js so the unified shell can `require()` this module to get
// the configured Express app without immediately binding a port. When
// run directly (`node server.js`), we still bootstrap exactly as before.

const { start } = require("./startup");

if (require.main === module) {
  start(app).catch((err) => {
    console.error("Startup failed:", err);
    process.exit(1);
  });
}

module.exports = { app, start, pool };
