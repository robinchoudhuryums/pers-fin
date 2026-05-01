// Page: per-account balance history chart.
// URL: /accounts/:id/history?source=linked|investment&months=N
// Reads from /api/accounts/:id/balance-history (added alongside the daily
// snapshot table). The page itself only renders the chart shell — the JS
// inside the EJS view fetches the history and looks up the account name
// from /api/accounts (linked) or /api/investment-accounts (investment) so
// the title stays accurate after balance refreshes.
module.exports = function(config) {
  const express = require("express");
  const router = express.Router();
  router.get("/accounts/:id/history", (_req, res) => {
    res.render("account-history");
  });
  return router;
};
