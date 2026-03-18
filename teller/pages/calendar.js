// Page: Bill Calendar — monthly view of expected charges and income
module.exports = function(config) {
  const express = require("express");
  const router = express.Router();
  router.get("/calendar", (_req, res) => {
    res.render("calendar", { apiKey: config.API_KEY });
  });
  return router;
};
