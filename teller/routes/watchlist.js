// ============================================================================
// Routes: Watchlist — user-curated merchant/category/keyword monitoring
// ============================================================================
// The watchlist is a single small table the user edits via Settings. The
// Sheets sync's syncWatchlist() function renders the watchlist + matching
// recent transactions into a dedicated tab. No real-time alerts (yet) —
// this is for periodic review.

const express = require("express");
const router = express.Router();
const { pool } = require("../services/database");

const VALID_TYPES = new Set(["merchant", "category", "keyword"]);

// GET /api/watchlist — list all items (active + inactive)
router.get("/api/watchlist", async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, type, value, notes, is_active, created_at FROM watchlist_items ORDER BY is_active DESC, type, value"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Watchlist list error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/watchlist — add an item. Body: { type, value, notes? }
router.post("/api/watchlist", async (req, res) => {
  const { type, value, notes } = req.body || {};
  if (!VALID_TYPES.has(type)) {
    return res.status(400).json({ error: "type must be 'merchant', 'category', or 'keyword'" });
  }
  const cleanedValue = typeof value === "string" ? value.trim() : "";
  if (!cleanedValue) return res.status(400).json({ error: "value required" });
  if (cleanedValue.length > 200) return res.status(400).json({ error: "value too long (max 200 chars)" });
  try {
    const result = await pool.query(
      `INSERT INTO watchlist_items (type, value, notes)
       VALUES ($1, $2, $3)
       ON CONFLICT (type, value) DO UPDATE
         SET is_active = true, notes = COALESCE(EXCLUDED.notes, watchlist_items.notes)
       RETURNING *`,
      [type, cleanedValue, typeof notes === "string" ? notes.slice(0, 500) : null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Watchlist insert error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// PATCH /api/watchlist/:id — toggle is_active or update notes
router.patch("/api/watchlist/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const { is_active, notes } = req.body || {};
  const updates = [];
  const values = [];
  let idx = 1;
  if (is_active !== undefined) {
    updates.push("is_active = $" + idx++);
    values.push(!!is_active);
  }
  if (notes !== undefined) {
    updates.push("notes = $" + idx++);
    values.push(typeof notes === "string" ? notes.slice(0, 500) : null);
  }
  if (!updates.length) return res.status(400).json({ error: "No fields to update" });
  values.push(id);
  try {
    const result = await pool.query(
      `UPDATE watchlist_items SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: "Watchlist item not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Watchlist patch error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// DELETE /api/watchlist/:id — hard-delete
router.delete("/api/watchlist/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  try {
    const result = await pool.query("DELETE FROM watchlist_items WHERE id = $1 RETURNING id", [id]);
    if (!result.rows.length) return res.status(404).json({ error: "Watchlist item not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("Watchlist delete error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

module.exports = router;
