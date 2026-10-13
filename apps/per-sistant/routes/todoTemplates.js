const express = require("express");

const { VALID_PRIORITIES, VALID_HORIZONS, VALID_RECURRENCE_RULES } = require("../config");
const { serverError } = require("../errors");

// PD-13: a template is validated like a todo (POST, and each PATCHed field),
// because apply copies it straight into todos — an unknown recurrence_rule
// ("biweekly") made a todo advanceRecurrence never moved forward, and a bad
// priority/horizon only failed at apply time with a 500.
function validateTemplateFields(b, { partial = false } = {}) {
  const has = (k) => b[k] !== undefined && b[k] !== null && b[k] !== "";
  if (!partial && (!b.name || !b.title)) return "Name and title required.";
  if (partial && b.name !== undefined && !String(b.name || "").trim()) return "Name can't be empty.";
  if (partial && b.title !== undefined && !String(b.title || "").trim()) return "Title can't be empty.";
  if (has("priority") && !VALID_PRIORITIES.includes(b.priority)) return "Invalid priority. Must be: " + VALID_PRIORITIES.join(", ");
  if (has("horizon") && !VALID_HORIZONS.includes(b.horizon)) return "Invalid horizon. Must be: " + VALID_HORIZONS.join(", ");
  if (has("recurrence_rule") && !VALID_RECURRENCE_RULES.includes(b.recurrence_rule)) return "Invalid recurrence rule. Must be: " + VALID_RECURRENCE_RULES.join(", ");
  if (has("recurrence_interval") && (!Number.isInteger(b.recurrence_interval) || b.recurrence_interval < 1 || b.recurrence_interval > 365)) {
    return "Invalid recurrence interval. Must be an integer between 1 and 365.";
  }
  if (b.recurring === true && !partial && !has("recurrence_rule")) return "A recurring template needs a recurrence rule.";
  if (b.subtasks !== undefined && b.subtasks !== null) {
    if (!Array.isArray(b.subtasks)) return "subtasks must be an array.";
    for (const sub of b.subtasks) {
      const t = typeof sub === "string" ? sub : sub && sub.title;
      if (typeof t !== "string" || !t.trim()) return "Every subtask needs a title.";
    }
  }
  return null;
}

module.exports = function ({ pool }) {
  const router = express.Router();

  router.get("/api/todo-templates", async (req, res) => {
    try {
      const r = await pool.query("SELECT * FROM todo_templates ORDER BY name ASC");
      res.json(r.rows);
    } catch (err) { serverError(res, err); }
  });

  router.post("/api/todo-templates", async (req, res) => {
    try {
      const { name, title, description, priority, horizon, category, recurring, recurrence_rule, recurrence_interval, subtasks } = req.body;
      const invalid = validateTemplateFields(req.body || {});
      if (invalid) return res.status(400).json({ error: invalid });
      const r = await pool.query(
        "INSERT INTO todo_templates (name, title, description, priority, horizon, category, recurring, recurrence_rule, recurrence_interval, subtasks) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
        [name, title, description || null, priority || "medium", horizon || "short", category || null, recurring || false, recurrence_rule || null, recurrence_interval || 1, JSON.stringify(subtasks || [])]
      );
      res.json(r.rows[0]);
    } catch (err) { serverError(res, err); }
  });

  router.patch("/api/todo-templates/:id", async (req, res) => {
    try {
      const { name, title, description, priority, horizon, category, recurring, recurrence_rule, recurrence_interval, subtasks } = req.body;
      const invalid = validateTemplateFields(req.body || {}, { partial: true });
      if (invalid) return res.status(400).json({ error: invalid });
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
    } catch (err) { serverError(res, err); }
  });

  router.delete("/api/todo-templates/:id", async (req, res) => {
    try {
      const r = await pool.query("DELETE FROM todo_templates WHERE id = $1 RETURNING id", [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json({ ok: true });
    } catch (err) { serverError(res, err); }
  });

  router.post("/api/todo-templates/:id/apply", async (req, res) => {
    try {
      const template = (await pool.query("SELECT * FROM todo_templates WHERE id = $1", [req.params.id])).rows[0];
      if (!template) return res.status(404).json({ error: "Template not found." });
      const overrides = req.body || {};
      const merged = {
        title: overrides.title || template.title,
        priority: overrides.priority || template.priority,
        horizon: overrides.horizon || template.horizon,
        recurrence_rule: template.recurring ? template.recurrence_rule : null,
        recurrence_interval: template.recurrence_interval == null ? null : Number(template.recurrence_interval),
        subtasks: template.subtasks || [],
      };
      // A template saved before PD-13 can still hold a bad value — 400 with the
      // reason instead of a 500 halfway through.
      const invalid = validateTemplateFields(merged, { partial: true });
      if (invalid) return res.status(400).json({ error: "This template can't be applied: " + invalid });
      // One transaction (PD-13): a failing subtask insert used to leave the
      // todo committed without the rest of its subtasks.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const r = await client.query(
          "INSERT INTO todos (title, description, priority, horizon, category, due_date, recurring, recurrence_rule, recurrence_interval) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
          [merged.title, overrides.description || template.description, merged.priority, merged.horizon, overrides.category || template.category, overrides.due_date || null, !!template.recurring, merged.recurrence_rule, merged.recurrence_interval || 1]
        );
        const todo = r.rows[0];
        for (const sub of merged.subtasks) {
          await client.query("INSERT INTO subtasks (todo_id, title) VALUES ($1, $2)", [todo.id, typeof sub === "string" ? sub : sub.title]);
        }
        await client.query("COMMIT");
        res.json(todo);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally { client.release(); }
    } catch (err) { serverError(res, err); }
  });

  return router;
};

module.exports.validateTemplateFields = validateTemplateFields;
