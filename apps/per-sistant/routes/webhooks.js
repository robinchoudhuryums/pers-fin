// ============================================================================
// Per-sistant — Webhook Routes
// ============================================================================

const express = require("express");

module.exports = function ({ pool, config, helpers }) {
  const router = express.Router();
  const { VALID_WEBHOOK_EVENTS, isValidWebhookUrl, validateWebhookHeaders } = config;
  const { sendWebhook } = helpers;

  router.get("/api/webhooks", async (req, res) => {
    try {
      const r = await pool.query("SELECT * FROM webhooks ORDER BY created_at DESC");
      res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post("/api/webhooks", async (req, res) => {
    try {
      const { name, url, events, headers } = req.body;
      if (!name || !url) return res.status(400).json({ error: "Name and URL are required." });
      if (!isValidWebhookUrl(url)) return res.status(400).json({ error: "Invalid webhook URL. Must be a public http/https URL." });
      if (events && !events.every(e => VALID_WEBHOOK_EVENTS.includes(e))) {
        return res.status(400).json({ error: "Invalid events. Must be: " + VALID_WEBHOOK_EVENTS.join(", ") });
      }
      if (headers) {
        const hv = validateWebhookHeaders(headers);
        if (!hv.valid) return res.status(400).json({ error: hv.error });
      }
      const r = await pool.query(
        "INSERT INTO webhooks (name, url, events, headers) VALUES ($1,$2,$3,$4) RETURNING *",
        [name, url, events || [], headers || {}]
      );
      res.json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.patch("/api/webhooks/:id", async (req, res) => {
    try {
      const { name, url, events, headers, enabled } = req.body;
      if (url !== undefined && !isValidWebhookUrl(url)) return res.status(400).json({ error: "Invalid webhook URL. Must be a public http/https URL." });
      if (headers !== undefined) {
        const hv = validateWebhookHeaders(headers);
        if (!hv.valid) return res.status(400).json({ error: hv.error });
      }
      const fields = []; const params = []; let idx = 1;
      if (name !== undefined) { fields.push(`name = $${idx++}`); params.push(name); }
      if (url !== undefined) { fields.push(`url = $${idx++}`); params.push(url); }
      if (events !== undefined) { fields.push(`events = $${idx++}`); params.push(events); }
      if (headers !== undefined) { fields.push(`headers = $${idx++}`); params.push(JSON.stringify(headers)); }
      if (enabled !== undefined) { fields.push(`enabled = $${idx++}`); params.push(enabled); }
      if (!fields.length) return res.status(400).json({ error: "No fields." });
      params.push(req.params.id);
      const r = await pool.query(`UPDATE webhooks SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`, params);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.delete("/api/webhooks/:id", async (req, res) => {
    try {
      const r = await pool.query("DELETE FROM webhooks WHERE id = $1 RETURNING id", [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Test a webhook
  router.post("/api/webhooks/:id/test", async (req, res) => {
    try {
      const r = await pool.query("SELECT * FROM webhooks WHERE id = $1", [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      const webhook = r.rows[0];
      const payload = { event: "test", timestamp: new Date().toISOString(), message: "Per-sistant webhook test" };
      const result = await sendWebhook(webhook, payload);
      res.json({ ok: result.ok, status: result.status });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
};
