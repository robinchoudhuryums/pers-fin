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

// Serve shared static assets (CSS, JS) — before auth so login page can use them
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));
// Serve Chart.js from node_modules (more reliable than CDN)
app.get("/vendor/chart.umd.js", (_req, res) => {
  res.sendFile(path.join(__dirname, "node_modules/chart.js/dist/chart.umd.js"));
});

// ---------------------------------------------------------------------------
// Session middleware
// ---------------------------------------------------------------------------
app.use(session({
  store: new pgSession({
    pool,
    tableName: "session",
    createTableIfMissing: true,
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
}));

function requireAuth(req, res, next) {
  if (!AUTH_SECRET) return next();
  if (["/login", "/api/login", "/api/webauthn/authenticate-options", "/api/webauthn/authenticate", "/manifest.json", "/sw.js", "/health", "/api/keep-alive-schedule", "/apple-touch-icon.svg", "/apple-touch-icon.png", "/logo.svg", "/api/sso/validate", "/api/perfin/webhook"].includes(req.path)) return next();
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
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
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
app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin requests (no origin header) always.
    // If ALLOWED_ORIGINS is not configured, only same-origin requests are allowed.
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.length > 0 && ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
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
// Start — run migrations before accepting requests
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
runMigrations().then(() => {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Teller server running on http://0.0.0.0:${PORT}`);
    console.log(`  Environment: ${TELLER_ENV}`);
    console.log(`  Application ID: ${TELLER_APP_ID || "(not set)"}`);
    startKeepAlive(PORT);

    // Sheets auto-sync check (every hour)
    setInterval(async () => {
      try {
        const settings = await pool.query("SELECT sheets_auto_sync_enabled, sheets_auto_sync_interval, sheets_last_auto_sync FROM user_settings WHERE id = 1");
        const s = settings.rows[0];
        if (!s || !s.sheets_auto_sync_enabled) return;
        const intervals = { daily: 1, weekly: 7, monthly: 30 };
        const intervalDays = intervals[s.sheets_auto_sync_interval] || 7;
        const lastSync = s.sheets_last_auto_sync ? new Date(s.sheets_last_auto_sync) : null;
        const now = new Date();
        if (!lastSync || (now - lastSync) / 86400000 >= intervalDays) {
          let sheetsSync;
          try { sheetsSync = require("../scripts/sheets-sync"); } catch { return; }
          if (!process.env.GOOGLE_SHEETS_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_KEY) return;
          await sheetsSync.syncAll();
          await pool.query("UPDATE user_settings SET sheets_last_auto_sync = now() WHERE id = 1");
          console.log("Auto-sync to Google Sheets complete.");
        }
      } catch (err) {
        console.error("Sheets auto-sync error:", err.message);
      }
    }, 60 * 60 * 1000); // Check every hour

    // Daily net worth auto-snapshot (checks every hour, takes one snapshot per day)
    setInterval(async () => {
      try {
        // Check if we already have a snapshot for today
        const existing = await pool.query(
          "SELECT id FROM net_worth_snapshots WHERE snapshot_date = CURRENT_DATE LIMIT 1"
        );
        if (existing.rows.length > 0) return;
        // Check if we have any accounts with balances
        const [accounts, investments] = await Promise.all([
          pool.query("SELECT name, type, available_balance, current_balance FROM linked_accounts WHERE available_balance IS NOT NULL OR current_balance IS NOT NULL"),
          pool.query("SELECT name, account_type, balance FROM investment_accounts WHERE is_active = true AND balance != 0"),
        ]);
        if (accounts.rows.length === 0 && investments.rows.length === 0) return;
        let totalAssets = 0, totalLiabilities = 0;
        const breakdown = { accounts: [], investments: [] };
        for (const a of accounts.rows) {
          if (a.type === "credit") {
            totalLiabilities += parseFloat(a.current_balance || 0);
            breakdown.accounts.push({ name: a.name, type: a.type, amount: -parseFloat(a.current_balance || 0) });
          } else {
            const bal = parseFloat(a.available_balance || a.current_balance || 0);
            totalAssets += bal;
            breakdown.accounts.push({ name: a.name, type: a.type, amount: bal });
          }
        }
        for (const inv of investments.rows) {
          const bal = parseFloat(inv.balance);
          totalAssets += bal;
          breakdown.investments.push({ name: inv.name, type: inv.account_type, amount: bal });
        }
        await pool.query(
          `INSERT INTO net_worth_snapshots (total_assets, total_liabilities, net_worth, breakdown, snapshot_date)
           VALUES ($1, $2, $3, $4, CURRENT_DATE)
           ON CONFLICT (snapshot_date) DO NOTHING`,
          [totalAssets, totalLiabilities, totalAssets - totalLiabilities, JSON.stringify(breakdown)]
        );
        console.log("Daily net worth snapshot recorded: $" + (totalAssets - totalLiabilities).toFixed(2));
      } catch (err) {
        console.error("Net worth auto-snapshot error:", err.message);
      }
    }, 60 * 60 * 1000); // Check every hour

    // Goal milestone notifications (checks every 6 hours)
    setInterval(async () => {
      try {
        const goals = await pool.query(
          "SELECT id, name, target_amount, current_amount FROM financial_goals WHERE is_active = true"
        );
        const MILESTONES = [25, 50, 75, 100];
        for (const g of goals.rows) {
          const target = parseFloat(g.target_amount);
          if (target <= 0) continue;
          const pct = Math.floor((parseFloat(g.current_amount) / target) * 100);
          for (const m of MILESTONES) {
            if (pct >= m) {
              // Check if we already notified for this milestone (stored as notes prefix)
              const key = `milestone_${m}`;
              const check = await pool.query(
                "SELECT notes FROM financial_goals WHERE id = $1", [g.id]
              );
              const notes = check.rows[0]?.notes || "";
              if (notes.includes(key)) continue;
              // Send notification
              try {
                const { sendToAll } = require("./routes/notifications");
                await sendToAll({
                  title: pct >= 100 ? "Goal reached!" : "Goal milestone: " + m + "%",
                  body: g.name + ": " + pct + "% complete" + (pct >= 100 ? " — congratulations!" : ""),
                  tag: "goal-" + g.id,
                  data: { url: "/goals" },
                });
              } catch {}
              // Mark milestone as notified
              const newNotes = (notes ? notes + " " : "") + key;
              await pool.query("UPDATE financial_goals SET notes = $1 WHERE id = $2", [newNotes, g.id]);
            }
          }
        }
      } catch (err) {
        console.error("Goal milestone check error:", err.message);
      }
    }, 6 * 60 * 60 * 1000); // Check every 6 hours

    // Auto-trigger AI insights based on cadence setting (checks every 6 hours)
    setInterval(async () => {
      try {
        if (!process.env.ANTHROPIC_API_KEY) return;
        const settings = await pool.query(
          "SELECT insights_enabled, insights_cadence_days, insights_last_run FROM user_settings WHERE id = 1"
        );
        const s = settings.rows[0];
        if (!s || !s.insights_enabled) return;
        const cadenceDays = s.insights_cadence_days || 30;
        const lastRun = s.insights_last_run ? new Date(s.insights_last_run) : null;
        const now = new Date();
        if (!lastRun || (now - lastRun) / 86400000 >= cadenceDays) {
          // Trigger insights generation via internal fetch.
          // Pass X-API-Key when API_KEY is configured so the request authenticates;
          // otherwise the request would always 401 and scheduled insights would silently never run.
          const port = process.env.PORT || 3000;
          const headers = { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" };
          if (API_KEY) headers["X-API-Key"] = API_KEY;
          try {
            const r = await fetch(`http://localhost:${port}/api/insights`, {
              method: "POST",
              headers,
            });
            if (r.ok) console.log("Auto-triggered AI insights (cadence: " + cadenceDays + " days).");
            else console.log("Auto-trigger insights skipped:", (await r.json().catch(() => ({}))).error);
          } catch (err) { console.error("Auto-trigger insights fetch error:", err.message); }
        }
      } catch (err) {
        console.error("Insights auto-trigger error:", err.message);
      }
    }, 6 * 60 * 60 * 1000); // Check every 6 hours

    // Budget alert push notifications (checks every 3 hours)
    setInterval(async () => {
      try {
        const { getCategorySpendingThisMonth } = require("./services/financial-queries");
        const [budgets, spending] = await Promise.all([
          pool.query("SELECT category, monthly_limit FROM budgets"),
          getCategorySpendingThisMonth(pool), // honors splits + reimbursed
        ]);
        if (budgets.rows.length === 0) return;
        const spendMap = {};
        for (const r of spending) spendMap[r.category] = parseFloat(r.spent);

        const { sendToAll } = require("./routes/notifications");
        for (const b of budgets.rows) {
          const spent = spendMap[b.category] || 0;
          const limit = parseFloat(b.monthly_limit);
          if (limit <= 0) continue;
          const pct = Math.round((spent / limit) * 100);
          // Thresholds aligned with /api/budgets/alerts: 100% = critical (over budget),
          // 80% = warning (approaching limit). The `info`/pace heuristic from the in-app
          // endpoint is intentionally NOT pushed — it would be too noisy as a notification.
          // Notification `tag` dedupes repeated pushes for the same category at the OS level.
          if (pct >= 100) {
            await sendToAll({
              title: "Budget exceeded: " + b.category,
              body: "$" + spent.toFixed(2) + " spent of $" + limit.toFixed(2) + " budget (" + pct + "%)",
              tag: "budget-over-" + b.category.toLowerCase().replace(/\s+/g, "-"),
              data: { url: "/budgets" },
            });
          } else if (pct >= 80) {
            await sendToAll({
              title: "Budget warning: " + b.category,
              body: "$" + spent.toFixed(2) + " of $" + limit.toFixed(2) + " (" + pct + "% — approaching limit)",
              tag: "budget-warn-" + b.category.toLowerCase().replace(/\s+/g, "-"),
              data: { url: "/budgets" },
            });
          }
        }
      } catch (err) {
        console.error("Budget alert notification error:", err.message);
      }
    }, 3 * 60 * 60 * 1000); // Check every 3 hours

    // Bank auto-sync (Phase A): every 1 hour, check whether the configured
    // interval has elapsed and call syncAllEnrollments + syncAllBalances
    // in-process. Called directly (not via HTTP fetch) so API_KEY-protected
    // deployments don't 401 against themselves, and so the work runs even
    // when the anomaly/push path is unavailable.
    setInterval(async () => {
      try {
        const settings = await pool.query(
          "SELECT auto_sync_enabled, auto_sync_interval_hours, last_auto_sync_at FROM user_settings WHERE id = 1"
        );
        const s = settings.rows[0];
        if (!s || !s.auto_sync_enabled) return;
        const intervalHours = Math.max(1, Math.min(168, parseInt(s.auto_sync_interval_hours) || 6));
        const lastSync = s.last_auto_sync_at ? new Date(s.last_auto_sync_at) : null;
        const now = new Date();
        const dueMs = intervalHours * 60 * 60 * 1000;
        if (lastSync && (now - lastSync) < dueMs) return;

        const { syncAllEnrollments, syncAllBalances } = require("./routes/enrollments");
        let txnResult = null, balResult = null;
        try { txnResult = await syncAllEnrollments(); }
        catch (e) { console.error("Auto-sync transactions error:", e.message); }
        try { balResult = await syncAllBalances(); }
        catch (e) { console.error("Auto-sync balances error:", e.message); }

        await pool.query("UPDATE user_settings SET last_auto_sync_at = now() WHERE id = 1")
          .catch(e => console.error("Auto-sync timestamp update failed:", e.message));
        console.log(
          "Auto-sync complete: " +
            (txnResult ? `${txnResult.transactions_added} txns added` : "txn sync failed") +
            ", " +
            (balResult ? `${balResult.accounts_updated} balances updated` : "balance sync failed")
        );
      } catch (err) {
        console.error("Auto-sync scheduler error:", err.message);
      }
    }, 60 * 60 * 1000); // Check every 1 hour
  });

  // --- Graceful shutdown ---
  function shutdown(signal) {
    console.log(`\n${signal} received — shutting down gracefully...`);
    server.close(() => {
      console.log("HTTP server closed.");
      pool.end().then(() => {
        console.log("Database pool closed.");
        process.exit(0);
      }).catch(() => process.exit(1));
    });
    // Force exit after 10s if graceful shutdown stalls
    setTimeout(() => { console.error("Forced shutdown after timeout."); process.exit(1); }, 10000);
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
});
