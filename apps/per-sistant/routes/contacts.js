const express = require("express");

module.exports = function ({ pool, config }) {
  const router = express.Router();
  const { envContacts, EMAIL_REGEX } = config;

  router.get("/api/contacts", async (req, res) => {
    try {
      const r = await pool.query("SELECT * FROM contacts ORDER BY name ASC");
      res.json(r.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/api/contacts", async (req, res) => {
    try {
      const { name, email } = req.body;
      if (!name || !email) return res.status(400).json({ error: "Name and email are required." });
      const r = await pool.query(
        `INSERT INTO contacts (name, email) VALUES ($1, $2) RETURNING *`,
        [name, email]
      );
      res.json(r.rows[0]);
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: "Contact with that name already exists." });
      res.status(500).json({ error: err.message });
    }
  });

  router.patch("/api/contacts/:id", async (req, res) => {
    try {
      const { name, email } = req.body;
      const fields = [];
      const params = [];
      let idx = 1;
      if (name !== undefined) { fields.push(`name = $${idx++}`); params.push(name); }
      if (email !== undefined) { fields.push(`email = $${idx++}`); params.push(email); }
      if (!fields.length) return res.status(400).json({ error: "No fields to update." });
      params.push(req.params.id);
      const r = await pool.query(`UPDATE contacts SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`, params);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json(r.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete("/api/contacts/:id", async (req, res) => {
    try {
      const r = await pool.query("DELETE FROM contacts WHERE id = $1 RETURNING id", [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Lookup contact by name (for "send email to <name>")
  router.get("/api/contacts/lookup/:name", async (req, res) => {
    try {
      const name = req.params.name.toLowerCase();
      // Check DB first
      const r = await pool.query("SELECT * FROM contacts WHERE LOWER(name) = $1", [name]);
      if (r.rows.length) return res.json(r.rows[0]);
      // Check env contacts
      for (const [n, e] of Object.entries(envContacts)) {
        if (n.toLowerCase() === name) return res.json({ name: n, email: e });
      }
      res.status(404).json({ error: "Contact not found." });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/api/contacts/import", async (req, res) => {
    try {
      const { contacts } = req.body;
      if (!Array.isArray(contacts) || !contacts.length) return res.status(400).json({ error: "contacts array required." });
      const imported = [];
      const errors = [];
      for (const c of contacts) {
        try {
          if (!c.name || !c.email) { errors.push({ contact: c, error: "name and email required" }); continue; }
          const trimmedEmail = c.email.trim().toLowerCase();
          if (!EMAIL_REGEX.test(trimmedEmail)) { errors.push({ contact: c, error: "invalid email" }); continue; }
          const r = await pool.query("INSERT INTO contacts (name, email) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING *", [c.name.trim(), trimmedEmail]);
          if (r.rows[0]) imported.push(r.rows[0]);
        } catch (err) { errors.push({ contact: c, error: err.message }); }
      }
      res.json({ imported: imported.length, errors: errors.length, details: errors.length ? errors : undefined });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
};
