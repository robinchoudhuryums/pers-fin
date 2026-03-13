const express = require("express");
const router = express.Router();

module.exports = function(config) {
  const { API_KEY } = config;
router.get("/dashboard", (req, res) => {
  res.render("dashboard", { apiKey: API_KEY || "" });
});

  return router;
};
