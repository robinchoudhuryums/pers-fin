const express = require("express");
const router = express.Router();

module.exports = function() {
  router.get("/budgets", (_req, res) => {
    res.render("budgets");
  });
  return router;
};
