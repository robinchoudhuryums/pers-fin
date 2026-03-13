const express = require("express");
const router = express.Router();

module.exports = function(config) {
  const { API_KEY } = config;
router.get("/subscriptions", (req, res) => {
  res.render("subscriptions", { apiKey: API_KEY || "" });
});

  return router;
};
