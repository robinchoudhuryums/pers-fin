const express = require("express");
const router = express.Router();

module.exports = function(config) {
  const { TELLER_APP_ID, TELLER_ENV } = config;
  function renderAccounts(_req, res) {
    const tellerEnv = TELLER_ENV === "production" ? "production" : TELLER_ENV === "development" ? "development" : "sandbox";
    res.render("accounts", { tellerAppId: TELLER_APP_ID, tellerEnv: tellerEnv });
  }
  // Accounts lives at /accounts. Root (/) redirects to the dashboard — that's
  // the expected entry point after login. (Previously the accounts page WAS the
  // root route, so every app-entry dumped the user on Accounts.) req.baseUrl is
  // "/perfin" under the unified shell and "" standalone, so the redirect lands
  // in the right mount either way.
  router.get("/accounts", renderAccounts);
  router.get("/", (req, res) => res.redirect((req.baseUrl || "") + "/dashboard"));
  return router;
};
