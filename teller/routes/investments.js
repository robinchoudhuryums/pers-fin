// ============================================================================
// Routes: Investment Accounts (Plaid holdings + Teller-linked + manual)
// ============================================================================
// Three sources contribute to the user's investment picture:
//   1. Plaid: full holdings sync (qty / cost basis / current value per security)
//      via /api/plaid/* endpoints below. Plaid syncs into investment_accounts
//      + investment_holdings.
//   2. Teller-linked: brokerage / IRA / 401k / HSA / 529 / etc. enrolled via
//      Teller Connect. They live in linked_accounts (the standard Teller
//      table) — the API returns account-level balance only; Teller's API
//      doesn't expose holdings or cost basis like Plaid does.
//   3. Manual: user-entered accounts via POST /api/investment-accounts (in
//      routes/goals.js). Stored in investment_accounts with no plaid_account_id.
//
// GET /api/investments below returns all three unified for dashboards/widgets.

const express = require("express");
const router = express.Router();
const { pool, ENCRYPTION_PASSPHRASE } = require("../services/database");
const { INVESTMENT_ACCOUNT_TYPES } = require("../services/financial-queries");

let PlaidApi, Configuration, PlaidEnvironments, Products, CountryCode;
try {
  const plaid = require("plaid");
  PlaidApi = plaid.PlaidApi;
  Configuration = plaid.Configuration;
  PlaidEnvironments = plaid.PlaidEnvironments;
  Products = plaid.Products;
  CountryCode = plaid.CountryCode;
} catch {
  PlaidApi = null;
}

function getPlaidClient() {
  if (!PlaidApi || !process.env.PLAID_CLIENT_ID) return null;
  const env = (process.env.PLAID_ENV || "sandbox").toLowerCase();
  const basePath = {
    production: PlaidEnvironments.production,
    development: PlaidEnvironments.development,
    sandbox: PlaidEnvironments.sandbox,
  }[env] || PlaidEnvironments.sandbox;
  const secret = {
    production: process.env.PLAID_SECRET_PROD,
    development: process.env.PLAID_SECRET_DEV,
    sandbox: process.env.PLAID_SECRET_SANDBOX,
  }[env] || process.env.PLAID_SECRET_SANDBOX;
  if (!secret) return null;
  const config = new Configuration({
    basePath,
    baseOptions: {
      headers: { "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID, "PLAID-SECRET": secret },
    },
  });
  return new PlaidApi(config);
}

// GET /api/plaid/status — check if Plaid is configured
router.get("/api/plaid/status", (_req, res) => {
  const client = getPlaidClient();
  res.json({
    configured: !!client,
    environment: process.env.PLAID_ENV || "sandbox",
  });
});

// POST /api/plaid/link-token — create a Plaid Link token for investments
router.post("/api/plaid/link-token", async (_req, res) => {
  const client = getPlaidClient();
  if (!client) return res.status(501).json({ error: "Plaid not configured. Set PLAID_CLIENT_ID and PLAID_SECRET." });
  try {
    const response = await client.linkTokenCreate({
      user: { client_user_id: "perfin-user-1" },
      client_name: "Perfin",
      products: [Products.Investments],
      country_codes: [CountryCode.Us],
      language: "en",
    });
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error("Plaid link token error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to create Plaid link token" });
  }
});

// =========================================================================
// Plaid Transactions — link, exchange, sync for banks Teller doesn't cover
// =========================================================================
// Uses the existing `plaid_items` + `sync_cursors` + `linked_accounts`
// schema that was scaffolded at project inception. Transactions land in the
// same `transactions` table as Teller-synced ones, so the entire dashboard,
// budget, AI insights, and Sheets pipeline works without changes.

// POST /api/plaid/link-token-transactions — create a link token scoped to
// the Transactions product (separate from the Investments link).
router.post("/api/plaid/link-token-transactions", async (_req, res) => {
  const client = getPlaidClient();
  if (!client) return res.status(501).json({ error: "Plaid not configured." });
  try {
    const response = await client.linkTokenCreate({
      user: { client_user_id: "perfin-user-1" },
      client_name: "Perfin",
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: "en",
    });
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error("Plaid link-token-transactions error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to create Plaid link token" });
  }
});

// POST /api/plaid/exchange-transactions — exchange public token after the
// user authenticates in Plaid Link, store the item in `plaid_items`, fetch
// accounts and store in `linked_accounts` with `plaid_item_id` set.
router.post("/api/plaid/exchange-transactions", async (req, res) => {
  const { public_token, institution } = req.body;
  if (!public_token) return res.status(400).json({ error: "public_token required" });
  const client = getPlaidClient();
  if (!client) return res.status(501).json({ error: "Plaid not configured." });

  try {
    const exchangeRes = await client.itemPublicTokenExchange({ public_token });
    const accessToken = exchangeRes.data.access_token;
    const itemId = exchangeRes.data.item_id;

    // Store the Plaid item (reuses the existing plaid_items table)
    const itemRow = await pool.query(
      `INSERT INTO plaid_items (item_id, institution_id, institution_name, access_token_enc)
       VALUES ($1, $2, $3, pgp_sym_encrypt($4, $5))
       ON CONFLICT (item_id) DO UPDATE SET
         access_token_enc = pgp_sym_encrypt($4, $5),
         institution_name = $3,
         updated_at = now()
       RETURNING id`,
      [itemId, institution?.institution_id || null, institution?.name || "Unknown",
       accessToken, ENCRYPTION_PASSPHRASE]
    );
    const plaidItemDbId = itemRow.rows[0].id;

    // Initialize the sync cursor for cursor-based transactionsSync
    await pool.query(
      `INSERT INTO sync_cursors (plaid_item_id, cursor)
       VALUES ($1, '')
       ON CONFLICT (plaid_item_id) DO NOTHING`,
      [plaidItemDbId]
    );

    // Fetch accounts and store in linked_accounts
    const acctRes = await client.accountsGet({ access_token: accessToken });
    let linked = 0;
    for (const acct of acctRes.data.accounts) {
      await pool.query(
        `INSERT INTO linked_accounts (plaid_item_id, account_id, name, official_name, type, subtype, mask)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (account_id) DO UPDATE SET
           name = EXCLUDED.name,
           official_name = EXCLUDED.official_name,
           type = EXCLUDED.type,
           subtype = EXCLUDED.subtype,
           plaid_item_id = EXCLUDED.plaid_item_id`,
        [plaidItemDbId, acct.account_id, acct.name, acct.official_name || null,
         acct.type, acct.subtype || null, acct.mask || null]
      );
      linked++;
    }

    // Run initial transaction sync immediately
    const syncResult = await syncPlaidItemTransactions(client, plaidItemDbId, accessToken);

    res.json({
      ok: true,
      item_id: itemId,
      institution: institution?.name || "Unknown",
      accounts_linked: linked,
      transactions_added: syncResult.added,
    });
  } catch (err) {
    console.error("Plaid exchange-transactions error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to exchange token: " + (err.response?.data?.error_message || err.message) });
  }
});

// Core sync helper: cursor-based transactionsSync for one Plaid item.
// Plaid's transactionsSync returns added/modified/removed transaction sets
// and a new cursor. We loop until `has_more` is false, upserting into our
// `transactions` table.
//
// Plaid amount convention: positive = money leaving account (debit),
// negative = money entering (credit). This matches our convention directly
// (no sign flip needed, unlike Teller which is inverted).
async function syncPlaidItemTransactions(client, plaidItemDbId, accessToken) {
  // Read the current cursor
  const cursorRow = await pool.query(
    "SELECT cursor FROM sync_cursors WHERE plaid_item_id = $1",
    [plaidItemDbId]
  );
  let cursor = cursorRow.rows[0]?.cursor || "";
  let totalAdded = 0;
  let totalModified = 0;
  let totalRemoved = 0;
  let hasMore = true;
  let pages = 0;
  const MAX_PAGES = 20;

  while (hasMore && pages < MAX_PAGES) {
    pages++;
    const syncRes = await client.transactionsSync({
      access_token: accessToken,
      cursor: cursor,
      count: 500,
    });
    const data = syncRes.data;

    // Process added transactions
    for (const txn of data.added || []) {
      if (txn.pending) continue;
      try {
        await pool.query(
          `INSERT INTO transactions (account_id, transaction_id, amount, iso_currency_code, date,
                                     merchant_name, name, category, pending, personal_finance_category)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9)
           ON CONFLICT (transaction_id)
           DO UPDATE SET
             amount = EXCLUDED.amount,
             date = EXCLUDED.date,
             merchant_name = EXCLUDED.merchant_name,
             name = EXCLUDED.name,
             category = EXCLUDED.category,
             pending = EXCLUDED.pending,
             personal_finance_category = EXCLUDED.personal_finance_category`,
          [
            txn.account_id,
            txn.transaction_id,
            txn.amount,
            txn.iso_currency_code || "USD",
            txn.date,
            txn.merchant_name || null,
            txn.name || "",
            txn.category ? `{${txn.category.join(",")}}` : null,
            txn.personal_finance_category ? JSON.stringify(txn.personal_finance_category) : null,
          ]
        );
        totalAdded++;
      } catch (err) {
        console.error("Plaid txn insert error:", err.message, txn.transaction_id);
      }
    }

    // Process modified transactions (same upsert — ON CONFLICT handles it)
    for (const txn of data.modified || []) {
      if (txn.pending) continue;
      try {
        await pool.query(
          `UPDATE transactions SET
             amount = $1, date = $2, merchant_name = $3, name = $4,
             category = $5, personal_finance_category = $6
           WHERE transaction_id = $7`,
          [
            txn.amount, txn.date, txn.merchant_name || null, txn.name || "",
            txn.category ? `{${txn.category.join(",")}}` : null,
            txn.personal_finance_category ? JSON.stringify(txn.personal_finance_category) : null,
            txn.transaction_id,
          ]
        );
        totalModified++;
      } catch (err) {
        console.error("Plaid txn update error:", err.message, txn.transaction_id);
      }
    }

    // Process removed transactions
    for (const txn of data.removed || []) {
      try {
        await pool.query("DELETE FROM transactions WHERE transaction_id = $1", [txn.transaction_id]);
        totalRemoved++;
      } catch (err) {
        console.error("Plaid txn delete error:", err.message, txn.transaction_id);
      }
    }

    cursor = data.next_cursor;
    hasMore = data.has_more;
  }

  // Persist the new cursor
  await pool.query(
    `UPDATE sync_cursors SET cursor = $1, last_synced_at = now() WHERE plaid_item_id = $2`,
    [cursor, plaidItemDbId]
  );

  return { added: totalAdded, modified: totalModified, removed: totalRemoved };
}

// POST /api/plaid/sync-transactions — sync transactions for all Plaid items
router.post("/api/plaid/sync-transactions", async (_req, res) => {
  const client = getPlaidClient();
  if (!client) return res.status(501).json({ error: "Plaid not configured." });
  try {
    const result = await syncAllPlaidTransactions();
    res.json(result);
  } catch (err) {
    console.error("Plaid sync-transactions error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// Helper: sync all Plaid items' transactions. Called by the endpoint above
// and by the bank auto-sync scheduler.
async function syncAllPlaidTransactions() {
  const client = getPlaidClient();
  if (!client) return { ok: false, error: "Plaid not configured" };

  const items = await pool.query(
    `SELECT pi.id, pi.item_id, pi.institution_name,
            pgp_sym_decrypt(pi.access_token_enc, $1) AS access_token
     FROM plaid_items pi
     WHERE pi.status = 'GOOD'`,
    [ENCRYPTION_PASSPHRASE]
  );

  let totalAdded = 0;
  let totalModified = 0;
  let totalRemoved = 0;
  const errors = [];

  for (const item of items.rows) {
    if (!item.access_token) {
      errors.push({ institution: item.institution_name, error: "decryption_failed" });
      continue;
    }
    try {
      const result = await syncPlaidItemTransactions(client, item.id, item.access_token);
      totalAdded += result.added;
      totalModified += result.modified;
      totalRemoved += result.removed;

      // Update balance snapshots for linked accounts under this item
      const accts = await pool.query(
        "SELECT id, account_id FROM linked_accounts WHERE plaid_item_id = $1",
        [item.id]
      );
      try {
        const balRes = await client.accountsGet({ access_token: item.access_token });
        for (const ba of balRes.data.accounts) {
          const la = accts.rows.find(a => a.account_id === ba.account_id);
          if (!la) continue;
          const bal = ba.balances?.current ?? ba.balances?.available ?? null;
          if (bal !== null) {
            await pool.query(
              `UPDATE linked_accounts SET
                 current_balance = $1, available_balance = $2, balance_updated_at = now()
               WHERE id = $3`,
              [ba.balances.current, ba.balances.available, la.id]
            );
            await pool.query(
              `INSERT INTO account_balance_snapshots (source, source_id, snapshot_date, balance, current_balance, available_balance)
               VALUES ('linked', $1, CURRENT_DATE, $2, $3, $4)
               ON CONFLICT (source, source_id, snapshot_date) DO UPDATE SET
                 balance = EXCLUDED.balance, current_balance = EXCLUDED.current_balance,
                 available_balance = EXCLUDED.available_balance`,
              [la.id, ba.balances.current ?? ba.balances.available, ba.balances.current, ba.balances.available]
            ).catch(e => console.error("Plaid balance snapshot error:", e.message));
          }
        }
      } catch (balErr) {
        console.error("Plaid balance update error for", item.institution_name, ":", balErr.message);
      }
    } catch (err) {
      console.error("Plaid sync error for", item.institution_name, ":", err.response?.data?.error_message || err.message);
      errors.push({ institution: item.institution_name, error: err.response?.data?.error_message || err.message });
    }
  }

  return {
    ok: true,
    items_synced: items.rows.length - errors.length,
    transactions_added: totalAdded,
    transactions_modified: totalModified,
    transactions_removed: totalRemoved,
    errors: errors.length > 0 ? errors : undefined,
  };
}

module.exports.syncAllPlaidTransactions = syncAllPlaidTransactions;

// POST /api/plaid/exchange — exchange public token and store investment accounts
router.post("/api/plaid/exchange", async (req, res) => {
  const { public_token, institution } = req.body;
  if (!public_token) return res.status(400).json({ error: "public_token is required" });
  const client = getPlaidClient();
  if (!client) return res.status(501).json({ error: "Plaid not configured." });

  try {
    const exchangeRes = await client.itemPublicTokenExchange({ public_token });
    const accessToken = exchangeRes.data.access_token;
    const itemId = exchangeRes.data.item_id;

    // Store the Plaid item
    await pool.query(
      `INSERT INTO plaid_investment_items (item_id, institution_name, access_token_enc)
       VALUES ($1, $2, pgp_sym_encrypt($3, $4))
       ON CONFLICT (item_id) DO UPDATE SET
         access_token_enc = pgp_sym_encrypt($3, $4),
         institution_name = $2,
         updated_at = now()`,
      [itemId, institution?.name || "Unknown", accessToken, ENCRYPTION_PASSPHRASE]
    );

    // Fetch initial holdings
    const holdingsRes = await client.investmentsHoldingsGet({ access_token: accessToken });
    const accounts = holdingsRes.data.accounts || [];
    const holdings = holdingsRes.data.holdings || [];
    const securities = holdingsRes.data.securities || [];

    // Build security lookup
    const secMap = {};
    for (const s of securities) secMap[s.security_id] = s;

    // Store accounts and holdings
    let stored = 0;
    for (const acct of accounts) {
      if (acct.type !== "investment") continue;
      // Upsert into investment_accounts
      const balance = acct.balances?.current || 0;
      await pool.query(
        `INSERT INTO investment_accounts (name, institution, account_type, balance, notes, plaid_account_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (plaid_account_id) DO UPDATE SET
           balance = $4, name = $1, updated_at = now()`,
        [
          acct.official_name || acct.name,
          institution?.name || "Unknown",
          acct.subtype || "brokerage",
          balance,
          null,
          acct.account_id,
        ]
      );
      stored++;
    }

    // Store holdings
    for (const h of holdings) {
      const sec = secMap[h.security_id] || {};
      await pool.query(
        `INSERT INTO investment_holdings (plaid_account_id, security_id, ticker, name,
          quantity, cost_basis, current_value, security_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (plaid_account_id, security_id) DO UPDATE SET
           quantity = $5, cost_basis = $6, current_value = $7, name = $4, ticker = $3, updated_at = now()`,
        [
          h.account_id,
          h.security_id,
          sec.ticker_symbol || null,
          sec.name || "Unknown",
          h.quantity,
          h.cost_basis || 0,
          h.institution_value || (sec.close_price ? h.quantity * sec.close_price : null),
          sec.type || "unknown",
        ]
      );
    }

    res.json({
      item_id: itemId,
      accounts_stored: stored,
      holdings_stored: holdings.length,
    });
  } catch (err) {
    console.error("Plaid exchange error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to exchange token" });
  }
});

// POST /api/plaid/sync-holdings — refresh investment holdings
router.post("/api/plaid/sync-holdings", async (_req, res) => {
  const client = getPlaidClient();
  if (!client) return res.status(501).json({ error: "Plaid not configured." });
  try {
    const items = await pool.query(
      `SELECT item_id, institution_name,
              pgp_sym_decrypt(access_token_enc, $1) AS access_token
       FROM plaid_investment_items`,
      [ENCRYPTION_PASSPHRASE]
    );

    let totalAccounts = 0, totalHoldings = 0;
    const errors = [];
    // Buffer per-account snapshot tuples and flush as a single batched INSERT
    // after the loop. Each snapshot used to be its own query with a swallowed
    // .catch(), so a mid-sync DB blip could leave a partial set of snapshots
    // for one day — showing a phantom spike or drop on the history chart.
    // A single INSERT … VALUES ($1, $2, …), ($n, $n+1, …) is atomic in
    // Postgres: either all of today's snapshots land or none do.
    const snapshotRows = [];
    for (const item of items.rows) {
      try {
        // pgp_sym_decrypt returns NULL when the passphrase is wrong (or empty)
        // instead of throwing — without this check the route used to call
        // Plaid with `access_token: null`, which Plaid 400s on, get caught
        // below, and ultimately return 200 with `accounts_updated: 0` and no
        // surface on the failure. Now we record a structured error per item.
        if (!item.access_token) {
          const msg = `Could not decrypt access token for ${item.institution_name} — check TOKEN_ENCRYPTION_PASSPHRASE`;
          console.error(msg);
          errors.push({ institution: item.institution_name, error: "decryption_failed" });
          continue;
        }
        const holdingsRes = await client.investmentsHoldingsGet({ access_token: item.access_token });
        const accounts = holdingsRes.data.accounts || [];
        const holdings = holdingsRes.data.holdings || [];
        const securities = holdingsRes.data.securities || [];
        const secMap = {};
        for (const s of securities) secMap[s.security_id] = s;

        for (const acct of accounts) {
          if (acct.type !== "investment") continue;
          const balance = acct.balances?.current || 0;
          // RETURNING the investment_accounts.id so the snapshot below can
          // attribute history to the right account (we key by plaid_account_id
          // here but the snapshot table uses the local SERIAL id).
          const updRes = await pool.query(
            `UPDATE investment_accounts SET balance = $1, updated_at = now()
             WHERE plaid_account_id = $2
             RETURNING id`,
            [balance, acct.account_id]
          );
          totalAccounts++;
          const invAcctId = updRes.rows[0]?.id;
          if (invAcctId) {
            snapshotRows.push({ invAcctId, balance });
          }
        }

        // Batch upsert holdings (instead of one query per holding)
        if (holdings.length > 0) {
          const placeholders = [];
          const values = [];
          let idx = 1;
          for (const h of holdings) {
            const sec = secMap[h.security_id] || {};
            placeholders.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
            values.push(
              h.account_id, h.security_id,
              sec.ticker_symbol || null, sec.name || "Unknown",
              h.quantity, h.cost_basis || 0,
              h.institution_value || (sec.close_price ? h.quantity * sec.close_price : null),
              sec.type || "unknown",
            );
          }
          await pool.query(
            `INSERT INTO investment_holdings (plaid_account_id, security_id, ticker, name,
              quantity, cost_basis, current_value, security_type)
             VALUES ${placeholders.join(", ")}
             ON CONFLICT (plaid_account_id, security_id) DO UPDATE SET
               quantity = EXCLUDED.quantity, cost_basis = EXCLUDED.cost_basis,
               current_value = EXCLUDED.current_value, ticker = EXCLUDED.ticker,
               name = EXCLUDED.name, updated_at = now()`,
            values
          );
          totalHoldings += holdings.length;
        }
      } catch (err) {
        console.error("Holdings sync error for " + item.institution_name + ":", err.message);
        errors.push({ institution: item.institution_name, error: err.message });
      }
    }

    // Atomic snapshot flush — single multi-row INSERT, all rows succeed or
    // all fail. ON CONFLICT DO UPDATE keeps the same-date upsert semantics
    // the per-row inserts had.
    if (snapshotRows.length > 0) {
      try {
        const placeholders = [];
        const values = [];
        let idx = 1;
        for (const s of snapshotRows) {
          placeholders.push(`('investment', $${idx++}, CURRENT_DATE, $${idx++})`);
          values.push(s.invAcctId, s.balance);
        }
        await pool.query(
          `INSERT INTO account_balance_snapshots (source, source_id, snapshot_date, balance)
           VALUES ${placeholders.join(", ")}
           ON CONFLICT (source, source_id, snapshot_date) DO UPDATE SET balance = EXCLUDED.balance`,
          values
        );
      } catch (err) {
        console.error("Balance snapshot batched insert (plaid) error:", err.message);
        errors.push({ stage: "balance_snapshot", error: err.message });
      }
    }

    res.json({
      accounts_updated: totalAccounts,
      holdings_updated: totalHoldings,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/plaid/holdings — list investment holdings
router.get("/api/plaid/holdings", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT h.*, ia.name AS account_name, ia.institution
       FROM investment_holdings h
       JOIN investment_accounts ia ON ia.plaid_account_id = h.plaid_account_id
       WHERE ia.is_active = true
       ORDER BY h.current_value DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/investments — Unified investment-account list across all three
// sources (Teller-linked, manual, Plaid). Each row has a `source` field so
// callers can branch on capabilities — only Plaid rows have an associated
// `holdings` array; Teller and manual rows expose account-level balance
// only.
//
// Response shape:
//   {
//     total_value: number,                   // sum across all sources
//     by_source: { teller, manual, plaid },  // per-source totals
//     accounts: [{
//       source: "teller" | "manual" | "plaid",
//       id: number,                          // primary key in source table
//       name: string,
//       institution: string | null,
//       account_type: string,                // brokerage / ira / 401k / etc.
//       balance: number,
//       supports_holdings: boolean,          // only true for Plaid rows
//       account_id?: string,                 // Teller account id (linked_accounts.account_id)
//       balance_updated_at?: string,
//     }, ...]
//   }
router.get("/api/investments", async (_req, res) => {
  try {
    const [teller, investments] = await Promise.all([
      pool.query(
        `SELECT la.id, la.account_id, la.name, la.type, la.subtype,
                COALESCE(la.available_balance, la.current_balance, 0) AS balance,
                la.balance_updated_at,
                COALESCE(te.institution_name, la.institution_name_manual) AS institution_name
         FROM linked_accounts la
         LEFT JOIN teller_enrollments te ON te.id = la.teller_enrollment_id
         WHERE ${INVESTMENT_ACCOUNT_TYPES}
         ORDER BY balance DESC`
      ),
      pool.query(
        `SELECT id, name, institution, account_type, balance, plaid_account_id, updated_at
         FROM investment_accounts
         WHERE is_active = true
         ORDER BY balance DESC`
      ),
    ]);

    const accounts = [];

    for (const r of teller.rows) {
      accounts.push({
        source: "teller",
        id: r.id,
        account_id: r.account_id,
        name: r.name,
        institution: r.institution_name,
        account_type: r.subtype || r.type || "investment",
        balance: parseFloat(r.balance),
        balance_updated_at: r.balance_updated_at,
        supports_holdings: false,
      });
    }
    for (const r of investments.rows) {
      const plaidLinked = !!r.plaid_account_id;
      accounts.push({
        source: plaidLinked ? "plaid" : "manual",
        id: r.id,
        name: r.name,
        institution: r.institution,
        account_type: r.account_type,
        balance: parseFloat(r.balance),
        balance_updated_at: r.updated_at,
        supports_holdings: plaidLinked,
      });
    }

    const by_source = { teller: 0, manual: 0, plaid: 0 };
    for (const a of accounts) by_source[a.source] += a.balance;
    const total_value = by_source.teller + by_source.manual + by_source.plaid;

    res.json({
      total_value: Math.round(total_value * 100) / 100,
      by_source: {
        teller: Math.round(by_source.teller * 100) / 100,
        manual: Math.round(by_source.manual * 100) / 100,
        plaid: Math.round(by_source.plaid * 100) / 100,
      },
      accounts: accounts.sort((a, b) => b.balance - a.balance),
    });
  } catch (err) {
    console.error("investments unified list error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/investments/performance — aggregate returns + asset allocation
//
// Pulls from `investment_holdings` (only Plaid-linked holdings have cost
// basis + current value at the security level — Teller-linked investments
// are account-balance-only and have no return-per-security data).
//
// Response:
//   {
//     total_value, total_cost_basis, total_return, total_return_pct,
//     holdings_count, accounts_count,
//     by_asset_class: [
//       { security_type, value, cost_basis, return, return_pct, pct_of_portfolio }, ...
//     ],
//     top_winners: [{ name, ticker, value, cost_basis, return, return_pct }, ...] (top 5),
//     top_losers:  [{ ... }, ...] (top 5),
//   }
//
// Auto-hides on the dashboard when total_value === 0 (no Plaid holdings).
router.get("/api/investments/performance", async (_req, res) => {
  try {
    const [holdings, targetsRow] = await Promise.all([
      pool.query(
        `SELECT h.name, h.ticker, h.quantity, h.cost_basis, h.current_value,
                h.security_type, h.plaid_account_id, ia.name AS account_name
         FROM investment_holdings h
         LEFT JOIN investment_accounts ia ON ia.plaid_account_id = h.plaid_account_id
         WHERE COALESCE(ia.is_active, true) = true`
      ),
      // #8: user-configured target allocation per asset class (security_type).
      // JSONB defaults to '{}'::jsonb so this never errors; empty object → no
      // target_pct/drift_pct fields on the response.
      pool.query("SELECT target_allocation_pct FROM user_settings WHERE id = 1")
        .catch(() => ({ rows: [{ target_allocation_pct: {} }] })),
    ]);
    let targets = targetsRow.rows[0]?.target_allocation_pct || {};
    if (typeof targets === "string") {
      try { targets = JSON.parse(targets); } catch { targets = {}; }
    }
    // Normalize keys to lowercase to match the by-asset-class keys we build
    // below (which lowercase security_type). Numbers cast through Number()
    // so a string "70" still works.
    const targetMap = {};
    for (const [k, v] of Object.entries(targets || {})) {
      const n = Number(v);
      if (Number.isFinite(n)) targetMap[String(k).toLowerCase()] = n;
    }
    const hasTargets = Object.keys(targetMap).length > 0;

    let totalValue = 0;
    let totalCostBasis = 0;
    const byClass = {};
    const enrichedHoldings = [];

    for (const h of holdings.rows) {
      const value = parseFloat(h.current_value || 0);
      const cost = parseFloat(h.cost_basis || 0);
      const ret = value - cost;
      const retPct = cost > 0 ? (ret / cost) * 100 : null;
      totalValue += value;
      totalCostBasis += cost;
      const cls = (h.security_type || "unknown").toLowerCase();
      if (!byClass[cls]) byClass[cls] = { security_type: cls, value: 0, cost_basis: 0 };
      byClass[cls].value += value;
      byClass[cls].cost_basis += cost;
      enrichedHoldings.push({
        name: h.name,
        ticker: h.ticker,
        account_name: h.account_name,
        value,
        cost_basis: cost,
        return: ret,
        return_pct: retPct,
      });
    }

    const totalReturn = totalValue - totalCostBasis;
    const totalReturnPct = totalCostBasis > 0 ? (totalReturn / totalCostBasis) * 100 : null;

    const byAssetClass = Object.values(byClass).map(c => {
      const ret = c.value - c.cost_basis;
      const retPct = c.cost_basis > 0 ? (ret / c.cost_basis) * 100 : null;
      const pctOfPortfolio = totalValue > 0 ? (c.value / totalValue) * 100 : 0;
      const row = {
        security_type: c.security_type,
        value: c.value,
        cost_basis: c.cost_basis,
        return: ret,
        return_pct: retPct,
        pct_of_portfolio: pctOfPortfolio,
      };
      // #8: attach target_pct + drift_pct when the user has configured a
      // target allocation. drift = actual − target (positive = overweight).
      if (hasTargets) {
        const target = targetMap[c.security_type];
        if (Number.isFinite(target)) {
          row.target_pct = target;
          row.drift_pct = pctOfPortfolio - target;
        }
      }
      return row;
    }).sort((a, b) => b.value - a.value);

    // #8: surface asset classes the user wants exposure to but currently
    // holds none of (zero-weight in actual portfolio). These need their own
    // rows since the loop above only iterates classes present in holdings.
    if (hasTargets) {
      const presentClasses = new Set(byAssetClass.map(c => c.security_type));
      for (const [cls, target] of Object.entries(targetMap)) {
        if (!presentClasses.has(cls)) {
          byAssetClass.push({
            security_type: cls,
            value: 0,
            cost_basis: 0,
            return: 0,
            return_pct: null,
            pct_of_portfolio: 0,
            target_pct: target,
            drift_pct: -target,  // underweight by the full target
          });
        }
      }
    }

    // Sort holdings by return_pct, filter to those with valid (non-null) pct
    const withPct = enrichedHoldings.filter(h => h.return_pct !== null);
    const topWinners = withPct.slice().sort((a, b) => b.return_pct - a.return_pct).slice(0, 5);
    const topLosers  = withPct.slice().sort((a, b) => a.return_pct - b.return_pct).slice(0, 5);

    // Distinct account count
    const accountIds = new Set();
    for (const h of holdings.rows) if (h.plaid_account_id) accountIds.add(h.plaid_account_id);

    res.json({
      total_value: totalValue,
      total_cost_basis: totalCostBasis,
      total_return: totalReturn,
      total_return_pct: totalReturnPct,
      holdings_count: holdings.rows.length,
      accounts_count: accountIds.size,
      by_asset_class: byAssetClass,
      top_winners: topWinners,
      top_losers: topLosers,
    });
  } catch (err) {
    console.error("Investment performance error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

module.exports = router;
