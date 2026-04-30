// ============================================================================
// Per-sistant — Todo Routes
// ============================================================================

const express = require("express");
const { advanceRecurrence, fireWebhooks, sendSlackNotification, runAutomations } = require("../helpers");

module.exports = function ({ pool, config }) {
  const router = express.Router();
  const { VALID_PRIORITIES, VALID_HORIZONS, VALID_RECURRENCE_RULES, MAX_PAGINATION_LIMIT, MAX_TITLE_LENGTH, MAX_BODY_LENGTH } = config;

  // ============================================================================
  // API — Todos CRUD
  // ============================================================================

  router.get("/api/todos", async (req, res) => {
    try {
      const { horizon, priority, completed, category, limit, offset } = req.query;
      let where = ["deleted_at IS NULL"];
      let params = [];
      let idx = 1;
      if (horizon) { where.push(`horizon = $${idx++}`); params.push(horizon); }
      if (priority) { where.push(`priority = $${idx++}`); params.push(priority); }
      if (completed !== undefined) { where.push(`completed = $${idx++}`); params.push(completed === "true"); }
      if (category) { where.push(`category = $${idx++}`); params.push(category); }
      const clause = "WHERE " + where.join(" AND ");
      let pagination = "";
      if (limit) { pagination += ` LIMIT $${idx++}`; params.push(Math.min(Math.max(1, parseInt(limit, 10) || 20), MAX_PAGINATION_LIMIT)); }
      if (offset) { pagination += ` OFFSET $${idx++}`; params.push(Math.max(0, parseInt(offset, 10) || 0)); }
      const r = await pool.query(`SELECT * FROM todos ${clause} ORDER BY completed ASC, sort_order ASC, CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at DESC${pagination}`, params);
      res.json(r.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/api/todos", async (req, res) => {
    try {
      const { title, description, priority, horizon, category, due_date, recurring, recurrence_rule, recurrence_interval } = req.body;
      if (!title) return res.status(400).json({ error: "Title is required." });
      if (title.length > MAX_TITLE_LENGTH) return res.status(400).json({ error: `Title too long. Maximum ${MAX_TITLE_LENGTH} characters.` });
      if (description && description.length > MAX_BODY_LENGTH) return res.status(400).json({ error: `Description too long. Maximum ${MAX_BODY_LENGTH} characters.` });
      if (priority && !VALID_PRIORITIES.includes(priority)) return res.status(400).json({ error: "Invalid priority. Must be: " + VALID_PRIORITIES.join(", ") });
      if (horizon && !VALID_HORIZONS.includes(horizon)) return res.status(400).json({ error: "Invalid horizon. Must be: " + VALID_HORIZONS.join(", ") });
      if (recurrence_rule && !VALID_RECURRENCE_RULES.includes(recurrence_rule)) return res.status(400).json({ error: "Invalid recurrence rule. Must be: " + VALID_RECURRENCE_RULES.join(", ") });
      const r = await pool.query(
        `INSERT INTO todos (title, description, priority, horizon, category, due_date, recurring, recurrence_rule, recurrence_interval) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [title, description || null, priority || "medium", horizon || "short", category || null, due_date || null, recurring || false, recurrence_rule || null, recurrence_interval || 1]
      );
      runAutomations('todo_created', r.rows[0], 'todo').catch(() => {});
      fireWebhooks('todo_created', r.rows[0]).catch(() => {});
      res.json(r.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch("/api/todos/:id", async (req, res) => {
    try {
      const { title, description, priority, horizon, category, due_date, completed, sort_order, recurring, recurrence_rule } = req.body;
      if (priority !== undefined && !VALID_PRIORITIES.includes(priority)) return res.status(400).json({ error: "Invalid priority. Must be: " + VALID_PRIORITIES.join(", ") });
      if (horizon !== undefined && !VALID_HORIZONS.includes(horizon)) return res.status(400).json({ error: "Invalid horizon. Must be: " + VALID_HORIZONS.join(", ") });
      if (recurrence_rule !== undefined && recurrence_rule !== null && !VALID_RECURRENCE_RULES.includes(recurrence_rule)) return res.status(400).json({ error: "Invalid recurrence rule. Must be: " + VALID_RECURRENCE_RULES.join(", ") });
      const fields = [];
      const params = [];
      let idx = 1;
      if (title !== undefined) { fields.push(`title = $${idx++}`); params.push(title); }
      if (description !== undefined) { fields.push(`description = $${idx++}`); params.push(description); }
      if (priority !== undefined) { fields.push(`priority = $${idx++}`); params.push(priority); }
      if (horizon !== undefined) { fields.push(`horizon = $${idx++}`); params.push(horizon); }
      if (category !== undefined) { fields.push(`category = $${idx++}`); params.push(category); }
      if (due_date !== undefined) { fields.push(`due_date = $${idx++}`); params.push(due_date || null); }
      if (sort_order !== undefined) { fields.push(`sort_order = $${idx++}`); params.push(sort_order); }
      if (recurring !== undefined) { fields.push(`recurring = $${idx++}`); params.push(recurring); }
      if (recurrence_rule !== undefined) { fields.push(`recurrence_rule = $${idx++}`); params.push(recurrence_rule); }
      if (req.body.recurrence_interval !== undefined) { fields.push(`recurrence_interval = $${idx++}`); params.push(req.body.recurrence_interval); }
      if (req.body.snoozed_until !== undefined) { fields.push(`snoozed_until = $${idx++}`); params.push(req.body.snoozed_until); }
      if (req.body.location_name !== undefined) { fields.push(`location_name = $${idx++}`); params.push(req.body.location_name); }
      if (req.body.location_lat !== undefined) { fields.push(`location_lat = $${idx++}`); params.push(req.body.location_lat); }
      if (req.body.location_lng !== undefined) { fields.push(`location_lng = $${idx++}`); params.push(req.body.location_lng); }
      if (req.body.location_radius !== undefined) { fields.push(`location_radius = $${idx++}`); params.push(req.body.location_radius); }
      if (completed !== undefined) {
        fields.push(`completed = $${idx++}`); params.push(completed);
        fields.push(`completed_at = $${idx++}`); params.push(completed ? new Date().toISOString() : null);
      }
      if (!fields.length) return res.status(400).json({ error: "No fields to update." });
      params.push(req.params.id);
      const r = await pool.query(`UPDATE todos SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`, params);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      if (completed) {
        runAutomations('todo_completed', r.rows[0], 'todo').catch(() => {});
        fireWebhooks('todo_completed', r.rows[0]).catch(() => {});
      }
      res.json(r.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete("/api/todos/:id", async (req, res) => {
    try {
      const r = await pool.query("UPDATE todos SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id", [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================================
  // API — Subtasks
  // ============================================================================

  router.get("/api/todos/:id/subtasks", async (req, res) => {
    try {
      const r = await pool.query("SELECT * FROM subtasks WHERE todo_id = $1 ORDER BY sort_order, id", [req.params.id]);
      res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post("/api/todos/:id/subtasks", async (req, res) => {
    try {
      const { title } = req.body;
      if (!title) return res.status(400).json({ error: "Title is required." });
      const r = await pool.query("INSERT INTO subtasks (todo_id, title) VALUES ($1, $2) RETURNING *", [req.params.id, title]);
      res.json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.patch("/api/subtasks/:id", async (req, res) => {
    try {
      const { title, completed, sort_order } = req.body;
      const fields = []; const params = []; let idx = 1;
      if (title !== undefined) { fields.push(`title = $${idx++}`); params.push(title); }
      if (completed !== undefined) { fields.push(`completed = $${idx++}`); params.push(completed); }
      if (sort_order !== undefined) { fields.push(`sort_order = $${idx++}`); params.push(sort_order); }
      if (!fields.length) return res.status(400).json({ error: "No fields." });
      params.push(req.params.id);
      const r = await pool.query(`UPDATE subtasks SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`, params);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.delete("/api/subtasks/:id", async (req, res) => {
    try {
      const r = await pool.query("DELETE FROM subtasks WHERE id = $1 RETURNING id", [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ============================================================================
  // API — Recurring tasks
  // ============================================================================

  router.post("/api/todos/:id/complete-recurring", async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query("SELECT * FROM todos WHERE id = $1 FOR UPDATE", [req.params.id]);
      if (!r.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Not found." }); }
      const todo = r.rows[0];
      if (!todo.recurring || !todo.recurrence_rule) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Not a recurring task." });
      }
      if (todo.completed) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Task already completed." }); }
      // Calculate streak: check if completed on time (before or on due date)
      const today = new Date().toISOString().split("T")[0];
      const isOnTime = !todo.due_date || today <= todo.due_date.toISOString().split("T")[0];
      let newStreak = isOnTime ? (todo.streak_count || 0) + 1 : 1;
      let newBest = Math.max(newStreak, todo.best_streak || 0);
      // Mark current as completed with streak info
      await client.query("UPDATE todos SET completed = true, completed_at = now(), streak_count = $2, best_streak = $3, last_streak_date = $4 WHERE id = $1",
        [todo.id, newStreak, newBest, today]);
      // Calculate next due date using interval
      const rule = todo.recurrence_rule;
      const interval = todo.recurrence_interval || 1;
      let nextDue = todo.due_date ? new Date(todo.due_date) : new Date();
      nextDue = advanceRecurrence(nextDue, rule, interval);
      // Create next instance with streak carried forward
      const n = await client.query(
        `INSERT INTO todos (title, description, priority, horizon, category, due_date, recurring, recurrence_rule, recurrence_interval, recurrence_parent_id, streak_count, best_streak, last_streak_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [todo.title, todo.description, todo.priority, todo.horizon, todo.category,
         nextDue.toISOString().split("T")[0], true, rule, interval, todo.recurrence_parent_id || todo.id,
         newStreak, newBest, today]
      );
      await client.query("COMMIT");
      fireWebhooks('todo_completed', todo).catch(() => {});
      res.json({ completed: todo, next: n.rows[0], streak: newStreak, best_streak: newBest });
    } catch (err) { await client.query("ROLLBACK").catch(() => {}); res.status(500).json({ error: err.message }); }
    finally { client.release(); }
  });

  // Skip recurring task (mark skipped, create next without breaking streak)
  router.post("/api/todos/:id/skip-recurring", async (req, res) => {
    try {
      const r = await pool.query("SELECT * FROM todos WHERE id = $1", [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      const todo = r.rows[0];
      if (!todo.recurring || !todo.recurrence_rule) return res.status(400).json({ error: "Not a recurring task." });
      // Mark as completed but increment skip counter (streak preserved but not incremented)
      await pool.query("UPDATE todos SET completed = true, completed_at = now(), skipped_count = COALESCE(skipped_count,0) + 1 WHERE id = $1", [todo.id]);
      const rule = todo.recurrence_rule;
      const interval = todo.recurrence_interval || 1;
      let nextDue = todo.due_date ? new Date(todo.due_date) : new Date();
      nextDue = advanceRecurrence(nextDue, rule, interval);
      const n = await pool.query(
        `INSERT INTO todos (title, description, priority, horizon, category, due_date, recurring, recurrence_rule, recurrence_interval, recurrence_parent_id, streak_count, best_streak, last_streak_date, skipped_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [todo.title, todo.description, todo.priority, todo.horizon, todo.category,
         nextDue.toISOString().split("T")[0], true, rule, interval, todo.recurrence_parent_id || todo.id,
         todo.streak_count || 0, todo.best_streak || 0, todo.last_streak_date, (todo.skipped_count || 0) + 1]
      );
      res.json({ skipped: todo, next: n.rows[0] });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Snooze recurring task (postpone due date)
  router.post("/api/todos/:id/snooze", async (req, res) => {
    try {
      const { until } = req.body;
      if (!until) return res.status(400).json({ error: "Snooze date (until) is required." });
      const r = await pool.query("UPDATE todos SET snoozed_until = $1, due_date = $1 WHERE id = $2 AND deleted_at IS NULL RETURNING *", [until, req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ============================================================================
  // API — Streak/Habit Stats
  // ============================================================================

  router.get("/api/streaks", async (req, res) => {
    try {
      // Get active recurring tasks with their current streaks
      const active = await pool.query(
        "SELECT id, title, recurrence_rule, streak_count, best_streak, last_streak_date, due_date FROM todos WHERE deleted_at IS NULL AND recurring = true AND completed = false ORDER BY streak_count DESC"
      );
      // Get top streaks across all recurring tasks (including completed ones)
      const top = await pool.query(
        "SELECT DISTINCT ON (COALESCE(recurrence_parent_id, id)) COALESCE(recurrence_parent_id, id) as chain_id, title, best_streak, streak_count, recurrence_rule FROM todos WHERE recurring = true AND best_streak > 0 ORDER BY COALESCE(recurrence_parent_id, id), best_streak DESC"
      );
      res.json({ active: active.rows, top_streaks: top.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ============================================================================
  // API — Task Dependencies
  // ============================================================================

  router.get("/api/todos/:id/dependencies", async (req, res) => {
    try {
      const [blockedBy, blocking] = await Promise.all([
        pool.query(`SELECT td.id as dep_id, td.depends_on_id, t.title, t.completed FROM task_dependencies td JOIN todos t ON t.id = td.depends_on_id WHERE td.todo_id = $1`, [req.params.id]),
        pool.query(`SELECT td.id as dep_id, td.todo_id, t.title, t.completed FROM task_dependencies td JOIN todos t ON t.id = td.todo_id WHERE td.depends_on_id = $1`, [req.params.id]),
      ]);
      res.json({ blocked_by: blockedBy.rows, blocking: blocking.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post("/api/todos/:id/dependencies", async (req, res) => {
    try {
      const { depends_on_id } = req.body;
      if (!depends_on_id) return res.status(400).json({ error: "depends_on_id is required." });
      if (parseInt(depends_on_id) === parseInt(req.params.id)) return res.status(400).json({ error: "A task cannot depend on itself." });
      // Check both tasks exist
      const [task, dep] = await Promise.all([
        pool.query("SELECT id FROM todos WHERE id = $1 AND deleted_at IS NULL", [req.params.id]),
        pool.query("SELECT id FROM todos WHERE id = $1 AND deleted_at IS NULL", [depends_on_id]),
      ]);
      if (!task.rows.length || !dep.rows.length) return res.status(404).json({ error: "Task not found." });
      // Check for circular dependency
      const chain = await pool.query("SELECT * FROM task_dependencies WHERE todo_id = $1 AND depends_on_id = $2", [depends_on_id, req.params.id]);
      if (chain.rows.length) return res.status(400).json({ error: "Circular dependency: that task already depends on this one." });
      const r = await pool.query(
        "INSERT INTO task_dependencies (todo_id, depends_on_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING *",
        [req.params.id, depends_on_id]
      );
      if (!r.rows.length) return res.status(409).json({ error: "Dependency already exists." });
      res.json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.delete("/api/dependencies/:id", async (req, res) => {
    try {
      const r = await pool.query("DELETE FROM task_dependencies WHERE id = $1 RETURNING id", [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ============================================================================
  // API — Todo Categories
  // ============================================================================

  router.get("/api/todo-categories", async (req, res) => {
    try {
      const r = await pool.query("SELECT DISTINCT category FROM todos WHERE deleted_at IS NULL AND category IS NOT NULL AND category != '' ORDER BY category");
      const defaults = ["work", "personal", "health", "finance", "errands", "home", "learning"];
      const dbCats = r.rows.map(row => row.category);
      const all = [...new Set([...defaults, ...dbCats])].sort();
      res.json(all);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ============================================================================
  // API — Todo Reorder
  // ============================================================================

  router.post("/api/todos/reorder", async (req, res) => {
    try {
      const { order } = req.body; // array of {id, sort_order}
      if (!Array.isArray(order)) return res.status(400).json({ error: "order array required." });
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const item of order) {
          await client.query("UPDATE todos SET sort_order = $1 WHERE id = $2", [item.sort_order, item.id]);
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally { client.release(); }
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
};
