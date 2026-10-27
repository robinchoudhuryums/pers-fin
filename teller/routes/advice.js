// ============================================================================
// Routes: "Where should my extra money go?" (roadmap T4.1 A2)
// ============================================================================
// GET /api/advice is the plan services/advice.js works out — every figure is
// the engine's (decision 1); this route only hands it over. The engine is
// fail-soft: a source it couldn't read is an { ok: false, error } plan (a fixed
// sentence), still a 200, so the dashboard card can say so. Only an unexpected
// throw is a 500, with a fixed message.

const express = require("express");
const router = express.Router();
const { pool } = require("../services/database");
const advice = require("../services/advice");

router.get("/api/advice", async (req, res) => {
  try {
    res.json(await advice.getAdvicePlan(pool));
  } catch (err) {
    console.error("advice error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

module.exports = router;
