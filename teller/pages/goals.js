const express = require("express");
const router = express.Router();

module.exports = function(config) {
  const { API_KEY } = config;
// ---------------------------------------------------------------------------
// GET /goals — financial goals page (EJS template)
// ---------------------------------------------------------------------------
router.get("/goals", (req, res) => {
  res.render("goals", { apiKey: API_KEY || "" });
});

  return router;
};
