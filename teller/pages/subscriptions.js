const express = require("express");
const router = express.Router();

module.exports = function() {
  router.get("/subscriptions", (_req, res) => {
    res.render("subscriptions");
  });
  return router;
};
