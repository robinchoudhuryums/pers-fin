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

const express = require("express");
const crypto = require("crypto");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const session = require("express-session");

// --- Services ---
const { pool, runMigrations } = require("./services/database");
const { TELLER_APP_ID, TELLER_ENV } = require("./services/teller-api");
const { startKeepAlive } = require("./services/keep-alive");

// --- Auth config ---
const SESSION_PASSWORD = process.env.SESSION_PASSWORD;
const SESSION_PIN = process.env.SESSION_PIN;
const AUTH_SECRET = SESSION_PASSWORD || SESSION_PIN || null;
const AUTH_MODE = SESSION_PIN ? "pin" : (SESSION_PASSWORD ? "password" : null);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

// --- Express app setup ---
const app = express();
// Trust first proxy (Render/Fly.io load balancer) so secure cookies work behind TLS termination
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ---------------------------------------------------------------------------
// Session middleware
// ---------------------------------------------------------------------------
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  },
}));

function requireAuth(req, res, next) {
  if (!AUTH_SECRET) return next();
  if (["/login", "/api/login", "/manifest.json", "/sw.js", "/health"].includes(req.path)) return next();
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
// Security middleware
// ---------------------------------------------------------------------------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.teller.io", "https://cdn.jsdelivr.net"],
      connectSrc: ["'self'", "https://api.teller.io"],
      frameSrc: ["https://cdn.teller.io"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
    },
  },
}));

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(s => s.trim())
  : [];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
      return cb(null, true);
    }
    cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));

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
  if (!API_KEY) return next();
  if (req.path === "/login" || req.path === "/logout") return next();
  if (req.session && req.session.authenticated) return next();
  const provided = req.headers["x-api-key"] || req.query.api_key;
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

// ---------------------------------------------------------------------------
// Mount HTML page modules
// ---------------------------------------------------------------------------
const pageConfig = { API_KEY: API_KEY || "", TELLER_APP_ID, TELLER_ENV };
const authConfig = { AUTH_MODE, AUTH_SECRET, SESSION_PASSWORD, SESSION_PIN };

app.use(require("./pages/dashboard")(pageConfig));
app.use(require("./pages/subscriptions")(pageConfig));
app.use(require("./pages/accounts")(pageConfig));
app.use(require("./pages/goals")(pageConfig));
app.use(require("./pages/login")(authConfig));
app.use(require("./pages/settings")(pageConfig));
app.use(require("./pages/pwa"));

// ---------------------------------------------------------------------------
// Health check (exempt from auth + API key)
// ---------------------------------------------------------------------------
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: Math.floor(process.uptime()) });
});

// ---------------------------------------------------------------------------
// Start — run migrations before accepting requests
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
runMigrations().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Teller server running on http://0.0.0.0:${PORT}`);
    console.log(`  Environment: ${TELLER_ENV}`);
    console.log(`  Application ID: ${TELLER_APP_ID || "(not set)"}`);
    startKeepAlive(PORT);
  });
});
