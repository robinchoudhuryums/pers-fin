// ============================================================================
// Plaid client factory — shared by routes/investments.js and
// routes/investment-performance.js (extracted so the two route modules don't
// need a circular require between them).
// ============================================================================

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

const PLAID_TIMEOUT_MS = 90 * 1000;

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
      // Every Plaid call is bounded (seams audit #4 B1): axios's default is no
      // timeout, so one call that never answered held a sync — and, through
      // the job runner, every scheduled job behind it — forever.
      timeout: PLAID_TIMEOUT_MS,
      headers: { "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID, "PLAID-SECRET": secret },
    },
  });
  return new PlaidApi(config);
}

module.exports = { getPlaidClient, Products, CountryCode, plaidAvailable: () => !!PlaidApi, PLAID_TIMEOUT_MS };
