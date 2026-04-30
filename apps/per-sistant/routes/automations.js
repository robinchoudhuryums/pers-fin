// ============================================================================
// Per-sistant — Automation Routes
// ============================================================================

const express = require("express");

module.exports = function ({ pool, config }) {
  const router = express.Router();
  const { VALID_TRIGGERS, VALID_ACTIONS } = config;

  router.get("/api/automations", async (req, res) => {
    try {
      const r = await pool.query("SELECT * FROM automations ORDER BY created_at DESC");
      res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post("/api/automations", async (req, res) => {
    try {
      const { name, trigger_type, conditions, action_type, action_data } = req.body;
      if (!name) return res.status(400).json({ error: "Name is required." });
      if (!VALID_TRIGGERS.includes(trigger_type)) return res.status(400).json({ error: "Invalid trigger. Must be: " + VALID_TRIGGERS.join(", ") });
      if (!VALID_ACTIONS.includes(action_type)) return res.status(400).json({ error: "Invalid action. Must be: " + VALID_ACTIONS.join(", ") });
      const r = await pool.query(
        "INSERT INTO automations (name, trigger_type, conditions, action_type, action_data) VALUES ($1,$2,$3,$4,$5) RETURNING *",
        [name, trigger_type, conditions || {}, action_type, action_data || {}]
      );
      res.json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.patch("/api/automations/:id", async (req, res) => {
    try {
      const { name, trigger_type, conditions, action_type, action_data, enabled } = req.body;
      if (trigger_type && !VALID_TRIGGERS.includes(trigger_type)) return res.status(400).json({ error: "Invalid trigger." });
      if (action_type && !VALID_ACTIONS.includes(action_type)) return res.status(400).json({ error: "Invalid action." });
      const fields = []; const params = []; let idx = 1;
      if (name !== undefined) { fields.push(`name = $${idx++}`); params.push(name); }
      if (trigger_type !== undefined) { fields.push(`trigger_type = $${idx++}`); params.push(trigger_type); }
      if (conditions !== undefined) { fields.push(`conditions = $${idx++}`); params.push(JSON.stringify(conditions)); }
      if (action_type !== undefined) { fields.push(`action_type = $${idx++}`); params.push(action_type); }
      if (action_data !== undefined) { fields.push(`action_data = $${idx++}`); params.push(JSON.stringify(action_data)); }
      if (enabled !== undefined) { fields.push(`enabled = $${idx++}`); params.push(enabled); }
      if (!fields.length) return res.status(400).json({ error: "No fields." });
      params.push(req.params.id);
      const r = await pool.query(`UPDATE automations SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`, params);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.delete("/api/automations/:id", async (req, res) => {
    try {
      const r = await pool.query("DELETE FROM automations WHERE id = $1 RETURNING id", [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
};
