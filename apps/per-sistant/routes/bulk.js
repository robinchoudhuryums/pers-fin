// ============================================================================
// Per-sistant — Bulk Action Routes
// ============================================================================

const express = require("express");

module.exports = function ({ pool, config }) {
  const router = express.Router();
  const { VALID_PRIORITIES, VALID_HORIZONS, MAX_BULK_IDS } = config;

  router.post("/api/bulk/todos", async (req, res) => {
    try {
      const { ids, action, data } = req.body;
      if (!ids || !Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "ids array is required." });
      if (ids.length > MAX_BULK_IDS) return res.status(400).json({ error: `Too many IDs. Maximum ${MAX_BULK_IDS} allowed.` });
      if (!action) return res.status(400).json({ error: "action is required." });
      if (action === "complete") {
        await pool.query("UPDATE todos SET completed = true, completed_at = now() WHERE id = ANY($1) AND deleted_at IS NULL", [ids]);
      } else if (action === "delete") {
        await pool.query("UPDATE todos SET deleted_at = now() WHERE id = ANY($1) AND deleted_at IS NULL", [ids]);
      } else if (action === "set_priority" && data?.priority && VALID_PRIORITIES.includes(data.priority)) {
        await pool.query("UPDATE todos SET priority = $1 WHERE id = ANY($2) AND deleted_at IS NULL", [data.priority, ids]);
      } else if (action === "set_horizon" && data?.horizon && VALID_HORIZONS.includes(data.horizon)) {
        await pool.query("UPDATE todos SET horizon = $1 WHERE id = ANY($2) AND deleted_at IS NULL", [data.horizon, ids]);
      } else {
        return res.status(400).json({ error: "Invalid action." });
      }
      res.json({ ok: true, count: ids.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post("/api/bulk/emails", async (req, res) => {
    try {
      const { ids, action } = req.body;
      if (!ids || !Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "ids array is required." });
      if (ids.length > MAX_BULK_IDS) return res.status(400).json({ error: `Too many IDs. Maximum ${MAX_BULK_IDS} allowed.` });
      if (action === "delete") {
        await pool.query("UPDATE emails SET deleted_at = now() WHERE id = ANY($1) AND deleted_at IS NULL", [ids]);
      } else {
        return res.status(400).json({ error: "Invalid action." });
      }
      res.json({ ok: true, count: ids.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post("/api/bulk/notes", async (req, res) => {
    try {
      const { ids, action } = req.body;
      if (!ids || !Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "ids array is required." });
      if (ids.length > MAX_BULK_IDS) return res.status(400).json({ error: `Too many IDs. Maximum ${MAX_BULK_IDS} allowed.` });
      if (action === "delete") {
        await pool.query("UPDATE notes SET deleted_at = now() WHERE id = ANY($1) AND deleted_at IS NULL", [ids]);
      } else {
        return res.status(400).json({ error: "Invalid action." });
      }
      res.json({ ok: true, count: ids.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
};
