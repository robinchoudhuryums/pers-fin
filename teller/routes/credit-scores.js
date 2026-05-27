// ============================================================================
// Routes: Credit Score tracking (manual entry + history)
// ============================================================================
// Users log their credit score periodically (typically monthly, from their
// bank/card app's free score). The app stores the history, trends it on the
// dashboard widget, syncs it to Google Sheets, and feeds the trajectory
// into AI insights so Claude can correlate score changes with spending.

const express = require("express");
const router = express.Router();
const { pool } = require("../services/database");

const VALID_SCORE_TYPES = new Set(["fico", "vantagescore", "other"]);

// GET /api/credit-scores — history, newest first. Optional query: limit, score_type
router.get("/api/credit-scores", async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  try {
    let where = "";
    const params = [limit];
    if (req.query.score_type && VALID_SCORE_TYPES.has(req.query.score_type)) {
      where = "WHERE score_type = $2";
      params.push(req.query.score_type);
    }
    const result = await pool.query(
      `SELECT * FROM credit_scores ${where} ORDER BY checked_at DESC, created_at DESC LIMIT $1`,
      params
    );
    // Compute trend: delta between latest and prior, and between latest
    // and the entry from ~6 months ago (if available).
    const rows = result.rows;
    let trend = null;
    if (rows.length >= 2) {
      const latest = rows[0];
      const prior = rows[1];
      const sixMoAgo = rows.find(r => {
        const age = (new Date(latest.checked_at) - new Date(r.checked_at)) / 86400000;
        return age >= 150;
      });
      trend = {
        current: latest.score,
        prior: prior.score,
        delta_vs_prior: latest.score - prior.score,
        six_month_ago: sixMoAgo ? sixMoAgo.score : null,
        delta_vs_6mo: sixMoAgo ? latest.score - sixMoAgo.score : null,
      };
    }
    res.json({ scores: rows, trend });
  } catch (err) {
    console.error("Credit scores list error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/credit-scores — log a new score.
// Body: { score, score_type?, source?, notes?, checked_at? }
router.post("/api/credit-scores", async (req, res) => {
  const { score, score_type, source, notes, checked_at } = req.body || {};
  const s = parseInt(score, 10);
  if (!Number.isFinite(s) || s < 300 || s > 850) {
    return res.status(400).json({ error: "score must be an integer 300-850" });
  }
  const type = VALID_SCORE_TYPES.has(score_type) ? score_type : "vantagescore";
  const date = checked_at || new Date().toISOString().split("T")[0];
  try {
    const result = await pool.query(
      `INSERT INTO credit_scores (score, score_type, source, notes, checked_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (checked_at, score_type) DO UPDATE
         SET score = EXCLUDED.score,
             source = COALESCE(EXCLUDED.source, credit_scores.source),
             notes = COALESCE(EXCLUDED.notes, credit_scores.notes)
       RETURNING *`,
      [s, type, typeof source === "string" ? source.slice(0, 200) : null,
       typeof notes === "string" ? notes.slice(0, 500) : null, date]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Credit score insert error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// DELETE /api/credit-scores/:id — remove an entry
router.delete("/api/credit-scores/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  try {
    const result = await pool.query("DELETE FROM credit_scores WHERE id = $1 RETURNING id", [id]);
    if (!result.rows.length) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("Credit score delete error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

module.exports = router;
