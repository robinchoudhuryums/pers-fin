const express = require("express");
const router = express.Router();

module.exports = function() {
  // ---------------------------------------------------------------------------
  // GET /goals — financial goals page (EJS template)
  // ---------------------------------------------------------------------------
  router.get("/goals", (_req, res) => {
    res.render("goals");
  });
  return router;
};
