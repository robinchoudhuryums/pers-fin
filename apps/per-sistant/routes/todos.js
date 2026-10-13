// ============================================================================
// Per-sistant — Todo Routes
// ============================================================================

const express = require("express");
const { recurrenceAnchorDay, ymdLocal, nextDueAfter, fireWebhooks, sendSlackNotification, runAutomations } = require("../helpers");
const { todayStr } = require("./health");

const { serverError } = require("../errors");

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
      // subtask_total / subtask_done let callers (dashboard task cards, todos
      // list) render a progress bar without an N+1 fetch per todo. Unqualified
      // column refs in ${clause}/ORDER BY still resolve against the aliased base
      // table (todos t) since it's the only table in scope.
      const r = await pool.query(`SELECT t.*,
          (SELECT COUNT(*)::int FROM subtasks s WHERE s.todo_id = t.id) AS subtask_total,
          (SELECT COUNT(*)::int FROM subtasks s WHERE s.todo_id = t.id AND s.completed) AS subtask_done
        FROM todos t ${clause} ORDER BY completed ASC, sort_order ASC, CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at DESC${pagination}`, params);
      res.json(r.rows);
    } catch (err) {
      serverError(res, err);
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
      // A zero/negative interval makes recurrence projections stand still or
      // run backwards (DB CHECK chk_todos_recurrence_interval backs this up).
      if (recurrence_interval !== undefined && recurrence_interval !== null &&
          (!Number.isInteger(recurrence_interval) || recurrence_interval < 1 || recurrence_interval > 365)) {
        return res.status(400).json({ error: "Invalid recurrence interval. Must be an integer between 1 and 365." });
      }
      // PD-5: the form sends location_* (geofence reminder) — they used to be
      // dropped here, so a new task silently saved without its location.
      const loc = parseLocationFields(req.body);
      if (loc.error) return res.status(400).json({ error: loc.error });
      const r = await pool.query(
        `INSERT INTO todos (title, description, priority, horizon, category, due_date, recurring, recurrence_rule, recurrence_interval,
                            location_name, location_lat, location_lng, location_radius)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13, 200)) RETURNING *`,
        [title, description || null, priority || "medium", horizon || "short", category || null, due_date || null, recurring || false, recurrence_rule || null, recurrence_interval || 1,
         loc.location_name, loc.location_lat, loc.location_lng, loc.location_radius]
      );
      runAutomations('todo_created', r.rows[0], 'todo').catch(() => {});
      fireWebhooks('todo_created', r.rows[0]).catch(() => {});
      res.json(r.rows[0]);
    } catch (err) {
      serverError(res, err);
    }
  });

  router.patch("/api/todos/:id", async (req, res) => {
    try {
      const { title, description, priority, horizon, category, due_date, completed, sort_order, recurring, recurrence_rule } = req.body;
      if (priority !== undefined && !VALID_PRIORITIES.includes(priority)) return res.status(400).json({ error: "Invalid priority. Must be: " + VALID_PRIORITIES.join(", ") });
      if (horizon !== undefined && !VALID_HORIZONS.includes(horizon)) return res.status(400).json({ error: "Invalid horizon. Must be: " + VALID_HORIZONS.join(", ") });
      if (recurrence_rule !== undefined && recurrence_rule !== null && !VALID_RECURRENCE_RULES.includes(recurrence_rule)) return res.status(400).json({ error: "Invalid recurrence rule. Must be: " + VALID_RECURRENCE_RULES.join(", ") });
      if (req.body.recurrence_interval !== undefined && req.body.recurrence_interval !== null &&
          (!Number.isInteger(req.body.recurrence_interval) || req.body.recurrence_interval < 1 || req.body.recurrence_interval > 365)) {
        return res.status(400).json({ error: "Invalid recurrence interval. Must be an integer between 1 and 365." });
      }
      const fields = [];
      const params = [];
      let idx = 1;
      if (title !== undefined) { fields.push(`title = $${idx++}`); params.push(title); }
      if (description !== undefined) { fields.push(`description = $${idx++}`); params.push(description); }
      if (priority !== undefined) { fields.push(`priority = $${idx++}`); params.push(priority); }
      if (horizon !== undefined) { fields.push(`horizon = $${idx++}`); params.push(horizon); }
      if (category !== undefined) { fields.push(`category = $${idx++}`); params.push(category); }
      if (due_date !== undefined) {
        fields.push(`due_date = $${idx++}`); params.push(due_date || null);
        // An explicit due-date edit sets a NEW schedule: drop the stored
        // month-end anchor so the next instance follows the new day (PD-2).
        // (Snooze changes due_date via its own route and keeps the anchor.)
        fields.push("recurrence_anchor_day = NULL");
      }
      if (sort_order !== undefined) { fields.push(`sort_order = $${idx++}`); params.push(sort_order); }
      if (recurring !== undefined) { fields.push(`recurring = $${idx++}`); params.push(recurring); }
      if (recurrence_rule !== undefined) { fields.push(`recurrence_rule = $${idx++}`); params.push(recurrence_rule); }
      if (req.body.recurrence_interval !== undefined) { fields.push(`recurrence_interval = $${idx++}`); params.push(req.body.recurrence_interval); }
      if (req.body.snoozed_until !== undefined) { fields.push(`snoozed_until = $${idx++}`); params.push(req.body.snoozed_until); }
      const loc = parseLocationFields(req.body);
      if (loc.error) return res.status(400).json({ error: loc.error });
      if (req.body.location_name !== undefined) { fields.push(`location_name = $${idx++}`); params.push(loc.location_name); }
      if (req.body.location_lat !== undefined) { fields.push(`location_lat = $${idx++}`); params.push(loc.location_lat); }
      if (req.body.location_lng !== undefined) { fields.push(`location_lng = $${idx++}`); params.push(loc.location_lng); }
      if (req.body.location_radius !== undefined) { fields.push(`location_radius = $${idx++}`); params.push(loc.location_radius); }
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
      serverError(res, err);
    }
  });

  router.delete("/api/todos/:id", async (req, res) => {
    try {
      const r = await pool.query("UPDATE todos SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id", [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json({ ok: true });
    } catch (err) {
      serverError(res, err);
    }
  });

  // ============================================================================
  // API — Subtasks
  // ============================================================================

  router.get("/api/todos/:id/subtasks", async (req, res) => {
    try {
      const r = await pool.query("SELECT * FROM subtasks WHERE todo_id = $1 ORDER BY sort_order, id", [req.params.id]);
      res.json(r.rows);
    } catch (err) { serverError(res, err); }
  });

  router.post("/api/todos/:id/subtasks", async (req, res) => {
    try {
      const { title } = req.body;
      if (!title) return res.status(400).json({ error: "Title is required." });
      const r = await pool.query("INSERT INTO subtasks (todo_id, title) VALUES ($1, $2) RETURNING *", [req.params.id, title]);
      res.json(r.rows[0]);
    } catch (err) { serverError(res, err); }
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
    } catch (err) { serverError(res, err); }
  });

  router.delete("/api/subtasks/:id", async (req, res) => {
    try {
      const r = await pool.query("DELETE FROM subtasks WHERE id = $1 RETURNING id", [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json({ ok: true });
    } catch (err) { serverError(res, err); }
  });

  // ============================================================================
  // API — Recurring tasks
  // ============================================================================

  router.post("/api/todos/:id/complete-recurring", async (req, res) => {
    try {
      const out = await completeRecurringTodo(pool, req.params.id);
      if (out.error) return res.status(out.status).json({ error: out.error });
      res.json({ completed: out.completed, next: out.next, streak: out.streak, best_streak: out.best_streak });
    } catch (err) { serverError(res, err); }
  });

  // Undo a recurring completion (PUI-3): re-open the completed instance and
  // remove the next instance that completion generated — only while that
  // instance is still untouched — so Undo doesn't leave two open copies.
  router.post("/api/todos/:id/undo-complete-recurring", async (req, res) => {
    try {
      const out = await undoCompleteRecurringTodo(pool, req.params.id, req.body && req.body.next_id);
      if (out.error) return res.status(out.status).json({ error: out.error });
      res.json(out);
    } catch (err) { serverError(res, err); }
  });

  // Skip recurring task (mark skipped, create next without breaking streak)
  router.post("/api/todos/:id/skip-recurring", async (req, res) => {
    try {
      const out = await skipRecurringTodo(pool, req.params.id);
      if (out.error) return res.status(out.status).json({ error: out.error });
      res.json({ skipped: out.skipped, next: out.next });
    } catch (err) { serverError(res, err); }
  });

  // Snooze recurring task (postpone due date)
  router.post("/api/todos/:id/snooze", async (req, res) => {
    try {
      const { until } = req.body;
      if (!until) return res.status(400).json({ error: "Snooze date (until) is required." });
      const r = await pool.query("UPDATE todos SET snoozed_until = $1, due_date = $1 WHERE id = $2 AND deleted_at IS NULL RETURNING *", [until, req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json(r.rows[0]);
    } catch (err) { serverError(res, err); }
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
    } catch (err) { serverError(res, err); }
  });

  // ============================================================================
  // API — Task Dependencies
  // ============================================================================

  router.get("/api/todos/:id/dependencies", async (req, res) => {
    try {
      const [blockedBy, blocking] = await Promise.all([
        // A trashed task neither blocks nor is blocked (PD-12): a deleted
        // blocker used to keep its dependent "blocked (1)" forever.
        pool.query(`SELECT td.id as dep_id, td.depends_on_id, t.title, t.completed FROM task_dependencies td JOIN todos t ON t.id = td.depends_on_id WHERE td.todo_id = $1 AND t.deleted_at IS NULL`, [req.params.id]),
        pool.query(`SELECT td.id as dep_id, td.todo_id, t.title, t.completed FROM task_dependencies td JOIN todos t ON t.id = td.todo_id WHERE td.depends_on_id = $1 AND t.deleted_at IS NULL`, [req.params.id]),
      ]);
      res.json({ blocked_by: blockedBy.rows, blocking: blocking.rows });
    } catch (err) { serverError(res, err); }
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
      // Circular dependency (PD-12): refuse when this task is already
      // reachable from the new blocker through ANY chain (A→B→C→A), not just a
      // direct A↔B pair. UNION (not UNION ALL) ends the walk on an existing loop.
      const chain = await pool.query(
        `WITH RECURSIVE reach(id) AS (
           SELECT depends_on_id FROM task_dependencies WHERE todo_id = $1
           UNION
           SELECT td.depends_on_id FROM task_dependencies td JOIN reach ON td.todo_id = reach.id
         )
         SELECT 1 FROM reach WHERE id = $2 LIMIT 1`, [depends_on_id, req.params.id]);
      if (chain.rows.length) return res.status(400).json({ error: "Circular dependency: that task already depends on this one (directly or through other tasks)." });
      const r = await pool.query(
        "INSERT INTO task_dependencies (todo_id, depends_on_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING *",
        [req.params.id, depends_on_id]
      );
      if (!r.rows.length) return res.status(409).json({ error: "Dependency already exists." });
      res.json(r.rows[0]);
    } catch (err) { serverError(res, err); }
  });

  router.delete("/api/dependencies/:id", async (req, res) => {
    try {
      const r = await pool.query("DELETE FROM task_dependencies WHERE id = $1 RETURNING id", [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json({ ok: true });
    } catch (err) { serverError(res, err); }
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
    } catch (err) { serverError(res, err); }
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
    } catch (err) { serverError(res, err); }
  });

  return router;
};

// ============================================================================
// Recurring completion / skip — shared by the routes above and bulk complete
// ============================================================================
// Both run in one transaction with the row locked (FOR UPDATE) and refuse an
// already-completed row, so a double-tap, a race with the midnight roll, or a
// bulk + single click can't create two next instances (PS-11 / PB-11). The next
// due date is caught up past today (nextDueAfter, PD-3).

// The next instance carries the chain's location reminder (PD-5) — appended as
// $15-$18 so the existing parameter positions are unchanged.
const INSERT_NEXT = `INSERT INTO todos (title, description, priority, horizon, category, due_date, recurring, recurrence_rule, recurrence_interval, recurrence_parent_id, streak_count, best_streak, last_streak_date, skipped_count, recurrence_anchor_day,
    location_name, location_lat, location_lng, location_radius)
  VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,COALESCE($18, 200)) RETURNING *`;
const locationParams = (t) => [t.location_name || null, t.location_lat == null ? null : t.location_lat, t.location_lng == null ? null : t.location_lng, t.location_radius == null ? null : t.location_radius];

// PD-5: validate location_* the way the DB CHECKs do (chk_location_lat/lng/
// radius) so a bad value is a 400, not a 500. Absent keys stay undefined.
function parseLocationFields(b) {
  const out = {};
  if (b.location_name !== undefined) {
    if (b.location_name !== null && typeof b.location_name !== "string") return { error: "location_name must be a string." };
    out.location_name = b.location_name ? String(b.location_name).slice(0, 200) : null;
  } else out.location_name = null;
  const num = (v) => (v === null || v === "" || v === undefined ? null : Number(v));
  for (const [k, lo, hi] of [["location_lat", -90, 90], ["location_lng", -180, 180]]) {
    const v = num(b[k]);
    if (v !== null && (!Number.isFinite(v) || v < lo || v > hi)) return { error: `${k} must be a number between ${lo} and ${hi}.` };
    out[k] = v;
  }
  const rad = num(b.location_radius);
  if (rad !== null && (!Number.isFinite(rad) || rad <= 0 || rad > 100000)) return { error: "location_radius must be a positive number of meters." };
  out.location_radius = rad === null ? null : Math.round(rad);
  return out;
}

async function lockRecurring(client, id) {
  const r = await client.query("SELECT * FROM todos WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [id]);
  if (!r.rows.length) return { status: 404, error: "Not found." };
  const todo = r.rows[0];
  if (!todo.recurring || !todo.recurrence_rule) return { status: 400, error: "Not a recurring task." };
  if (todo.completed) return { status: 400, error: "Task already completed." };
  return { todo };
}

async function completeRecurringTodo(pool, id) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lock = await lockRecurring(client, id);
    if (lock.error) { await client.query("ROLLBACK"); return lock; }
    const todo = lock.todo;
    // Calculate streak: check if completed on time (before or on due date).
    // "Today" in APP_TIMEZONE (PD-4): the UTC date made a 6pm-Pacific
    // completion on the due date count as the NEXT day and reset the streak.
    // due_date read with local getters (node-pg DATE = local midnight).
    const today = todayStr();
    const isOnTime = !todo.due_date || today <= ymdLocal(new Date(todo.due_date));
    const newStreak = isOnTime ? (todo.streak_count || 0) + 1 : 1;
    const newBest = Math.max(newStreak, todo.best_streak || 0);
    await client.query("UPDATE todos SET completed = true, completed_at = now(), streak_count = $2, best_streak = $3, last_streak_date = $4 WHERE id = $1",
      [todo.id, newStreak, newBest, today]);
    // The chain keeps its ORIGINAL day-of-month (PD-2) and the next instance
    // is due after today (PD-3).
    const anchor = recurrenceAnchorDay(todo);
    const nextDue = nextDueAfter(todo, today);
    const n = await client.query(INSERT_NEXT,
      [todo.title, todo.description, todo.priority, todo.horizon, todo.category,
       ymdLocal(nextDue), todo.recurrence_rule, todo.recurrence_interval || 1, todo.recurrence_parent_id || todo.id,
       newStreak, newBest, today, 0, anchor, ...locationParams(todo)]); // skipped_count starts at 0 (the column default) as before
    await client.query("COMMIT");
    fireWebhooks('todo_completed', todo).catch(() => {});
    // PD-6: completing a recurring task is a completion too.
    runAutomations('todo_completed', { ...todo, completed: true }, 'todo').catch(() => {});
    return { completed: todo, next: n.rows[0], streak: newStreak, best_streak: newBest };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally { client.release(); }
}

async function skipRecurringTodo(pool, id) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lock = await lockRecurring(client, id);
    if (lock.error) { await client.query("ROLLBACK"); return lock; }
    const todo = lock.todo;
    // Mark as completed but increment skip counter (streak preserved but not incremented)
    await client.query("UPDATE todos SET completed = true, completed_at = now(), skipped_count = COALESCE(skipped_count,0) + 1 WHERE id = $1", [todo.id]);
    const anchor = recurrenceAnchorDay(todo); // PD-2
    const nextDue = nextDueAfter(todo, todayStr()); // PD-3
    const n = await client.query(INSERT_NEXT,
      [todo.title, todo.description, todo.priority, todo.horizon, todo.category,
       ymdLocal(nextDue), todo.recurrence_rule, todo.recurrence_interval || 1, todo.recurrence_parent_id || todo.id,
       todo.streak_count || 0, todo.best_streak || 0, todo.last_streak_date, (todo.skipped_count || 0) + 1, anchor, ...locationParams(todo)]);
    await client.query("COMMIT");
    return { skipped: todo, next: n.rows[0] };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally { client.release(); }
}

async function undoCompleteRecurringTodo(pool, id, nextId) {
  const nid = parseInt(nextId, 10);
  if (!Number.isInteger(nid)) return { status: 400, error: "next_id is required." };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query("SELECT * FROM todos WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [id]);
    if (!cur.rows.length) { await client.query("ROLLBACK"); return { status: 404, error: "Not found." }; }
    const todo = cur.rows[0];
    if (!todo.recurring || !todo.completed || todo.missed) { await client.query("ROLLBACK"); return { status: 400, error: "That task isn't a completed recurring task." }; }
    const chain = todo.recurrence_parent_id || todo.id;
    // The generated instance: same chain, still open and unedited-by-completion.
    const del = await client.query(
      `DELETE FROM todos WHERE id = $1 AND recurrence_parent_id = $2 AND completed = false AND deleted_at IS NULL
         AND created_at >= now() - interval '1 day'
       RETURNING streak_count`, [nid, chain]);
    if (!del.rows.length) { await client.query("ROLLBACK"); return { status: 409, error: "The next instance has already changed — undo it by hand." }; }
    // Its streak_count is the value this completion set; step back by one.
    const prevStreak = Math.max(0, (del.rows[0].streak_count || 0) - 1);
    await client.query("UPDATE todos SET completed = false, completed_at = NULL, streak_count = $2 WHERE id = $1", [todo.id, prevStreak]);
    await client.query("COMMIT");
    return { ok: true, reopened: todo.id, removed_next: nid };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally { client.release(); }
}

module.exports.completeRecurringTodo = completeRecurringTodo;
module.exports.undoCompleteRecurringTodo = undoCompleteRecurringTodo;
module.exports.parseLocationFields = parseLocationFields;
module.exports.skipRecurringTodo = skipRecurringTodo;
