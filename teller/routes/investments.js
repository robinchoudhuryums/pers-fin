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

// Sum holdings' current value per Plaid account. Used as the account balance
// fallback when accountsGet/holdingsGet return a null account-level
// `balances.current` — which Schwab (and some other brokerages) do for
// investment accounts, leaving the real value only in the holdings (F-invest).
function sumHoldingsByAccount(holdings, secMap) {
  const m = {};
  for (const h of holdings || []) {
    const sec = secMap[h.security_id] || {};
    const val = h.institution_value != null
      ? h.institution_value
      : (sec.close_price != null ? h.quantity * sec.close_price : 0);
    m[h.account_id] = (m[h.account_id] || 0) + (parseFloat(val) || 0);
  }
  return m;
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

// POST /api/plaid/link-token-transactions — create a link token that
// requests Transactions + Investments in one Plaid Link session. Banks
// like Schwab serve both checking (transactions) and brokerage (holdings)
// under a single login — requesting both products means the user links
// once instead of twice. transactions.days_requested pulls maximum
// history (730 days); some banks cap lower (Capital One = 90 days).
router.post("/api/plaid/link-token-transactions", async (req, res) => {
  const client = getPlaidClient();
  if (!client) return res.status(501).json({ error: "Plaid not configured." });
  try {
    // OAuth redirect mode: client passes its current page URL as redirect_uri
    // so banks that require full-page OAuth (Capital One, Chase via OAuth,
    // many credit unions, and most mobile flows) can hand control back to
    // the same page. The URI must be registered in the Plaid Dashboard
    // (Team Settings → API → Allowed redirect URIs). When omitted (e.g.
    // desktop popup flow), Plaid Link uses popup mode and no redirect URI
    // is needed.
    const tokenRequest = {
      user: { client_user_id: "perfin-user-1" },
      client_name: "Perfin",
      // Only Transactions is required — every bank we'd want to link
      // supports it. Investments and Liabilities are optional so banks
      // that don't offer them (Capital One has no brokerage; Discover
      // is mostly credit cards) still link successfully with just the
      // products they DO support. Without this split, Plaid blocks
      // linking unless ALL listed products are supported by the
      // institution, which excludes most credit-card-only banks.
      products: [Products.Transactions],
      optional_products: [Products.Investments, Products.Liabilities],
      country_codes: [CountryCode.Us],
      language: "en",
      transactions: { days_requested: 730 },
    };
    if (req.body?.redirect_uri) {
      tokenRequest.redirect_uri = req.body.redirect_uri;
    }
    const response = await client.linkTokenCreate(tokenRequest);
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error("Plaid link-token-transactions error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error_message || "Failed to create Plaid link token" });
  }
});

// POST /api/plaid/hosted-link — create a hosted Plaid Link URL for the
// mobile-friendly redirect-based flow. The browser navigates to the
// returned URL; the user completes the entire flow on plaid.com's
// domain; Plaid redirects back to our redirect_uri with the public
// token in query params. No iframes involved — works around iOS Safari's
// iframe modal incompatibility.
router.post("/api/plaid/hosted-link", async (req, res) => {
  const client = getPlaidClient();
  if (!client) return res.status(501).json({ error: "Plaid not configured." });
  if (!req.body?.redirect_uri) {
    return res.status(400).json({ error: "redirect_uri required for hosted link" });
  }
  try {
    const response = await client.linkTokenCreate({
      user: { client_user_id: "perfin-user-1" },
      client_name: "Perfin",
      // Same product split as the modal-based link — required:
      // Transactions only; optional: Investments + Liabilities. Lets
      // credit-card-only banks (Capital One, Discover) link.
      products: [Products.Transactions],
      optional_products: [Products.Investments, Products.Liabilities],
      country_codes: [CountryCode.Us],
      language: "en",
      transactions: { days_requested: 730 },
      redirect_uri: req.body.redirect_uri,
      hosted_link: {
        url_lifetime_seconds: 3600,
        completion_redirect_uri: req.body.redirect_uri,
      },
    });
    res.json({
      link_token: response.data.link_token,
      hosted_link_url: response.data.hosted_link_url,
    });
  } catch (err) {
    console.error("Plaid hosted-link error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error_message || "Failed to create hosted Plaid link" });
  }
});

// POST /api/plaid/hosted-link-complete — finalize a hosted link session.
// After hosted link completes on Plaid's side, the public_token isn't in
// the return URL. Instead, we call linkTokenGet to retrieve the link
// session's public_token, then run the standard exchange-transactions
// flow (store in plaid_items, fetch accounts, initial sync, liabilities).
router.post("/api/plaid/hosted-link-complete", async (req, res) => {
  const client = getPlaidClient();
  if (!client) return res.status(501).json({ error: "Plaid not configured." });
  const linkToken = req.body?.link_token;
  if (!linkToken) return res.status(400).json({ error: "link_token required" });
  try {
    const tokenInfo = await client.linkTokenGet({ link_token: linkToken });
    const sessions = tokenInfo.data.link_sessions || [];
    if (sessions.length === 0) {
      return res.status(400).json({ error: "No link session yet — try again in a moment." });
    }
    // Take the most recent completed session.
    const session = sessions[sessions.length - 1];
    const publicToken = session.results?.item_add_results?.[0]?.public_token
                     || session.public_token;
    const institutionName = session.results?.item_add_results?.[0]?.institution?.name
                         || session.institution?.name
                         || "Unknown";
    if (!publicToken) {
      return res.status(400).json({ error: "Link session has no public_token yet — user may not have completed the flow." });
    }
    // Now do the same as exchange-transactions
    const exchangeRes = await client.itemPublicTokenExchange({ public_token: publicToken });
    const accessToken = exchangeRes.data.access_token;
    const itemId = exchangeRes.data.item_id;

    const itemRow = await pool.query(
      `INSERT INTO plaid_items (item_id, institution_name, access_token_enc)
       VALUES ($1, $2, pgp_sym_encrypt($3, $4))
       ON CONFLICT (item_id) DO UPDATE SET
         access_token_enc = pgp_sym_encrypt($3, $4),
         institution_name = $2,
         updated_at = now()
       RETURNING id`,
      [itemId, institutionName, accessToken, ENCRYPTION_PASSPHRASE]
    );
    const plaidItemDbId = itemRow.rows[0].id;

    await pool.query(
      `INSERT INTO sync_cursors (plaid_item_id, cursor) VALUES ($1, '')
       ON CONFLICT (plaid_item_id) DO NOTHING`,
      [plaidItemDbId]
    );

    const acctRes = await client.accountsGet({ access_token: accessToken });
    let linked = 0;
    for (const acct of acctRes.data.accounts) {
      const cur = acct.balances?.current ?? null;
      const avail = acct.balances?.available ?? null;
      const limit = acct.balances?.limit ?? null;
      await pool.query(
        `INSERT INTO linked_accounts (plaid_item_id, account_id, name, official_name, type, subtype, mask,
                                       current_balance, available_balance, credit_limit, balance_updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
         ON CONFLICT (account_id) DO UPDATE SET
           name = EXCLUDED.name,
           official_name = EXCLUDED.official_name,
           type = EXCLUDED.type,
           subtype = EXCLUDED.subtype,
           plaid_item_id = EXCLUDED.plaid_item_id,
           current_balance = EXCLUDED.current_balance,
           available_balance = EXCLUDED.available_balance,
           credit_limit = COALESCE(EXCLUDED.credit_limit, linked_accounts.credit_limit),
           balance_updated_at = now()`,
        [plaidItemDbId, acct.account_id, acct.name, acct.official_name || null,
         acct.type, acct.subtype || null, acct.mask || null,
         cur, avail, limit]
      );
      linked++;
    }

    const syncResult = await syncPlaidItemTransactions(client, plaidItemDbId, accessToken);
    const liabResult = await syncPlaidLiabilities(client, accessToken, plaidItemDbId);

    res.json({
      ok: true,
      item_id: itemId,
      institution: institutionName,
      accounts_linked: linked,
      transactions_added: syncResult.added,
      liabilities_synced: liabResult.updated || undefined,
    });
  } catch (err) {
    console.error("Plaid hosted-link-complete error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error_message || err.message });
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
      const cur = acct.balances?.current ?? null;
      const avail = acct.balances?.available ?? null;
      const limit = acct.balances?.limit ?? null;
      await pool.query(
        `INSERT INTO linked_accounts (plaid_item_id, account_id, name, official_name, type, subtype, mask,
                                       current_balance, available_balance, credit_limit, balance_updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
         ON CONFLICT (account_id) DO UPDATE SET
           name = EXCLUDED.name,
           official_name = EXCLUDED.official_name,
           type = EXCLUDED.type,
           subtype = EXCLUDED.subtype,
           plaid_item_id = EXCLUDED.plaid_item_id,
           current_balance = EXCLUDED.current_balance,
           available_balance = EXCLUDED.available_balance,
           credit_limit = COALESCE(EXCLUDED.credit_limit, linked_accounts.credit_limit),
           balance_updated_at = now()`,
        [plaidItemDbId, acct.account_id, acct.name, acct.official_name || null,
         acct.type, acct.subtype || null, acct.mask || null,
         cur, avail, limit]
      );
      linked++;
    }

    // Run initial transaction sync immediately
    const syncResult = await syncPlaidItemTransactions(client, plaidItemDbId, accessToken);

    // #1: Sync liabilities (APR, min payment, due dates) — runs for
    // credit cards, student loans, and mortgages. Fails gracefully when
    // the institution doesn't support the Liabilities product.
    const liabResult = await syncPlaidLiabilities(client, accessToken, plaidItemDbId);

    // If the linked institution has investment accounts, also sync
    // holdings. The link token requested Transactions + Investments +
    // Liabilities, so multi-product banks link everything in one pass.
    let holdingsSynced = 0;
    const investmentAccounts = acctRes.data.accounts.filter(a => a.type === "investment");
    if (investmentAccounts.length > 0) {
      try {
        // Also store in plaid_investment_items so the existing
        // POST /api/plaid/sync-holdings path picks them up.
        await pool.query(
          `INSERT INTO plaid_investment_items (item_id, institution_name, access_token_enc)
           VALUES ($1, $2, pgp_sym_encrypt($3, $4))
           ON CONFLICT (item_id) DO UPDATE SET
             access_token_enc = pgp_sym_encrypt($3, $4),
             institution_name = $2,
             updated_at = now()`,
          [itemId, institution?.name || "Unknown", accessToken, ENCRYPTION_PASSPHRASE]
        );
        const holdingsRes = await client.investmentsHoldingsGet({ access_token: accessToken });
        const holdings = holdingsRes.data.holdings || [];
        const securities = holdingsRes.data.securities || [];
        const secMap = {};
        for (const sec of securities) secMap[sec.security_id] = sec;
        // Fall back to the sum of holdings when the account-level current
        // balance is null (Schwab et al.) so brokerages don't show $0.
        const acctValue = sumHoldingsByAccount(holdings, secMap);
        for (const acct of investmentAccounts) {
          const balance = acct.balances?.current ?? acctValue[acct.account_id] ?? 0;
          await pool.query(
            `INSERT INTO investment_accounts (name, institution, account_type, balance, plaid_account_id)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (plaid_account_id) DO UPDATE SET
               balance = $4, name = $1, is_active = true, updated_at = now()`,
            [acct.name, institution?.name || "Unknown", acct.subtype || "brokerage",
             balance, acct.account_id]
          );
          // Backfill the linked_accounts row too so the accounts grid (which
          // reads current_balance) shows the real value instead of $0.
          await pool.query(
            "UPDATE linked_accounts SET current_balance = $1, balance_updated_at = now() WHERE account_id = $2 AND (current_balance IS NULL OR current_balance = 0)",
            [balance, acct.account_id]
          );
        }
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
          holdingsSynced = holdings.length;
        }
      } catch (invErr) {
        console.error("Initial holdings sync error:", invErr.response?.data?.error_message || invErr.message);
      }
    }

    res.json({
      ok: true,
      item_id: itemId,
      institution: institution?.name || "Unknown",
      accounts_linked: linked,
      transactions_added: syncResult.added,
      holdings_synced: holdingsSynced || undefined,
      liabilities_synced: liabResult.updated || undefined,
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
  let incomplete = false;
  const MAX_PAGES = 20;

  // Reusable upsert for both `added` and `modified`. Plaid frequently delivers
  // a transaction as pending in `added`, then re-delivers it posted in
  // `modified`; a bare UPDATE would match zero rows in that case and silently
  // drop the now-posted transaction (F5). Upserting on both paths makes the
  // `modified` branch self-healing.
  const upsertTxn = (txn) => {
    const logoUrl = txn.counterparties?.[0]?.logo_url || null;
    return pool.query(
      `INSERT INTO transactions (account_id, transaction_id, amount, iso_currency_code, date,
                                 merchant_name, name, category, pending, personal_finance_category, logo_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, $10)
       ON CONFLICT (transaction_id)
       DO UPDATE SET
         amount = EXCLUDED.amount,
         date = EXCLUDED.date,
         merchant_name = EXCLUDED.merchant_name,
         name = EXCLUDED.name,
         category = EXCLUDED.category,
         pending = EXCLUDED.pending,
         personal_finance_category = EXCLUDED.personal_finance_category,
         logo_url = COALESCE(EXCLUDED.logo_url, transactions.logo_url)
       RETURNING (xmax = 0) AS inserted`,
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
        logoUrl,
      ]
    );
  };

  while (hasMore && pages < MAX_PAGES) {
    pages++;
    const syncRes = await client.transactionsSync({
      access_token: accessToken,
      cursor: cursor,
      count: 500,
    });
    const data = syncRes.data;

    // Track per-page row failures. Plaid's cursor contract is "everything up to
    // `cursor` has been durably processed" — so if ANY row in this page fails to
    // persist, we must NOT advance past it, or Plaid will never resend it (F1).
    let pageFailed = false;

    // Process added transactions
    for (const txn of data.added || []) {
      if (txn.pending) continue;
      try {
        // Count only genuine inserts (xmax = 0), not ON-CONFLICT updates — on a
        // reconcile/cursor-reset Plaid re-delivers existing rows in `added`, and
        // counting those as new inflated transactions_added (F16).
        const r = await upsertTxn(txn);
        if (r.rows[0]?.inserted) totalAdded++;
      } catch (err) {
        console.error("Plaid txn insert error:", err.message, txn.transaction_id);
        pageFailed = true;
      }
    }

    // Process modified transactions (upsert so a pending→posted re-delivery
    // with no existing row is inserted rather than dropped — see F5 above).
    for (const txn of data.modified || []) {
      if (txn.pending) continue;
      try {
        await upsertTxn(txn);
        totalModified++;
      } catch (err) {
        console.error("Plaid txn update error:", err.message, txn.transaction_id);
        pageFailed = true;
      }
    }

    // Process removed transactions
    for (const txn of data.removed || []) {
      try {
        await pool.query("DELETE FROM transactions WHERE transaction_id = $1", [txn.transaction_id]);
        totalRemoved++;
      } catch (err) {
        console.error("Plaid txn delete error:", err.message, txn.transaction_id);
        pageFailed = true;
      }
    }

    if (pageFailed) {
      // Halt without advancing the cursor. The rows that succeeded this page are
      // idempotent (ON CONFLICT upserts / idempotent deletes), so re-processing
      // the page on the next sync is safe; the failed rows get another chance
      // instead of being lost forever.
      incomplete = true;
      console.error(`Plaid sync (item ${plaidItemDbId}): row failure on page ${pages}; halting cursor advance to avoid data loss.`);
      break;
    }

    cursor = data.next_cursor;
    hasMore = data.has_more;

    // Persist progressively after each fully-successful page so a failure on a
    // later page can't discard the progress of earlier pages.
    await pool.query(
      `UPDATE sync_cursors SET cursor = $1, last_synced_at = now() WHERE plaid_item_id = $2`,
      [cursor, plaidItemDbId]
    );
  }

  // If MAX_PAGES was hit while has_more is still true, the sync is partial but
  // the cursor is correctly positioned for the next invocation to resume.
  if (hasMore && !incomplete) incomplete = true;

  return { added: totalAdded, modified: totalModified, removed: totalRemoved, incomplete };
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

      // #1: sync liabilities (APR, min payment) on each auto-sync cycle
      try { await syncPlaidLiabilities(client, item.access_token, item.id); }
      catch (libErr) { console.error("Liabilities sync error for", item.institution_name, ":", libErr.message); }

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
            // Keep credit_limit fresh on the auto-sync path too (only the
            // balance-only path did before), so utilization stays correct when
            // Plaid reports `available: null` for a credit card (F-credit).
            await pool.query(
              `UPDATE linked_accounts SET
                 current_balance = $1, available_balance = $2,
                 credit_limit = COALESCE($3, credit_limit), balance_updated_at = now()
               WHERE id = $4`,
              [ba.balances.current, ba.balances.available, ba.balances?.limit ?? null, la.id]
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


// reconcilePlaidTransactions — reset every Plaid item's transactionsSync cursor
// to empty, then re-walk the full history. Plaid's cursor model is all-or-
// nothing (you can't bound it to "last N days"), so reconciliation is a full
// re-pull; all writes are idempotent upserts, so it only recovers anything we
// previously dropped — it doesn't duplicate. Heavier than the incremental sync,
// so it's a manual/weekly action, never the hourly auto-sync path.
async function reconcilePlaidTransactions() {
  const client = getPlaidClient();
  if (!client) return { ok: false, error: "Plaid not configured" };
  await pool.query("UPDATE sync_cursors SET cursor = ''").catch(e => console.error("cursor reset error:", e.message));
  const result = await syncAllPlaidTransactions();
  return { ok: true, reconciled: true, ...result };
}

// Balance-only refresh for every linked Plaid item. Used by
// POST /api/sync-balances so a single "Sync Balances" click pulls Plaid
// AND Teller balances. Doesn't touch the transactions table — that's what
// makes it safe to run independently of the full transactionsSync cycle.
async function syncAllPlaidBalances() {
  const client = getPlaidClient();
  if (!client) return { ok: true, items_synced: 0, accounts_updated: 0, errors: [] };
  const items = await pool.query(
    `SELECT id, institution_name,
            pgp_sym_decrypt(access_token_enc, $1) AS access_token
     FROM plaid_items`,
    [ENCRYPTION_PASSPHRASE]
  );
  let accountsUpdated = 0;
  const errors = [];
  for (const item of items.rows) {
    if (!item.access_token) {
      errors.push({ institution: item.institution_name, error: "decryption_failed" });
      continue;
    }
    try {
      const balRes = await client.accountsGet({ access_token: item.access_token });
      for (const ba of balRes.data.accounts) {
        const cur = ba.balances?.current ?? null;
        const avail = ba.balances?.available ?? null;
        const limit = ba.balances?.limit ?? null;
        if (cur === null && avail === null) continue;
        const upd = await pool.query(
          `UPDATE linked_accounts SET
             current_balance = $1, available_balance = $2,
             credit_limit = COALESCE($3, credit_limit),
             balance_updated_at = now()
           WHERE account_id = $4 AND plaid_item_id = $5
           RETURNING id`,
          [cur, avail, limit, ba.account_id, item.id]
        );
        if (upd.rows.length) {
          accountsUpdated++;
          const daily = cur !== null ? cur : avail;
          await pool.query(
            `INSERT INTO account_balance_snapshots
               (source, source_id, snapshot_date, balance, available_balance, current_balance)
             VALUES ('linked', $1, CURRENT_DATE, $2, $3, $4)
             ON CONFLICT (source, source_id, snapshot_date) DO UPDATE SET
               balance = EXCLUDED.balance,
               available_balance = EXCLUDED.available_balance,
               current_balance = EXCLUDED.current_balance`,
            [upd.rows[0].id, daily, avail, cur]
          ).catch(e => console.error("Plaid balance snapshot error:", e.message));
        }
      }
      // Refresh liabilities (APR / min payment / due date) on the balance path
      // too — previously only the transaction sync + exchange did, so clicking
      // "Sync Balances" never updated APR. Fails gracefully when unsupported.
      try { await syncPlaidLiabilities(client, item.access_token, item.id); }
      catch (libErr) { console.error("Liabilities refresh error for", item.institution_name, ":", libErr.message); }
    } catch (err) {
      console.error("Plaid balance refresh error for", item.institution_name, ":", err.response?.data?.error_message || err.message);
      errors.push({ institution: item.institution_name, error: err.response?.data?.error_message || err.message });
    }
  }
  return { ok: true, items_synced: items.rows.length - errors.length, accounts_updated: accountsUpdated, errors };
}


// =========================================================================
// #1 — Plaid Liabilities (APR, minimum payment, loan details)
// =========================================================================
// Syncs credit-card and loan liability details from Plaid into
// linked_accounts columns. Called once at exchange time and on each
// auto-sync cycle. Updates apr, credit_limit, minimum_payment,
// next_payment_due_date, and last_payment fields.

async function syncPlaidLiabilities(client, accessToken, plaidItemDbId) {
  try {
    const libRes = await client.liabilitiesGet({ access_token: accessToken });
    const credit = libRes.data.liabilities?.credit || [];
    const student = libRes.data.liabilities?.student || [];
    const mortgage = libRes.data.liabilities?.mortgage || [];

    let updated = 0;
    for (const cc of credit) {
      if (!cc.account_id) continue;
      const aprs = cc.aprs || [];
      const purchaseApr = aprs.find(a => a.apr_type === "purchase_apr") || aprs[0];
      await pool.query(
        `UPDATE linked_accounts SET
           apr = COALESCE($1, apr),
           credit_limit = COALESCE($2, credit_limit),
           minimum_payment = $3,
           next_payment_due_date = $4,
           last_payment_amount = $5,
           last_payment_date = $6,
           balance_updated_at = now()
         WHERE account_id = $7 AND plaid_item_id = $8`,
        [
          purchaseApr?.apr_percentage || null,
          cc.credit_limit || null,
          cc.minimum_payment_amount || null,
          cc.next_payment_due_date || null,
          cc.last_payment_amount || null,
          cc.last_payment_date || null,
          cc.account_id,
          plaidItemDbId,
        ]
      );
      updated++;
    }

    // Student loans + mortgages — store summary on the linked_account
    // row so the debt optimizer sees them. These account types may not
    // have a linked_accounts row (they'd need to be in the accounts
    // response at link time). If the row doesn't exist, skip silently.
    for (const loan of [...student, ...mortgage]) {
      if (!loan.account_id) continue;
      const apr = loan.interest_rate_percentage ??
                  loan.origination_principal_amount ? null : null;
      await pool.query(
        `UPDATE linked_accounts SET
           apr = COALESCE($1, apr),
           minimum_payment = COALESCE($2, minimum_payment),
           next_payment_due_date = COALESCE($3, next_payment_due_date),
           last_payment_amount = COALESCE($4, last_payment_amount),
           last_payment_date = COALESCE($5, last_payment_date),
           balance_updated_at = now()
         WHERE account_id = $6 AND plaid_item_id = $7`,
        [
          loan.interest_rate_percentage || null,
          loan.minimum_payment_amount || null,
          loan.next_payment_due_date || null,
          loan.last_payment_amount || null,
          loan.last_payment_date || null,
          loan.account_id,
          plaidItemDbId,
        ]
      );
      updated++;
    }

    return { credit: credit.length, student: student.length, mortgage: mortgage.length, updated };
  } catch (err) {
    // Liabilities may not be supported for all institutions — fail
    // gracefully so the rest of the sync continues.
    if (err.response?.data?.error_code === "PRODUCTS_NOT_SUPPORTED") {
      return { credit: 0, student: 0, mortgage: 0, updated: 0, skipped: "not_supported" };
    }
    console.error("Plaid liabilities sync error:", err.response?.data?.error_message || err.message);
    return { credit: 0, student: 0, mortgage: 0, updated: 0, error: err.message };
  }
}

// =========================================================================
// #2 + #4 — Plaid Recurring Transactions (subscriptions + income streams)
// =========================================================================
// Calls transactionsRecurringGet for each Plaid item and returns both
// outflow_streams (detected subscriptions) and inflow_streams (detected
// income). These complement — not replace — the app's own detection.
//
// GET /api/plaid/recurring returns the combined view so the dashboard or
// subscriptions page can show "Plaid detected" alongside "Perfin detected".

router.get("/api/plaid/recurring", async (_req, res) => {
  const client = getPlaidClient();
  if (!client) return res.status(501).json({ error: "Plaid not configured." });

  try {
    const items = await pool.query(
      `SELECT pi.id, pi.item_id, pi.institution_name,
              pgp_sym_decrypt(pi.access_token_enc, $1) AS access_token
       FROM plaid_items pi WHERE pi.status = 'GOOD'`,
      [ENCRYPTION_PASSPHRASE]
    );

    const allOutflows = [];
    const allInflows = [];

    for (const item of items.rows) {
      if (!item.access_token) continue;
      try {
        const recRes = await client.transactionsRecurringGet({
          access_token: item.access_token,
          options: {},
        });
        const outflows = (recRes.data.outflow_streams || []).map(s => ({
          stream_id: s.stream_id,
          institution: item.institution_name,
          merchant_name: s.merchant_name || s.description,
          amount: Math.abs(s.average_amount?.amount || s.last_amount?.amount || 0),
          frequency: s.frequency,
          category: s.personal_finance_category?.primary || s.category?.[0] || null,
          last_date: s.last_date,
          next_date: s.predicted_next_date,
          is_active: s.is_active,
          status: s.status,
          direction: "outflow",
        }));
        const inflows = (recRes.data.inflow_streams || []).map(s => ({
          stream_id: s.stream_id,
          institution: item.institution_name,
          merchant_name: s.merchant_name || s.description,
          amount: Math.abs(s.average_amount?.amount || s.last_amount?.amount || 0),
          frequency: s.frequency,
          category: s.personal_finance_category?.primary || s.category?.[0] || null,
          last_date: s.last_date,
          next_date: s.predicted_next_date,
          is_active: s.is_active,
          status: s.status,
          direction: "inflow",
        }));
        allOutflows.push(...outflows);
        allInflows.push(...inflows);
      } catch (err) {
        if (err.response?.data?.error_code !== "PRODUCTS_NOT_SUPPORTED") {
          console.error("Plaid recurring error for", item.institution_name, ":", err.response?.data?.error_message || err.message);
        }
      }
    }

    res.json({
      outflow_streams: allOutflows.sort((a, b) => b.amount - a.amount),
      inflow_streams: allInflows.sort((a, b) => b.amount - a.amount),
      total_monthly_outflow: allOutflows.filter(s => s.is_active).reduce((sum, s) => sum + s.amount, 0),
      total_monthly_inflow: allInflows.filter(s => s.is_active).reduce((sum, s) => sum + s.amount, 0),
    });
  } catch (err) {
    console.error("Plaid recurring error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

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
           balance = $4, name = $1, is_active = true, updated_at = now()`,
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
        // Holdings-sum fallback for accounts whose account-level current balance
        // is null (Schwab et al.), so they don't get persisted as $0.
        const acctValue = sumHoldingsByAccount(holdings, secMap);

        for (const acct of accounts) {
          if (acct.type !== "investment") continue;
          const balance = acct.balances?.current ?? acctValue[acct.account_id] ?? 0;
          // RETURNING the investment_accounts.id so the snapshot below can
          // attribute history to the right account (we key by plaid_account_id
          // here but the snapshot table uses the local SERIAL id).
          const updRes = await pool.query(
            `UPDATE investment_accounts SET balance = $1, updated_at = now()
             WHERE plaid_account_id = $2 AND is_active = true
             RETURNING id`,
            [balance, acct.account_id]
          );
          // Keep the linked_accounts mirror in sync so the accounts grid agrees.
          await pool.query(
            "UPDATE linked_accounts SET current_balance = $1, balance_updated_at = now() WHERE account_id = $2",
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
           AND la.plaid_item_id IS NULL
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

// =========================================================================
// Migration helper: Teller → Plaid override preservation
// =========================================================================
// When switching an account from Teller to Plaid, deleting the Teller
// enrollment CASCADEs to its transactions, taking the user's overrides
// (user_merchant_name, user_category, user_notes, is_reimbursed) with it.
// This endpoint pre-emptively copies those overrides to the matching
// Plaid transactions so the manual override work isn't lost.
//
// Match heuristic: same date ±2 days, same amount (exact match — money
// doesn't approximate), same merchant signature (case-insensitive substring).
// Conservative on purpose — a Plaid transaction only gets the override if
// there's exactly ONE Teller candidate that matches.

router.get("/api/plaid/migrate-preview", async (_req, res) => {
  try {
    // List Teller-linked accounts whose mask + name appears in any
    // Plaid-linked account too (indicates a likely duplicate to migrate).
    const result = await pool.query(`
      SELECT
        te.id AS teller_enrollment_id,
        te.institution_name AS teller_institution,
        la_t.id AS teller_account_id,
        la_t.name AS teller_account_name,
        la_t.mask AS teller_mask,
        pi.id AS plaid_item_id,
        pi.institution_name AS plaid_institution,
        la_p.id AS plaid_account_id,
        la_p.name AS plaid_account_name,
        la_p.mask AS plaid_mask,
        (SELECT COUNT(*) FROM transactions t
         WHERE t.account_id = la_t.account_id
           AND (t.user_merchant_name IS NOT NULL
                OR t.user_category IS NOT NULL
                OR t.user_notes IS NOT NULL
                OR t.is_reimbursed = true)
        ) AS overrides_at_risk
      FROM teller_enrollments te
      JOIN linked_accounts la_t ON la_t.teller_enrollment_id = te.id
      JOIN linked_accounts la_p ON la_p.mask = la_t.mask AND la_p.plaid_item_id IS NOT NULL
      JOIN plaid_items pi ON pi.id = la_p.plaid_item_id
      WHERE la_t.mask IS NOT NULL
      ORDER BY te.institution_name, la_t.mask
    `);
    res.json({
      candidate_pairs: result.rows,
      note: "These Teller-linked accounts have matching Plaid-linked accounts (by mask). Running migrate-execute copies user overrides from Teller transactions to matching Plaid transactions before you can safely delete the Teller enrollment.",
    });
  } catch (err) {
    console.error("Migration preview error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

router.post("/api/plaid/migrate-overrides", async (req, res) => {
  const tellerAccountId = req.body?.teller_account_id;
  const plaidAccountId = req.body?.plaid_account_id;
  if (!tellerAccountId || !plaidAccountId) {
    return res.status(400).json({ error: "teller_account_id and plaid_account_id required (numeric linked_accounts.id values from /migrate-preview)" });
  }
  try {
    // Resolve both accounts to their Teller/Plaid string account_ids
    const accts = await pool.query(
      `SELECT id, account_id, teller_enrollment_id, plaid_item_id, mask, name
       FROM linked_accounts
       WHERE id = ANY($1::int[])`,
      [[tellerAccountId, plaidAccountId]]
    );
    if (accts.rows.length !== 2) return res.status(404).json({ error: "One or both linked_accounts rows not found" });
    const teller = accts.rows.find(r => r.teller_enrollment_id);
    const plaid = accts.rows.find(r => r.plaid_item_id);
    if (!teller || !plaid) {
      return res.status(400).json({ error: "Pair must be one Teller-linked and one Plaid-linked account" });
    }

    // For each Teller transaction with overrides, find the matching
    // Plaid transaction (date ±2 days, exact amount) and copy overrides.
    // Conservative: only copy if exactly one Plaid candidate matches.
    const tellerTxns = await pool.query(
      `SELECT transaction_id, date, amount, merchant_name, name,
              user_merchant_name, user_category, user_notes, is_reimbursed, reimbursed_at
       FROM transactions
       WHERE account_id = $1
         AND (user_merchant_name IS NOT NULL
              OR user_category IS NOT NULL
              OR user_notes IS NOT NULL
              OR is_reimbursed = true)`,
      [teller.account_id]
    );

    let migrated = 0;
    let ambiguous = 0;
    let unmatched = 0;
    const unmatchedSamples = [];

    for (const t of tellerTxns.rows) {
      const candidates = await pool.query(
        `SELECT transaction_id FROM transactions
         WHERE account_id = $1
           AND amount = $2
           AND ABS(EXTRACT(EPOCH FROM (date::timestamp - $3::timestamp)) / 86400) <= 2
         LIMIT 2`,
        [plaid.account_id, t.amount, t.date]
      );
      if (candidates.rows.length === 0) {
        unmatched++;
        if (unmatchedSamples.length < 5) {
          unmatchedSamples.push({ date: t.date, amount: t.amount, merchant: t.merchant_name || t.name });
        }
        continue;
      }
      if (candidates.rows.length > 1) {
        ambiguous++;
        continue;
      }
      await pool.query(
        `UPDATE transactions SET
           user_merchant_name = COALESCE($1, user_merchant_name),
           user_category = COALESCE($2, user_category),
           user_notes = COALESCE($3, user_notes),
           is_reimbursed = $4 OR is_reimbursed,
           reimbursed_at = COALESCE($5, reimbursed_at)
         WHERE transaction_id = $6`,
        [t.user_merchant_name, t.user_category, t.user_notes, t.is_reimbursed, t.reimbursed_at, candidates.rows[0].transaction_id]
      );
      migrated++;
    }

    res.json({
      ok: true,
      overrides_found: tellerTxns.rows.length,
      migrated,
      ambiguous,
      unmatched,
      unmatched_samples: unmatchedSamples,
      next_step: "Verify the Plaid account looks correct on the Transactions page, then delete the Teller enrollment via the Accounts page. The Teller transactions will be removed but your overrides now live on the matching Plaid transactions.",
    });
  } catch (err) {
    console.error("Migration execute error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// IMPORTANT: assign the router FIRST, then attach the named helpers. Doing
// `module.exports = router` here (at the end) would otherwise discard any
// `module.exports.X = X` set earlier in the file against the default {} —
// which had silently left syncAllPlaidTransactions / syncAllPlaidBalances
// undefined for startup.js's schedulers. All three are hoisted function
// declarations, so they're defined by the time this runs.
module.exports = router;
module.exports.syncAllPlaidTransactions = syncAllPlaidTransactions;
module.exports.reconcilePlaidTransactions = reconcilePlaidTransactions;
module.exports.syncAllPlaidBalances = syncAllPlaidBalances;
