// ============================================================================
// Per-sistant — Middleware (auth, CSRF, security, rate limiting)
// ============================================================================

const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const { pool } = require("./db");
const { AUTH_SECRET, AUTH_MODE, SESSION_SECRET } = require("./config");

function setup(app) {
  // Session
  app.use(session({
    store: new pgSession({
      pool,
      tableName: "session",
      createTableIfMissing: true,
      pruneSessionInterval: 60 * 15,
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000,
    },
  }));

  // Health check — no auth required (registered before auth middleware)
  app.get("/api/health", (req, res) => {
    const uptime = process.uptime();
    const mem = process.memoryUsage();
    pool.query("SELECT 1").then(() => {
      res.json({ status: "ok", uptime: Math.floor(uptime), memory_mb: Math.round(mem.rss / 1048576), db: "connected", timestamp: new Date().toISOString() });
    }).catch(() => {
      res.status(503).json({ status: "degraded", uptime: Math.floor(uptime), memory_mb: Math.round(mem.rss / 1048576), db: "disconnected", timestamp: new Date().toISOString() });
    });
  });

  // Auth
  app.use(requireAuth);

  // CSRF
  app.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    if (req.path === "/api/login") return next();
    const ct = (req.headers["content-type"] || "").toLowerCase();
    if (req.headers["x-requested-with"] || ct.includes("application/json") || ct.includes("multipart/form-data")) return next();
    return res.status(403).json({ error: "Forbidden: missing CSRF header" });
  });

  // Security headers
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
      },
    },
  }));

  app.use(cors({ origin: false, credentials: true }));

  // Rate limiters
  const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: { error: "Too many requests, please try again later." },
  });
  app.use("/api/", generalLimiter);

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: "Too many login attempts, please try again later." },
  });
  app.use("/api/login", authLimiter);

  const aiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: { error: "Too many AI requests, please slow down." },
  });
  app.use("/api/ai/", aiLimiter);
}

function requireAuth(req, res, next) {
  if (!AUTH_SECRET) return next();
  if (["/login", "/api/login", "/manifest.json", "/sw.js", "/api/health", "/api/keep-alive-schedule"].includes(req.path)) return next();
  if (req.path.startsWith("/icon-")) return next();
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

module.exports = { setup };
