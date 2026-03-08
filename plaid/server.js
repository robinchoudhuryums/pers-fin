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
const { Pool } = require("pg");
const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require("plaid");

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
  </style>
</head>
<body>
  <h1>Subscription Tracker</h1>
  <p>Link a financial institution to start tracking recurring charges.</p>
  <button id="link-btn" disabled>Loading…</button>
  <div id="status"></div>
  <div id="items"><h3>Linked Institutions</h3><div id="items-list">Loading…</div></div>

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

    // Initialize
    linkBtn.textContent = 'Link an Account';
    linkBtn.disabled = false;
    linkBtn.addEventListener('click', startLink);
    loadItems();
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
