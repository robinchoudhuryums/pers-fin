// ============================================================================
// Plaid Link Server — Personal Subscription Tracker
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
console.log(`Plaid environment: ${plaidEnv} | client_id: ${process.env.PLAID_CLIENT_ID ? process.env.PLAID_CLIENT_ID.slice(0, 6) + "..." : "MISSING"} | secret: ${(plaidEnv === "development" ? process.env.PLAID_SECRET_DEV : process.env.PLAID_SECRET_SANDBOX) ? "set" : "MISSING"}`);

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
// GET /dashboard — subscription dashboard page
// ---------------------------------------------------------------------------
app.get("/dashboard", (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Subscription Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; color: #1a1a1a; }
    a { color: #0052ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    h1 { margin-bottom: 4px; }
    .subtitle { color: #666; margin-bottom: 24px; font-size: 14px; }

    /* Summary cards */
    .summary { display: flex; gap: 16px; margin-bottom: 28px; flex-wrap: wrap; }
    .card { flex: 1; min-width: 140px; padding: 16px; border-radius: 8px; background: #f8f9fa; border: 1px solid #e9ecef; }
    .card .label { font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
    .card .value { font-size: 28px; font-weight: 700; margin-top: 4px; }
    .card .value.cost { color: #d63031; }
    .card .value.count { color: #0052ff; }

    /* Action bar */
    .actions { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; align-items: center; }
    .actions button, .actions select {
      padding: 8px 16px; font-size: 14px; border: 1px solid #ccc; border-radius: 6px;
      cursor: pointer; background: #fff;
    }
    .actions button.primary { background: #0052ff; color: #fff; border-color: #0052ff; }
    .actions button.primary:disabled { opacity: 0.6; cursor: not-allowed; }
    .actions button:hover:not(:disabled) { opacity: 0.9; }

    /* Subscription table */
    table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    th { text-align: left; padding: 10px 8px; border-bottom: 2px solid #dee2e6; font-size: 13px;
         color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
    td { padding: 10px 8px; border-bottom: 1px solid #f0f0f0; font-size: 14px; }
    tr:hover { background: #f8f9fa; }
    .amount { font-weight: 600; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
    .badge-new { background: #d4edda; color: #155724; }
    .badge-price { background: #fff3cd; color: #856404; }
    .badge-manual { background: #e0e7ff; color: #3730a3; }
    .badge-dismissed { background: #f0f0f0; color: #666; }
    .badge-cancelled { background: #fce4e4; color: #c0392b; }
    .btn-sm { padding: 4px 10px; font-size: 12px; border: 1px solid #ccc; border-radius: 4px;
              cursor: pointer; background: #fff; margin-right: 4px; }
    .btn-sm:hover { background: #f0f0f0; }
    .btn-sm.cancel { border-color: #e74c3c; color: #e74c3c; }
    .btn-sm.cancel:hover { background: #fce4e4; }
    .btn-sm.restore { border-color: #27ae60; color: #27ae60; }
    .btn-sm.restore:hover { background: #e6f9e6; }
    .cancel-link { font-size: 12px; }
    .next-date { font-size: 13px; color: #666; }
    .next-date.overdue { color: #e74c3c; font-weight: 600; }

    /* Manual add form */
    .manual-form { background: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 24px; display: none; }
    .manual-form h3 { margin-bottom: 12px; }
    .manual-form .fields { display: flex; gap: 12px; flex-wrap: wrap; align-items: end; }
    .manual-form .field { display: flex; flex-direction: column; gap: 4px; }
    .manual-form label { font-size: 12px; font-weight: 600; color: #666; }
    .manual-form input, .manual-form select { padding: 8px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px; }
    .manual-form input[name="name"] { width: 200px; }
    .manual-form input[name="amount"] { width: 100px; }
    .manual-form input[name="notes"] { width: 200px; }

    .status-msg { padding: 10px; border-radius: 6px; margin-bottom: 16px; display: none; }
    .status-msg.success { background: #e6f9e6; border: 1px solid #4caf50; display: block; }
    .status-msg.error { background: #fce4e4; border: 1px solid #f44336; display: block; }
    .empty { text-align: center; padding: 40px; color: #999; }
    nav { margin-bottom: 20px; font-size: 14px; }
  </style>
</head>
<body>
  <nav><a href="/">Link Accounts / CSV Import</a></nav>
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
    <button id="sheets-btn" onclick="syncSheets()" title="Sync to Google Sheets">Sync to Sheets</button>
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

  <script>
    const tbody = document.getElementById('subs-body');
    const statusMsg = document.getElementById('status-msg');

    function showMsg(text, ok) {
      statusMsg.textContent = text;
      statusMsg.className = 'status-msg ' + (ok ? 'success' : 'error');
      setTimeout(() => { statusMsg.style.display = 'none'; statusMsg.className = 'status-msg'; }, 4000);
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
      btn.disabled = true;
      btn.textContent = 'Detecting...';
      try {
        const res = await fetch('/api/detect', { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
          showMsg('Detection complete: ' + data.detected_count + ' subscriptions found.', true);
          loadSubscriptions();
        } else {
          showMsg('Detection error: ' + data.error, false);
        }
      } catch (e) { showMsg('Network error: ' + e.message, false); }
      btn.disabled = false;
      btn.textContent = 'Run Detection';
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
          const data = await res.json();
          showMsg('Error: ' + data.error, false);
        }
      } catch (e) { showMsg('Network error: ' + e.message, false); }
    }

    async function dismissSub(id) {
      await fetch('/api/subscriptions/' + id + '/dismiss', { method: 'PATCH' });
      loadSubscriptions();
    }

    async function undismissSub(id) {
      await fetch('/api/subscriptions/' + id + '/undismiss', { method: 'PATCH' });
      loadSubscriptions();
    }

    async function markCancelled(id) {
      if (!confirm('Mark this subscription as cancelled?')) return;
      await fetch('/api/subscriptions/' + id + '/cancel', { method: 'PATCH' });
      showMsg('Subscription marked as cancelled.', true);
      loadSubscriptions();
    }

    async function uncancelSub(id) {
      await fetch('/api/subscriptions/' + id + '/uncancel', { method: 'PATCH' });
      loadSubscriptions();
    }

    async function syncSheets() {
      const btn = document.getElementById('sheets-btn');
      btn.disabled = true;
      btn.textContent = 'Syncing...';
      try {
        const res = await fetch('/api/sheets/sync', { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
          showMsg('Synced to Google Sheets: ' + data.transactions_synced + ' transactions, ' + data.subscriptions_synced + ' subscriptions.', true);
        } else {
          showMsg('Sheets sync error: ' + data.error, false);
        }
      } catch (e) { showMsg('Network error: ' + e.message, false); }
      btn.disabled = false;
      btn.textContent = 'Sync to Sheets';
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
  <title>Subscription Tracker — Link Account</title>
  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 60px auto; padding: 0 20px; }
    button { padding: 12px 24px; font-size: 16px; cursor: pointer; border: none;
             background: #0052ff; color: #fff; border-radius: 6px; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    #status { margin-top: 20px; padding: 12px; border-radius: 6px; display: none; }
    .success { background: #e6f9e6; border: 1px solid #4caf50; }
    .error   { background: #fce4e4; border: 1px solid #f44336; }
    #items   { margin-top: 30px; }
    .item    { padding: 10px; margin: 8px 0; background: #f5f5f5; border-radius: 4px; }
    .divider { margin: 40px 0; border-top: 1px solid #ddd; }
    .csv-section { margin-top: 20px; }
    .csv-form { display: flex; flex-direction: column; gap: 12px; max-width: 400px; }
    .csv-form label { font-weight: 600; font-size: 14px; }
    .csv-form select, .csv-form input[type="text"] {
      padding: 8px 12px; font-size: 14px; border: 1px solid #ccc; border-radius: 4px; }
    .csv-form input[type="file"] { font-size: 14px; }
    .csv-imports { margin-top: 16px; }
    .csv-import-entry { padding: 8px; margin: 4px 0; background: #f0f4ff; border-radius: 4px; font-size: 14px; }
  </style>
</head>
<body>
  <nav style="margin-bottom:20px;font-size:14px;"><a href="/dashboard">View Dashboard</a></nav>
  <h1>Subscription Tracker</h1>
  <p>Link a financial institution to start tracking recurring charges.</p>
  <button id="link-btn" disabled>Loading…</button>
  <div id="status"></div>
  <div id="items"><h3>Linked Institutions</h3><div id="items-list">Loading…</div></div>

  <div class="divider"></div>

  <div class="csv-section">
    <h2>Import from CSV</h2>
    <p>Upload a CSV export from your bank. Supports Chase, Wells Fargo, Capital One, and generic formats.</p>
    <div class="csv-form">
      <label for="csv-institution">Bank / Institution</label>
      <select id="csv-institution">
        <option value="Chase">Chase</option>
        <option value="Wells Fargo">Wells Fargo</option>
        <option value="Capital One">Capital One</option>
        <option value="Bank of America">Bank of America</option>
        <option value="Other">Other</option>
      </select>
      <input type="text" id="csv-custom-institution" placeholder="Institution name" style="display:none">

      <label for="csv-account-label">Account Label</label>
      <input type="text" id="csv-account-label" placeholder="e.g. Chase Checking, WF Visa">

      <label for="csv-file">CSV File</label>
      <input type="file" id="csv-file" accept=".csv">

      <button id="csv-upload-btn" onclick="uploadCsv()">Upload & Import</button>
    </div>
    <div id="csv-status" style="margin-top:12px;padding:12px;border-radius:6px;display:none"></div>
    <div class="csv-imports">
      <h3>Import History</h3>
      <div id="csv-imports-list">Loading…</div>
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
    }

    async function loadItems() {
      try {
        const res = await fetch('/api/items');
        const items = await res.json();
        if (!items.length) { itemsList.textContent = 'No institutions linked yet.'; return; }
        itemsList.innerHTML = items.map(i =>
          '<div class="item"><strong>' + i.institution_name + '</strong> — ' +
          i.accounts.length + ' account(s) — Status: ' + i.status + '</div>'
        ).join('');
      } catch { itemsList.textContent = 'Could not load items.'; }
    }

    async function startLink() {
      const res = await fetch('/api/create_link_token', { method: 'POST' });
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

      document.getElementById('csv-upload-btn').disabled = true;
      showCsvStatus('Importing…', true);

      try {
        const resp = await fetch('/api/import-csv', { method: 'POST', body: formData });
        const data = await resp.json();
        if (resp.ok) {
          showCsvStatus(
            'Imported ' + data.rows_imported + ' transactions (' + data.rows_skipped +
            ' skipped) — Format: ' + data.format_detected, true
          );
          loadCsvImports();
          loadItems();
        } else {
          showCsvStatus('Error: ' + data.error, false);
        }
      } catch (e) { showCsvStatus('Network error: ' + e.message, false); }
      document.getElementById('csv-upload-btn').disabled = false;
    }

    async function loadCsvImports() {
      const list = document.getElementById('csv-imports-list');
      try {
        const res = await fetch('/api/csv-imports');
        const imports = await res.json();
        if (!imports.length) { list.textContent = 'No CSV imports yet.'; return; }
        list.innerHTML = imports.map(i =>
          '<div class="csv-import-entry"><strong>' + i.institution + '</strong> — ' +
          i.account_label + ' — ' + i.rows_imported + ' rows — ' +
          new Date(i.imported_at).toLocaleDateString() + ' — <em>' + i.filename + '</em></div>'
        ).join('');
      } catch { list.textContent = 'Could not load import history.'; }
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
