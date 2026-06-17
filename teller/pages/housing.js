const express = require("express");
const router = express.Router();

module.exports = function () {
  router.get("/housing", (_req, res) => {
    res.render("housing");
  });
  return router;
};
