const express = require("express");
const router = express.Router();

// The Tax page (roadmap T3.3 K4): the year-end package's sections, downloads
// and the documents checklist. Everything is fetched by public/tax-page.js.
module.exports = function () {
  router.get("/tax", (_req, res) => {
    res.render("tax");
  });
  return router;
};
