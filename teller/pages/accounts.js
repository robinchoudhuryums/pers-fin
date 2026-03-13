const express = require("express");
const router = express.Router();

module.exports = function(config) {
  const { API_KEY, TELLER_APP_ID, TELLER_ENV } = config;
router.get("/", (req, res) => {
  const tellerEnv = TELLER_ENV === "production" ? "production" : TELLER_ENV === "development" ? "development" : "sandbox";
  res.render("accounts", { apiKey: API_KEY || "", tellerAppId: TELLER_APP_ID, tellerEnv: tellerEnv });
});

  return router;
};
