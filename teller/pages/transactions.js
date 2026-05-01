// Page: Transactions search, filter, and bulk categorization
module.exports = function() {
  const express = require("express");
  const router = express.Router();
  router.get("/transactions", (_req, res) => {
    res.render("transactions");
  });
  return router;
};
