// ============================================================================
// Teller Server — Personal Subscription Tracker
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
//   GET  /dashboard            — subscription dashboard
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
const { parse } = require("csv-parse/sync");
const { detectSubscriptions } = require("../scripts/detect-subscriptions");

let sheetsSync;
try {
  sheetsSync = require("../scripts/sheets-sync");
} catch {
  sheetsSync = null;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Security middleware
// ---------------------------------------------------------------------------
// Helmet — sets security headers (CSP, X-Frame-Options, HSTS, etc.)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.teller.io"],
      connectSrc: ["'self'", "https://api.teller.io"],
      frameSrc: ["https://cdn.teller.io"],
      styleSrc: ["'self'", "'unsafe-inline'"],
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
// Set API_KEY env var to enable. Browser pages (/, /dashboard) remain open.
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
// GET /dashboard — subscription dashboard page
// ---------------------------------------------------------------------------
app.get("/dashboard", (req, res) => {
  const apiKey = API_KEY || "";
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Subscription Dashboard</title>
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
  </style>
</head>
<body>
  <div class="container">
  <nav class="topnav">
    <div class="logo">Subscription Tracker</div>
    <div class="nav-links">
      <a href="/">Accounts</a>
      <a href="/dashboard">Dashboard</a>
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
  <title>Subscription Tracker — Link Account</title>
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
  </style>
</head>
<body>
  <div class="container">
  <nav class="topnav">
    <div class="logo">Subscription Tracker</div>
    <div class="nav-links">
      <a href="/">Accounts</a>
      <a href="/dashboard">Dashboard</a>
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
