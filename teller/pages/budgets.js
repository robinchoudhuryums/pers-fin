const express = require("express");
const router = express.Router();

module.exports = function(config) {
  const { API_KEY } = config;
router.get("/budgets", (req, res) => {
  res.render("budgets", { apiKey: API_KEY || "" });
});

  return router;
};
