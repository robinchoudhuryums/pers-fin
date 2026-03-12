// ============================================================================
// Plaid Link Server — Perfin (Personal Finance Tracker)
// ============================================================================
// Minimal Express server that handles:
//   1. POST /api/create_link_token  — generates a Plaid Link token
//   2. POST /api/exchange_token     — exchanges public_token for access_token,
//      encrypts it, and stores the Item + accounts in Neon Postgres
//   3. GET  /api/items              — lists linked institutions (for debugging)
//   4. GET  /                       — serves a tiny HTML page with Plaid Link
//
// Run with:  node server.js
// Requires:  .env file in repo root (see .env.example)
// ============================================================================

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");
const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require("plaid");
const path = require("path");
const multer = require("multer");
const { parse } = require("csv-parse/sync");
const { detectSubscriptions } = require("../scripts/detect-subscriptions");

let sheetsSync;
try {
  sheetsSync = require("../scripts/sheets-sync");
} catch {
  sheetsSync = null; // googleapis not installed — Sheets sync disabled
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Plaid client setup
// ---------------------------------------------------------------------------
// Set PLAID_ENV in .env:
//   sandbox     — free, no approval needed (test credentials: user_good / pass_good)
//   development — requires Plaid approval
//   production  — Limited Production works for non-OAuth institutions
//                  (Chase, Wells Fargo, Discover, Schwab). Capital One requires
//                  full Production with OAuth.
const plaidEnv = (process.env.PLAID_ENV || "sandbox").toLowerCase();
const plaidBasePath = {
  production: PlaidEnvironments.production,
  development: PlaidEnvironments.development,
  sandbox: PlaidEnvironments.sandbox,
}[plaidEnv] || PlaidEnvironments.sandbox;

const plaidSecret = {
  production: process.env.PLAID_SECRET_PROD,
  development: process.env.PLAID_SECRET_DEV,
  sandbox: process.env.PLAID_SECRET_SANDBOX,
}[plaidEnv] || process.env.PLAID_SECRET_SANDBOX;

const plaidConfig = new Configuration({
  basePath: plaidBasePath,
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
      "PLAID-SECRET": plaidSecret,
    },
  },
});
const plaidClient = new PlaidApi(plaidConfig);
console.log(`Plaid environment: ${plaidEnv} | client_id: ${process.env.PLAID_CLIENT_ID ? process.env.PLAID_CLIENT_ID.slice(0, 6) + "..." : "MISSING"} | secret: ${plaidSecret ? "set" : "MISSING"}`);

// ---------------------------------------------------------------------------
// Neon Postgres pool — use the pgBouncer pooled connection string
// ---------------------------------------------------------------------------
// Neon's scale-to-zero can cause the first query to take 1-3 s while the
// compute spins up.  The pgBouncer endpoint handles this gracefully; just set
// a generous connectionTimeoutMillis.
const pool = new Pool({
  connectionString: process.env.NEON_DATABASE_URL, // use ?pgbouncer=true endpoint
  ssl: { rejectUnauthorized: false },
  max: 3,                        // single-user app, keep it small
  connectionTimeoutMillis: 10000, // allow for Neon cold-start
  idleTimeoutMillis: 30000,
});

const ENCRYPTION_PASSPHRASE = process.env.TOKEN_ENCRYPTION_PASSPHRASE;

// ---------------------------------------------------------------------------
// POST /api/create_link_token
// ---------------------------------------------------------------------------
app.post("/api/create_link_token", async (_req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: "personal-user-1" },
      client_name: "Personal Subscription Tracker",
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: "en",
      // PLAID DEV NOTE: If you need to link Capital One (or any institution
      // that requires OAuth), you must register a redirect URI in the Plaid
      // dashboard and uncomment the line below.
      // redirect_uri: process.env.PLAID_REDIRECT_URI,
    });
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error("create_link_token error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/exchange_token
// ---------------------------------------------------------------------------
// Receives { public_token, institution } from the frontend after the user
// completes Plaid Link.  Exchanges for an access_token, encrypts it, and
// stores the Item + accounts.
app.post("/api/exchange_token", async (req, res) => {
  const { public_token, institution } = req.body;
  if (!public_token) {
    return res.status(400).json({ error: "public_token is required" });
  }

  const client = await pool.connect();
  try {
    // 1. Exchange public token → access token + item_id
    const exchangeRes = await plaidClient.itemPublicTokenExchange({
      public_token,
    });
    const { access_token, item_id } = exchangeRes.data;

    await client.query("BEGIN");

    // 2. Store the Item with encrypted access_token
    const itemResult = await client.query(
      `INSERT INTO plaid_items (item_id, institution_id, institution_name, access_token_enc)
       VALUES ($1, $2, $3, pgp_sym_encrypt($4, $5))
       ON CONFLICT (item_id)
       DO UPDATE SET
         institution_name = EXCLUDED.institution_name,
         access_token_enc = EXCLUDED.access_token_enc,
         status = 'GOOD',
         updated_at = now()
       RETURNING id`,
      [
        item_id,
        institution?.institution_id || null,
        institution?.name || "Unknown",
        access_token,
        ENCRYPTION_PASSPHRASE,
      ]
    );
    const plaidItemId = itemResult.rows[0].id;

    // 3. Initialize sync cursor for this Item
    await client.query(
      `INSERT INTO sync_cursors (plaid_item_id, cursor)
       VALUES ($1, '')
       ON CONFLICT (plaid_item_id) DO NOTHING`,
      [plaidItemId]
    );

    // 4. Fetch and store accounts
    const acctRes = await plaidClient.accountsGet({ access_token });
    for (const acct of acctRes.data.accounts) {
      await client.query(
        `INSERT INTO linked_accounts
           (plaid_item_id, account_id, name, official_name, type, subtype, mask)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (account_id)
         DO UPDATE SET
           name = EXCLUDED.name,
           official_name = EXCLUDED.official_name,
           type = EXCLUDED.type,
           subtype = EXCLUDED.subtype,
           mask = EXCLUDED.mask`,
        [
          plaidItemId,
          acct.account_id,
          acct.name,
          acct.official_name,
          acct.type,
          acct.subtype,
          acct.mask,
        ]
      );
    }

    await client.query("COMMIT");

    console.log(`Linked: ${institution?.name || "Unknown"} (${item_id}), ${acctRes.data.accounts.length} accounts`);
    res.json({
      item_id,
      accounts_linked: acctRes.data.accounts.length,
      institution: institution?.name,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("exchange_token error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// GET /api/items — list linked institutions (debug/admin)
// ---------------------------------------------------------------------------
app.get("/api/items", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT pi.id, pi.item_id, pi.institution_name, pi.status, pi.created_at,
              json_agg(json_build_object(
                'account_id', la.account_id,
                'name', la.name,
                'type', la.type,
                'subtype', la.subtype,
                'mask', la.mask
              )) AS accounts
       FROM plaid_items pi
       LEFT JOIN linked_accounts la ON la.plaid_item_id = pi.id
       GROUP BY pi.id
       ORDER BY pi.created_at`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("list items error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/items/:id — unlink an institution (remove item, keep transactions)
// ---------------------------------------------------------------------------
app.delete("/api/items/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const check = await pool.query("SELECT id, institution_name FROM plaid_items WHERE id = $1", [id]);
    if (!check.rows.length) return res.status(404).json({ error: "Item not found" });
    const name = check.rows[0].institution_name;
    await pool.query("DELETE FROM linked_accounts WHERE plaid_item_id = $1", [id]);
    await pool.query("DELETE FROM plaid_items WHERE id = $1", [id]);
    res.json({ success: true, institution_name: name });
  } catch (err) {
    console.error("delete item error:", err.message);
    res.status(500).json({ error: err.message });
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
              COALESCE(pi.institution_name, 'Unknown') AS institution_name,
              'plaid' AS provider
       FROM linked_accounts la
       LEFT JOIN plaid_items pi ON pi.id = la.plaid_item_id
       ORDER BY la.type, la.name`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("list accounts error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/sync-balances — fetch latest balances from Plaid
// ---------------------------------------------------------------------------
app.post("/api/sync-balances", async (_req, res) => {
  try {
    const items = await pool.query(
      `SELECT id, item_id, institution_name,
              pgp_sym_decrypt(access_token_enc, $1) AS access_token
       FROM plaid_items WHERE status = 'GOOD'`,
      [ENCRYPTION_PASSPHRASE]
    );

    let updated = 0;
    const errors = [];

    for (const item of items.rows) {
      try {
        const balanceRes = await plaidClient.accountsGet({ access_token: item.access_token });
        for (const acct of balanceRes.data.accounts) {
          const bal = acct.balances || {};
          await pool.query(
            `UPDATE linked_accounts
             SET available_balance = $1, current_balance = $2, balance_updated_at = now()
             WHERE account_id = $3`,
            [bal.available, bal.current, acct.account_id]
          );
          updated++;
        }
      } catch (err) {
        errors.push({ institution: item.institution_name, error: err.response?.data?.error_message || err.message });
      }
    }

    res.json({ accounts_updated: updated, errors: errors.length > 0 ? errors : undefined });
  } catch (err) {
    console.error("sync-balances error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/spending-summary — aggregated spending data for dashboard
// ---------------------------------------------------------------------------
app.get("/api/spending-summary", async (req, res) => {
  const months = parseInt(req.query.months) || 6;
  try {
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
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/import-csv — import transactions from a bank CSV export
// ---------------------------------------------------------------------------
// Supported formats: Chase, Wells Fargo, Capital One, and generic.
// Auto-detects format from CSV headers.
// Creates virtual plaid_items and linked_accounts rows for FK integrity.

const CSV_FORMATS = {
  chase: {
    detect: (headers) => headers.includes("Transaction Date") && headers.includes("Post Date") && headers.includes("Description"),
    parse: (row) => ({
      date: row["Transaction Date"],
      merchant_name: row["Description"],
      amount: -parseFloat(row["Amount"]),   // Chase: negative = debit
      category: row["Category"] || null,
    }),
  },
  wellsfargo: {
    detect: (headers) => headers.length >= 5 && !headers.includes("Transaction Date") && !headers.includes("Category"),
    // Wells Fargo has no header row by default; columns: Date, Amount, *, *, Description
    parseHeaderless: true,
    parse: (row, columns) => ({
      date: columns[0],
      merchant_name: columns[4] || columns[3] || null,
      amount: -parseFloat(columns[1]),      // Wells Fargo: negative = debit
      category: null,
    }),
  },
  capitalone: {
    detect: (headers) => headers.includes("Transaction Date") && headers.includes("Posted Date") && (headers.includes("Debit") || headers.includes("Credit")),
    parse: (row) => ({
      date: row["Transaction Date"],
      merchant_name: row["Description"],
      amount: parseFloat(row["Debit"] || "0") || -(parseFloat(row["Credit"] || "0")),
      category: row["Category"] || null,
    }),
  },
  discover: {
    detect: (headers) => headers.includes("Trans. Date") && headers.includes("Post Date") && headers.includes("Description") && headers.includes("Amount"),
    parse: (row) => ({
      date: row["Trans. Date"],
      merchant_name: row["Description"],
      amount: Math.abs(parseFloat(row["Amount"])),
      category: row["Category"] || null,
    }),
  },
  schwab: {
    detect: (headers) => headers.includes("Date") && headers.includes("Description") && (headers.includes("Withdrawal") || headers.includes("Amount")),
    parse: (row) => ({
      date: row["Date"],
      merchant_name: row["Description"],
      amount: Math.abs(parseFloat(row["Withdrawal"] || row["Amount"] || "0")),
      category: row["Type"] || null,
    }),
  },
  generic: {
    detect: () => true,  // fallback
    parse: (row) => {
      // Try common column names
      const date = row["Date"] || row["Transaction Date"] || row["date"] || Object.values(row)[0];
      const desc = row["Description"] || row["Merchant"] || row["Name"] || row["description"] || Object.values(row).find(v => typeof v === "string" && v.length > 3 && isNaN(v));
      const amtStr = row["Amount"] || row["Debit"] || row["amount"] || Object.values(row).find(v => !isNaN(parseFloat(v)));
      return {
        date,
        merchant_name: desc || null,
        amount: Math.abs(parseFloat(amtStr) || 0),
        category: row["Category"] || row["category"] || null,
      };
    },
  },
};

function detectCsvFormat(headers) {
  for (const [name, fmt] of Object.entries(CSV_FORMATS)) {
    if (name !== "generic" && fmt.detect(headers)) return name;
  }
  return "generic";
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  const cleaned = dateStr.trim();
  // MM/DD/YYYY or M/D/YYYY
  const slashMatch = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) return `${slashMatch[3]}-${slashMatch[1].padStart(2, "0")}-${slashMatch[2].padStart(2, "0")}`;
  // YYYY-MM-DD (already ISO)
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return cleaned;
  // Try native parse
  const d = new Date(cleaned);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

app.post("/api/import-csv", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const institution = (req.body.institution || "CSV Import").trim();
  const accountLabel = (req.body.account_label || `${institution} Account`).trim();

  let records;
  const content = req.file.buffer.toString("utf-8");

  try {
    records = parse(content, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  } catch {
    // Try headerless (Wells Fargo)
    try {
      records = parse(content, { columns: false, skip_empty_lines: true, trim: true, bom: true });
    } catch (e2) {
      return res.status(400).json({ error: "Could not parse CSV: " + e2.message });
    }
  }

  if (!records.length) return res.status(400).json({ error: "CSV file is empty" });

  // Detect format
  const hasHeaders = !Array.isArray(records[0]);
  const headers = hasHeaders ? Object.keys(records[0]) : [];
  const format = hasHeaders ? detectCsvFormat(headers) : "wellsfargo";
  const fmt = CSV_FORMATS[format];

  // Generate stable IDs for this CSV source
  const institutionSlug = institution.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const accountSlug = accountLabel.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const virtualItemId = `csv_${institutionSlug}`;
  const virtualAccountId = `csv_${accountSlug}`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Ensure virtual plaid_item exists for this CSV source
    const itemResult = await client.query(
      `INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status)
       VALUES ($1, $2, pgp_sym_encrypt('csv_import', $3), 'CSV')
       ON CONFLICT (item_id)
       DO UPDATE SET institution_name = EXCLUDED.institution_name, updated_at = now()
       RETURNING id`,
      [virtualItemId, institution, ENCRYPTION_PASSPHRASE]
    );
    const plaidItemId = itemResult.rows[0].id;

    // Ensure virtual linked_account exists
    await client.query(
      `INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype)
       VALUES ($1, $2, $3, 'csv_import', 'csv')
       ON CONFLICT (account_id)
       DO UPDATE SET name = EXCLUDED.name`,
      [plaidItemId, virtualAccountId, accountLabel]
    );

    let imported = 0;
    let skipped = 0;

    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      let parsed;
      try {
        parsed = hasHeaders ? fmt.parse(row) : fmt.parse(row, row);
      } catch {
        skipped++;
        continue;
      }

      const date = parseDate(parsed.date);
      if (!date || isNaN(parsed.amount) || parsed.amount === 0) {
        skipped++;
        continue;
      }

      // Generate a deterministic transaction_id from content to avoid duplicates
      const txnHash = crypto
        .createHash("sha256")
        .update(`${virtualAccountId}|${date}|${parsed.amount}|${parsed.merchant_name || ""}|${i}`)
        .digest("hex")
        .slice(0, 24);
      const transactionId = `csv_${txnHash}`;

      try {
        await client.query(
          `INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, category, pending)
           VALUES ($1, $2, $3, $4, $5, $6, $7, false)
           ON CONFLICT (transaction_id) DO NOTHING`,
          [
            virtualAccountId,
            transactionId,
            parsed.amount,
            date,
            parsed.merchant_name,
            parsed.merchant_name,  // use same value for name
            parsed.category ? [parsed.category] : null,
          ]
        );
        imported++;
      } catch {
        skipped++;
      }
    }

    // Log the import
    await client.query(
      `INSERT INTO csv_imports (filename, institution, account_label, rows_imported, rows_skipped)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.file.originalname, institution, accountLabel, imported, skipped]
    );

    await client.query("COMMIT");

    console.log(`CSV import: ${institution} — ${imported} imported, ${skipped} skipped (format: ${format})`);
    res.json({
      format_detected: format,
      institution,
      account_label: accountLabel,
      rows_imported: imported,
      rows_skipped: skipped,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("CSV import error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// GET /api/csv-imports — list previous CSV imports
// ---------------------------------------------------------------------------
app.get("/api/csv-imports", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, filename, institution, account_label, rows_imported, rows_skipped, imported_at
       FROM csv_imports ORDER BY imported_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Cancellation URLs for common subscription services
// ---------------------------------------------------------------------------
const CANCEL_URLS = {
  "netflix": "https://www.netflix.com/cancelplan",
  "spotify": "https://www.spotify.com/account/subscription/",
  "hulu": "https://secure.hulu.com/account",
  "disney+": "https://www.disneyplus.com/account",
  "disney plus": "https://www.disneyplus.com/account",
  "hbo max": "https://www.max.com/account",
  "max": "https://www.max.com/account",
  "amazon prime": "https://www.amazon.com/mc/pipelines/cancelPrime",
  "prime video": "https://www.amazon.com/mc/pipelines/cancelPrime",
  "apple tv": "https://support.apple.com/en-us/HT202039",
  "apple music": "https://support.apple.com/en-us/HT202039",
  "apple one": "https://support.apple.com/en-us/HT202039",
  "icloud": "https://support.apple.com/en-us/HT202039",
  "youtube premium": "https://www.youtube.com/paid_memberships",
  "youtube music": "https://www.youtube.com/paid_memberships",
  "google one": "https://one.google.com/settings",
  "adobe": "https://account.adobe.com/plans",
  "creative cloud": "https://account.adobe.com/plans",
  "microsoft 365": "https://account.microsoft.com/services/",
  "xbox game pass": "https://account.microsoft.com/services/",
  "playstation plus": "https://store.playstation.com/subscriptions",
  "ps plus": "https://store.playstation.com/subscriptions",
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

function findCancelUrl(merchantName) {
  if (!merchantName) return null;
  const lower = merchantName.toLowerCase();
  for (const [key, url] of Object.entries(CANCEL_URLS)) {
    if (lower.includes(key)) return url;
  }
  return null;
}

// ---------------------------------------------------------------------------
// GET /api/subscriptions — list all detected subscriptions
// ---------------------------------------------------------------------------
app.get("/api/subscriptions", async (req, res) => {
  const filter = req.query.filter || "active"; // active | dismissed | cancelled | all
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

    // Attach cancellation links
    const subs = result.rows.map(s => ({
      ...s,
      cancel_url: findCancelUrl(s.display_name) || findCancelUrl(s.merchant_key),
    }));

    // Summary
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
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/subscriptions — manually add a subscription
// ---------------------------------------------------------------------------
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
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/subscriptions/:id/dismiss — hide a false positive
// ---------------------------------------------------------------------------
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
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/subscriptions/:id/undismiss — restore a dismissed subscription
// ---------------------------------------------------------------------------
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
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/subscriptions/:id/cancel — mark subscription as cancelled
// ---------------------------------------------------------------------------
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
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/subscriptions/:id/uncancel — undo a cancellation mark
// ---------------------------------------------------------------------------
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
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/detect — trigger subscription detection on demand
// ---------------------------------------------------------------------------
app.post("/api/detect", async (_req, res) => {
  try {
    const detected = await detectSubscriptions();
    res.json({ detected_count: detected.length, subscriptions: detected });
  } catch (err) {
    console.error("On-demand detection error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/sheets/sync — sync transactions + subscriptions to Google Sheets
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
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/sheets/dashboard — rebuild dashboard sheet only
// ---------------------------------------------------------------------------
app.post("/api/sheets/dashboard", async (_req, res) => {
  if (!sheetsSync) {
    return res.status(501).json({ error: "Google Sheets integration not available. Install googleapis: npm install googleapis" });
  }
  try {
    const result = await sheetsSync.syncDashboardOnly();
    res.json(result);
  } catch (err) {
    console.error("Dashboard rebuild error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/cleanup — manual retention cleanup
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
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /dashboard — personal finance dashboard
// ---------------------------------------------------------------------------
app.get("/dashboard", (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard — Perfin</title>
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
  </style>
</head>
<body>
  <div class="container">
  <nav class="topnav">
    <div class="logo">Perfin</div>
    <div class="nav-links">
      <a href="/dashboard" class="active">Dashboard</a>
      <a href="/subscriptions">Subscriptions</a>
      <a href="/">Accounts</a>
    </div>
  </nav>

  <h1>Dashboard</h1>
  <p class="subtitle">Personal finance overview</p>

  <div class="actions">
    <button id="balance-btn" onclick="syncBalances()">Refresh Balances</button>
    <button id="detect-btn" onclick="runDetection()">Run Detection</button>
  </div>

  <div id="status-msg" class="status-msg"></div>

  <div class="top-cards" id="summary-cards">
    <div class="card"><div class="label">Net Balance</div><div class="value warm" id="net-balance">--</div></div>
    <div class="card"><div class="label">Monthly Spend</div><div class="value warm" id="avg-monthly">--</div><div class="sub" id="avg-monthly-sub"></div></div>
    <div class="card"><div class="label">Subscriptions /mo</div><div class="value teal" id="subs-monthly">--</div></div>
    <div class="card"><div class="label">Active Subs</div><div class="value teal" id="active-subs">--</div></div>
    <div class="card"><div class="label">Avg Daily Spend</div><div class="value warm" id="avg-daily">--</div></div>
    <div class="card"><div class="label">Linked Accounts</div><div class="value teal" id="acct-count">--</div></div>
  </div>

  <div id="accounts-section" style="margin-bottom:28px;">
    <div style="font-size:10px;font-weight:500;color:var(--text-muted);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:14px;">Account Balances</div>
    <div class="accounts-grid" id="accounts-grid">
      <div class="empty-msg">Loading accounts...</div>
    </div>
  </div>

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

    const fmt = (n) => '$' + parseFloat(n || 0).toFixed(2);
    const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '\\u2014';
    const fmtMonth = (m) => {
      const [y, mo] = m.split('-');
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return months[parseInt(mo)-1] + ' ' + y;
    };

    const barColors = ['#c8856c','#d4a574','#5a8f8f','#6fcf97','#7fb5e6','#f0c36d','#eb6b6b','#b07cc6','#e8a87c','#85dcb0','#7bb5d4','#d4a0a0','#9fd4c9','#c4b28f','#a8c3d4'];

    async function loadAccounts() {
      try {
        const res = await fetch('/api/accounts');
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

    async function loadSpendingSummary() {
      try {
        const res = await fetch('/api/spending-summary?months=6');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();

        const monthBody = document.getElementById('monthly-body');
        if (data.monthly_trend.length) {
          monthBody.innerHTML = data.monthly_trend.map(m =>
            '<tr><td>' + fmtMonth(m.month) + '</td>' +
            '<td class="amount warm">' + fmt(m.total_spend) + '</td>' +
            '<td>' + m.txn_count + '</td>' +
            '<td class="amount">' + fmt(m.avg_transaction) + '</td></tr>'
          ).join('');

          const totalSpend = data.monthly_trend.reduce((s, m) => s + parseFloat(m.total_spend), 0);
          const avgMonthly = totalSpend / data.monthly_trend.length;
          document.getElementById('avg-monthly').textContent = fmt(avgMonthly);
          document.getElementById('avg-monthly-sub').textContent = data.monthly_trend.length + '-month avg';

          const totalDays = data.monthly_trend.length * 30;
          document.getElementById('avg-daily').textContent = fmt(totalSpend / totalDays);
        } else {
          monthBody.innerHTML = '<tr><td colspan="4" class="empty-msg">No spending data yet.</td></tr>';
        }

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

        const upBody = document.getElementById('upcoming-body');
        if (data.upcoming_subscriptions.length) {
          upBody.innerHTML = data.upcoming_subscriptions.map(s =>
            '<tr><td>' + s.display_name + '</td>' +
            '<td class="amount teal">' + fmt(s.amount) + '</td>' +
            '<td>' + fmtDate(s.next_expected) + '</td></tr>'
          ).join('');

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

    async function syncBalances() {
      const btn = document.getElementById('balance-btn');
      btnLoading(btn, true);
      try {
        const res = await fetch('/api/sync-balances', { method: 'POST' });
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
        const res = await fetch('/api/detect', { method: 'POST' });
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

    loadAccounts();
    loadSpendingSummary();
  </script>
</body>
</html>`);
});

// ---------------------------------------------------------------------------
// GET /subscriptions — subscription management page
// ---------------------------------------------------------------------------
app.get("/subscriptions", (_req, res) => {
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
    @keyframes spin { to { transform: rotate(360deg); } }
    .btn-loading { position: relative; color: transparent !important; pointer-events: none; }
    .btn-loading::after {
      content: ''; position: absolute; top: 50%; left: 50%; width: 14px; height: 14px;
      margin: -7px 0 0 -7px; border: 2px solid var(--warm); border-top-color: transparent;
      border-radius: 50%; animation: spin 0.6s linear infinite;
    }
    .container { max-width: 960px; margin: 0 auto; padding: 24px 20px; position: relative; z-index: 1; }
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

    h1 { font-size: 42px; font-weight: 300; letter-spacing: -0.5px; margin-bottom: 8px; }
    .subtitle { color: var(--text-muted); margin-bottom: 40px; font-size: 15px; font-weight: 300; letter-spacing: 0.3px; }

    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
               gap: 16px; margin-bottom: 36px; }
    .card { padding: 24px; border-radius: var(--radius); background: var(--surface);
            border: 1px solid var(--border); transition: all 0.3s ease; backdrop-filter: blur(12px); }
    .card:hover { border-color: var(--border-hover); background: var(--surface-2); }
    .card .label { font-size: 10px; color: var(--text-muted); text-transform: uppercase;
                   letter-spacing: 1.5px; font-weight: 500; }
    .card .value { font-size: 32px; font-weight: 300; margin-top: 8px;
                   font-variant-numeric: tabular-nums; letter-spacing: -1px; }
    .card .value.cost { color: var(--warm-glow); }
    .card .value.count { color: var(--teal); }

    .actions { display: flex; gap: 10px; margin-bottom: 24px; flex-wrap: wrap; align-items: center; }
    .actions button, .actions select {
      padding: 9px 18px; font-size: 12px; font-weight: 500; letter-spacing: 0.5px;
      border: 1px solid var(--border); border-radius: 8px; cursor: pointer;
      background: transparent; color: var(--text-muted); transition: all 0.2s; text-transform: uppercase;
    }
    .actions button:hover:not(:disabled) { border-color: var(--warm); color: var(--text); }
    .actions button.primary { border-color: var(--warm); color: var(--warm); background: transparent; }
    .actions button.primary:hover:not(:disabled) { background: rgba(212,165,116,0.1); color: var(--text); }
    .actions button.primary:disabled { opacity: 0.4; cursor: not-allowed; }
    .actions select { appearance: none; padding-right: 30px;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23d4a574' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 10px center; background-color: transparent; }
    .actions select option { background: #131620; color: var(--text); }

    table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    th { text-align: left; padding: 12px 14px; font-size: 10px; color: var(--text-muted);
         text-transform: uppercase; letter-spacing: 1.5px; font-weight: 500;
         border-bottom: 1px solid var(--border); }
    td { padding: 14px; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 14px; font-weight: 300; }
    tr { transition: background 0.15s; }
    tr:hover { background: var(--surface); }
    .amount { font-weight: 400; font-variant-numeric: tabular-nums; letter-spacing: -0.3px; }

    .badge { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 9px;
             font-weight: 600; letter-spacing: 0.8px; text-transform: uppercase; }
    .badge-new { background: var(--green-bg); color: var(--green); }
    .badge-price { background: var(--yellow-bg); color: var(--yellow); }
    .badge-manual { background: var(--blue-bg); color: var(--blue); }
    .badge-dismissed { background: var(--surface-2); color: var(--text-muted); }
    .badge-cancelled { background: var(--red-bg); color: var(--red); }

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

    .manual-form { background: var(--surface); padding: 28px; border-radius: var(--radius);
                   border: 1px solid var(--border); margin-bottom: 28px; display: none; backdrop-filter: blur(12px); }
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

    .status-msg { padding: 14px 18px; border-radius: 8px; margin-bottom: 20px; display: none;
                  font-size: 13px; font-weight: 400; }
    .status-msg.success { background: var(--green-bg); border: 1px solid rgba(111,207,151,0.15);
                          color: var(--green); display: block; }
    .status-msg.error { background: var(--red-bg); border: 1px solid rgba(235,107,107,0.15);
                        color: var(--red); display: block; }
    .empty { text-align: center; padding: 56px; color: var(--text-muted); font-weight: 300; font-size: 15px; }
  </style>
</head>
<body>
  <div class="container">
  <nav class="topnav">
    <div class="logo">Perfin</div>
    <div class="nav-links">
      <a href="/dashboard">Dashboard</a>
      <a href="/subscriptions">Subscriptions</a>
      <a href="/">Accounts</a>
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

    function isOverdue(dateStr) {
      return new Date(dateStr) < new Date();
    }

    async function loadSubscriptions() {
      const filter = document.getElementById('filter-select').value;
      try {
        const res = await fetch('/api/subscriptions?filter=' + filter);
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || 'HTTP ' + res.status);
        }
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
              actions += '<a class="btn-sm cancel" href="' + s.cancel_url + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">Cancel&rarr;</a>';
              actions += '<button class="btn-sm cancel" onclick="markCancelled(' + s.id + ')" title="Mark as cancelled after completing cancellation">Done</button>';
            } else {
              actions += '<button class="btn-sm cancel" onclick="markCancelled(' + s.id + ')">Cancel</button>';
            }
          }

          const notesHtml = s.notes ? '<div style="font-size:12px;color:#888;">' + s.notes + '</div>' : '';

          return '<tr>' +
            '<td><strong>' + s.display_name + '</strong> ' + badges.join(' ') + notesHtml + '</td>' +
            '<td class="amount">$' + parseFloat(s.amount).toFixed(2) + '</td>' +
            '<td class="amount">$' + parseFloat(s.monthly_cost).toFixed(2) + '</td>' +
            '<td>' + cadenceLabel(s.cadence_days) + '</td>' +
            '<td><span class="' + nextClass + '">' + nextLabel + '</span></td>' +
            '<td>' + actions + '</td>' +
            '</tr>';
        }).join('');
      } catch (e) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty">Error loading subscriptions: ' + e.message + '</td></tr>';
      }
    }

    async function runDetection() {
      const btn = document.getElementById('detect-btn');
      btnLoading(btn, true);
      try {
        const res = await fetch('/api/detect', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          showMsg('Detection complete: ' + (data.detected_count || 0) + ' subscriptions found.', true);
          loadSubscriptions();
        } else {
          showMsg('Detection error: ' + (data.error || 'HTTP ' + res.status), false);
        }
      } catch (e) { showMsg('Detection failed: ' + e.message, false); }
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
        const res = await fetch('/api/subscriptions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, amount, cadence_days, notes: notes || undefined }),
        });
        if (res.ok) {
          showMsg('Added ' + name + ' ($' + amount.toFixed(2) + '/' + cadenceLabel(cadence_days).toLowerCase() + ')', true);
          document.querySelector('.manual-form input[name="name"]').value = '';
          document.querySelector('.manual-form input[name="amount"]').value = '';
          document.querySelector('.manual-form input[name="notes"]').value = '';
          loadSubscriptions();
        } else {
          const data = await res.json().catch(() => ({}));
          showMsg('Error adding subscription: ' + (data.error || 'HTTP ' + res.status), false);
        }
      } catch (e) { showMsg('Failed to add subscription: ' + e.message, false); }
    }

    async function dismissSub(id) {
      try {
        const res = await fetch('/api/subscriptions/' + id + '/dismiss', { method: 'PATCH' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          showMsg('Failed to dismiss: ' + (data.error || 'HTTP ' + res.status), false);
          return;
        }
        loadSubscriptions();
      } catch (e) { showMsg('Failed to dismiss: ' + e.message, false); }
    }

    async function undismissSub(id) {
      try {
        const res = await fetch('/api/subscriptions/' + id + '/undismiss', { method: 'PATCH' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          showMsg('Failed to restore: ' + (data.error || 'HTTP ' + res.status), false);
          return;
        }
        loadSubscriptions();
      } catch (e) { showMsg('Failed to restore: ' + e.message, false); }
    }

    async function markCancelled(id) {
      if (!confirm('Mark this subscription as cancelled?')) return;
      try {
        const res = await fetch('/api/subscriptions/' + id + '/cancel', { method: 'PATCH' });
        if (res.ok) {
          showMsg('Subscription marked as cancelled.', true);
          loadSubscriptions();
        } else {
          const data = await res.json().catch(() => ({}));
          showMsg('Failed to cancel: ' + (data.error || 'HTTP ' + res.status), false);
        }
      } catch (e) { showMsg('Failed to cancel: ' + e.message, false); }
    }

    async function uncancelSub(id) {
      try {
        const res = await fetch('/api/subscriptions/' + id + '/uncancel', { method: 'PATCH' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          showMsg('Failed to restore: ' + (data.error || 'HTTP ' + res.status), false);
          return;
        }
        loadSubscriptions();
      } catch (e) { showMsg('Failed to restore: ' + e.message, false); }
    }

    async function syncSheets() {
      const btn = document.getElementById('sheets-btn');
      btnLoading(btn, true);
      try {
        const res = await fetch('/api/sheets/sync', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          showMsg('Synced to Google Sheets: ' + (data.transactions_synced || 0) + ' transactions, ' + (data.subscriptions_synced || 0) + ' subscriptions.', true);
        } else {
          showMsg('Sheets sync error: ' + (data.error || 'HTTP ' + res.status), false);
        }
      } catch (e) { showMsg('Sheets sync failed: ' + e.message, false); }
      btnLoading(btn, false, 'Sync to Sheets');
    }

    loadSubscriptions();
  </script>
</body>
</html>`);
});

// ---------------------------------------------------------------------------
// GET / — minimal HTML page with Plaid Link
// ---------------------------------------------------------------------------
app.get("/", (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Perfin — Link Account</title>
  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
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
    @keyframes spin { to { transform: rotate(360deg); } }
    .btn-loading { position: relative; color: transparent !important; pointer-events: none; }
    .btn-loading::after {
      content: ''; position: absolute; top: 50%; left: 50%; width: 14px; height: 14px;
      margin: -7px 0 0 -7px; border: 2px solid var(--warm); border-top-color: transparent;
      border-radius: 50%; animation: spin 0.6s linear infinite;
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

    #status { margin-top: 20px; padding: 14px 18px; border-radius: 8px; display: none; font-size: 13px; }
    .success { background: var(--green-bg); border: 1px solid rgba(111,207,151,0.15); color: var(--green); }
    .error   { background: var(--red-bg); border: 1px solid rgba(235,107,107,0.15); color: var(--red); }

    #items { margin-top: 36px; }
    .item { padding: 16px 18px; margin: 8px 0; background: var(--surface); border: 1px solid var(--border);
            border-radius: var(--radius); font-size: 14px; font-weight: 300; transition: all 0.2s;
            backdrop-filter: blur(12px); display: flex; align-items: center; justify-content: space-between; }
    .item:hover { border-color: var(--border-hover); background: var(--surface-2); }
    .item-info { flex: 1; }
    .item-actions { flex-shrink: 0; margin-left: 12px; }
    .btn-unlink { padding: 5px 12px; font-size: 10px; font-weight: 500; letter-spacing: 0.5px;
                  border: 1px solid rgba(235,107,107,0.25); border-radius: 6px; cursor: pointer;
                  background: transparent; color: var(--red); text-transform: uppercase;
                  transition: all 0.2s; }
    .btn-unlink:hover { background: var(--red-bg); }

    .section-divider { margin: 48px 0; border: none; border-top: 1px solid var(--border); }

    .csv-section { margin-top: 8px; }
    .csv-form { display: flex; flex-direction: column; gap: 18px; max-width: 420px; }
    .csv-form label { font-weight: 500; font-size: 10px; color: var(--text-muted);
                      text-transform: uppercase; letter-spacing: 1.5px; }
    .csv-form select, .csv-form input[type="text"] {
      padding: 10px 14px; font-size: 14px; border: 1px solid var(--border); border-radius: 8px;
      background: transparent; color: var(--text); width: 100%; font-weight: 300; transition: border-color 0.2s; }
    .csv-form select:focus, .csv-form input:focus { outline: none; border-color: var(--warm); }
    .csv-form select option { background: #131620; color: var(--text); }
    .csv-form input[type="file"] { font-size: 13px; color: var(--text-muted); }
    .csv-form .field { display: flex; flex-direction: column; gap: 8px; }
    .csv-form input::placeholder { color: var(--text-muted); }

    .csv-imports { margin-top: 32px; }
    .csv-import-entry { padding: 14px 18px; margin: 6px 0; background: var(--surface);
                        border: 1px solid var(--border); border-radius: var(--radius);
                        font-size: 13px; font-weight: 300; backdrop-filter: blur(12px); }
  </style>
</head>
<body>
  <div class="container">
  <nav class="topnav">
    <div class="logo">Perfin</div>
    <div class="nav-links">
      <a href="/dashboard">Dashboard</a>
      <a href="/subscriptions">Subscriptions</a>
      <a href="/">Accounts</a>
    </div>
  </nav>

  <h1>Link Accounts</h1>
  <p>Connect a financial institution to start tracking recurring charges automatically.</p>
  <button id="link-btn" disabled>Loading...</button>
  <div id="status"></div>
  <div id="items"><h3>Linked Institutions</h3><div id="items-list" style="color:var(--text-muted);font-size:14px;font-weight:300;">Loading...</div></div>

  <hr class="section-divider">

  <div class="csv-section">
    <h2>Import from CSV</h2>
    <p>Upload a CSV export from your bank. Supports Chase, Wells Fargo, Capital One, and generic formats.</p>
    <div class="csv-form">
      <div class="field">
        <label for="csv-institution">Bank / Institution</label>
        <select id="csv-institution">
          <option value="Chase">Chase</option>
          <option value="Wells Fargo">Wells Fargo</option>
          <option value="Capital One">Capital One</option>
          <option value="Bank of America">Bank of America</option>
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
    const statusEl  = document.getElementById('status');
    const linkBtn   = document.getElementById('link-btn');
    const itemsList = document.getElementById('items-list');

    function showStatus(msg, ok) {
      statusEl.textContent = msg;
      statusEl.className = ok ? 'success' : 'error';
      statusEl.style.display = 'block';
      if (statusEl._timer) clearTimeout(statusEl._timer);
      statusEl._timer = setTimeout(() => {
        statusEl.style.display = 'none'; statusEl.className = '';
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

    async function unlinkAccount(id, name) {
      if (!confirm('Unlink ' + name + '? This will remove the enrollment but keep existing transaction data.')) return;
      try {
        const res = await fetch('/api/items/' + id, { method: 'DELETE' });
        if (res.ok) {
          showStatus('Unlinked ' + name + ' successfully.', true);
          loadItems();
        } else {
          const data = await res.json().catch(() => ({}));
          showStatus('Failed to unlink: ' + (data.error || 'HTTP ' + res.status), false);
        }
      } catch (e) { showStatus('Failed to unlink: ' + e.message, false); }
    }

    async function loadItems() {
      try {
        const res = await fetch('/api/items');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const items = await res.json();
        if (!items.length) { itemsList.textContent = 'No institutions linked yet.'; return; }
        itemsList.innerHTML = items.map(i =>
          '<div class="item">' +
            '<div class="item-info"><strong>' + i.institution_name + '</strong> — ' +
            i.accounts.length + ' account(s) — Status: ' + i.status + '</div>' +
            '<div class="item-actions"><button class="btn-unlink" onclick="unlinkAccount(' + i.id + ', \\'' + (i.institution_name || '').replace(/'/g, "\\\\'") + '\\')">Unlink</button></div>' +
          '</div>'
        ).join('');
      } catch (e) { itemsList.textContent = 'Could not load items: ' + e.message; }
    }

    async function startLink() {
      btnLoading(linkBtn, true);
      try {
        const res = await fetch('/api/create_link_token', { method: 'POST' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          showStatus('Failed to create link token: ' + (data.error || 'HTTP ' + res.status), false);
          btnLoading(linkBtn, false, 'Link an Account');
          return;
        }
        const { link_token } = await res.json();

        const handler = Plaid.create({
          token: link_token,
          onSuccess: async (public_token, metadata) => {
            showStatus('Exchanging token…', true);
            try {
              const exRes = await fetch('/api/exchange_token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  public_token,
                  institution: metadata.institution,
                }),
              });
              const data = await exRes.json();
              if (exRes.ok) {
                showStatus('Linked ' + data.institution + ' (' + data.accounts_linked + ' accounts)', true);
                loadItems();
              } else {
                showStatus('Error: ' + JSON.stringify(data.error), false);
              }
            } catch (e) { showStatus('Network error: ' + e.message, false); }
          },
          onExit: (err) => {
            if (err) showStatus('Link exited with error: ' + err.error_message, false);
          },
        });
        handler.open();
      } catch (e) { showStatus('Failed to start link: ' + e.message, false); }
      btnLoading(linkBtn, false, 'Link an Account');
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
      csvStatusEl._timer = setTimeout(() => {
        csvStatusEl.style.display = 'none'; csvStatusEl.className = '';
      }, ok ? 5000 : 10000);
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
      showCsvStatus('Importing…', true);

      try {
        const resp = await fetch('/api/import-csv', { method: 'POST', body: formData });
        const data = await resp.json().catch(() => ({}));
        if (resp.ok) {
          showCsvStatus(
            'Imported ' + (data.rows_imported || 0) + ' transactions (' + (data.rows_skipped || 0) +
            ' skipped) — Format: ' + (data.format_detected || 'unknown'), true
          );
          loadCsvImports();
          loadItems();
        } else {
          showCsvStatus('Import error: ' + (data.error || 'HTTP ' + resp.status), false);
        }
      } catch (e) { showCsvStatus('Import failed: ' + e.message, false); }
      btnLoading(btn, false, 'Upload & Import');
    }

    async function loadCsvImports() {
      const list = document.getElementById('csv-imports-list');
      try {
        const res = await fetch('/api/csv-imports');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const imports = await res.json();
        if (!imports.length) { list.textContent = 'No CSV imports yet.'; return; }
        list.innerHTML = imports.map(i =>
          '<div class="csv-import-entry"><strong>' + i.institution + '</strong> — ' +
          i.account_label + ' — ' + i.rows_imported + ' rows — ' +
          new Date(i.imported_at).toLocaleDateString() + ' — <em>' + i.filename + '</em></div>'
        ).join('');
      } catch (e) { list.textContent = 'Could not load import history: ' + e.message; }
    }

    // Initialize
    linkBtn.textContent = 'Link an Account';
    linkBtn.disabled = false;
    linkBtn.addEventListener('click', startLink);
    loadItems();
    loadCsvImports();
  </script>
</body>
</html>`);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Plaid Link server running on http://localhost:${PORT}`);
});
