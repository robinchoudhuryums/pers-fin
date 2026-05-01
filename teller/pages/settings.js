const express = require("express");
const router = express.Router();

module.exports = function() {
  router.get("/settings", (_req, res) => {
    res.render("settings");
  });
  return router;
};
