const express = require("express");

const VALID_PRIORITIES = ["low", "medium", "high", "urgent"];
const VALID_HORIZONS = ["short", "medium", "long"];

module.exports = function ({ pool }) {
  const router = express.Router();

  router.get("/api/todo-templates", async (req, res) => {
    try {
      const r = await pool.query("SELECT * FROM todo_templates ORDER BY name ASC");
      res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post("/api/todo-templates", async (req, res) => {
    try {
      const { name, title, description, priority, horizon, category, recurring, recurrence_rule, recurrence_interval, subtasks } = req.body;
      if (!name || !title) return res.status(400).json({ error: "Name and title required." });
      if (priority && !VALID_PRIORITIES.includes(priority)) return res.status(400).json({ error: "Invalid priority." });
      if (horizon && !VALID_HORIZONS.includes(horizon)) return res.status(400).json({ error: "Invalid horizon." });
      const r = await pool.query(
        "INSERT INTO todo_templates (name, title, description, priority, horizon, category, recurring, recurrence_rule, recurrence_interval, subtasks) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
        [name, title, description || null, priority || "medium", horizon || "short", category || null, recurring || false, recurrence_rule || null, recurrence_interval || 1, JSON.stringify(subtasks || [])]
      );
      res.json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.patch("/api/todo-templates/:id", async (req, res) => {
    try {
      const { name, title, description, priority, horizon, category, recurring, recurrence_rule, recurrence_interval, subtasks } = req.body;
      const fields = []; const params = []; let idx = 1;
      if (name !== undefined) { fields.push(`name = $${idx++}`); params.push(name); }
      if (title !== undefined) { fields.push(`title = $${idx++}`); params.push(title); }
      if (description !== undefined) { fields.push(`description = $${idx++}`); params.push(description); }
      if (priority !== undefined) { fields.push(`priority = $${idx++}`); params.push(priority); }
      if (horizon !== undefined) { fields.push(`horizon = $${idx++}`); params.push(horizon); }
      if (category !== undefined) { fields.push(`category = $${idx++}`); params.push(category); }
      if (recurring !== undefined) { fields.push(`recurring = $${idx++}`); params.push(recurring); }
      if (recurrence_rule !== undefined) { fields.push(`recurrence_rule = $${idx++}`); params.push(recurrence_rule); }
      if (recurrence_interval !== undefined) { fields.push(`recurrence_interval = $${idx++}`); params.push(recurrence_interval); }
      if (subtasks !== undefined) { fields.push(`subtasks = $${idx++}`); params.push(JSON.stringify(subtasks)); }
      if (!fields.length) return res.status(400).json({ error: "No fields." });
      params.push(req.params.id);
      const r = await pool.query(`UPDATE todo_templates SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`, params);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.delete("/api/todo-templates/:id", async (req, res) => {
    try {
      const r = await pool.query("DELETE FROM todo_templates WHERE id = $1 RETURNING id", [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post("/api/todo-templates/:id/apply", async (req, res) => {
    try {
      const template = (await pool.query("SELECT * FROM todo_templates WHERE id = $1", [req.params.id])).rows[0];
      if (!template) return res.status(404).json({ error: "Template not found." });
      const overrides = req.body || {};
      const r = await pool.query(
        "INSERT INTO todos (title, description, priority, horizon, category, due_date, recurring, recurrence_rule, recurrence_interval) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
        [overrides.title || template.title, overrides.description || template.description, overrides.priority || template.priority, overrides.horizon || template.horizon, overrides.category || template.category, overrides.due_date || null, template.recurring, template.recurrence_rule, template.recurrence_interval]
      );
      const todo = r.rows[0];
      const subs = template.subtasks || [];
      for (const sub of subs) {
        await pool.query("INSERT INTO subtasks (todo_id, title) VALUES ($1, $2)", [todo.id, typeof sub === "string" ? sub : sub.title]);
      }
      res.json(todo);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
};
