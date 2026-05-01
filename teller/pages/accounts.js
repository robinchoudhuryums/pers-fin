const express = require("express");
const router = express.Router();

module.exports = function(config) {
  const { TELLER_APP_ID, TELLER_ENV } = config;
  router.get("/", (_req, res) => {
    const tellerEnv = TELLER_ENV === "production" ? "production" : TELLER_ENV === "development" ? "development" : "sandbox";
    res.render("accounts", { tellerAppId: TELLER_APP_ID, tellerEnv: tellerEnv });
  });
  return router;
};
