// ============================================================================
// Teller Server — Perfin (Personal Finance Tracker)
// ============================================================================
// Express server that uses the Teller API (https://api.teller.io) instead of
// Plaid.  Teller uses mTLS (client certificate) + HTTP Basic Auth (access
// token) — no SDK required.
//
// Endpoints:
//   POST /api/enroll           — store access token from Teller Connect
//   POST /api/sync             — pull transactions for all enrollments
//   GET  /api/items            — list linked institutions
//   GET  /api/transactions     — list transactions (query: months, limit, offset)
//   GET  /api/subscriptions    — list detected subscriptions
//   GET  /                     — Teller Connect + CSV import UI
//   GET  /dashboard            — personal finance dashboard
//   GET  /subscriptions        — subscription management
//
// Run with:  node server.js
// Requires:  .env file in repo root (see .env.example)
// ============================================================================

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const express = require("express");
const https = require("https");
const fs = require("fs");
const crypto = require("crypto");
const { Pool } = require("pg");
const path = require("path");
const multer = require("multer");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const session = require("express-session");
const { parse } = require("csv-parse/sync");
const { detectSubscriptions } = require("../scripts/detect-subscriptions");

let sheetsSync;
try {
  sheetsSync = require("../scripts/sheets-sync");
} catch {
  sheetsSync = null;
}

let Anthropic;
try {
  Anthropic = require("@anthropic-ai/sdk").default || require("@anthropic-ai/sdk");
} catch {
  Anthropic = null;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const SESSION_PASSWORD = process.env.SESSION_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

const app = express();
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
  if (!SESSION_PASSWORD) return next();
  if (["/login", "/api/login", "/manifest.json", "/sw.js"].includes(req.path)) return next();
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
// Helmet — sets security headers (CSP, X-Frame-Options, HSTS, etc.)
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

// CORS — restrict to allowed origins
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(s => s.trim())
  : [];
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (server-to-server, curl, mobile apps)
    if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
      return cb(null, true);
    }
    cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));

// Rate limiting — general + tight limits for expensive operations
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { error: "Too many requests, please try again later." },
});
const tightLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  message: { error: "Too many requests, please try again later." },
});
app.use("/api/", generalLimiter);
app.use("/api/sync", tightLimiter);
app.use("/api/detect", tightLimiter);
app.use("/api/cleanup", tightLimiter);
app.use("/api/enroll", tightLimiter);

// API key authentication — protects all /api/* routes
// Set API_KEY env var to enable. Browser pages (/, /dashboard, /subscriptions) remain open.
const API_KEY = process.env.API_KEY;
app.use("/api", (req, res, next) => {
  if (!API_KEY) return next(); // no key configured = open (dev mode)
  const provided = req.headers["x-api-key"] || req.query.api_key;
  const providedBuf = Buffer.from(provided || "");
  const keyBuf = Buffer.from(API_KEY);
  if (!provided || providedBuf.length !== keyBuf.length || !crypto.timingSafeEqual(providedBuf, keyBuf)) {
    return res.status(401).json({ error: "Unauthorized: invalid or missing API key" });
  }
  next();
});

// ---------------------------------------------------------------------------
// Teller API config
// ---------------------------------------------------------------------------
const TELLER_API_BASE = "https://api.teller.io";
const TELLER_APP_ID = process.env.TELLER_APPLICATION_ID;
const TELLER_ENV = (process.env.TELLER_ENV || "sandbox").toLowerCase();
const TELLER_CERT_PATH = process.env.TELLER_CERT_PATH;
const TELLER_KEY_PATH = process.env.TELLER_KEY_PATH;

// Load TLS client certificate for mTLS
// Supports: file paths (TELLER_CERT_PATH) or base64 env vars (TELLER_CERT / TELLER_KEY)
let tlsAgent = null;
function getTlsAgent() {
  if (tlsAgent) return tlsAgent;

  let cert, key;

  // Option 1: base64-encoded cert/key in env vars (recommended for PaaS)
  if (process.env.TELLER_CERT && process.env.TELLER_KEY) {
    console.log("[mTLS] Loading certificate from TELLER_CERT/TELLER_KEY env vars (base64)");
    cert = Buffer.from(process.env.TELLER_CERT, "base64");
    key = Buffer.from(process.env.TELLER_KEY, "base64");
  } else {
    // Option 2: file paths
    const certPath = path.resolve(TELLER_CERT_PATH || "./certificate.pem");
    const keyPath = path.resolve(TELLER_KEY_PATH || "./private_key.pem");
    console.log(`[mTLS] Loading certificate from files: ${certPath}, ${keyPath}`);

    if (!fs.existsSync(certPath)) {
      console.error(`[mTLS] ERROR: Certificate file not found: ${certPath}`);
      console.error(`[mTLS] cwd: ${process.cwd()}`);
      throw new Error(`Certificate file not found: ${certPath}`);
    }
    if (!fs.existsSync(keyPath)) {
      console.error(`[mTLS] ERROR: Private key file not found: ${keyPath}`);
      throw new Error(`Private key file not found: ${keyPath}`);
    }

    cert = fs.readFileSync(certPath);
    key = fs.readFileSync(keyPath);
  }

  console.log(`[mTLS] Certificate loaded (${cert.length} bytes), key loaded (${key.length} bytes)`);
  tlsAgent = new https.Agent({ cert, key });
  return tlsAgent;
}

// ---------------------------------------------------------------------------
// Teller API helper — makes authenticated requests
// ---------------------------------------------------------------------------
async function tellerRequest(endpoint, accessToken, options = {}) {
  const url = `${TELLER_API_BASE}${endpoint}`;
  const method = options.method || "GET";

  // Basic auth: access_token as username, empty password
  const authHeader = "Basic " + Buffer.from(accessToken + ":").toString("base64");
  const bodyData = options.body ? JSON.stringify(options.body) : null;

  // Use https.request (not fetch) so the mTLS agent is actually applied
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method,
        agent: getTlsAgent(),
        headers: {
          "Authorization": authHeader,
          "Content-Type": "application/json",
          ...options.headers,
          ...(bodyData ? { "Content-Length": Buffer.byteLength(bodyData) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          if (res.statusCode >= 400) {
            const err = new Error(`Teller API error ${res.statusCode}: ${text}`);
            err.status = res.statusCode;
            err.body = text;
            return reject(err);
          }
          // DELETE returns 204 No Content
          if (res.statusCode === 204) return resolve(null);
          try {
            resolve(JSON.parse(text));
          } catch (e) {
            reject(new Error(`Invalid JSON from Teller API: ${text}`));
          }
        });
      }
    );
    req.on("error", reject);
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Postgres pool
// ---------------------------------------------------------------------------
const pool = new Pool({
  connectionString: process.env.NEON_DATABASE_URL,
  ssl: { rejectUnauthorized: true },
  max: 5,
  connectionTimeoutMillis: 10000,
});

const ENCRYPTION_PASSPHRASE = process.env.TOKEN_ENCRYPTION_PASSPHRASE;

// ---------------------------------------------------------------------------
// POST /api/enroll — store Teller Connect enrollment
// ---------------------------------------------------------------------------
// Called by the frontend after Teller Connect completes.
// Receives: { accessToken, enrollment: { id, institution: { name } } }
app.post("/api/enroll", async (req, res) => {
  const { accessToken, enrollment } = req.body;
  if (!accessToken || !enrollment?.id) {
    return res.status(400).json({ error: "accessToken and enrollment are required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const institutionName = enrollment.institution?.name || "Unknown";

    // Insert enrollment with encrypted access token
    const enrollResult = await client.query(
      `INSERT INTO teller_enrollments (enrollment_id, institution_name, access_token_enc)
       VALUES ($1, $2, pgp_sym_encrypt($3, $4))
       ON CONFLICT (enrollment_id) DO UPDATE SET
         access_token_enc = pgp_sym_encrypt($3, $4),
         institution_name = $2,
         status = 'GOOD',
         updated_at = now()
       RETURNING id`,
      [enrollment.id, institutionName, accessToken, ENCRYPTION_PASSPHRASE]
    );
    const enrollmentDbId = enrollResult.rows[0].id;

    // Fetch accounts from Teller API
    const accounts = await tellerRequest("/accounts", accessToken);

    let linked = 0;
    for (const acct of accounts) {
      await client.query(
        `INSERT INTO linked_accounts (teller_enrollment_id, account_id, name, official_name, type, subtype, mask)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (account_id) DO UPDATE SET
           name = EXCLUDED.name,
           official_name = EXCLUDED.official_name,
           type = EXCLUDED.type,
           subtype = EXCLUDED.subtype`,
        [
          enrollmentDbId,
          acct.id,
          acct.name,
          acct.name, // Teller uses 'name' for both
          acct.type, // depository, credit
          acct.subtype || acct.type,
          acct.last_four || null,
        ]
      );
      linked++;
    }

    await client.query("COMMIT");

    console.log(`Enrolled ${institutionName}: ${linked} accounts linked.`);
    res.json({
      enrollment_id: enrollment.id,
      institution: institutionName,
      accounts_linked: linked,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Enrollment error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// POST /api/sync — pull transactions for all Teller enrollments
// ---------------------------------------------------------------------------
app.post("/api/sync", async (req, res) => {
  try {
    const { rows: enrollments } = await pool.query(
      `SELECT te.id, te.enrollment_id, te.institution_name,
              pgp_sym_decrypt(te.access_token_enc, $1) AS access_token,
              te.last_synced_txn_date
       FROM teller_enrollments te
       WHERE te.status != 'SUSPENDED'
       ORDER BY te.id`,
      [ENCRYPTION_PASSPHRASE]
    );

    let totalAdded = 0;
    let totalUpdated = 0;
    const errors = [];

    for (const enrollment of enrollments) {
      try {
        const result = await syncEnrollment(enrollment);
        totalAdded += result.added;
        totalUpdated += result.updated;
      } catch (err) {
        console.error(`Sync error for ${enrollment.institution_name}:`, err.message);

        // Mark disconnected enrollments
        if (err.status === 401 || err.status === 403) {
          await pool.query(
            `UPDATE teller_enrollments SET status = 'DISCONNECTED', updated_at = now()
             WHERE id = $1`,
            [enrollment.id]
          );
        }

        errors.push({
          institution: enrollment.institution_name,
          error: err.message,
        });
      }
    }

    res.json({
      enrollments_synced: enrollments.length - errors.length,
      transactions_added: totalAdded,
      transactions_updated: totalUpdated,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error("Sync error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

async function syncEnrollment(enrollment) {
  const { id: enrollmentDbId, access_token, last_synced_txn_date, institution_name } = enrollment;

  // Get all accounts for this enrollment
  const { rows: accounts } = await pool.query(
    `SELECT account_id FROM linked_accounts WHERE teller_enrollment_id = $1`,
    [enrollmentDbId]
  );

  let added = 0;
  let updated = 0;
  let latestDate = last_synced_txn_date;

  for (const { account_id } of accounts) {
    // Fetch transactions from Teller
    // Teller returns up to 500 transactions per request, supports from_id for pagination
    let allTxns = [];
    let endpoint = `/accounts/${account_id}/transactions`;

    // If we have a last sync date, only fetch newer transactions
    if (last_synced_txn_date) {
      // Fetch all and filter — Teller doesn't support date filtering directly
      // but returns transactions in reverse chronological order
    }

    // Paginate through all transactions
    let keepFetching = true;
    while (keepFetching) {
      const txns = await tellerRequest(endpoint, access_token);

      if (!txns || txns.length === 0) break;
      allTxns = allTxns.concat(txns);

      // Teller returns transactions newest first
      // If we have a sync date, stop when we've gone past it
      const oldestInBatch = txns[txns.length - 1];
      if (last_synced_txn_date && new Date(oldestInBatch.date) <= new Date(last_synced_txn_date)) {
        keepFetching = false;
      } else if (txns.length < 500) {
        keepFetching = false; // No more pages
      } else {
        // Next page: use from_id of the last transaction
        endpoint = `/accounts/${account_id}/transactions?from_id=${oldestInBatch.id}`;
      }
    }

    // Filter to only transactions newer than last sync (if applicable)
    const txnsToProcess = last_synced_txn_date
      ? allTxns.filter(t => new Date(t.date) > new Date(last_synced_txn_date))
      : allTxns;

    // Upsert transactions
    for (const txn of txnsToProcess) {
      if (txn.status === "pending") continue;

      const amount = Math.abs(parseFloat(txn.amount));
      // Teller uses negative amounts for debits; we store positive for debits (like Plaid)
      const normalizedAmount = parseFloat(txn.amount) < 0 ? Math.abs(parseFloat(txn.amount)) : -parseFloat(txn.amount);

      const result = await pool.query(
        `INSERT INTO transactions (account_id, transaction_id, amount, iso_currency_code, date,
                                   merchant_name, name, category, pending)
         VALUES ($1, $2, $3, 'USD', $4, $5, $6, $7, false)
         ON CONFLICT (transaction_id)
         DO UPDATE SET
           amount = EXCLUDED.amount,
           date = EXCLUDED.date,
           merchant_name = EXCLUDED.merchant_name,
           name = EXCLUDED.name,
           category = EXCLUDED.category,
           pending = EXCLUDED.pending`,
        [
          account_id,
          txn.id, // Teller transaction ID
          normalizedAmount,
          txn.date,
          txn.details?.counterparty?.name || txn.description || null,
          txn.description || "",
          txn.details?.category ? `{${txn.details.category}}` : null,
        ]
      );

      if (result.rowCount > 0) {
        // Check if it was an insert or update
        added++;
      }

      // Track latest date
      if (!latestDate || new Date(txn.date) > new Date(latestDate)) {
        latestDate = txn.date;
      }
    }
  }

  // Update last synced date
  if (latestDate) {
    await pool.query(
      `UPDATE teller_enrollments SET last_synced_txn_date = $1, updated_at = now()
       WHERE id = $2`,
      [latestDate, enrollmentDbId]
    );
  }

  console.log(`  ${institution_name}: ${added} added/updated`);
  return { added, updated };
}

// ---------------------------------------------------------------------------
// GET /api/items — list linked institutions
// ---------------------------------------------------------------------------
app.get("/api/items", async (_req, res) => {
  try {
    // Fetch both Plaid and Teller enrollments
    const result = await pool.query(
      `SELECT
         COALESCE(te.id, pi.id) AS id,
         COALESCE(te.enrollment_id, pi.item_id) AS item_id,
         COALESCE(te.institution_name, pi.institution_name) AS institution_name,
         COALESCE(te.status, pi.status) AS status,
         COALESCE(te.created_at, pi.created_at) AS created_at,
         CASE WHEN te.id IS NOT NULL THEN 'teller' ELSE 'plaid' END AS provider,
         json_agg(json_build_object(
           'account_id', la.account_id,
           'name', la.name,
           'type', la.type,
           'subtype', la.subtype,
           'mask', la.mask
         )) AS accounts
       FROM linked_accounts la
       LEFT JOIN teller_enrollments te ON te.id = la.teller_enrollment_id
       LEFT JOIN plaid_items pi ON pi.id = la.plaid_item_id
       GROUP BY te.id, te.enrollment_id, te.institution_name, te.status, te.created_at,
                pi.id, pi.item_id, pi.institution_name, pi.status, pi.created_at
       ORDER BY COALESCE(te.created_at, pi.created_at)`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("list items error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/enrollments/:id — disconnect an institution
// ---------------------------------------------------------------------------
app.delete("/api/enrollments/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT enrollment_id,
              pgp_sym_decrypt(access_token_enc, $1) AS access_token
       FROM teller_enrollments WHERE id = $2`,
      [ENCRYPTION_PASSPHRASE, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Enrollment not found" });

    // Revoke access at Teller for each account
    try {
      const accounts = await tellerRequest("/accounts", rows[0].access_token);
      for (const acct of accounts) {
        await tellerRequest(`/accounts/${acct.id}`, rows[0].access_token, { method: "DELETE" });
      }
    } catch (err) {
      console.warn("Could not revoke at Teller (may already be disconnected):", err.message);
    }

    // Remove from DB (cascade deletes linked_accounts and transactions)
    await pool.query(`DELETE FROM teller_enrollments WHERE id = $1`, [req.params.id]);

    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/accounts — list accounts with balances
// ---------------------------------------------------------------------------
app.get("/api/accounts", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT la.id, la.account_id, la.name, la.official_name, la.type, la.subtype, la.mask,
              la.available_balance, la.current_balance, la.balance_currency, la.balance_updated_at,
              COALESCE(te.institution_name, pi.institution_name) AS institution_name,
              CASE WHEN te.id IS NOT NULL THEN 'teller' ELSE 'plaid' END AS provider
       FROM linked_accounts la
       LEFT JOIN teller_enrollments te ON te.id = la.teller_enrollment_id
       LEFT JOIN plaid_items pi ON pi.id = la.plaid_item_id
       ORDER BY la.type, la.name`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("list accounts error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// ---------------------------------------------------------------------------
// POST /api/sync-balances — fetch latest balances from Teller
// ---------------------------------------------------------------------------
app.post("/api/sync-balances", async (_req, res) => {
  try {
    const enrollments = await pool.query(
      `SELECT id, enrollment_id, institution_name,
              pgp_sym_decrypt(access_token_enc, $1) AS access_token
       FROM teller_enrollments WHERE status = 'GOOD'`,
      [ENCRYPTION_PASSPHRASE]
    );

    let updated = 0;
    const errors = [];

    for (const enrollment of enrollments.rows) {
      try {
        const accounts = await tellerRequest("/accounts", enrollment.access_token);
        for (const acct of accounts) {
          // Teller returns balance info on each account object
          let balances = null;
          try {
            balances = await tellerRequest(`/accounts/${acct.id}/balances`, enrollment.access_token);
          } catch {
            // Some account types may not support balances
          }

          const available = balances?.available || acct.balance?.available || null;
          const ledger = balances?.ledger || acct.balance?.ledger || acct.balance?.current || null;

          if (available !== null || ledger !== null) {
            await pool.query(
              `UPDATE linked_accounts
               SET available_balance = $1, current_balance = $2, balance_updated_at = now()
               WHERE account_id = $3`,
              [available ? parseFloat(available) : null, ledger ? parseFloat(ledger) : null, acct.id]
            );
            updated++;
          }
        }
      } catch (err) {
        errors.push({ institution: enrollment.institution_name, error: err.message });
      }
    }

    res.json({ accounts_updated: updated, errors: errors.length > 0 ? errors : undefined });
  } catch (err) {
    console.error("sync-balances error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/spending-summary — aggregated spending data for dashboard
// ---------------------------------------------------------------------------
app.get("/api/spending-summary", async (req, res) => {
  const months = parseInt(req.query.months) || 6;
  try {
    // Monthly spending trend
    const monthlyTrend = await pool.query(
      `SELECT TO_CHAR(date, 'YYYY-MM') AS month,
              SUM(amount) AS total_spend,
              COUNT(*) AS txn_count,
              ROUND(AVG(amount), 2) AS avg_transaction
       FROM transactions
       WHERE amount > 0 AND date >= CURRENT_DATE - ($1 || ' months')::INTERVAL
       GROUP BY TO_CHAR(date, 'YYYY-MM')
       ORDER BY month DESC`,
      [months]
    );

    // Spending by category
    const byCategory = await pool.query(
      `SELECT COALESCE(category[1], 'Uncategorized') AS category,
              SUM(amount) AS total,
              COUNT(*) AS txn_count
       FROM transactions
       WHERE amount > 0 AND date >= CURRENT_DATE - ($1 || ' months')::INTERVAL
       GROUP BY COALESCE(category[1], 'Uncategorized')
       ORDER BY total DESC
       LIMIT 15`,
      [months]
    );

    // Top merchants
    const topMerchants = await pool.query(
      `SELECT COALESCE(merchant_name, name) AS merchant,
              SUM(amount) AS total_spent,
              COUNT(*) AS txn_count
       FROM transactions
       WHERE amount > 0 AND merchant_name IS NOT NULL
             AND date >= CURRENT_DATE - ($1 || ' months')::INTERVAL
       GROUP BY COALESCE(merchant_name, name)
       ORDER BY total_spent DESC
       LIMIT 10`,
      [months]
    );

    // Upcoming subscription charges
    const upcoming = await pool.query(
      `SELECT display_name, amount, cadence_days, next_expected,
              ROUND(amount * (30.0 / NULLIF(cadence_days, 0)), 2) AS monthly_cost
       FROM detected_subscriptions
       WHERE is_active = true AND is_dismissed = false AND cancelled_at IS NULL
       ORDER BY next_expected ASC
       LIMIT 10`
    );

    res.json({
      monthly_trend: monthlyTrend.rows,
      by_category: byCategory.rows,
      top_merchants: topMerchants.rows,
      upcoming_subscriptions: upcoming.rows,
    });
  } catch (err) {
    console.error("spending-summary error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// ---------------------------------------------------------------------------
// CSV Import — same as Plaid server (shared format detection logic)
// ---------------------------------------------------------------------------
const CSV_FORMATS = {
  chase: {
    detect: (headers) => headers.includes("Transaction Date") && headers.includes("Post Date") && headers.includes("Description"),
    parse: (row) => ({
      date: row["Transaction Date"],
      merchant_name: row["Description"],
      amount: -parseFloat(row["Amount"]),
      category: row["Category"] || "",
    }),
  },
  capitalone: {
    detect: (headers) => headers.includes("Transaction Date") && headers.includes("Posted Date") && (headers.includes("Debit") || headers.includes("Credit")),
    parse: (row) => ({
      date: row["Transaction Date"],
      merchant_name: row["Description"],
      amount: parseFloat(row["Debit"] || "0") || -(parseFloat(row["Credit"] || "0")),
      category: row["Category"] || "",
    }),
  },
  discover: {
    detect: (headers) => headers.includes("Trans. Date") && headers.includes("Description") && headers.includes("Amount"),
    parse: (row) => ({
      date: row["Trans. Date"],
      merchant_name: row["Description"],
      amount: Math.abs(parseFloat(row["Amount"])),
      category: row["Category"] || "",
    }),
  },
  wellsfargo: {
    detect: (headers) => headers.length === 5 && !headers.includes("Transaction Date"),
    headerless: true,
    columns: ["date", "amount", "ignore1", "ignore2", "merchant_name"],
    parse: (row, cols) => ({
      date: row[cols[0]],
      merchant_name: (row[cols[4]] || row[cols[3]] || "").trim(),
      amount: -parseFloat(row[cols[1]]),
      category: "",
    }),
  },
  schwab: {
    detect: (headers) => headers.includes("Date") && headers.includes("Description") && (headers.includes("Withdrawal") || headers.includes("Amount")),
    parse: (row) => ({
      date: row["Date"],
      merchant_name: row["Description"],
      amount: Math.abs(parseFloat(row["Withdrawal"] || row["Amount"] || "0")),
      category: row["Type"] || "",
    }),
  },
  generic: {
    detect: () => true,
    parse: (row) => {
      const date = row["Date"] || row["Transaction Date"] || Object.values(row)[0];
      const merchant = row["Description"] || row["Merchant"] || row["Name"] || Object.values(row)[1];
      const amount = parseFloat(row["Amount"] || row["Debit"] || Object.values(row)[2] || 0);
      const category = row["Category"] || "";
      return { date, merchant_name: merchant, amount: Math.abs(amount), category };
    },
  },
};

function detectCsvFormat(headers) {
  for (const [name, fmt] of Object.entries(CSV_FORMATS)) {
    if (name === "generic") continue;
    if (fmt.detect(headers)) return name;
  }
  return "generic";
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  const trimmed = dateStr.trim();
  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, m, d, y] = slashMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const isoMatch = trimmed.match(/^\d{4}-\d{2}-\d{2}$/);
  if (isoMatch) return trimmed;
  const parsed = new Date(trimmed);
  return isNaN(parsed) ? null : parsed.toISOString().split("T")[0];
}

function csvTransactionId(accountLabel, date, amount, merchant, rowIdx) {
  const raw = `${accountLabel}|${date}|${amount}|${merchant || ""}|${rowIdx}`;
  return "csv_" + crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

app.post("/api/import-csv", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const institution = req.body.institution || "CSV Import";
  const accountLabel = req.body.account_label || `${institution} Account`;

  try {
    const content = req.file.buffer.toString("utf-8");
    const records = parse(content, { columns: true, skip_empty_lines: true, trim: true, bom: true });
    if (!records.length) return res.status(400).json({ error: "CSV file is empty or unparseable" });

    const headers = Object.keys(records[0]);
    const formatName = detectCsvFormat(headers);
    const fmt = CSV_FORMATS[formatName];

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Create virtual teller_enrollment + linked_account for CSV source
      const virtualEnrollId = `csv_${institution.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
      const virtualAccountId = `csv_${accountLabel.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;

      // Ensure plaid_items entry exists for CSV (backward compat with existing CSV imports)
      await client.query(
        `INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status)
         VALUES ($1, $2, pgp_sym_encrypt('csv_no_token', $3), 'CSV')
         ON CONFLICT (item_id) DO NOTHING`,
        [virtualEnrollId, institution, ENCRYPTION_PASSPHRASE]
      );

      const piRow = await client.query(`SELECT id FROM plaid_items WHERE item_id = $1`, [virtualEnrollId]);

      await client.query(
        `INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype)
         VALUES ($1, $2, $3, 'csv', 'import')
         ON CONFLICT (account_id) DO NOTHING`,
        [piRow.rows[0].id, virtualAccountId, accountLabel]
      );

      let imported = 0;
      let skipped = 0;

      for (let i = 0; i < records.length; i++) {
        const row = records[i];
        let parsed;
        try {
          parsed = fmt.parse(row, headers);
        } catch { skipped++; continue; }

        const date = parseDate(parsed.date);
        if (!date || isNaN(parsed.amount) || parsed.amount === 0) { skipped++; continue; }

        const txnId = csvTransactionId(accountLabel, date, parsed.amount, parsed.merchant_name, i);

        const result = await client.query(
          `INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, category, pending)
           VALUES ($1, $2, $3, $4, $5, $6, $7, false)
           ON CONFLICT (transaction_id) DO NOTHING`,
          [
            virtualAccountId, txnId, parsed.amount, date,
            parsed.merchant_name || null, parsed.merchant_name || "",
            parsed.category ? `{${parsed.category}}` : null,
          ]
        );
        if (result.rowCount > 0) imported++;
        else skipped++;
      }

      // Log import
      await client.query(
        `INSERT INTO csv_imports (filename, institution, account_label, rows_imported, rows_skipped)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.file.originalname, institution, accountLabel, imported, skipped]
      );

      await client.query("COMMIT");

      res.json({
        format_detected: formatName,
        rows_imported: imported,
        rows_skipped: skipped,
        account_label: accountLabel,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("CSV import error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

app.get("/api/csv-imports", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM csv_imports ORDER BY imported_at DESC LIMIT 50`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// ---------------------------------------------------------------------------
// Cancel URL lookup (same as Plaid server)
// ---------------------------------------------------------------------------
const CANCEL_URLS = {
  "netflix": "https://www.netflix.com/cancelplan",
  "spotify": "https://www.spotify.com/account/subscription/",
  "hulu": "https://secure.hulu.com/account",
  "disney+": "https://www.disneyplus.com/account",
  "disney plus": "https://www.disneyplus.com/account",
  "hbo max": "https://www.max.com/account",
  "hbo": "https://www.max.com/account",
  "max": "https://www.max.com/account",
  "amazon prime": "https://www.amazon.com/mc/pipelines/cancelPrime",
  "prime video": "https://www.amazon.com/mc/pipelines/cancelPrime",
  "apple": "https://support.apple.com/en-us/HT202039",
  "icloud": "https://support.apple.com/en-us/HT202039",
  "youtube": "https://www.youtube.com/paid_memberships",
  "google one": "https://one.google.com/settings",
  "adobe": "https://account.adobe.com/plans",
  "microsoft": "https://account.microsoft.com/services/",
  "xbox": "https://account.microsoft.com/services/",
  "playstation": "https://store.playstation.com/subscriptions",
  "dropbox": "https://www.dropbox.com/account/plan",
  "chatgpt": "https://chat.openai.com/settings/subscription",
  "openai": "https://chat.openai.com/settings/subscription",
  "slack": "https://slack.com/account/settings",
  "zoom": "https://zoom.us/account",
  "nordvpn": "https://my.nordaccount.com/dashboard/nordvpn/",
  "expressvpn": "https://www.expressvpn.com/subscriptions",
  "paramount+": "https://www.paramountplus.com/account/",
  "paramount plus": "https://www.paramountplus.com/account/",
  "peacock": "https://www.peacocktv.com/account/subscription",
  "crunchyroll": "https://www.crunchyroll.com/account/subscription",
  "audible": "https://www.audible.com/account/prefs",
  "kindle unlimited": "https://www.amazon.com/kindle-dbs/hz/subscribe/ku",
  "nytimes": "https://myaccount.nytimes.com/seg/subscription",
  "new york times": "https://myaccount.nytimes.com/seg/subscription",
  "wall street journal": "https://customercenter.wsj.com/",
  "wsj": "https://customercenter.wsj.com/",
  "linkedin premium": "https://www.linkedin.com/mypreferences/d/manage-subscription",
  "grammarly": "https://account.grammarly.com/subscription",
  "dashlane": "https://app.dashlane.com/account/subscriptions",
  "1password": "https://my.1password.com/settings/billing",
  "github": "https://github.com/settings/billing",
  "notion": "https://www.notion.so/my-account",
  "figma": "https://www.figma.com/settings",
  "canva": "https://www.canva.com/settings/billing-and-plans",
};

// Subscription category auto-tagging
const CATEGORY_RULES = {
  streaming: ["netflix", "hulu", "disney", "hbo", "max", "prime video", "peacock", "paramount", "crunchyroll", "apple tv", "youtube premium", "spotify", "tidal", "deezer", "pandora", "audible"],
  software: ["adobe", "microsoft", "notion", "figma", "canva", "github", "slack", "zoom", "dropbox", "1password", "dashlane", "grammarly", "chatgpt", "openai", "jetbrains"],
  gaming: ["xbox", "playstation", "ps plus", "nintendo", "steam", "ea play", "game pass"],
  news: ["nytimes", "new york times", "wsj", "wall street journal", "washington post", "the athletic", "substack"],
  fitness: ["peloton", "strava", "fitbit", "headspace", "calm", "noom", "orange theory", "planet fitness", "gym"],
  cloud: ["icloud", "google one", "aws", "azure", "digitalocean", "backblaze"],
  vpn: ["nordvpn", "expressvpn", "surfshark", "protonvpn", "private internet"],
  shopping: ["amazon prime", "costco", "walmart", "instacart", "doordash", "uber eats", "grubhub"],
  finance: ["mint", "ynab", "quickbooks", "turbotax", "credit karma"],
  communication: ["linkedin", "bumble", "tinder", "match", "whatsapp", "skype"],
};

function categorizeSubscription(merchantName) {
  if (!merchantName) return "other";
  const lower = merchantName.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_RULES)) {
    if (keywords.some(kw => lower.includes(kw))) return category;
  }
  return "other";
}

function findCancelUrl(merchantName) {
  if (!merchantName) return null;
  const lower = merchantName.toLowerCase();
  for (const [key, url] of Object.entries(CANCEL_URLS)) {
    if (lower.includes(key)) return url;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Subscription CRUD (same as Plaid server — shared schema)
// ---------------------------------------------------------------------------
app.get("/api/subscriptions", async (req, res) => {
  const filter = req.query.filter || "active";
  try {
    let where;
    switch (filter) {
      case "dismissed": where = "WHERE ds.is_dismissed = true AND ds.cancelled_at IS NULL"; break;
      case "cancelled": where = "WHERE ds.cancelled_at IS NOT NULL"; break;
      case "all": where = ""; break;
      default: where = "WHERE ds.is_active = true AND ds.is_dismissed = false AND ds.cancelled_at IS NULL";
    }
    const result = await pool.query(`
      SELECT ds.*,
        CASE WHEN ds.cadence_days > 0
          THEN ROUND(ds.amount * (30.0 / ds.cadence_days), 2)
          ELSE ds.amount
        END AS monthly_cost
      FROM detected_subscriptions ds
      ${where}
      ORDER BY ds.amount DESC
    `);

    const subs = result.rows.map(s => ({
      ...s,
      cancel_url: findCancelUrl(s.display_name) || findCancelUrl(s.merchant_key),
      category: categorizeSubscription(s.display_name),
    }));

    const active = subs.filter(s => !s.is_dismissed && !s.cancelled_at);
    const monthlyCost = active.reduce((sum, s) => sum + parseFloat(s.monthly_cost || 0), 0);
    const yearlyCost = monthlyCost * 12;

    res.json({
      subscriptions: subs,
      summary: {
        total_active: active.length,
        monthly_cost: Math.round(monthlyCost * 100) / 100,
        yearly_cost: Math.round(yearlyCost * 100) / 100,
      },
    });
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

app.post("/api/subscriptions", async (req, res) => {
  const { name, amount, cadence_days, notes } = req.body;
  if (!name || !amount || !cadence_days) {
    return res.status(400).json({ error: "name, amount, and cadence_days are required" });
  }
  try {
    const merchantKey = `manual_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
    const today = new Date().toISOString().slice(0, 10);
    const nextExpected = new Date(Date.now() + cadence_days * 86400000).toISOString().slice(0, 10);

    const result = await pool.query(
      `INSERT INTO detected_subscriptions
         (merchant_key, display_name, amount, cadence_days, first_seen, last_charged,
          next_expected, is_active, is_new, source, notes)
       VALUES ($1, $2, $3, $4, $5, $5, $6, true, false, 'manual', $7)
       ON CONFLICT (merchant_key, cadence_days)
       DO UPDATE SET
         display_name = EXCLUDED.display_name,
         amount = EXCLUDED.amount,
         notes = EXCLUDED.notes,
         is_active = true,
         cancelled_at = NULL,
         updated_at = now()
       RETURNING *`,
      [merchantKey, name, amount, cadence_days, today, nextExpected, notes || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

app.patch("/api/subscriptions/:id/dismiss", async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE detected_subscriptions SET is_dismissed = true, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

app.patch("/api/subscriptions/:id/undismiss", async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE detected_subscriptions SET is_dismissed = false, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

app.patch("/api/subscriptions/:id/cancel", async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE detected_subscriptions
       SET cancelled_at = now(), cancel_confirmed = true, is_active = false, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

app.patch("/api/subscriptions/:id/uncancel", async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE detected_subscriptions
       SET cancelled_at = NULL, cancel_confirmed = false, is_active = true, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/transactions — list transactions with optional filters
// ---------------------------------------------------------------------------
app.get("/api/transactions", async (req, res) => {
  const months = parseInt(req.query.months) || 6;
  const limit = Math.min(parseInt(req.query.limit) || 10000, 50000);
  const offset = parseInt(req.query.offset) || 0;

  try {
    const result = await pool.query(`
      SELECT
        t.transaction_id,
        t.date,
        COALESCE(t.merchant_name, t.name) AS merchant,
        t.amount,
        la.name AS account_name,
        la.type AS account_type,
        COALESCE(pi.institution_name, te.institution_name, 'CSV Import') AS institution_name,
        t.category[1] AS category,
        t.personal_finance_category->>'primary' AS pfc_primary,
        t.personal_finance_category->>'detailed' AS pfc_detailed,
        t.pending
      FROM transactions t
      JOIN linked_accounts la ON la.account_id = t.account_id
      LEFT JOIN plaid_items pi ON pi.id = la.plaid_item_id
      LEFT JOIN teller_enrollments te ON te.id = la.teller_enrollment_id
      WHERE t.pending = false
        AND t.date >= CURRENT_DATE - make_interval(months => $1)
      ORDER BY t.date DESC
      LIMIT $2 OFFSET $3
    `, [months, limit, offset]);

    const countResult = await pool.query(`
      SELECT COUNT(*) AS total
      FROM transactions
      WHERE pending = false
        AND date >= CURRENT_DATE - make_interval(months => $1)
    `, [months]);

    res.json({
      transactions: result.rows,
      total: parseInt(countResult.rows[0].total),
      months,
      limit,
      offset,
    });
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// ---------------------------------------------------------------------------
// POST /api/detect — trigger subscription detection
// ---------------------------------------------------------------------------
app.post("/api/detect", async (_req, res) => {
  try {
    const detected = await detectSubscriptions();
    res.json({ detected_count: detected.length, subscriptions: detected });
  } catch (err) {
    console.error("Detection error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// ---------------------------------------------------------------------------
// Google Sheets sync
// ---------------------------------------------------------------------------
app.post("/api/sheets/sync", async (_req, res) => {
  if (!sheetsSync) {
    return res.status(501).json({ error: "Google Sheets integration not available. Install googleapis: npm install googleapis" });
  }
  if (!process.env.GOOGLE_SHEETS_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    return res.status(400).json({ error: "Set GOOGLE_SHEETS_ID and GOOGLE_SERVICE_ACCOUNT_KEY in .env" });
  }
  try {
    const result = await sheetsSync.syncAll();
    res.json(result);
  } catch (err) {
    console.error("Sheets sync error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

app.post("/api/sheets/dashboard", async (_req, res) => {
  if (!sheetsSync) {
    return res.status(501).json({ error: "Google Sheets integration not available." });
  }
  try {
    const result = await sheetsSync.syncDashboardOnly();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// ---------------------------------------------------------------------------
// POST /api/cleanup — retention cleanup
// ---------------------------------------------------------------------------
app.post("/api/cleanup", async (_req, res) => {
  try {
    const txnResult = await pool.query(
      `DELETE FROM transactions WHERE date < (CURRENT_DATE - INTERVAL '18 months') RETURNING transaction_id`
    );
    const subResult = await pool.query(
      `DELETE FROM detected_subscriptions WHERE is_active = false AND updated_at < (CURRENT_DATE - INTERVAL '6 months') RETURNING merchant_key`
    );
    res.json({
      transactions_pruned: txnResult.rowCount,
      subscriptions_pruned: subResult.rowCount,
    });
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// ---------------------------------------------------------------------------
// GET /dashboard — personal finance dashboard
// ---------------------------------------------------------------------------
app.get("/dashboard", (req, res) => {
  const apiKey = API_KEY || "";
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard — Perfin</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#080b12">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #080b12; --surface: rgba(255,255,255,0.04); --surface-2: rgba(255,255,255,0.07);
      --border: rgba(255,255,255,0.08); --border-hover: rgba(255,255,255,0.18);
      --text: #f0ebe3; --text-muted: rgba(240,235,227,0.5);
      --warm: #d4a574; --warm-glow: #c8856c; --teal: #5a8f8f;
      --green: #6fcf97; --green-bg: rgba(111,207,151,0.1);
      --red: #eb6b6b; --red-bg: rgba(235,107,107,0.1);
      --yellow: #f0c36d; --yellow-bg: rgba(240,195,109,0.1);
      --blue: #7fb5e6; --blue-bg: rgba(127,181,230,0.1);
      --radius: 12px;
    }
    [data-theme="light"] {
      --bg: #f5f2ed; --surface: rgba(0,0,0,0.03); --surface-2: rgba(0,0,0,0.06);
      --border: rgba(0,0,0,0.10); --border-hover: rgba(0,0,0,0.20);
      --text: #1a1a2e; --text-muted: rgba(26,26,46,0.5);
      --warm: #b07a4a; --warm-glow: #a0684c; --teal: #3d7272;
      --green: #2d9f5f; --green-bg: rgba(45,159,95,0.1);
      --red: #c94444; --red-bg: rgba(201,68,68,0.1);
      --yellow: #c49a2a; --yellow-bg: rgba(196,154,42,0.1);
      --blue: #4a8abf; --blue-bg: rgba(74,138,191,0.1);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', system-ui, sans-serif; background: var(--bg);
      color: var(--text); min-height: 100vh; position: relative; overflow-x: hidden;
    }
    body::before {
      content: ''; position: fixed; top: -30%; right: -20%; width: 90vw; height: 90vh;
      background: radial-gradient(ellipse at 50% 30%, rgba(200,133,108,0.28) 0%, rgba(180,120,100,0.15) 25%, rgba(90,143,143,0.12) 50%, transparent 75%);
      pointer-events: none; z-index: 0; filter: blur(50px);
    }
    body::after {
      content: ''; position: fixed; bottom: -20%; left: -15%; width: 80vw; height: 70vh;
      background: radial-gradient(ellipse at 40% 60%, rgba(90,143,143,0.20) 0%, rgba(212,165,116,0.10) 35%, rgba(160,100,80,0.05) 60%, transparent 80%);
      pointer-events: none; z-index: 0; filter: blur(60px);
    }
    [data-theme="light"] body::before {
      background: radial-gradient(ellipse at 50% 30%, rgba(200,133,108,0.12) 0%, rgba(90,143,143,0.06) 50%, transparent 75%);
    }
    [data-theme="light"] body::after {
      background: radial-gradient(ellipse at 40% 60%, rgba(90,143,143,0.10) 0%, rgba(212,165,116,0.05) 35%, transparent 80%);
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .btn-loading { position: relative; color: transparent !important; pointer-events: none; }
    .btn-loading::after {
      content: ''; position: absolute; top: 50%; left: 50%; width: 14px; height: 14px;
      margin: -7px 0 0 -7px; border: 2px solid var(--warm); border-top-color: transparent;
      border-radius: 50%; animation: spin 0.6s linear infinite;
    }
    .container { max-width: 1060px; margin: 0 auto; padding: 24px 20px; position: relative; z-index: 1; }
    a { color: var(--warm); text-decoration: none; transition: color 0.2s; }
    a:hover { color: var(--text); }

    .topnav { display: flex; align-items: center; justify-content: space-between;
              padding: 20px 0; margin-bottom: 40px; }
    .topnav .logo { font-weight: 300; font-size: 13px; letter-spacing: 2px;
                    text-transform: uppercase; color: var(--text-muted); }
    .topnav .nav-links { display: flex; gap: 24px; font-size: 13px; font-weight: 400;
                         letter-spacing: 0.5px; }
    .topnav .nav-links a { color: var(--text-muted); }
    .topnav .nav-links a:hover { color: var(--text); }
    .topnav .nav-links a.active { color: var(--warm); }

    h1 { font-size: 42px; font-weight: 300; letter-spacing: -0.5px; margin-bottom: 8px; }
    .subtitle { color: var(--text-muted); margin-bottom: 36px; font-size: 15px; font-weight: 300; letter-spacing: 0.3px; }

    .top-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
                 gap: 16px; margin-bottom: 36px; }
    .card { padding: 24px; border-radius: var(--radius); background: var(--surface);
            border: 1px solid var(--border); transition: all 0.3s ease; backdrop-filter: blur(12px); }
    .card:hover { border-color: var(--border-hover); background: var(--surface-2); }
    .card .label { font-size: 10px; color: var(--text-muted); text-transform: uppercase;
                   letter-spacing: 1.5px; font-weight: 500; }
    .card .value { font-size: 28px; font-weight: 300; margin-top: 8px;
                   font-variant-numeric: tabular-nums; letter-spacing: -1px; }
    .card .value.warm { color: var(--warm-glow); }
    .card .value.teal { color: var(--teal); }
    .card .value.green { color: var(--green); }
    .card .value.red { color: var(--red); }
    .card .sub { font-size: 11px; color: var(--text-muted); margin-top: 4px; font-weight: 300; }

    .actions { display: flex; gap: 10px; margin-bottom: 28px; flex-wrap: wrap; align-items: center; }
    .actions button {
      padding: 9px 18px; font-size: 12px; font-weight: 500; letter-spacing: 0.5px;
      border: 1px solid var(--border); border-radius: 8px; cursor: pointer;
      background: transparent; color: var(--text-muted); transition: all 0.2s; text-transform: uppercase;
    }
    .actions button:hover:not(:disabled) { border-color: var(--warm); color: var(--text); }
    .actions button.primary { border-color: var(--warm); color: var(--warm); }
    .actions button.primary:hover:not(:disabled) { background: rgba(212,165,116,0.1); color: var(--text); }

    .status-msg { padding: 14px 18px; border-radius: 8px; margin-bottom: 20px; display: none;
                  font-size: 13px; font-weight: 400; }
    .status-msg.success { background: var(--green-bg); border: 1px solid rgba(111,207,151,0.15);
                          color: var(--green); display: block; }
    .status-msg.error { background: var(--red-bg); border: 1px solid rgba(235,107,107,0.15);
                        color: var(--red); display: block; }

    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 28px; }
    @media (max-width: 768px) { .two-col { grid-template-columns: 1fr; } }

    .section { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
               padding: 24px; backdrop-filter: blur(12px); }
    .section h2 { font-size: 10px; font-weight: 500; color: var(--text-muted); text-transform: uppercase;
                  letter-spacing: 1.5px; margin-bottom: 20px; }

    .accounts-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
                     gap: 12px; margin-bottom: 28px; }
    .acct-card { padding: 18px; border-radius: var(--radius); background: var(--surface);
                 border: 1px solid var(--border); transition: all 0.2s; }
    .acct-card:hover { border-color: var(--border-hover); }
    .acct-card .acct-inst { font-size: 10px; color: var(--text-muted); text-transform: uppercase;
                            letter-spacing: 1px; font-weight: 500; }
    .acct-card .acct-name { font-size: 14px; font-weight: 400; margin-top: 4px; }
    .acct-card .acct-mask { color: var(--text-muted); font-weight: 300; }
    .acct-card .acct-balance { font-size: 22px; font-weight: 300; margin-top: 10px;
                               font-variant-numeric: tabular-nums; }
    .acct-card .acct-balance.positive { color: var(--green); }
    .acct-card .acct-balance.negative { color: var(--red); }
    .acct-card .acct-balance.neutral { color: var(--warm-glow); }
    .acct-card .acct-type { font-size: 10px; color: var(--text-muted); margin-top: 4px;
                            text-transform: uppercase; letter-spacing: 0.5px; font-weight: 400; }

    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 10px 12px; font-size: 9px; color: var(--text-muted);
         text-transform: uppercase; letter-spacing: 1.5px; font-weight: 500;
         border-bottom: 1px solid var(--border); }
    td { padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 13px; font-weight: 300; }
    tr { transition: background 0.15s; }
    tr:hover { background: var(--surface); }
    .amount { font-weight: 400; font-variant-numeric: tabular-nums; letter-spacing: -0.3px; }
    .amount.warm { color: var(--warm-glow); }
    .amount.teal { color: var(--teal); }

    .bar-container { width: 100%; height: 6px; background: rgba(255,255,255,0.06);
                     border-radius: 3px; overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 3px; transition: width 0.5s ease; }

    .empty-msg { text-align: center; padding: 40px; color: var(--text-muted); font-weight: 300; font-size: 14px; }

    /* Charts */
    .charts-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 28px; }
    .chart-card { padding: 20px; border-radius: var(--radius); background: var(--surface);
                  border: 1px solid var(--border); backdrop-filter: blur(12px); }
    .chart-card h3 { font-size: 10px; font-weight: 500; color: var(--text-muted); text-transform: uppercase;
                     letter-spacing: 1.5px; margin-bottom: 16px; }
    .chart-card canvas { max-height: 240px; }
    @media (max-width: 640px) {
      .charts-grid { grid-template-columns: 1fr; }
      .topnav { flex-direction: column; gap: 12px; align-items: flex-start; }
      .topnav .nav-links { gap: 16px; flex-wrap: wrap; }
      h1 { font-size: 28px; }
      .summary { grid-template-columns: 1fr 1fr; }
      .two-col { grid-template-columns: 1fr; }
      .accounts-grid { grid-template-columns: 1fr; }
    }
  </style>
  <script>document.documentElement.setAttribute('data-theme', localStorage.getItem('perfin-theme') || 'dark');</script>
</head>
<body>
  <div class="container">
  <nav class="topnav">
    <div class="logo">Perfin</div>
    <div class="nav-links">
      <a href="/dashboard" class="active">Dashboard</a>
      <a href="/subscriptions">Subscriptions</a>
      <a href="/">Accounts</a>
      <a href="/settings">Settings</a>
    </div>
  </nav>

  <h1>Dashboard</h1>
  <p class="subtitle">Personal finance overview</p>

  <!-- Charts -->
  <div class="charts-grid">
    <div class="chart-card">
      <h3>Monthly Spending Trend</h3>
      <canvas id="trend-chart"></canvas>
    </div>
    <div class="chart-card">
      <h3>Spending by Category</h3>
      <canvas id="category-chart"></canvas>
    </div>
  </div>

  <div class="actions">
    <button class="primary" id="sync-btn" onclick="syncTransactions()">Sync Transactions</button>
    <button id="balance-btn" onclick="syncBalances()">Refresh Balances</button>
    <button id="detect-btn" onclick="runDetection()">Run Detection</button>
  </div>

  <div id="status-msg" class="status-msg"></div>

  <!-- Summary cards -->
  <div class="top-cards" id="summary-cards">
    <div class="card"><div class="label">Net Balance</div><div class="value warm" id="net-balance">--</div></div>
    <div class="card"><div class="label">Monthly Spend</div><div class="value warm" id="avg-monthly">--</div><div class="sub" id="avg-monthly-sub"></div></div>
    <div class="card"><div class="label">Subscriptions /mo</div><div class="value teal" id="subs-monthly">--</div></div>
    <div class="card"><div class="label">Active Subs</div><div class="value teal" id="active-subs">--</div></div>
    <div class="card"><div class="label">Avg Daily Spend</div><div class="value warm" id="avg-daily">--</div></div>
    <div class="card"><div class="label">Linked Accounts</div><div class="value teal" id="acct-count">--</div></div>
  </div>

  <!-- Account balances -->
  <div id="accounts-section" style="margin-bottom:28px;">
    <div style="font-size:10px;font-weight:500;color:var(--text-muted);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:14px;">Account Balances</div>
    <div class="accounts-grid" id="accounts-grid">
      <div class="empty-msg">Loading accounts...</div>
    </div>
  </div>

  <!-- Two-column: Monthly trend + Categories -->
  <div class="two-col">
    <div class="section">
      <h2>Monthly Spending</h2>
      <table>
        <thead><tr><th>Month</th><th>Total</th><th>Txns</th><th>Avg</th></tr></thead>
        <tbody id="monthly-body"><tr><td colspan="4" class="empty-msg">Loading...</td></tr></tbody>
      </table>
    </div>
    <div class="section">
      <h2>Spending by Category</h2>
      <table>
        <thead><tr><th>Category</th><th>Total</th><th style="width:30%">Share</th></tr></thead>
        <tbody id="category-body"><tr><td colspan="3" class="empty-msg">Loading...</td></tr></tbody>
      </table>
    </div>
  </div>

  <!-- Two-column: Top merchants + Upcoming subscriptions -->
  <div class="two-col">
    <div class="section">
      <h2>Top Merchants</h2>
      <table>
        <thead><tr><th>Merchant</th><th>Total</th><th>Txns</th></tr></thead>
        <tbody id="merchant-body"><tr><td colspan="3" class="empty-msg">Loading...</td></tr></tbody>
      </table>
    </div>
    <div class="section">
      <h2>Upcoming Charges</h2>
      <table>
        <thead><tr><th>Service</th><th>Amount</th><th>Next</th></tr></thead>
        <tbody id="upcoming-body"><tr><td colspan="3" class="empty-msg">Loading...</td></tr></tbody>
      </table>
    </div>
  </div>
  </div>

  <script>
    const API_KEY = '${apiKey}';
    const statusMsg = document.getElementById('status-msg');

    function apiFetch(url, opts = {}) {
      if (API_KEY) {
        opts.headers = opts.headers || {};
        opts.headers['x-api-key'] = API_KEY;
      }
      return fetch(url, opts);
    }

    function showMsg(text, ok) {
      statusMsg.textContent = text;
      statusMsg.className = 'status-msg ' + (ok ? 'success' : 'error');
      if (statusMsg._timer) clearTimeout(statusMsg._timer);
      statusMsg._timer = setTimeout(() => {
        statusMsg.style.display = 'none'; statusMsg.className = 'status-msg';
      }, ok ? 5000 : 10000);
    }

    function btnLoading(btn, loading, originalText) {
      if (loading) {
        btn._origText = btn.textContent;
        btn.disabled = true;
        btn.classList.add('btn-loading');
      } else {
        btn.disabled = false;
        btn.classList.remove('btn-loading');
        btn.textContent = originalText || btn._origText || btn.textContent;
      }
    }

    const fmt = (n) => '$' + parseFloat(n || 0).toFixed(2);
    const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '\\u2014';
    const fmtMonth = (m) => {
      const [y, mo] = m.split('-');
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return months[parseInt(mo)-1] + ' ' + y;
    };

    const barColors = ['#c8856c','#d4a574','#5a8f8f','#6fcf97','#7fb5e6','#f0c36d','#eb6b6b','#b07cc6','#e8a87c','#85dcb0','#7bb5d4','#d4a0a0','#9fd4c9','#c4b28f','#a8c3d4'];

    // Load accounts with balances
    async function loadAccounts() {
      try {
        const res = await apiFetch('/api/accounts');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const accounts = await res.json();
        const grid = document.getElementById('accounts-grid');

        document.getElementById('acct-count').textContent = accounts.length;

        if (!accounts.length) {
          grid.innerHTML = '<div class="empty-msg">No accounts linked. <a href="/">Link an account</a> to get started.</div>';
          return;
        }

        let netBalance = 0;
        const hasBalances = accounts.some(a => a.available_balance !== null || a.current_balance !== null);

        grid.innerHTML = accounts.map(a => {
          const bal = parseFloat(a.available_balance || a.current_balance || 0);
          // Credit accounts: balance represents debt
          const isCredit = a.type === 'credit';
          const displayBal = isCredit ? -bal : bal;
          netBalance += displayBal;

          const balClass = !hasBalances ? 'neutral' : displayBal > 0 ? 'positive' : displayBal < 0 ? 'negative' : 'neutral';
          const balDisplay = hasBalances ? (displayBal < 0 ? '-' + fmt(Math.abs(displayBal)) : fmt(displayBal)) : '\\u2014';

          return '<div class="acct-card">' +
            '<div class="acct-inst">' + (a.institution_name || 'Unknown') + '</div>' +
            '<div class="acct-name">' + a.name + (a.mask ? ' <span class="acct-mask">\\u2022\\u2022\\u2022\\u2022 ' + a.mask + '</span>' : '') + '</div>' +
            '<div class="acct-balance ' + balClass + '">' + balDisplay + '</div>' +
            '<div class="acct-type">' + (a.subtype || a.type || '') + '</div>' +
          '</div>';
        }).join('');

        document.getElementById('net-balance').textContent = hasBalances ? fmt(netBalance) : '\\u2014';
        if (hasBalances) {
          document.getElementById('net-balance').className = 'value ' + (netBalance >= 0 ? 'green' : 'red');
        }
      } catch (e) {
        document.getElementById('accounts-grid').innerHTML = '<div class="empty-msg">Could not load accounts: ' + e.message + '</div>';
      }
    }

    // Load spending summary
    async function loadSpendingSummary() {
      try {
        const res = await apiFetch('/api/spending-summary?months=6');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();

        // Monthly trend
        const monthBody = document.getElementById('monthly-body');
        if (data.monthly_trend.length) {
          monthBody.innerHTML = data.monthly_trend.map(m =>
            '<tr><td>' + fmtMonth(m.month) + '</td>' +
            '<td class="amount warm">' + fmt(m.total_spend) + '</td>' +
            '<td>' + m.txn_count + '</td>' +
            '<td class="amount">' + fmt(m.avg_transaction) + '</td></tr>'
          ).join('');

          // Avg monthly spend
          const totalSpend = data.monthly_trend.reduce((s, m) => s + parseFloat(m.total_spend), 0);
          const avgMonthly = totalSpend / data.monthly_trend.length;
          document.getElementById('avg-monthly').textContent = fmt(avgMonthly);
          document.getElementById('avg-monthly-sub').textContent = data.monthly_trend.length + '-month avg';

          // Avg daily
          const totalDays = data.monthly_trend.length * 30;
          document.getElementById('avg-daily').textContent = fmt(totalSpend / totalDays);
        } else {
          monthBody.innerHTML = '<tr><td colspan="4" class="empty-msg">No spending data yet.</td></tr>';
        }

        // Categories
        const catBody = document.getElementById('category-body');
        if (data.by_category.length) {
          const maxCat = parseFloat(data.by_category[0].total);
          catBody.innerHTML = data.by_category.map((c, i) => {
            const pct = Math.round((parseFloat(c.total) / maxCat) * 100);
            const color = barColors[i % barColors.length];
            return '<tr><td>' + c.category + '</td>' +
              '<td class="amount warm">' + fmt(c.total) + '</td>' +
              '<td><div class="bar-container"><div class="bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div></td></tr>';
          }).join('');
        } else {
          catBody.innerHTML = '<tr><td colspan="3" class="empty-msg">No category data yet.</td></tr>';
        }

        // Top merchants
        const merchBody = document.getElementById('merchant-body');
        if (data.top_merchants.length) {
          merchBody.innerHTML = data.top_merchants.map(m =>
            '<tr><td>' + m.merchant + '</td>' +
            '<td class="amount warm">' + fmt(m.total_spent) + '</td>' +
            '<td>' + m.txn_count + '</td></tr>'
          ).join('');
        } else {
          merchBody.innerHTML = '<tr><td colspan="3" class="empty-msg">No merchant data yet.</td></tr>';
        }

        // Upcoming subscriptions
        const upBody = document.getElementById('upcoming-body');
        if (data.upcoming_subscriptions.length) {
          upBody.innerHTML = data.upcoming_subscriptions.map(s =>
            '<tr><td>' + s.display_name + '</td>' +
            '<td class="amount teal">' + fmt(s.amount) + '</td>' +
            '<td>' + fmtDate(s.next_expected) + '</td></tr>'
          ).join('');

          // Subs monthly total
          const subsMonthly = data.upcoming_subscriptions.reduce((s, sub) => s + parseFloat(sub.monthly_cost || 0), 0);
          document.getElementById('subs-monthly').textContent = fmt(subsMonthly);
          document.getElementById('active-subs').textContent = data.upcoming_subscriptions.length;
        } else {
          upBody.innerHTML = '<tr><td colspan="3" class="empty-msg">No upcoming charges.</td></tr>';
        }
      } catch (e) {
        showMsg('Could not load spending data: ' + e.message, false);
      }
    }

    async function syncTransactions() {
      const btn = document.getElementById('sync-btn');
      btnLoading(btn, true);
      try {
        const res = await apiFetch('/api/sync', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          showMsg('Synced: ' + (data.transactions_added || 0) + ' transactions added.', true);
          loadSpendingSummary();
        } else {
          showMsg('Sync error: ' + (data.error || 'HTTP ' + res.status), false);
        }
      } catch (e) { showMsg('Sync failed: ' + e.message, false); }
      btnLoading(btn, false, 'Sync Transactions');
    }

    async function syncBalances() {
      const btn = document.getElementById('balance-btn');
      btnLoading(btn, true);
      try {
        const res = await apiFetch('/api/sync-balances', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          showMsg('Balances updated for ' + (data.accounts_updated || 0) + ' accounts.', true);
          loadAccounts();
        } else {
          showMsg('Balance sync error: ' + (data.error || 'HTTP ' + res.status), false);
        }
      } catch (e) { showMsg('Balance sync failed: ' + e.message, false); }
      btnLoading(btn, false, 'Refresh Balances');
    }

    async function runDetection() {
      const btn = document.getElementById('detect-btn');
      btnLoading(btn, true);
      try {
        const res = await apiFetch('/api/detect', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          showMsg('Detection complete: ' + (data.detected_count || 0) + ' subscriptions found.', true);
          loadSpendingSummary();
        } else {
          showMsg('Detection error: ' + (data.error || 'HTTP ' + res.status), false);
        }
      } catch (e) { showMsg('Detection failed: ' + e.message, false); }
      btnLoading(btn, false, 'Run Detection');
    }

    // Initialize
    loadAccounts();
    loadSpendingSummary();

    // PWA
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

    // Charts
    const chartScript = document.createElement('script');
    chartScript.src = 'https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js';
    chartScript.onload = loadCharts;
    document.head.appendChild(chartScript);

    async function loadCharts() {
      const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
      const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
      const textColor = isDark ? 'rgba(240,235,227,0.5)' : 'rgba(26,26,46,0.5)';
      Chart.defaults.color = textColor;
      Chart.defaults.borderColor = gridColor;
      try {
        const txRes = await apiFetch('/api/transactions?months=6');
        const txData = await txRes.json();
        const monthlyMap = {};
        (txData.transactions || []).forEach(t => {
          if (t.amount > 0) {
            const m = t.date.slice(0, 7);
            monthlyMap[m] = (monthlyMap[m] || 0) + parseFloat(t.amount);
          }
        });
        const months = Object.keys(monthlyMap).sort();
        const amounts = months.map(m => monthlyMap[m]);
        const trendCtx = document.getElementById('trend-chart');
        if (trendCtx && months.length > 0) {
          new Chart(trendCtx, {
            type: 'line',
            data: {
              labels: months.map(m => { const d = new Date(m + '-01'); return d.toLocaleString('default', { month: 'short', year: '2-digit' }); }),
              datasets: [{
                label: 'Spending',
                data: amounts,
                borderColor: '#d4a574',
                backgroundColor: 'rgba(212,165,116,0.1)',
                fill: true, tension: 0.4, pointRadius: 4,
                pointBackgroundColor: '#d4a574',
              }]
            },
            options: {
              responsive: true, maintainAspectRatio: true,
              plugins: { legend: { display: false } },
              scales: {
                y: { beginAtZero: true, ticks: { callback: v => '$' + v.toLocaleString() }, grid: { color: gridColor } },
                x: { grid: { display: false } }
              }
            }
          });
        }
        // Category doughnut
        const catMap = {};
        (txData.transactions || []).forEach(t => {
          if (t.amount > 0) {
            const cat = (t.personal_finance_category && t.personal_finance_category.primary) || t.category || 'Other';
            catMap[cat] = (catMap[cat] || 0) + parseFloat(t.amount);
          }
        });
        const cats = Object.entries(catMap).sort((a, b) => b[1] - a[1]).slice(0, 8);
        const pieColors = ['#d4a574', '#5a8f8f', '#c8856c', '#6fcf97', '#7fb5e6', '#f0c36d', '#eb6b6b', '#b08ed6'];
        const catCtx = document.getElementById('category-chart');
        if (catCtx && cats.length > 0) {
          new Chart(catCtx, {
            type: 'doughnut',
            data: {
              labels: cats.map(c => c[0]),
              datasets: [{ data: cats.map(c => c[1].toFixed(2)), backgroundColor: pieColors.slice(0, cats.length), borderWidth: 0 }]
            },
            options: {
              responsive: true, maintainAspectRatio: true, cutout: '60%',
              plugins: {
                legend: { position: 'right', labels: { boxWidth: 12, padding: 10, font: { size: 11 } } },
                tooltip: { callbacks: { label: ctx => ctx.label + ': $' + parseFloat(ctx.raw).toLocaleString() } }
              }
            }
          });
        }
      } catch (e) { console.warn('Charts load error:', e); }
    }
  </script>
</body>
</html>`);
});

// ---------------------------------------------------------------------------
// GET /subscriptions — subscription management page
// ---------------------------------------------------------------------------
app.get("/subscriptions", (req, res) => {
  const apiKey = API_KEY || "";
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Subscriptions — Perfin</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #080b12; --surface: rgba(255,255,255,0.04); --surface-2: rgba(255,255,255,0.07);
      --border: rgba(255,255,255,0.08); --border-hover: rgba(255,255,255,0.18);
      --text: #f0ebe3; --text-muted: rgba(240,235,227,0.5);
      --warm: #d4a574; --warm-glow: #c8856c; --teal: #5a8f8f;
      --green: #6fcf97; --green-bg: rgba(111,207,151,0.1);
      --red: #eb6b6b; --red-bg: rgba(235,107,107,0.1);
      --yellow: #f0c36d; --yellow-bg: rgba(240,195,109,0.1);
      --blue: #7fb5e6; --blue-bg: rgba(127,181,230,0.1);
      --radius: 12px;
    }
    [data-theme="light"] {
      --bg: #f5f2ed; --surface: rgba(0,0,0,0.03); --surface-2: rgba(0,0,0,0.06);
      --border: rgba(0,0,0,0.10); --border-hover: rgba(0,0,0,0.20);
      --text: #1a1a2e; --text-muted: rgba(26,26,46,0.5);
      --warm: #b07a4a; --warm-glow: #a0684c; --teal: #3d7272;
      --green: #2d9f5f; --green-bg: rgba(45,159,95,0.1);
      --red: #c94444; --red-bg: rgba(201,68,68,0.1);
      --yellow: #c49a2a; --yellow-bg: rgba(196,154,42,0.1);
      --blue: #4a8abf; --blue-bg: rgba(74,138,191,0.1);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', system-ui, sans-serif; background: var(--bg);
      color: var(--text); min-height: 100vh; position: relative; overflow-x: hidden;
    }
    body::before {
      content: ''; position: fixed; top: -30%; right: -20%; width: 90vw; height: 90vh;
      background: radial-gradient(ellipse at 50% 30%, rgba(200,133,108,0.28) 0%, rgba(180,120,100,0.15) 25%, rgba(90,143,143,0.12) 50%, transparent 75%);
      pointer-events: none; z-index: 0; filter: blur(50px);
    }
    body::after {
      content: ''; position: fixed; bottom: -20%; left: -15%; width: 80vw; height: 70vh;
      background: radial-gradient(ellipse at 40% 60%, rgba(90,143,143,0.20) 0%, rgba(212,165,116,0.10) 35%, rgba(160,100,80,0.05) 60%, transparent 80%);
      pointer-events: none; z-index: 0; filter: blur(60px);
    }
    .container { max-width: 960px; margin: 0 auto; padding: 24px 20px; position: relative; z-index: 1; }
    a { color: var(--warm); text-decoration: none; transition: color 0.2s; }
    a:hover { color: var(--text); }

    /* Nav */
    .topnav { display: flex; align-items: center; justify-content: space-between;
              padding: 20px 0; margin-bottom: 40px; }
    .topnav .logo { font-weight: 300; font-size: 13px; letter-spacing: 2px;
                    text-transform: uppercase; color: var(--text-muted); }
    .topnav .nav-links { display: flex; gap: 24px; font-size: 13px; font-weight: 400;
                         letter-spacing: 0.5px; }
    .topnav .nav-links a { color: var(--text-muted); }
    .topnav .nav-links a:hover { color: var(--text); }

    h1 { font-size: 42px; font-weight: 300; letter-spacing: -0.5px; margin-bottom: 8px;
         color: var(--text); }
    .subtitle { color: var(--text-muted); margin-bottom: 40px; font-size: 15px; font-weight: 300;
                letter-spacing: 0.3px; }

    /* Summary Cards */
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
               gap: 16px; margin-bottom: 36px; }
    .card { padding: 24px; border-radius: var(--radius); background: var(--surface);
            border: 1px solid var(--border); transition: all 0.3s ease;
            backdrop-filter: blur(12px); }
    .card:hover { border-color: var(--border-hover); background: var(--surface-2); }
    .card .label { font-size: 10px; color: var(--text-muted); text-transform: uppercase;
                   letter-spacing: 1.5px; font-weight: 500; }
    .card .value { font-size: 32px; font-weight: 300; margin-top: 8px;
                   font-variant-numeric: tabular-nums; letter-spacing: -1px; }
    .card .value.cost { color: var(--warm-glow); }
    .card .value.count { color: var(--teal); }

    /* Action bar */
    .actions { display: flex; gap: 10px; margin-bottom: 24px; flex-wrap: wrap; align-items: center; }
    .actions button, .actions select {
      padding: 9px 18px; font-size: 12px; font-weight: 500; letter-spacing: 0.5px;
      border: 1px solid var(--border); border-radius: 8px; cursor: pointer;
      background: transparent; color: var(--text-muted); transition: all 0.2s;
      text-transform: uppercase;
    }
    .actions button:hover:not(:disabled) { border-color: var(--warm); color: var(--text); }
    .actions button.primary { border-color: var(--warm); color: var(--warm); background: transparent; }
    .actions button.primary:hover:not(:disabled) { background: rgba(212,165,116,0.1); color: var(--text); }
    .actions button.primary:disabled { opacity: 0.4; cursor: not-allowed; }
    .actions select { appearance: none; padding-right: 30px;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23d4a574' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 10px center; background-color: transparent; }
    .actions select option { background: #131620; color: var(--text); }

    /* Table */
    table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    th { text-align: left; padding: 12px 14px; font-size: 10px; color: var(--text-muted);
         text-transform: uppercase; letter-spacing: 1.5px; font-weight: 500;
         border-bottom: 1px solid var(--border); }
    td { padding: 14px; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 14px;
         font-weight: 300; }
    tr { transition: background 0.15s; }
    tr:hover { background: var(--surface); }
    .amount { font-weight: 400; font-variant-numeric: tabular-nums; letter-spacing: -0.3px; }

    /* Badges */
    .badge { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 9px;
             font-weight: 600; letter-spacing: 0.8px; text-transform: uppercase; }
    .badge-new { background: var(--green-bg); color: var(--green); }
    .badge-price { background: var(--yellow-bg); color: var(--yellow); }
    .badge-manual { background: var(--blue-bg); color: var(--blue); }
    .badge-dismissed { background: var(--surface-2); color: var(--text-muted); }
    .badge-cancelled { background: var(--red-bg); color: var(--red); }
    .badge-category { background: var(--surface-2); color: var(--text-muted); font-weight: 400; }

    /* Action buttons */
    .btn-sm { padding: 5px 12px; font-size: 10px; font-weight: 500; letter-spacing: 0.5px;
              border: 1px solid var(--border); border-radius: 6px; cursor: pointer;
              background: transparent; color: var(--text-muted); margin-right: 4px;
              transition: all 0.2s; text-transform: uppercase; }
    .btn-sm:hover { border-color: var(--border-hover); color: var(--text); }
    .btn-sm.cancel { border-color: rgba(235,107,107,0.25); color: var(--red); }
    .btn-sm.cancel:hover { background: var(--red-bg); }
    .btn-sm.restore { border-color: rgba(111,207,151,0.25); color: var(--green); }
    .btn-sm.restore:hover { background: var(--green-bg); }

    .next-date { font-size: 13px; color: var(--text-muted); font-weight: 300; }
    .next-date.overdue { color: var(--red); font-weight: 500; }

    /* Manual form */
    .manual-form { background: var(--surface); padding: 28px; border-radius: var(--radius);
                   border: 1px solid var(--border); margin-bottom: 28px; display: none;
                   backdrop-filter: blur(12px); }
    .manual-form h3 { margin-bottom: 20px; font-size: 14px; font-weight: 400;
                      text-transform: uppercase; letter-spacing: 1px; color: var(--text-muted); }
    .manual-form .fields { display: flex; gap: 14px; flex-wrap: wrap; align-items: end; }
    .manual-form .field { display: flex; flex-direction: column; gap: 6px; }
    .manual-form label { font-size: 10px; font-weight: 500; color: var(--text-muted);
                         text-transform: uppercase; letter-spacing: 1px; }
    .manual-form input, .manual-form select {
      padding: 9px 14px; border: 1px solid var(--border); border-radius: 8px; font-size: 14px;
      background: transparent; color: var(--text); font-weight: 300; transition: border-color 0.2s; }
    .manual-form input:focus, .manual-form select:focus { outline: none; border-color: var(--warm); }
    .manual-form input::placeholder { color: var(--text-muted); }
    .manual-form input[name="name"] { width: 200px; }
    .manual-form input[name="amount"] { width: 100px; }
    .manual-form input[name="notes"] { width: 200px; }

    /* Status messages */
    .status-msg { padding: 14px 18px; border-radius: 8px; margin-bottom: 20px; display: none;
                  font-size: 13px; font-weight: 400; letter-spacing: 0.2px; }
    .status-msg.success { background: var(--green-bg); border: 1px solid rgba(111,207,151,0.15);
                          color: var(--green); display: block; }
    .status-msg.error { background: var(--red-bg); border: 1px solid rgba(235,107,107,0.15);
                        color: var(--red); display: block; }
    .empty { text-align: center; padding: 56px; color: var(--text-muted); font-weight: 300; font-size: 15px; }

    .export-link { font-size: 12px; color: var(--text-muted); }

    /* Loading spinner for buttons */
    @keyframes spin { to { transform: rotate(360deg); } }
    .btn-loading { position: relative; color: transparent !important; pointer-events: none; }
    .btn-loading::after {
      content: ''; position: absolute; top: 50%; left: 50%; width: 14px; height: 14px;
      margin: -7px 0 0 -7px; border: 2px solid var(--warm); border-top-color: transparent;
      border-radius: 50%; animation: spin 0.6s linear infinite;
    }
    @media (max-width: 640px) {
      .topnav { flex-direction: column; gap: 12px; align-items: flex-start; }
      .topnav .nav-links { gap: 14px; flex-wrap: wrap; }
      h1 { font-size: 28px; }
      .summary { grid-template-columns: 1fr 1fr; }
    }
  </style>
  <script>document.documentElement.setAttribute('data-theme', localStorage.getItem('perfin-theme') || 'dark');</script>
</head>
<body>
  <div class="container">
  <nav class="topnav">
    <div class="logo">Perfin</div>
    <div class="nav-links">
      <a href="/dashboard">Dashboard</a>
      <a href="/subscriptions" class="active">Subscriptions</a>
      <a href="/">Accounts</a>
      <a href="/settings">Settings</a>
      <a href="/api/export?type=subscriptions&api_key=${apiKey}" class="export-link">Export</a>
    </div>
  </nav>

  <h1>Subscriptions</h1>
  <p class="subtitle">Detected recurring charges and manually tracked subscriptions</p>

  <div class="summary">
    <div class="card"><div class="label">Monthly Cost</div><div class="value cost" id="monthly-cost">--</div></div>
    <div class="card"><div class="label">Yearly Cost</div><div class="value cost" id="yearly-cost">--</div></div>
    <div class="card"><div class="label">Active</div><div class="value count" id="active-count">--</div></div>
  </div>

  <div class="actions">
    <button class="primary" id="sync-btn" onclick="syncTransactions()">Sync Transactions</button>
    <button class="primary" id="detect-btn" onclick="runDetection()">Run Detection</button>
    <button id="add-btn" onclick="toggleManualForm()">+ Add Manual</button>
    <button id="sheets-btn" onclick="syncSheets()">Sync to Sheets</button>
    <select id="filter-select" onchange="loadSubscriptions()">
      <option value="active">Active</option>
      <option value="dismissed">Dismissed</option>
      <option value="cancelled">Cancelled</option>
      <option value="all">All</option>
    </select>
  </div>

  <div id="status-msg" class="status-msg"></div>

  <div class="manual-form" id="manual-form">
    <h3>Add Subscription Manually</h3>
    <div class="fields">
      <div class="field"><label>Service Name</label><input name="name" placeholder="e.g. Netflix"></div>
      <div class="field"><label>Amount ($)</label><input name="amount" type="number" step="0.01" placeholder="15.99"></div>
      <div class="field">
        <label>Billing Cycle</label>
        <select name="cadence">
          <option value="30">Monthly</option>
          <option value="90">Quarterly</option>
          <option value="365">Yearly</option>
          <option value="60">Every 2 months</option>
        </select>
      </div>
      <div class="field"><label>Notes (optional)</label><input name="notes" placeholder="Family plan, etc."></div>
      <div class="field"><label>&nbsp;</label><button class="primary" onclick="addManual()">Add</button></div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Subscription</th>
        <th>Amount</th>
        <th>/month</th>
        <th>Cycle</th>
        <th>Next Charge</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody id="subs-body">
      <tr><td colspan="6" class="empty">Loading...</td></tr>
    </tbody>
  </table>
  </div>

  <script>
    const _apiKey = "${apiKey}";
    function apiFetch(url, opts = {}) {
      if (_apiKey) {
        opts.headers = { ...opts.headers, 'x-api-key': _apiKey };
      }
      return fetch(url, opts);
    }
    const tbody = document.getElementById('subs-body');
    const statusMsg = document.getElementById('status-msg');

    function showMsg(text, ok) {
      statusMsg.textContent = text;
      statusMsg.className = 'status-msg ' + (ok ? 'success' : 'error');
      if (statusMsg._timer) clearTimeout(statusMsg._timer);
      statusMsg._timer = setTimeout(() => {
        statusMsg.style.display = 'none'; statusMsg.className = 'status-msg';
      }, ok ? 5000 : 10000);
    }

    function btnLoading(btn, loading, originalText) {
      if (loading) {
        btn._origText = btn.textContent;
        btn.disabled = true;
        btn.classList.add('btn-loading');
      } else {
        btn.disabled = false;
        btn.classList.remove('btn-loading');
        btn.textContent = originalText || btn._origText || btn.textContent;
      }
    }

    function cadenceLabel(days) {
      if (days === 30) return 'Monthly';
      if (days === 60) return 'Bimonthly';
      if (days === 90) return 'Quarterly';
      if (days === 365) return 'Yearly';
      return days + 'd';
    }

    function isOverdue(dateStr) { return new Date(dateStr) < new Date(); }

    async function loadSubscriptions() {
      const filter = document.getElementById('filter-select').value;
      try {
        const res = await apiFetch('/api/subscriptions?filter=' + filter);
        if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || 'Server returned ' + res.status); }
        const data = await res.json();
        document.getElementById('monthly-cost').textContent = '$' + data.summary.monthly_cost.toFixed(2);
        document.getElementById('yearly-cost').textContent = '$' + data.summary.yearly_cost.toFixed(2);
        document.getElementById('active-count').textContent = data.summary.total_active;
        if (!data.subscriptions.length) {
          tbody.innerHTML = '<tr><td colspan="6" class="empty">No subscriptions found. Import transactions or add manually.</td></tr>';
          return;
        }
        tbody.innerHTML = data.subscriptions.map(s => {
          const badges = [];
          if (s.is_new) badges.push('<span class="badge badge-new">NEW</span>');
          if (s.amount_changed) badges.push('<span class="badge badge-price">PRICE CHANGE</span>');
          if (s.source === 'manual') badges.push('<span class="badge badge-manual">MANUAL</span>');
          if (s.category && s.category !== 'other') badges.push('<span class="badge badge-category">' + s.category + '</span>');
          if (s.is_dismissed) badges.push('<span class="badge badge-dismissed">DISMISSED</span>');
          if (s.cancelled_at) badges.push('<span class="badge badge-cancelled">CANCELLED</span>');
          const overdue = !s.cancelled_at && isOverdue(s.next_expected);
          const nextClass = overdue ? 'next-date overdue' : 'next-date';
          const nextLabel = s.cancelled_at ? 'Cancelled ' + new Date(s.cancelled_at).toLocaleDateString() : new Date(s.next_expected).toLocaleDateString();
          let actions = '';
          if (s.cancelled_at) {
            actions = '<button class="btn-sm restore" onclick="uncancelSub(' + s.id + ')">Restore</button>';
          } else if (s.is_dismissed) {
            actions = '<button class="btn-sm restore" onclick="undismissSub(' + s.id + ')">Restore</button>';
          } else {
            actions += '<button class="btn-sm" onclick="dismissSub(' + s.id + ')">Dismiss</button>';
            if (s.cancel_url) {
              actions += '<a class="btn-sm cancel" href="' + s.cancel_url + '" target="_blank" rel="noopener">Cancel&rarr;</a>';
              actions += '<button class="btn-sm cancel" onclick="markCancelled(' + s.id + ')" title="Mark as cancelled">Done</button>';
            } else {
              actions += '<button class="btn-sm cancel" onclick="markCancelled(' + s.id + ')">Cancel</button>';
            }
          }
          const notesHtml = s.notes ? '<div style="font-size:12px;color:var(--text-muted);">' + s.notes + '</div>' : '';
          return '<tr>' +
            '<td><strong>' + s.display_name + '</strong> ' + badges.join(' ') + notesHtml + '</td>' +
            '<td class="amount">$' + parseFloat(s.amount).toFixed(2) + '</td>' +
            '<td class="amount">$' + parseFloat(s.monthly_cost).toFixed(2) + '</td>' +
            '<td>' + cadenceLabel(s.cadence_days) + '</td>' +
            '<td><span class="' + nextClass + '">' + nextLabel + '</span></td>' +
            '<td>' + actions + '</td></tr>';
        }).join('');
      } catch (e) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty">Error loading subscriptions: ' + e.message + '</td></tr>';
        showMsg('Failed to load subscriptions: ' + e.message, false);
      }
    }

    async function syncTransactions() {
      const btn = document.getElementById('sync-btn');
      btnLoading(btn, true);
      try {
        const res = await apiFetch('/api/sync', { method: 'POST' });
        const data = await res.json();
        if (res.ok) showMsg('Synced ' + data.transactions_added + ' transactions from ' + data.enrollments_synced + ' institution(s).', true);
        else showMsg('Sync failed: ' + (data.error || 'Unknown error (HTTP ' + res.status + ')'), false);
      } catch (e) { showMsg('Sync failed: Could not reach server. ' + e.message, false); }
      btnLoading(btn, false, 'Sync Transactions');
    }

    async function runDetection() {
      const btn = document.getElementById('detect-btn');
      btnLoading(btn, true);
      try {
        const res = await apiFetch('/api/detect', { method: 'POST' });
        const data = await res.json();
        if (res.ok) { showMsg('Detection complete: ' + data.detected_count + ' subscriptions found.', true); loadSubscriptions(); }
        else showMsg('Detection failed: ' + (data.error || 'Unknown error (HTTP ' + res.status + ')'), false);
      } catch (e) { showMsg('Detection failed: Could not reach server. ' + e.message, false); }
      btnLoading(btn, false, 'Run Detection');
    }

    function toggleManualForm() {
      const form = document.getElementById('manual-form');
      form.style.display = form.style.display === 'none' ? 'block' : 'none';
    }

    async function addManual() {
      const name = document.querySelector('.manual-form input[name="name"]').value.trim();
      const amount = parseFloat(document.querySelector('.manual-form input[name="amount"]').value);
      const cadence_days = parseInt(document.querySelector('.manual-form select[name="cadence"]').value);
      const notes = document.querySelector('.manual-form input[name="notes"]').value.trim();
      if (!name || !amount) { showMsg('Name and amount are required.', false); return; }
      try {
        const res = await apiFetch('/api/subscriptions', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, amount, cadence_days, notes: notes || undefined }),
        });
        if (res.ok) {
          showMsg('Added ' + name + ' ($' + amount.toFixed(2) + '/' + cadenceLabel(cadence_days).toLowerCase() + ')', true);
          document.querySelector('.manual-form input[name="name"]').value = '';
          document.querySelector('.manual-form input[name="amount"]').value = '';
          document.querySelector('.manual-form input[name="notes"]').value = '';
          loadSubscriptions();
        } else { const data = await res.json(); showMsg('Failed to add: ' + (data.error || 'HTTP ' + res.status), false); }
      } catch (e) { showMsg('Failed to add subscription: ' + e.message, false); }
    }

    async function dismissSub(id) {
      try { await apiFetch('/api/subscriptions/' + id + '/dismiss', { method: 'PATCH' }); loadSubscriptions(); }
      catch (e) { showMsg('Failed to dismiss: ' + e.message, false); }
    }
    async function undismissSub(id) {
      try { await apiFetch('/api/subscriptions/' + id + '/undismiss', { method: 'PATCH' }); loadSubscriptions(); }
      catch (e) { showMsg('Failed to restore: ' + e.message, false); }
    }
    async function markCancelled(id) {
      if (!confirm('Mark this subscription as cancelled?')) return;
      try {
        await apiFetch('/api/subscriptions/' + id + '/cancel', { method: 'PATCH' });
        showMsg('Subscription marked as cancelled.', true); loadSubscriptions();
      } catch (e) { showMsg('Failed to cancel: ' + e.message, false); }
    }
    async function uncancelSub(id) {
      try { await apiFetch('/api/subscriptions/' + id + '/uncancel', { method: 'PATCH' }); loadSubscriptions(); }
      catch (e) { showMsg('Failed to restore: ' + e.message, false); }
    }

    async function syncSheets() {
      const btn = document.getElementById('sheets-btn');
      btnLoading(btn, true);
      try {
        const res = await apiFetch('/api/sheets/sync', { method: 'POST' });
        const data = await res.json();
        if (res.ok) showMsg('Synced to Sheets: ' + data.transactions_synced + ' txns, ' + data.subscriptions_synced + ' subs.', true);
        else showMsg('Sheets sync failed: ' + (data.error || 'HTTP ' + res.status), false);
      } catch (e) { showMsg('Sheets sync failed: ' + e.message, false); }
      btnLoading(btn, false, 'Sync to Sheets');
    }

    loadSubscriptions();
  </script>
</body>
</html>`);
});

// ---------------------------------------------------------------------------
// GET / — Teller Connect enrollment + CSV import page
// ---------------------------------------------------------------------------
app.get("/", (req, res) => {
  const tellerEnv = TELLER_ENV === "production" ? "production" : TELLER_ENV === "development" ? "development" : "sandbox";
  const apiKey = API_KEY || "";

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Perfin — Link Account</title>
  <script src="https://cdn.teller.io/connect/connect.js"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #080b12; --surface: rgba(255,255,255,0.04); --surface-2: rgba(255,255,255,0.07);
      --border: rgba(255,255,255,0.08); --border-hover: rgba(255,255,255,0.18);
      --text: #f0ebe3; --text-muted: rgba(240,235,227,0.5);
      --warm: #d4a574; --warm-glow: #c8856c; --teal: #5a8f8f;
      --green: #6fcf97; --green-bg: rgba(111,207,151,0.1);
      --red: #eb6b6b; --red-bg: rgba(235,107,107,0.1);
      --radius: 12px;
    }
    [data-theme="light"] {
      --bg: #f5f2ed; --surface: rgba(0,0,0,0.03); --surface-2: rgba(0,0,0,0.06);
      --border: rgba(0,0,0,0.10); --border-hover: rgba(0,0,0,0.20);
      --text: #1a1a2e; --text-muted: rgba(26,26,46,0.5);
      --warm: #b07a4a; --warm-glow: #a0684c; --teal: #3d7272;
      --green: #2d9f5f; --green-bg: rgba(45,159,95,0.1);
      --red: #c94444; --red-bg: rgba(201,68,68,0.1);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', system-ui, sans-serif; background: var(--bg);
      color: var(--text); min-height: 100vh; position: relative; overflow-x: hidden;
    }
    body::before {
      content: ''; position: fixed; top: -30%; right: -20%; width: 90vw; height: 90vh;
      background: radial-gradient(ellipse at 50% 30%, rgba(200,133,108,0.28) 0%, rgba(180,120,100,0.15) 25%, rgba(90,143,143,0.12) 50%, transparent 75%);
      pointer-events: none; z-index: 0; filter: blur(50px);
    }
    body::after {
      content: ''; position: fixed; bottom: -20%; left: -15%; width: 80vw; height: 70vh;
      background: radial-gradient(ellipse at 40% 60%, rgba(90,143,143,0.20) 0%, rgba(212,165,116,0.10) 35%, rgba(160,100,80,0.05) 60%, transparent 80%);
      pointer-events: none; z-index: 0; filter: blur(60px);
    }
    .container { max-width: 640px; margin: 0 auto; padding: 24px 20px; position: relative; z-index: 1; }
    a { color: var(--warm); text-decoration: none; transition: color 0.2s; }
    a:hover { color: var(--text); }

    .topnav { display: flex; align-items: center; justify-content: space-between;
              padding: 20px 0; margin-bottom: 48px; }
    .topnav .logo { font-weight: 300; font-size: 13px; letter-spacing: 2px;
                    text-transform: uppercase; color: var(--text-muted); }
    .topnav .nav-links { display: flex; gap: 24px; font-size: 13px; font-weight: 400;
                         letter-spacing: 0.5px; }
    .topnav .nav-links a { color: var(--text-muted); }
    .topnav .nav-links a:hover { color: var(--text); }

    h1 { font-size: 42px; font-weight: 300; letter-spacing: -0.5px; margin-bottom: 8px; }
    h2 { font-size: 28px; font-weight: 300; letter-spacing: -0.3px; margin-bottom: 8px; }
    h3 { font-size: 10px; font-weight: 500; margin-bottom: 12px; color: var(--text-muted);
         text-transform: uppercase; letter-spacing: 1.5px; }
    p { color: var(--text-muted); font-size: 15px; line-height: 1.6; margin-bottom: 24px; font-weight: 300; }

    button { padding: 12px 28px; font-size: 12px; font-weight: 500; cursor: pointer;
             border: 1px solid var(--warm); background: transparent; color: var(--warm);
             border-radius: 8px; transition: all 0.2s; text-transform: uppercase; letter-spacing: 1px; }
    button:hover { background: rgba(212,165,116,0.1); color: var(--text); }
    button:disabled { opacity: 0.4; cursor: not-allowed; }

    #status { margin-top: 20px; padding: 14px 18px; border-radius: 8px; display: none; font-size: 13px; font-weight: 400; }
    .success { background: var(--green-bg); border: 1px solid rgba(111,207,151,0.15); color: var(--green); }
    .error   { background: var(--red-bg); border: 1px solid rgba(235,107,107,0.15); color: var(--red); }

    #items { margin-top: 36px; }
    .item { padding: 16px 18px; margin: 8px 0; background: var(--surface); border: 1px solid var(--border);
            border-radius: var(--radius); font-size: 14px; font-weight: 300; transition: all 0.2s;
            backdrop-filter: blur(12px); }
    .item:hover { border-color: var(--border-hover); background: var(--surface-2); }

    .section-divider { margin: 48px 0; border: none; border-top: 1px solid var(--border); }

    .csv-section { margin-top: 8px; }
    .csv-form { display: flex; flex-direction: column; gap: 18px; max-width: 420px; }
    .csv-form label { font-weight: 500; font-size: 10px; color: var(--text-muted);
                      text-transform: uppercase; letter-spacing: 1.5px; }
    .csv-form select, .csv-form input[type="text"] {
      padding: 10px 14px; font-size: 14px; border: 1px solid var(--border); border-radius: 8px;
      background: transparent; color: var(--text); width: 100%; font-weight: 300;
      transition: border-color 0.2s; }
    .csv-form select:focus, .csv-form input:focus { outline: none; border-color: var(--warm); }
    .csv-form select option { background: #131620; color: var(--text); }
    .csv-form input[type="file"] { font-size: 13px; color: var(--text-muted); }
    .csv-form .field { display: flex; flex-direction: column; gap: 8px; }
    .csv-form input::placeholder { color: var(--text-muted); }

    .csv-imports { margin-top: 32px; }
    .csv-import-entry { padding: 14px 18px; margin: 6px 0; background: var(--surface);
                        border: 1px solid var(--border); border-radius: var(--radius);
                        font-size: 13px; font-weight: 300; backdrop-filter: blur(12px); }

    /* Loading spinner */
    @keyframes spin { to { transform: rotate(360deg); } }
    .btn-loading { position: relative; color: transparent !important; pointer-events: none; }
    .btn-loading::after {
      content: ''; position: absolute; top: 50%; left: 50%; width: 14px; height: 14px;
      margin: -7px 0 0 -7px; border: 2px solid var(--warm); border-top-color: transparent;
      border-radius: 50%; animation: spin 0.6s linear infinite;
    }

    /* Item with actions */
    .item { display: flex; align-items: center; justify-content: space-between; }
    .item-info { flex: 1; }
    .item-actions { flex-shrink: 0; margin-left: 12px; }
    .btn-unlink { padding: 5px 12px; font-size: 10px; font-weight: 500; letter-spacing: 0.5px;
                  border: 1px solid rgba(235,107,107,0.25); border-radius: 6px; cursor: pointer;
                  background: transparent; color: var(--red); text-transform: uppercase;
                  transition: all 0.2s; }
    .btn-unlink:hover { background: var(--red-bg); }
    @media (max-width: 640px) {
      .topnav { flex-direction: column; gap: 12px; align-items: flex-start; }
      .topnav .nav-links { gap: 14px; flex-wrap: wrap; }
      h1 { font-size: 28px; }
    }
  </style>
  <script>document.documentElement.setAttribute('data-theme', localStorage.getItem('perfin-theme') || 'dark');</script>
</head>
<body>
  <div class="container">
  <nav class="topnav">
    <div class="logo">Perfin</div>
    <div class="nav-links">
      <a href="/dashboard">Dashboard</a>
      <a href="/subscriptions">Subscriptions</a>
      <a href="/" class="active">Accounts</a>
      <a href="/settings">Settings</a>
    </div>
  </nav>

  <h1>Link Accounts</h1>
  <p>Connect a financial institution to start tracking recurring charges automatically.</p>
  <button id="link-btn" onclick="startLink()">Link an Account</button>
  <div id="status"></div>
  <div id="items"><h3>Linked Institutions</h3><div id="items-list" style="color:var(--text-muted);font-size:14px;font-weight:300;">Loading...</div></div>

  <hr class="section-divider">

  <div class="csv-section">
    <h2>Import from CSV</h2>
    <p>Upload a CSV export from your bank. Supports Chase, Wells Fargo, Capital One, Discover, Schwab, and generic formats.</p>
    <div class="csv-form">
      <div class="field">
        <label for="csv-institution">Bank / Institution</label>
        <select id="csv-institution">
          <option value="Chase">Chase</option>
          <option value="Wells Fargo">Wells Fargo</option>
          <option value="Capital One">Capital One</option>
          <option value="Discover">Discover</option>
          <option value="Charles Schwab">Charles Schwab</option>
          <option value="Other">Other</option>
        </select>
      </div>
      <input type="text" id="csv-custom-institution" placeholder="Institution name" style="display:none">

      <div class="field">
        <label for="csv-account-label">Account Label</label>
        <input type="text" id="csv-account-label" placeholder="e.g. Chase Checking, WF Visa">
      </div>

      <div class="field">
        <label for="csv-file">CSV File</label>
        <input type="file" id="csv-file" accept=".csv">
      </div>

      <button id="csv-upload-btn" onclick="uploadCsv()">Upload & Import</button>
    </div>
    <div id="csv-status" style="margin-top:12px;padding:14px 18px;border-radius:8px;display:none;font-size:13px;"></div>
    <div class="csv-imports">
      <h3>Import History</h3>
      <div id="csv-imports-list" style="color:var(--text-muted);font-size:14px;font-weight:300;">Loading...</div>
    </div>
  </div>
  </div>

  <script>
    const _apiKey = "${apiKey}";
    function apiFetch(url, opts = {}) {
      if (_apiKey) {
        opts.headers = { ...opts.headers, 'x-api-key': _apiKey };
      }
      return fetch(url, opts);
    }
    const statusEl  = document.getElementById('status');
    const itemsList = document.getElementById('items-list');

    function showStatus(msg, ok) {
      statusEl.textContent = msg;
      statusEl.className = ok ? 'success' : 'error';
      statusEl.style.display = 'block';
      if (statusEl._timer) clearTimeout(statusEl._timer);
      if (ok) { statusEl._timer = setTimeout(() => { statusEl.style.display = 'none'; }, 8000); }
    }

    function btnLoading(btn, loading, originalText) {
      if (loading) {
        btn._origText = btn.textContent;
        btn.disabled = true;
        btn.classList.add('btn-loading');
      } else {
        btn.disabled = false;
        btn.classList.remove('btn-loading');
        btn.textContent = originalText || btn._origText || btn.textContent;
      }
    }

    async function loadItems() {
      try {
        const res = await apiFetch('/api/items');
        if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || 'HTTP ' + res.status); }
        const items = await res.json();
        if (!items.length) { itemsList.textContent = 'No institutions linked yet.'; return; }
        itemsList.innerHTML = items.map(i =>
          '<div class="item">' +
            '<div class="item-info"><strong>' + i.institution_name + '</strong>' +
            ' (' + (i.provider || 'teller') + ') — ' +
            i.accounts.length + ' account(s) — Status: ' + i.status + '</div>' +
            '<div class="item-actions"><button class="btn-unlink" onclick="unlinkAccount(' + i.id + ', \\'' + (i.institution_name || '').replace(/'/g, "\\\\'") + '\\')">Unlink</button></div>' +
          '</div>'
        ).join('');
      } catch (e) {
        itemsList.textContent = 'Could not load items: ' + e.message;
        showStatus('Failed to load linked accounts: ' + e.message, false);
      }
    }

    async function unlinkAccount(id, name) {
      if (!confirm('Unlink ' + name + '? This will remove the enrollment but keep existing transaction data.')) return;
      try {
        const res = await apiFetch('/api/enrollments/' + id, { method: 'DELETE' });
        if (res.ok) {
          showStatus('Unlinked ' + name + ' successfully.', true);
          loadItems();
        } else {
          const data = await res.json().catch(() => ({}));
          showStatus('Failed to unlink: ' + (data.error || 'HTTP ' + res.status), false);
        }
      } catch (e) { showStatus('Failed to unlink: ' + e.message, false); }
    }

    function startLink() {
      var tellerConnect = TellerConnect.setup({
        applicationId: "${TELLER_APP_ID}",
        environment: "${tellerEnv}",
        onInit: function() { console.log("Teller Connect initialized"); },
        onSuccess: async function(enrollment) {
          showStatus('Enrolling...', true);
          try {
            const res = await apiFetch('/api/enroll', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                accessToken: enrollment.accessToken,
                enrollment: {
                  id: enrollment.enrollment.id,
                  institution: enrollment.enrollment.institution,
                },
              }),
            });
            const data = await res.json();
            if (res.ok) {
              showStatus('Linked ' + data.institution + ' (' + data.accounts_linked + ' accounts)', true);
              loadItems();
            } else {
              showStatus('Enrollment failed: ' + (data.error || 'HTTP ' + res.status), false);
            }
          } catch (e) { showStatus('Enrollment failed: Could not reach server. ' + e.message, false); }
        },
        onExit: function() { console.log("Teller Connect exited"); },
        onFailure: function(failure) {
          showStatus('Teller Connect error: ' + (failure.message || JSON.stringify(failure)), false);
        },
      });
      tellerConnect.open();
    }

    // CSV import
    const csvInstitution = document.getElementById('csv-institution');
    const csvCustom = document.getElementById('csv-custom-institution');
    const csvStatusEl = document.getElementById('csv-status');

    csvInstitution.addEventListener('change', () => {
      csvCustom.style.display = csvInstitution.value === 'Other' ? 'block' : 'none';
    });

    function showCsvStatus(msg, ok) {
      csvStatusEl.textContent = msg;
      csvStatusEl.className = ok ? 'success' : 'error';
      csvStatusEl.style.display = 'block';
      if (csvStatusEl._timer) clearTimeout(csvStatusEl._timer);
      if (ok) { csvStatusEl._timer = setTimeout(() => { csvStatusEl.style.display = 'none'; }, 8000); }
    }

    async function uploadCsv() {
      const fileInput = document.getElementById('csv-file');
      const file = fileInput.files[0];
      if (!file) { showCsvStatus('Please select a CSV file.', false); return; }
      const institution = csvInstitution.value === 'Other'
        ? csvCustom.value.trim() || 'Unknown'
        : csvInstitution.value;
      const accountLabel = document.getElementById('csv-account-label').value.trim()
        || institution + ' Account';
      const formData = new FormData();
      formData.append('file', file);
      formData.append('institution', institution);
      formData.append('account_label', accountLabel);
      const btn = document.getElementById('csv-upload-btn');
      btnLoading(btn, true);
      showCsvStatus('Importing...', true);
      try {
        const resp = await apiFetch('/api/import-csv', { method: 'POST', body: formData });
        const data = await resp.json();
        if (resp.ok) {
          showCsvStatus('Imported ' + data.rows_imported + ' transactions (' + data.rows_skipped +
            ' skipped) — Format: ' + data.format_detected, true);
          loadCsvImports(); loadItems();
        } else showCsvStatus('Import failed: ' + (data.error || 'HTTP ' + resp.status), false);
      } catch (e) { showCsvStatus('Import failed: Could not reach server. ' + e.message, false); }
      btnLoading(btn, false, 'Upload & Import');
    }

    async function loadCsvImports() {
      const list = document.getElementById('csv-imports-list');
      try {
        const res = await apiFetch('/api/csv-imports');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const imports = await res.json();
        if (!imports.length) { list.textContent = 'No CSV imports yet.'; return; }
        list.innerHTML = imports.map(i =>
          '<div class="csv-import-entry"><strong>' + i.institution + '</strong> — ' +
          i.account_label + ' — ' + i.rows_imported + ' rows — ' +
          new Date(i.imported_at).toLocaleDateString() + ' — <em>' + i.filename + '</em></div>'
        ).join('');
      } catch (e) { list.textContent = 'Could not load import history.'; }
    }

    loadItems();
    loadCsvImports();
  </script>
</body>
</html>`);
});

// ---------------------------------------------------------------------------
// GET /login — login page
// ---------------------------------------------------------------------------
app.get("/login", (_req, res) => {
  if (!SESSION_PASSWORD) return res.redirect("/dashboard");
  res.send(`<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login — Perfin</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#080b12">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root { --bg: #080b12; --surface: rgba(255,255,255,0.04); --border: rgba(255,255,255,0.08);
      --text: #f0ebe3; --text-muted: rgba(240,235,227,0.5); --warm: #d4a574; --warm-glow: #c8856c;
      --red: #eb6b6b; --red-bg: rgba(235,107,107,0.1); }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', system-ui, sans-serif; background: var(--bg); color: var(--text);
           min-height: 100vh; display: flex; align-items: center; justify-content: center;
           position: relative; overflow: hidden; }
    body::before { content: ''; position: fixed; top: -30%; right: -20%; width: 90vw; height: 90vh;
      background: radial-gradient(ellipse at 50% 30%, rgba(200,133,108,0.28) 0%, rgba(180,120,100,0.15) 25%, rgba(90,143,143,0.12) 50%, transparent 75%);
      pointer-events: none; z-index: 0; filter: blur(50px); }
    body::after { content: ''; position: fixed; bottom: -20%; left: -15%; width: 80vw; height: 70vh;
      background: radial-gradient(ellipse at 40% 60%, rgba(90,143,143,0.20) 0%, rgba(212,165,116,0.10) 35%, transparent 80%);
      pointer-events: none; z-index: 0; filter: blur(60px); }
    .login-card { position: relative; z-index: 1; width: 100%; max-width: 360px; padding: 44px 32px;
      background: var(--surface); border: 1px solid var(--border); border-radius: 16px;
      backdrop-filter: blur(16px); text-align: center; }
    .logo { font-weight: 300; font-size: 13px; letter-spacing: 2px; text-transform: uppercase;
            color: var(--text-muted); margin-bottom: 28px; }
    h1 { font-size: 26px; font-weight: 300; letter-spacing: -0.3px; margin-bottom: 6px; }
    p { color: var(--text-muted); font-size: 14px; font-weight: 300; margin-bottom: 24px; }
    input[type="password"] { width: 100%; padding: 12px 16px; font-size: 14px; font-weight: 300;
      border: 1px solid var(--border); border-radius: 8px; background: transparent;
      color: var(--text); font-family: inherit; }
    input:focus { outline: none; border-color: var(--warm); }
    button { width: 100%; margin-top: 14px; padding: 12px; font-size: 13px; font-weight: 500;
      border: 1px solid var(--warm); border-radius: 8px; cursor: pointer;
      background: transparent; color: var(--warm); text-transform: uppercase;
      letter-spacing: 1px; font-family: inherit; transition: all 0.2s; }
    button:hover { background: rgba(212,165,116,0.1); color: var(--text); }
    .error-msg { margin-top: 14px; padding: 10px; border-radius: 6px;
      background: var(--red-bg); color: var(--red); font-size: 13px; display: none; }
  </style>
</head><body>
  <div class="login-card">
    <div class="logo">Perfin</div>
    <h1>Welcome back</h1>
    <p>Enter your password to continue</p>
    <form id="login-form">
      <input type="password" id="password" placeholder="Password" autofocus required>
      <button type="submit">Sign In</button>
    </form>
    <div id="error" class="error-msg"></div>
  </div>
  <script>
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('error');
      try {
        const res = await fetch('/api/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: document.getElementById('password').value }),
        });
        const data = await res.json();
        if (res.ok) window.location.href = '/dashboard';
        else { errEl.textContent = data.error || 'Invalid password'; errEl.style.display = 'block'; }
      } catch { errEl.textContent = 'Connection error'; errEl.style.display = 'block'; }
    });
  </script>
</body></html>`);
});

// POST /api/login
app.post("/api/login", (req, res) => {
  if (!SESSION_PASSWORD) return res.json({ ok: true });
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "Password required" });
  const providedBuf = Buffer.from(password);
  const expectedBuf = Buffer.from(SESSION_PASSWORD);
  if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return res.status(401).json({ error: "Invalid password" });
  }
  req.session.authenticated = true;
  req.session.lastActivity = Date.now();
  req.session.timeoutMinutes = 15;
  res.json({ ok: true });
});

// POST /api/logout
app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// GET /api/settings
app.get("/api/settings", async (_req, res) => {
  try {
    const result = await pool.query("SELECT session_timeout_minutes, theme, dashboard_months, insights_enabled, insights_last_run, insights_running_summary FROM user_settings WHERE id = 1");
    res.json(result.rows[0] || { session_timeout_minutes: 15, theme: "dark", dashboard_months: 6, insights_enabled: false, insights_last_run: null, insights_running_summary: null });
  } catch {
    res.json({ session_timeout_minutes: 15, theme: "dark", dashboard_months: 6, insights_enabled: false, insights_last_run: null });
  }
});

// PATCH /api/settings
app.patch("/api/settings", async (req, res) => {
  const { session_timeout_minutes, theme, dashboard_months, insights_enabled } = req.body;
  try {
    const updates = []; const values = []; let idx = 1;
    if (session_timeout_minutes !== undefined) {
      updates.push("session_timeout_minutes = $" + idx++);
      values.push(Math.max(1, Math.min(parseInt(session_timeout_minutes) || 15, 1440)));
      if (req.session) req.session.timeoutMinutes = values[values.length - 1];
    }
    if (theme !== undefined && ["dark", "light"].includes(theme)) {
      updates.push("theme = $" + idx++); values.push(theme);
    }
    if (dashboard_months !== undefined) {
      updates.push("dashboard_months = $" + idx++);
      values.push(Math.max(1, Math.min(parseInt(dashboard_months) || 6, 24)));
    }
    if (insights_enabled !== undefined) {
      updates.push("insights_enabled = $" + idx++); values.push(!!insights_enabled);
    }
    if (!updates.length) return res.status(400).json({ error: "No valid settings" });
    updates.push("updated_at = now()");
    await pool.query("INSERT INTO user_settings (id) VALUES (1) ON CONFLICT DO NOTHING");
    const result = await pool.query("UPDATE user_settings SET " + updates.join(", ") + " WHERE id = 1 RETURNING *", values);
    res.json(result.rows[0]);
  } catch (err) {
    console.error("settings error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/insights/status — check if AI insights are configured
app.get("/api/insights/status", async (_req, res) => {
  const configured = !!(Anthropic && process.env.ANTHROPIC_API_KEY);
  let tokensThisMonth = 0;
  let budgetCents = parseInt(process.env.INSIGHTS_MONTHLY_BUDGET_CENTS) || 50;
  try {
    const usage = await pool.query(
      "SELECT COALESCE(SUM(tokens_used), 0)::int AS total FROM financial_insights WHERE created_at >= date_trunc('month', CURRENT_DATE)"
    );
    tokensThisMonth = usage.rows[0].total;
  } catch {}
  const estimatedCostCents = (tokensThisMonth / 1_000_000) * 800;
  res.json({
    configured,
    reason: configured ? null : (!Anthropic ? "SDK not installed" : "ANTHROPIC_API_KEY not set in .env"),
    tokens_this_month: tokensThisMonth,
    estimated_cost_cents: Math.round(estimatedCostCents * 100) / 100,
    budget_cents: budgetCents,
    budget_remaining_cents: Math.round((budgetCents - estimatedCostCents) * 100) / 100,
  });
});

// GET /api/insights/usage — historical usage breakdown
app.get("/api/insights/usage", async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, tokens_used, model_used, created_at, " +
      "ROUND((tokens_used::numeric / 1000000) * 8, 4) AS estimated_cost_usd " +
      "FROM financial_insights ORDER BY created_at DESC LIMIT 20"
    );
    const totals = await pool.query(
      "SELECT COUNT(*) AS total_runs, COALESCE(SUM(tokens_used), 0)::int AS total_tokens, " +
      "ROUND((COALESCE(SUM(tokens_used), 0)::numeric / 1000000) * 8, 4) AS total_cost_usd " +
      "FROM financial_insights"
    );
    res.json({ history: result.rows, totals: totals.rows[0] });
  } catch { res.json({ history: [], totals: { total_runs: 0, total_tokens: 0, total_cost_usd: 0 } }); }
});

// GET /api/insights
app.get("/api/insights", async (_req, res) => {
  try {
    const result = await pool.query("SELECT * FROM financial_insights ORDER BY created_at DESC LIMIT 5");
    res.json(result.rows);
  } catch { res.json([]); }
});

// POST /api/insights — generate via Claude
app.post("/api/insights", async (_req, res) => {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    return res.status(501).json({ error: "Set ANTHROPIC_API_KEY in .env to enable AI insights." });
  }
  try {
    // Monthly budget cap — check tokens used this calendar month
    // Default cap: $0.50/month (50 cents). At ~$0.02/run, allows ~25 runs before hitting cap.
    const budgetCents = parseInt(process.env.INSIGHTS_MONTHLY_BUDGET_CENTS) || 50;
    const usageResult = await pool.query(
      "SELECT COALESCE(SUM(tokens_used), 0)::int AS total_tokens FROM financial_insights " +
      "WHERE created_at >= date_trunc('month', CURRENT_DATE)"
    ).catch(() => ({ rows: [{ total_tokens: 0 }] }));
    const tokensThisMonth = usageResult.rows[0].total_tokens;
    // Rough cost estimate: ~$3/M input + $15/M output tokens. Average ~$8/M blended.
    const estimatedCostCents = (tokensThisMonth / 1_000_000) * 800;
    if (estimatedCostCents >= budgetCents) {
      return res.status(429).json({
        error: `Monthly AI budget reached ($${(estimatedCostCents / 100).toFixed(2)} of $${(budgetCents / 100).toFixed(2)} cap). Resets next month. Adjust INSIGHTS_MONTHLY_BUDGET_CENTS in .env to raise the limit.`,
        tokens_this_month: tokensThisMonth,
        budget_cents: budgetCents,
      });
    }

    const [monthlyData, subData, prevInsight, settingsRow] = await Promise.all([
      pool.query(
        "SELECT TO_CHAR(date, 'YYYY-MM') AS month, SUM(amount) AS total, COUNT(*) AS txns " +
        "FROM transactions WHERE amount > 0 AND date >= CURRENT_DATE - INTERVAL '6 months' " +
        "GROUP BY TO_CHAR(date, 'YYYY-MM') ORDER BY month"
      ),
      pool.query(
        "SELECT display_name, amount, cadence_days FROM detected_subscriptions " +
        "WHERE is_active = true AND is_dismissed = false AND cancelled_at IS NULL ORDER BY amount DESC"
      ),
      pool.query(
        "SELECT insight_text, created_at FROM financial_insights ORDER BY created_at DESC LIMIT 1"
      ).catch(() => ({ rows: [] })),
      pool.query(
        "SELECT insights_running_summary FROM user_settings WHERE id = 1"
      ).catch(() => ({ rows: [{ insights_running_summary: null }] })),
    ]);
    const runningSummary = settingsRow.rows[0]?.insights_running_summary || null;
    const subTotal = subData.rows.reduce((s, r) => s + parseFloat(r.amount) * 30 / r.cadence_days, 0);
    let prompt = "You are a personal finance advisor providing ongoing monthly analysis. You have two tasks:\n\n" +
      "TASK 1: Analyze the data below and give 3-5 concise, actionable insights with specific dollar amounts. Use markdown bullet points. Reference long-term context where relevant.\n\n" +
      "TASK 2: After your insights, output a delimiter line containing exactly '---RUNNING_SUMMARY---' followed by an updated cumulative summary (max 200 words). This summary should capture:\n" +
      "- Baseline spending levels and trends (e.g. 'avg monthly spend ~$X, trending up/down')\n" +
      "- Key subscriptions and any changes noticed over time\n" +
      "- Progress on past recommendations (what improved, what didn't)\n" +
      "- Any recurring patterns or concerns worth tracking long-term\n" +
      "This summary persists across sessions as your long-term memory. Update it — don't just append.\n\n" +
      "=== CURRENT DATA ===\n" +
      "Monthly Spending (6mo):\n" + monthlyData.rows.map(r => r.month + ": $" + parseFloat(r.total).toFixed(2) + " (" + r.txns + " txns)").join("\n") +
      "\n\nActive Subscriptions (" + subData.rows.length + " total, $" + subTotal.toFixed(2) + "/mo):\n" +
      subData.rows.map(r => r.display_name + ": $" + parseFloat(r.amount).toFixed(2) + " every " + r.cadence_days + " days").join("\n");
    // Include running summary for long-term context
    if (runningSummary) {
      prompt += "\n\n=== LONG-TERM CONTEXT (your cumulative memory from past analyses) ===\n" + runningSummary;
    }
    // Include most recent analysis for immediate continuity
    if (prevInsight.rows.length > 0) {
      const prev = prevInsight.rows[0];
      const date = new Date(prev.created_at).toLocaleDateString("en-US", { month: "short", year: "numeric" });
      prompt += "\n\n=== MOST RECENT ANALYSIS [" + date + "] ===\n" + prev.insight_text.substring(0, 600) + (prev.insight_text.length > 600 ? "..." : "");
    }
    const client = new Anthropic();
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514", max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });
    const fullResponse = message.content[0].text;
    const tokensUsed = (message.usage?.input_tokens || 0) + (message.usage?.output_tokens || 0);
    // Parse out the running summary from the response
    const delimIdx = fullResponse.indexOf("---RUNNING_SUMMARY---");
    let insightText, newSummary;
    if (delimIdx !== -1) {
      insightText = fullResponse.substring(0, delimIdx).trim();
      newSummary = fullResponse.substring(delimIdx + "---RUNNING_SUMMARY---".length).trim();
    } else {
      insightText = fullResponse.trim();
      newSummary = runningSummary; // keep existing if AI didn't output delimiter
    }
    await pool.query(
      "INSERT INTO financial_insights (insight_text, period_start, period_end, model_used, tokens_used) VALUES ($1, CURRENT_DATE - INTERVAL '6 months', CURRENT_DATE, $2, $3)",
      [insightText, "claude-sonnet-4-20250514", tokensUsed]
    );
    // Persist the updated running summary
    if (newSummary) {
      await pool.query(
        "UPDATE user_settings SET insights_running_summary = $1, insights_last_run = now() WHERE id = 1",
        [newSummary]
      ).catch(() => {});
    } else {
      await pool.query("UPDATE user_settings SET insights_last_run = now() WHERE id = 1").catch(() => {});
    }
    res.json({ insight: insightText, tokens_used: tokensUsed });
  } catch (err) {
    console.error("Insights error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/insights/reset — clear running summary (fresh start)
app.post("/api/insights/reset", async (_req, res) => {
  try {
    await pool.query("UPDATE user_settings SET insights_running_summary = NULL WHERE id = 1");
    res.json({ ok: true, message: "Long-term AI context cleared. Next analysis starts fresh." });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/insights/rebuild — rebuild running summary from all historical insights
app.post("/api/insights/rebuild", async (_req, res) => {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    return res.status(501).json({ error: "Set ANTHROPIC_API_KEY in .env to enable AI insights." });
  }
  try {
    const allInsights = await pool.query(
      "SELECT insight_text, created_at FROM financial_insights ORDER BY created_at ASC"
    );
    if (allInsights.rows.length === 0) {
      return res.json({ ok: true, message: "No historical insights to rebuild from.", summary: null });
    }
    // Build a condensed timeline of all past analyses
    let timeline = "";
    allInsights.rows.forEach((ins) => {
      const date = new Date(ins.created_at).toLocaleDateString("en-US", { month: "short", year: "numeric" });
      timeline += "[" + date + "]: " + ins.insight_text.substring(0, 400) + (ins.insight_text.length > 400 ? "..." : "") + "\n\n";
    });
    const client = new Anthropic();
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514", max_tokens: 500,
      messages: [{ role: "user", content:
        "You are a personal finance advisor. Below is a chronological timeline of all past monthly financial analyses for one user. " +
        "Synthesize these into a single cumulative summary (max 200 words) that captures:\n" +
        "- Baseline spending levels and long-term trends\n" +
        "- Key subscriptions and how they've changed over time\n" +
        "- Progress on past recommendations (what improved, what didn't)\n" +
        "- Recurring patterns or concerns worth continuing to track\n\n" +
        "This summary will serve as persistent memory for future analyses.\n\n" +
        "=== ALL PAST ANALYSES ===\n" + timeline
      }],
    });
    const newSummary = message.content[0].text.trim();
    const tokensUsed = (message.usage?.input_tokens || 0) + (message.usage?.output_tokens || 0);
    await pool.query(
      "UPDATE user_settings SET insights_running_summary = $1 WHERE id = 1", [newSummary]
    );
    res.json({ ok: true, message: "Long-term context rebuilt from " + allInsights.rows.length + " historical analyses.", summary: newSummary, tokens_used: tokensUsed });
  } catch (err) {
    console.error("Rebuild error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /settings — settings page
// ---------------------------------------------------------------------------
app.get("/settings", (req, res) => {
  const apiKey = API_KEY || "";
  res.send(`<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Settings — Perfin</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#080b12">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #080b12; --surface: rgba(255,255,255,0.04); --surface-2: rgba(255,255,255,0.07);
      --border: rgba(255,255,255,0.08); --border-hover: rgba(255,255,255,0.18);
      --text: #f0ebe3; --text-muted: rgba(240,235,227,0.5);
      --warm: #d4a574; --warm-glow: #c8856c; --teal: #5a8f8f;
      --green: #6fcf97; --green-bg: rgba(111,207,151,0.1);
      --red: #eb6b6b; --red-bg: rgba(235,107,107,0.1);
      --radius: 12px;
    }
    [data-theme="light"] {
      --bg: #f5f2ed; --surface: rgba(0,0,0,0.03); --surface-2: rgba(0,0,0,0.06);
      --border: rgba(0,0,0,0.10); --border-hover: rgba(0,0,0,0.20);
      --text: #1a1a2e; --text-muted: rgba(26,26,46,0.5);
      --warm: #b07a4a; --warm-glow: #a0684c; --teal: #3d7272;
      --green: #2d9f5f; --green-bg: rgba(45,159,95,0.1);
      --red: #c94444; --red-bg: rgba(201,68,68,0.1);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', system-ui, sans-serif; background: var(--bg); color: var(--text);
           min-height: 100vh; position: relative; overflow-x: hidden; }
    body::before { content: ''; position: fixed; top: -30%; right: -20%; width: 90vw; height: 90vh;
      background: radial-gradient(ellipse at 50% 30%, rgba(200,133,108,0.28) 0%, rgba(180,120,100,0.15) 25%, rgba(90,143,143,0.12) 50%, transparent 75%);
      pointer-events: none; z-index: 0; filter: blur(50px); }
    body::after { content: ''; position: fixed; bottom: -20%; left: -15%; width: 80vw; height: 70vh;
      background: radial-gradient(ellipse at 40% 60%, rgba(90,143,143,0.20) 0%, rgba(212,165,116,0.10) 35%, transparent 80%);
      pointer-events: none; z-index: 0; filter: blur(60px); }
    [data-theme="light"] body::before {
      background: radial-gradient(ellipse at 50% 30%, rgba(200,133,108,0.12) 0%, rgba(90,143,143,0.06) 50%, transparent 75%); }
    [data-theme="light"] body::after {
      background: radial-gradient(ellipse at 40% 60%, rgba(90,143,143,0.10) 0%, rgba(212,165,116,0.05) 35%, transparent 80%); }
    .container { max-width: 640px; margin: 0 auto; padding: 24px 20px; position: relative; z-index: 1; }
    a { color: var(--warm); text-decoration: none; }
    a:hover { color: var(--text); }
    .topnav { display: flex; align-items: center; justify-content: space-between;
              padding: 20px 0; margin-bottom: 40px; }
    .topnav .logo { font-weight: 300; font-size: 13px; letter-spacing: 2px; text-transform: uppercase; color: var(--text-muted); }
    .topnav .nav-links { display: flex; gap: 24px; font-size: 13px; font-weight: 400; letter-spacing: 0.5px; }
    .topnav .nav-links a { color: var(--text-muted); }
    .topnav .nav-links a:hover { color: var(--text); }
    .topnav .nav-links a.active { color: var(--warm); }
    h1 { font-size: 36px; font-weight: 300; letter-spacing: -0.5px; margin-bottom: 6px; }
    .subtitle { color: var(--text-muted); margin-bottom: 32px; font-size: 15px; font-weight: 300; }
    .section { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
               padding: 24px; margin-bottom: 16px; backdrop-filter: blur(12px); }
    .section h2 { font-size: 10px; font-weight: 500; color: var(--text-muted); text-transform: uppercase;
                  letter-spacing: 1.5px; margin-bottom: 20px; }
    .setting-row { display: flex; align-items: center; justify-content: space-between;
                   padding: 14px 0; border-bottom: 1px solid rgba(128,128,128,0.08); }
    .setting-row:last-child { border-bottom: none; }
    .setting-info .name { font-size: 14px; font-weight: 400; margin-bottom: 3px; }
    .setting-info .desc { font-size: 12px; color: var(--text-muted); font-weight: 300; }
    .setting-control { flex-shrink: 0; margin-left: 20px; }
    .toggle { position: relative; width: 44px; height: 24px; cursor: pointer; display: inline-block; }
    .toggle input { opacity: 0; width: 0; height: 0; }
    .toggle .slider { position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(128,128,128,0.3); border-radius: 12px; transition: 0.3s; }
    .toggle .slider::before { content: ''; position: absolute; width: 18px; height: 18px;
      left: 3px; bottom: 3px; background: var(--text); border-radius: 50%; transition: 0.3s; }
    .toggle input:checked + .slider { background: var(--warm); }
    .toggle input:checked + .slider::before { transform: translateX(20px); }
    select, input[type="number"] { padding: 8px 12px; font-size: 13px; border: 1px solid var(--border);
      border-radius: 8px; background: transparent; color: var(--text); font-family: inherit; font-weight: 300; }
    select:focus, input[type="number"]:focus { outline: none; border-color: var(--warm); }
    select option { background: var(--bg); }
    input[type="number"] { width: 80px; text-align: center; }
    .btn { padding: 8px 16px; font-size: 12px; font-weight: 500; letter-spacing: 0.5px;
      border: 1px solid var(--border); border-radius: 8px; cursor: pointer; background: transparent;
      color: var(--text-muted); transition: all 0.2s; text-transform: uppercase; font-family: inherit; }
    .btn:hover:not(:disabled) { border-color: var(--warm); color: var(--text); }
    .btn.primary { border-color: var(--warm); color: var(--warm); }
    .btn.primary:hover:not(:disabled) { background: rgba(212,165,116,0.1); color: var(--text); }
    .btn.danger { border-color: rgba(235,107,107,0.25); color: var(--red); }
    .btn.danger:hover { background: var(--red-bg); }
    .status-msg { padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; display: none; font-size: 13px; }
    .status-msg.success { background: var(--green-bg); border: 1px solid rgba(111,207,151,0.15);
      color: var(--green); display: block; }
    .status-msg.error { background: var(--red-bg); border: 1px solid rgba(235,107,107,0.15);
      color: var(--red); display: block; }
    .insight-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
      padding: 20px; margin-top: 12px; backdrop-filter: blur(12px); }
    .insight-card h3 { font-size: 14px; font-weight: 400; margin-bottom: 10px; }
    .insight-text { font-size: 13px; line-height: 1.7; color: var(--text-muted); font-weight: 300; }
    .insight-text strong { color: var(--text); font-weight: 500; }
    .insight-text li { margin-left: 16px; margin-bottom: 6px; }
    .insight-meta { font-size: 11px; color: var(--text-muted); margin-top: 10px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .btn-loading { position: relative; color: transparent !important; pointer-events: none; }
    .btn-loading::after { content: ''; position: absolute; top: 50%; left: 50%; width: 14px; height: 14px;
      margin: -7px 0 0 -7px; border: 2px solid var(--warm); border-top-color: transparent;
      border-radius: 50%; animation: spin 0.6s linear infinite; }
    @media (max-width: 640px) {
      .topnav { flex-direction: column; gap: 12px; align-items: flex-start; }
      .topnav .nav-links { gap: 14px; flex-wrap: wrap; }
      h1 { font-size: 28px; }
      .setting-row { flex-direction: column; align-items: flex-start; gap: 10px; }
      .setting-control { margin-left: 0; }
    }
  </style>
  <script>document.documentElement.setAttribute('data-theme', localStorage.getItem('perfin-theme') || 'dark');</script>
</head><body>
  <div class="container">
  <nav class="topnav">
    <div class="logo">Perfin</div>
    <div class="nav-links">
      <a href="/dashboard">Dashboard</a>
      <a href="/subscriptions">Subscriptions</a>
      <a href="/">Accounts</a>
      <a href="/settings" class="active">Settings</a>
    </div>
  </nav>
  <h1>Settings</h1>
  <p class="subtitle">Preferences and configuration</p>
  <div id="status-msg" class="status-msg"></div>

  <div class="section"><h2>Appearance</h2>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Theme</div><div class="desc">Switch between dark (night) and light (day) mode</div></div>
      <div class="setting-control">
        <select id="theme-select" onchange="updateSetting('theme', this.value)">
          <option value="dark">Night Mode</option><option value="light">Day Mode</option>
        </select>
      </div>
    </div>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Dashboard Range</div><div class="desc">Months of spending shown in charts</div></div>
      <div class="setting-control">
        <select id="months-select" onchange="updateSetting('dashboard_months', parseInt(this.value))">
          <option value="3">3 months</option><option value="6">6 months</option>
          <option value="12">12 months</option><option value="24">24 months</option>
        </select>
      </div>
    </div>
  </div>

  <div class="section"><h2>Security</h2>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Session Timeout</div><div class="desc">Minutes before requiring password again (1–1440)</div></div>
      <div class="setting-control">
        <input type="number" id="timeout-input" min="1" max="1440" value="15"
               onchange="updateSetting('session_timeout_minutes', parseInt(this.value))">
      </div>
    </div>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Sign Out</div><div class="desc">End your current session</div></div>
      <div class="setting-control"><button class="btn danger" onclick="logout()">Sign Out</button></div>
    </div>
  </div>

  <div class="section"><h2>AI Insights</h2>
    <div class="setting-row">
      <div class="setting-info"><div class="name">API Status</div><div class="desc" id="api-status-desc">Checking...</div></div>
      <div class="setting-control"><span id="api-status-badge" style="font-size:11px;font-weight:600;padding:3px 10px;border-radius:6px;letter-spacing:0.5px;text-transform:uppercase;">--</span></div>
    </div>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Monthly AI Analysis</div><div class="desc">Financial insights powered by Claude (~$0.02/month)</div></div>
      <div class="setting-control">
        <label class="toggle"><input type="checkbox" id="insights-toggle" onchange="updateSetting('insights_enabled', this.checked)"><span class="slider"></span></label>
      </div>
    </div>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Generate Now</div><div class="desc">Run AI analysis on current data</div></div>
      <div class="setting-control"><button class="btn primary" id="insights-btn" onclick="generateInsights()">Generate</button></div>
    </div>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Monthly Budget Cap</div><div class="desc" id="budget-desc">Limits API spending per month (set via INSIGHTS_MONTHLY_BUDGET_CENTS env var)</div></div>
      <div class="setting-control"><span id="budget-status" style="font-size:12px;color:var(--text-muted);">--</span></div>
    </div>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Long-Term Memory</div><div class="desc" id="memory-desc">AI maintains a cumulative summary across analyses for context continuity</div></div>
      <div class="setting-control"><span id="memory-status" style="font-size:12px;color:var(--text-muted);">--</span></div>
    </div>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Reset AI Context</div><div class="desc">Clear long-term memory — next analysis starts fresh with no prior context</div></div>
      <div class="setting-control"><button class="btn danger" id="reset-btn" onclick="resetContext()">Reset</button></div>
    </div>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Rebuild AI Context</div><div class="desc">Regenerate long-term memory by re-reading all historical analyses</div></div>
      <div class="setting-control"><button class="btn primary" id="rebuild-btn" onclick="rebuildContext()">Rebuild</button></div>
    </div>
  </div>

  <div id="insights-container"></div>

  <div class="section"><h2>API Usage History</h2>
    <div id="usage-summary" style="padding:10px 0;font-size:13px;color:var(--text-muted);font-weight:300;">Loading...</div>
    <div id="usage-history" style="max-height:260px;overflow-y:auto;"></div>
  </div>

  <div class="section"><h2>Data</h2>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Export Transactions</div><div class="desc">Download as CSV</div></div>
      <div class="setting-control"><a href="/api/export?type=transactions&api_key=${apiKey}"><button class="btn">Export</button></a></div>
    </div>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Export Subscriptions</div><div class="desc">Download as CSV</div></div>
      <div class="setting-control"><a href="/api/export?type=subscriptions&api_key=${apiKey}"><button class="btn">Export</button></a></div>
    </div>
  </div>
  </div>
  <script>
    const API_KEY = '${apiKey}';
    const statusEl = document.getElementById('status-msg');
    function apiFetch(url, opts = {}) {
      if (API_KEY) { opts.headers = opts.headers || {}; opts.headers['x-api-key'] = API_KEY; }
      return fetch(url, opts);
    }
    function showMsg(text, ok) {
      statusEl.textContent = text;
      statusEl.className = 'status-msg ' + (ok ? 'success' : 'error');
      clearTimeout(statusEl._t);
      statusEl._t = setTimeout(() => { statusEl.style.display = 'none'; statusEl.className = 'status-msg'; }, ok ? 3000 : 6000);
    }
    function applyTheme(t) { document.documentElement.setAttribute('data-theme', t); localStorage.setItem('perfin-theme', t); }
    async function loadSettings() {
      try {
        const res = await apiFetch('/api/settings'); if (!res.ok) return;
        const s = await res.json();
        document.getElementById('theme-select').value = s.theme || 'dark';
        document.getElementById('months-select').value = s.dashboard_months || 6;
        document.getElementById('timeout-input').value = s.session_timeout_minutes || 15;
        document.getElementById('insights-toggle').checked = s.insights_enabled || false;
        applyTheme(s.theme || 'dark');
        // Show memory status
        const memEl = document.getElementById('memory-status');
        if (memEl) {
          if (s.insights_running_summary) {
            memEl.innerHTML = '<span style="color:var(--green);">Active</span> (' + s.insights_running_summary.split(/\s+/).length + ' words)';
          } else {
            memEl.textContent = 'Not yet initialized — runs after first analysis';
          }
        }
      } catch {}
      // Check AI API status
      try {
        const sRes = await apiFetch('/api/insights/status');
        const st = await sRes.json();
        const badge = document.getElementById('api-status-badge');
        const desc = document.getElementById('api-status-desc');
        const budgetEl = document.getElementById('budget-status');
        if (st.configured) {
          badge.textContent = 'Active';
          badge.style.background = 'var(--green-bg)'; badge.style.color = 'var(--green)';
          desc.textContent = 'ANTHROPIC_API_KEY is configured and ready';
          if (budgetEl) budgetEl.textContent = '$' + (st.estimated_cost_cents / 100).toFixed(3) + ' of $' + (st.budget_cents / 100).toFixed(2) + ' cap used this month';
        } else {
          badge.textContent = 'Not Set';
          badge.style.background = 'var(--yellow-bg)'; badge.style.color = 'var(--yellow)';
          desc.textContent = st.reason + ' — insights will not run until configured';
          if (budgetEl) budgetEl.textContent = 'N/A';
        }
      } catch {}
    }
    async function updateSetting(key, value) {
      try {
        const body = {}; body[key] = value;
        const res = await apiFetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (res.ok) { showMsg('Setting saved.', true); if (key === 'theme') applyTheme(value); }
        else { const d = await res.json().catch(() => ({})); showMsg(d.error || 'Failed', false); }
      } catch (e) { showMsg(e.message, false); }
    }
    async function logout() { await fetch('/api/logout', { method: 'POST' }); window.location.href = '/login'; }
    async function generateInsights() {
      const btn = document.getElementById('insights-btn');
      btn.classList.add('btn-loading'); btn.disabled = true;
      try {
        const res = await apiFetch('/api/insights', { method: 'POST' });
        const data = await res.json();
        if (res.ok) { showMsg('Insights generated (' + (data.tokens_used || 0) + ' tokens).', true); renderInsight(data.insight); }
        else showMsg(data.error || 'Failed', false);
      } catch (e) { showMsg(e.message, false); }
      btn.classList.remove('btn-loading'); btn.disabled = false;
    }
    function renderInsight(text) {
      let html = text.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
        .replace(/^[\\-\\*] (.+)$/gm, '<li>$1</li>').replace(/\\n/g, '<br>');
      document.getElementById('insights-container').innerHTML =
        '<div class="insight-card"><h3>AI Financial Insights</h3><div class="insight-text">' + html +
        '</div><div class="insight-meta">Generated just now</div></div>';
    }
    async function loadInsights() {
      try {
        const res = await apiFetch('/api/insights'); const data = await res.json();
        if (data.length > 0) {
          renderInsight(data[0].insight_text);
          const meta = document.querySelector('.insight-meta');
          if (meta) meta.textContent = 'Generated ' + new Date(data[0].created_at).toLocaleDateString();
          // Show budget status from this month's usage
          const thisMonth = data.filter(d => {
            const created = new Date(d.created_at);
            const now = new Date();
            return created.getMonth() === now.getMonth() && created.getFullYear() === now.getFullYear();
          });
          const totalTokens = thisMonth.reduce((sum, d) => sum + (d.tokens_used || 0), 0);
          const estCost = (totalTokens / 1000000) * 8; // ~$8/M blended
          document.getElementById('budget-status').textContent =
            '$' + estCost.toFixed(3) + ' used this month (~' + totalTokens.toLocaleString() + ' tokens)';
        }
      } catch {}
    }
    async function loadUsageHistory() {
      try {
        const res = await apiFetch('/api/insights/usage');
        const data = await res.json();
        const sumEl = document.getElementById('usage-summary');
        const t = data.totals;
        sumEl.innerHTML = '<span style="color:var(--text)">' + t.total_runs + ' total runs</span> &middot; ' +
          Number(t.total_tokens).toLocaleString() + ' tokens &middot; <span style="color:var(--warm)">$' +
          parseFloat(t.total_cost_usd).toFixed(4) + ' estimated total</span>';
        const histEl = document.getElementById('usage-history');
        if (data.history.length === 0) { histEl.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:8px 0;">No AI insights generated yet.</div>'; return; }
        let html = '<table style="width:100%;font-size:12px;border-collapse:collapse;">' +
          '<tr style="color:var(--text-muted);text-transform:uppercase;font-size:10px;letter-spacing:1px;">' +
          '<th style="text-align:left;padding:6px 0;border-bottom:1px solid var(--border);">Date</th>' +
          '<th style="text-align:right;padding:6px 0;border-bottom:1px solid var(--border);">Tokens</th>' +
          '<th style="text-align:right;padding:6px 0;border-bottom:1px solid var(--border);">Est. Cost</th>' +
          '<th style="text-align:right;padding:6px 0;border-bottom:1px solid var(--border);">Model</th></tr>';
        data.history.forEach(function(row) {
          html += '<tr style="font-weight:300;">' +
            '<td style="padding:6px 0;border-bottom:1px solid rgba(128,128,128,0.06);">' + new Date(row.created_at).toLocaleDateString() + '</td>' +
            '<td style="text-align:right;padding:6px 0;border-bottom:1px solid rgba(128,128,128,0.06);">' + (row.tokens_used || 0).toLocaleString() + '</td>' +
            '<td style="text-align:right;padding:6px 0;border-bottom:1px solid rgba(128,128,128,0.06);color:var(--warm);">$' + parseFloat(row.estimated_cost_usd || 0).toFixed(4) + '</td>' +
            '<td style="text-align:right;padding:6px 0;border-bottom:1px solid rgba(128,128,128,0.06);color:var(--text-muted);font-size:11px;">' + (row.model_used || '').replace('claude-', '').split('-202')[0] + '</td></tr>';
        });
        html += '</table>';
        histEl.innerHTML = html;
      } catch {}
    }
    async function resetContext() {
      if (!confirm('Clear all long-term AI memory? Next analysis will start fresh with no prior context.')) return;
      const btn = document.getElementById('reset-btn');
      btn.classList.add('btn-loading'); btn.disabled = true;
      try {
        const res = await apiFetch('/api/insights/reset', { method: 'POST' });
        const data = await res.json();
        if (res.ok) { showMsg(data.message, true); document.getElementById('memory-status').textContent = 'Cleared — will reinitialize on next analysis'; }
        else showMsg(data.error || 'Failed', false);
      } catch (e) { showMsg(e.message, false); }
      btn.classList.remove('btn-loading'); btn.disabled = false;
    }
    async function rebuildContext() {
      if (!confirm('Rebuild long-term memory from all historical analyses? This uses a small API call to synthesize past insights.')) return;
      const btn = document.getElementById('rebuild-btn');
      btn.classList.add('btn-loading'); btn.disabled = true;
      try {
        const res = await apiFetch('/api/insights/rebuild', { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
          showMsg(data.message + (data.tokens_used ? ' (' + data.tokens_used + ' tokens)' : ''), true);
          const memEl = document.getElementById('memory-status');
          if (data.summary) memEl.innerHTML = '<span style="color:var(--green);">Active</span> (' + data.summary.split(/\\s+/).length + ' words)';
          else memEl.textContent = 'No historical data to rebuild from';
        } else showMsg(data.error || 'Failed', false);
      } catch (e) { showMsg(e.message, false); }
      btn.classList.remove('btn-loading'); btn.disabled = false;
    }
    loadSettings(); loadInsights(); loadUsageHistory();
  </script>
</body></html>`);
});

// ---------------------------------------------------------------------------
// PWA manifest and service worker
// ---------------------------------------------------------------------------
app.get("/manifest.json", (_req, res) => {
  res.json({
    name: "Perfin — Subscription Tracker",
    short_name: "Perfin",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#080b12",
    theme_color: "#080b12",
    icons: [
      { src: "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect fill='%23080b12' width='100' height='100' rx='20'/><text y='70' x='50' text-anchor='middle' font-size='55' fill='%23d4a574'>$</text></svg>"),
        sizes: "any", type: "image/svg+xml" }
    ],
  });
});

app.get("/sw.js", (_req, res) => {
  res.type("application/javascript").send(
    "const CACHE='perfin-v1';" +
    "self.addEventListener('install',()=>self.skipWaiting());" +
    "self.addEventListener('activate',e=>e.waitUntil(clients.claim()));" +
    "self.addEventListener('fetch',e=>{" +
    "if(e.request.method!=='GET')return;" +
    "e.respondWith(fetch(e.request).then(r=>{" +
    "if(r.ok&&e.request.url.includes('cdn.jsdelivr.net')){" +
    "const c=r.clone();caches.open(CACHE).then(ca=>ca.put(e.request,c));}" +
    "return r;}).catch(()=>caches.match(e.request)));" +
    "});"
  );
});

// ---------------------------------------------------------------------------
// GET /api/export — download transactions or subscriptions as CSV
// ---------------------------------------------------------------------------
app.get("/api/export", async (req, res) => {
  const type = req.query.type || "transactions";
  const months = Math.max(1, Math.min(parseInt(req.query.months) || 12, 120));

  try {
    let csvContent = "";

    if (type === "subscriptions") {
      const result = await pool.query(`
        SELECT ds.display_name, ds.amount, ds.cadence_days, ds.first_seen, ds.last_charged,
               ds.next_expected, ds.is_active, ds.is_dismissed, ds.cancelled_at, ds.source, ds.notes
        FROM detected_subscriptions ds
        ORDER BY ds.amount DESC
      `);
      csvContent = "Service,Amount,Cycle Days,Monthly Cost,First Seen,Last Charged,Next Charge,Status,Category,Source,Notes\n";
      for (const r of result.rows) {
        const monthlyCost = r.cadence_days > 0 ? (r.amount * 30 / r.cadence_days).toFixed(2) : r.amount;
        const status = r.cancelled_at ? "Cancelled" : r.is_dismissed ? "Dismissed" : r.is_active ? "Active" : "Inactive";
        const category = categorizeSubscription(r.display_name);
        const escapeCsv = (s) => `"${(s || "").toString().replace(/"/g, '""')}"`;
        csvContent += [escapeCsv(r.display_name), r.amount, r.cadence_days, monthlyCost,
          r.first_seen, r.last_charged, r.next_expected, status, category, r.source, escapeCsv(r.notes)].join(",") + "\n";
      }
      res.setHeader("Content-Disposition", "attachment; filename=subscriptions.csv");
    } else {
      const result = await pool.query(`
        SELECT t.date, COALESCE(t.merchant_name, t.name) AS merchant, t.amount,
               la.name AS account_name,
               COALESCE(pi.institution_name, te.institution_name, 'CSV Import') AS institution,
               t.personal_finance_category->>'primary' AS category
        FROM transactions t
        JOIN linked_accounts la ON la.account_id = t.account_id
        LEFT JOIN plaid_items pi ON pi.id = la.plaid_item_id
        LEFT JOIN teller_enrollments te ON te.id = la.teller_enrollment_id
        WHERE t.pending = false AND t.date >= CURRENT_DATE - make_interval(months => $1)
        ORDER BY t.date DESC
      `, [months]);
      csvContent = "Date,Merchant,Amount,Account,Institution,Category\n";
      for (const r of result.rows) {
        const escapeCsv = (s) => `"${(s || "").toString().replace(/"/g, '""')}"`;
        csvContent += [r.date, escapeCsv(r.merchant), r.amount, escapeCsv(r.account_name),
          escapeCsv(r.institution), escapeCsv(r.category)].join(",") + "\n";
      }
      res.setHeader("Content-Disposition", `attachment; filename=transactions-${months}mo.csv`);
    }

    res.setHeader("Content-Type", "text/csv");
    res.send(csvContent);
  } catch (err) {
    console.error("Export error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Teller server running on http://0.0.0.0:${PORT}`);
  console.log(`  Environment: ${TELLER_ENV}`);
  console.log(`  Application ID: ${TELLER_APP_ID || "(not set)"}`);
});
