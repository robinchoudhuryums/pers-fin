// ============================================================================
// Routes: Plaid Investment Account Integration
// ============================================================================
// Uses Plaid API for investment accounts (brokerage, retirement, crypto)
// while Teller handles regular bank accounts (checking, savings, credit).

const express = require("express");
const router = express.Router();
const { pool, ENCRYPTION_PASSPHRASE } = require("../services/database");

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
          h.institution_value || (h.quantity * (sec.close_price || 0)),
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
    for (const item of items.rows) {
      try {
        const holdingsRes = await client.investmentsHoldingsGet({ access_token: item.access_token });
        const accounts = holdingsRes.data.accounts || [];
        const holdings = holdingsRes.data.holdings || [];
        const securities = holdingsRes.data.securities || [];
        const secMap = {};
        for (const s of securities) secMap[s.security_id] = s;

        for (const acct of accounts) {
          if (acct.type !== "investment") continue;
          const balance = acct.balances?.current || 0;
          await pool.query(
            `UPDATE investment_accounts SET balance = $1, updated_at = now()
             WHERE plaid_account_id = $2`,
            [balance, acct.account_id]
          );
          totalAccounts++;
        }

        for (const h of holdings) {
          const sec = secMap[h.security_id] || {};
          await pool.query(
            `INSERT INTO investment_holdings (plaid_account_id, security_id, ticker, name,
              quantity, cost_basis, current_value, security_type)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (plaid_account_id, security_id) DO UPDATE SET
               quantity = $5, cost_basis = $6, current_value = $7, ticker = $3, name = $4, updated_at = now()`,
            [
              h.account_id, h.security_id,
              sec.ticker_symbol || null, sec.name || "Unknown",
              h.quantity, h.cost_basis || 0,
              h.institution_value || (h.quantity * (sec.close_price || 0)),
              sec.type || "unknown",
            ]
          );
          totalHoldings++;
        }
      } catch (err) {
        console.error("Holdings sync error for " + item.institution_name + ":", err.message);
      }
    }

    res.json({ accounts_updated: totalAccounts, holdings_updated: totalHoldings });
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

module.exports = router;
