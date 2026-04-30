const express = require("express");

module.exports = function ({ pool, config, helpers }) {
  const router = express.Router();
  const { VALID_NOTE_COLORS, MAX_PAGINATION_LIMIT, MAX_CONTENT_LENGTH } = config;
  const { fireWebhooks, sendSlackNotification, runAutomations } = helpers;

  router.get("/api/notes", async (req, res) => {
    try {
      const { limit, offset } = req.query;
      let params = [];
      let idx = 1;
      let pagination = "";
      if (limit) { pagination += ` LIMIT $${idx++}`; params.push(Math.min(Math.max(1, parseInt(limit, 10) || 20), MAX_PAGINATION_LIMIT)); }
      if (offset) { pagination += ` OFFSET $${idx++}`; params.push(Math.max(0, parseInt(offset, 10) || 0)); }
      const r = await pool.query(`SELECT * FROM notes WHERE deleted_at IS NULL ORDER BY pinned DESC, updated_at DESC${pagination}`, params);
      res.json(r.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/api/notes", async (req, res) => {
    try {
      const { title, content, pinned, color, reminder_at, tags, format } = req.body;
      if (!content) return res.status(400).json({ error: "Content is required." });
      if (content.length > MAX_CONTENT_LENGTH) return res.status(400).json({ error: `Content too long. Maximum ${MAX_CONTENT_LENGTH} characters.` });
      if (color && !VALID_NOTE_COLORS.includes(color)) return res.status(400).json({ error: "Invalid color. Must be: " + VALID_NOTE_COLORS.join(", ") });
      if (tags && !Array.isArray(tags)) return res.status(400).json({ error: "Tags must be an array." });
      if (format && !["plain", "markdown"].includes(format)) return res.status(400).json({ error: "Invalid format. Must be: plain, markdown" });
      const r = await pool.query(
        `INSERT INTO notes (title, content, pinned, color, reminder_at, tags, format) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [title || null, content, pinned || false, color || "default", reminder_at || null, tags || null, format || "plain"]
      );
      res.json(r.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch("/api/notes/:id", async (req, res) => {
    try {
      const { title, content, pinned, color, reminder_at, tags, format } = req.body;
      if (color !== undefined && !VALID_NOTE_COLORS.includes(color)) return res.status(400).json({ error: "Invalid color. Must be: " + VALID_NOTE_COLORS.join(", ") });
      if (tags !== undefined && tags !== null && !Array.isArray(tags)) return res.status(400).json({ error: "Tags must be an array." });
      if (format !== undefined && !["plain", "markdown"].includes(format)) return res.status(400).json({ error: "Invalid format. Must be: plain, markdown" });
      const fields = [];
      const params = [];
      let idx = 1;
      if (title !== undefined) { fields.push(`title = $${idx++}`); params.push(title); }
      if (content !== undefined) { fields.push(`content = $${idx++}`); params.push(content); }
      if (pinned !== undefined) { fields.push(`pinned = $${idx++}`); params.push(pinned); }
      if (color !== undefined) { fields.push(`color = $${idx++}`); params.push(color); }
      if (reminder_at !== undefined) { fields.push(`reminder_at = $${idx++}`); params.push(reminder_at); }
      if (tags !== undefined) { fields.push(`tags = $${idx++}`); params.push(tags); }
      if (format !== undefined) { fields.push(`format = $${idx++}`); params.push(format); }
      if (!fields.length) return res.status(400).json({ error: "No fields to update." });
      params.push(req.params.id);
      const r = await pool.query(`UPDATE notes SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`, params);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json(r.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete("/api/notes/:id", async (req, res) => {
    try {
      const r = await pool.query("UPDATE notes SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id", [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
