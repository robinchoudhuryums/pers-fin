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
const multer = require("multer");
const { parse } = require("csv-parse/sync");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Plaid client setup
// ---------------------------------------------------------------------------
// Set PLAID_ENV=development in .env to use Development (requires Plaid
// approval).  Defaults to sandbox, which is free and needs no approval.
// Sandbox test credentials:  user_good / pass_good
const plaidEnv = (process.env.PLAID_ENV || "sandbox").toLowerCase();
const plaidConfig = new Configuration({
  basePath: plaidEnv === "development"
    ? PlaidEnvironments.development
    : PlaidEnvironments.sandbox,
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
      "PLAID-SECRET": plaidEnv === "development"
        ? process.env.PLAID_SECRET_DEV
        : process.env.PLAID_SECRET_SANDBOX,
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
