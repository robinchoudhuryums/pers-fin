const express = require("express");
const router = express.Router();

module.exports = function() {
  router.get("/dashboard", (_req, res) => {
    res.render("dashboard");
  });
  return router;
};
