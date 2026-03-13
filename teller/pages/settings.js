const express = require("express");
const router = express.Router();

module.exports = function(config) {
  const { API_KEY } = config;
router.get("/settings", (req, res) => {
  res.render("settings", { apiKey: API_KEY || "" });
});

  return router;
};
