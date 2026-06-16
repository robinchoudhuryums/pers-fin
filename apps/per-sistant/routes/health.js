// ============================================================================
// Per-sistant — Health & Habits Routes
// ============================================================================
// Habit definitions + daily logs + measurement time series (db/020_health.sql).
//
// Streaks are computed at read time from habit_logs (never stored), so a
// backfilled log retroactively repairs a streak and nothing can drift.
// Schedule semantics:
//   daily        — due every day
//   weekdays     — due Mon–Fri
//   custom_days  — due on schedule_days (INT[] of 0=Sun..6=Sat)
//   weekly       — due until times_per_week completions land in the current
//                  week (weeks start Monday); streaks count whole weeks
// A "completed" day means value > 0 for boolean habits, or value >=
// target_value for quantity habits with a target. Today never BREAKS a
// streak while still unlogged — the day isn't over yet.

const express = require("express");

const { serverError } = require("../errors");

const MAX_HABIT_NAME = 200;
const MAX_METRIC_NAME = 50;
const MAX_NOTE_LENGTH = 2000;
const STREAK_MILESTONES = [7, 30, 100, 365];

// ---------------------------------------------------------------------------
// Pure date/streak helpers (exported for tests + notifications + briefing)
// ---------------------------------------------------------------------------
function todayStr() {
  return new Date().toISOString().split("T")[0];
}

function normDate(d) {
  if (typeof d === "string") return d.slice(0, 10);
  return new Date(d).toISOString().slice(0, 10);
}

function dowOf(dateStr) {
  return new Date(dateStr + "T00:00:00Z").getUTCDay();
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split("T")[0];
}

// Monday of the week containing dateStr — weekly habits count Mon–Sun weeks.
function weekKey(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const fromMonday = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - fromMonday);
  return d.toISOString().split("T")[0];
}

function isDueOn(habit, dateStr) {
  switch (habit.schedule) {
    case "weekdays": {
      const dow = dowOf(dateStr);
      return dow >= 1 && dow <= 5;
    }
    case "custom_days":
      return Array.isArray(habit.schedule_days) && habit.schedule_days.includes(dowOf(dateStr));
    default:
      // daily; weekly habits are loggable any day — weekly "dueness" is
      // decided by the week's remaining target (see gatherHealthSummary).
      return true;
  }
}

function meetsTarget(habit, value) {
  const v = Number(value);
  if (!(v > 0)) return false;
  if (habit.kind === "quantity" && habit.target_value != null) return v >= Number(habit.target_value);
  return true;
}

// logs: [{ log_date, value }] in any order. Returns { current_streak, best_streak }.
function computeStreaks(habit, logs, today = todayStr()) {
  const done = new Set();
  for (const l of logs) {
    if (meetsTarget(habit, l.value)) done.add(normDate(l.log_date));
  }

  if (habit.schedule === "weekly") {
    const target = habit.times_per_week || 1;
    const byWeek = new Map();
    for (const ds of done) {
      const wk = weekKey(ds);
      byWeek.set(wk, (byWeek.get(wk) || 0) + 1);
    }
    const thisWeek = weekKey(today);
    // Current streak: this week counts once the target is met; while still
    // short it's in-progress and neither counts nor breaks.
    let current = (byWeek.get(thisWeek) || 0) >= target ? 1 : 0;
    let wk = thisWeek;
    for (let guard = 0; guard < 6000; guard++) {
      wk = addDays(wk, -7);
      if ((byWeek.get(wk) || 0) >= target) current++;
      else break;
    }
    let best = current;
    if (byWeek.size) {
      const weeks = [...byWeek.keys()].sort();
      let w = weeks[0];
      let run = 0;
      for (let guard = 0; w <= thisWeek && guard < 6000; guard++) {
        if ((byWeek.get(w) || 0) >= target) {
          run++;
          if (run > best) best = run;
        } else if (w !== thisWeek) {
          run = 0;
        }
        w = addDays(w, 7);
      }
    }
    return { current_streak: current, best_streak: best };
  }

  // Daily-type schedules: consecutive DUE days completed, walking back from
  // today. Non-due days are skipped; an unlogged today doesn't break.
  let current = 0;
  let d = today;
  for (let guard = 0; guard < 40000; guard++) {
    if (isDueOn(habit, d)) {
      if (done.has(d)) current++;
      else if (d !== today) break;
    }
    d = addDays(d, -1);
  }
  let best = current;
  if (done.size) {
    const dates = [...done].sort();
    let dd = dates[0];
    let run = 0;
    for (let guard = 0; dd <= today && guard < 40000; guard++) {
      if (isDueOn(habit, dd)) {
        if (done.has(dd)) {
          run++;
          if (run > best) best = run;
        } else if (dd !== today) {
          run = 0;
        }
      }
      dd = addDays(dd, 1);
    }
  }
  return { current_streak: current, best_streak: best };
}

// ---------------------------------------------------------------------------
// Shared aggregator — used by GET /api/health/summary, the notification
// check, and the AI daily briefing so all three surfaces agree.
// ---------------------------------------------------------------------------
async function gatherHealthSummary(pool, today = todayStr()) {
  const habitsR = await pool.query(
    "SELECT * FROM habits WHERE is_active = true ORDER BY sort_order, id"
  );
  const habits = habitsR.rows;
  const latestMetricsR = await pool.query(
    "SELECT DISTINCT ON (metric) id, metric, value, unit, recorded_on, note FROM health_metrics ORDER BY metric, recorded_on DESC"
  );
  if (!habits.length) {
    return { habits: [], due_today: 0, done_today: 0, streaks_at_risk: [], latest_metrics: latestMetricsR.rows };
  }

  const logsR = await pool.query(
    "SELECT habit_id, log_date, value FROM habit_logs WHERE habit_id = ANY($1)",
    [habits.map((h) => h.id)]
  );
  const byHabit = new Map();
  for (const l of logsR.rows) {
    if (!byHabit.has(l.habit_id)) byHabit.set(l.habit_id, []);
    byHabit.get(l.habit_id).push(l);
  }

  const thisWeek = weekKey(today);
  const enriched = habits.map((h) => {
    const logs = byHabit.get(h.id) || [];
    const { current_streak, best_streak } = computeStreaks(h, logs, today);
    const todayLog = logs.find((l) => normDate(l.log_date) === today) || null;
    const doneToday = todayLog ? meetsTarget(h, todayLog.value) : false;
    let dueToday;
    if (h.schedule === "weekly") {
      const weekCount = logs.filter(
        (l) => meetsTarget(h, l.value) && weekKey(normDate(l.log_date)) === thisWeek
      ).length;
      dueToday = weekCount < (h.times_per_week || 1);
    } else {
      dueToday = isDueOn(h, today);
    }
    // Last 7 days (oldest first) for the page's weekly grid.
    const week = [];
    for (let i = 6; i >= 0; i--) {
      const ds = addDays(today, -i);
      const log = logs.find((l) => normDate(l.log_date) === ds) || null;
      week.push({
        date: ds,
        due: isDueOn(h, ds),
        value: log ? Number(log.value) : 0,
        met: log ? meetsTarget(h, log.value) : false,
      });
    }
    return {
      ...h,
      current_streak,
      best_streak,
      due_today: dueToday,
      done_today: doneToday,
      today_value: todayLog ? Number(todayLog.value) : 0,
      week,
    };
  });

  const due = enriched.filter((h) => h.due_today);
  const streaksAtRisk = due.filter((h) => !h.done_today && h.current_streak >= 3);
  return {
    habits: enriched,
    due_today: due.length,
    done_today: due.filter((h) => h.done_today).length,
    streaks_at_risk: streaksAtRisk.map((h) => ({ id: h.id, name: h.name, current_streak: h.current_streak })),
    latest_metrics: latestMetricsR.rows,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateHabitFields(body, { partial = false } = {}) {
  const errors = [];
  const out = {};
  const has = (k) => body[k] !== undefined;

  if (!partial || has("name")) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) errors.push("Name is required.");
    else if (name.length > MAX_HABIT_NAME) errors.push(`Name too long. Maximum ${MAX_HABIT_NAME} characters.`);
    else out.name = name;
  }
  if (has("description")) {
    if (body.description !== null && typeof body.description !== "string") errors.push("Description must be a string.");
    else out.description = body.description || null;
  }
  if (!partial || has("kind")) {
    const kind = body.kind || "boolean";
    if (!["boolean", "quantity"].includes(kind)) errors.push("Invalid kind. Must be: boolean, quantity");
    else out.kind = kind;
  }
  if (has("target_value") || (!partial && body.kind === "quantity")) {
    const t = body.target_value;
    if (t === null || t === undefined) out.target_value = null;
    else if (!Number.isFinite(Number(t)) || Number(t) <= 0) errors.push("target_value must be a positive number.");
    else out.target_value = Number(t);
  }
  if (has("unit")) {
    if (body.unit !== null && (typeof body.unit !== "string" || body.unit.length > 30)) errors.push("Unit must be a string of at most 30 characters.");
    else out.unit = body.unit || null;
  }
  if (!partial || has("schedule")) {
    const schedule = body.schedule || "daily";
    if (!["daily", "weekdays", "custom_days", "weekly"].includes(schedule)) {
      errors.push("Invalid schedule. Must be: daily, weekdays, custom_days, weekly");
    } else {
      out.schedule = schedule;
      if (schedule === "custom_days") {
        const days = body.schedule_days;
        if (!Array.isArray(days) || !days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
          errors.push("custom_days requires schedule_days: a non-empty array of integers 0 (Sun) – 6 (Sat).");
        } else {
          out.schedule_days = [...new Set(days)].sort();
        }
      } else {
        out.schedule_days = null;
      }
      if (schedule === "weekly") {
        const t = Number(body.times_per_week);
        if (!Number.isInteger(t) || t < 1 || t > 7) errors.push("weekly requires times_per_week: an integer 1–7.");
        else out.times_per_week = t;
      } else {
        out.times_per_week = null;
      }
    }
  }
  if (has("sort_order")) {
    const s = Number(body.sort_order);
    if (!Number.isInteger(s)) errors.push("sort_order must be an integer.");
    else out.sort_order = s;
  }
  return { errors, out };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
module.exports = function ({ pool, helpers }) {
  const router = express.Router();
  const fireWebhooks = (helpers && helpers.fireWebhooks) || (async () => {});

  // ----- Habits ------------------------------------------------------------
  router.get("/api/habits", async (req, res) => {
    try {
      const summary = await gatherHealthSummary(pool);
      if (req.query.all === "1" || req.query.all === "true") {
        const archived = await pool.query(
          "SELECT * FROM habits WHERE is_active = false ORDER BY archived_at DESC NULLS LAST, id"
        );
        return res.json({ habits: summary.habits, archived: archived.rows });
      }
      res.json({ habits: summary.habits });
    } catch (err) { serverError(res, err); }
  });

  router.post("/api/habits", async (req, res) => {
    try {
      const { errors, out } = validateHabitFields(req.body || {});
      if (errors.length) return res.status(400).json({ error: errors.join(" ") });
      if (out.kind === "quantity" && out.target_value == null) {
        return res.status(400).json({ error: "Quantity habits require a target_value." });
      }
      const r = await pool.query(
        `INSERT INTO habits (name, description, kind, target_value, unit, schedule, schedule_days, times_per_week, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [out.name, out.description || null, out.kind, out.target_value ?? null, out.unit || null,
         out.schedule, out.schedule_days || null, out.times_per_week ?? null, out.sort_order || 0]
      );
      res.json(r.rows[0]);
    } catch (err) { serverError(res, err); }
  });

  router.patch("/api/habits/:id", async (req, res) => {
    try {
      const body = req.body || {};
      const { errors, out } = validateHabitFields(body, { partial: true });
      if (errors.length) return res.status(400).json({ error: errors.join(" ") });
      // F9: enforce the quantity⇒target_value invariant on the MERGED post-update
      // state (validateHabitFields only sees the partial body). Switching a habit
      // to kind='quantity' without a target — or nulling the target of a quantity
      // habit — would silently degrade meetsTarget to "any value > 0 counts".
      if (out.kind === "quantity" || out.target_value === null) {
        const ex = await pool.query("SELECT kind, target_value FROM habits WHERE id = $1", [req.params.id]);
        if (ex.rows.length) {
          const mergedKind = out.kind !== undefined ? out.kind : ex.rows[0].kind;
          const mergedTarget = out.target_value !== undefined ? out.target_value : ex.rows[0].target_value;
          if (mergedKind === "quantity" && mergedTarget == null) {
            return res.status(400).json({ error: "Quantity habits require a target_value." });
          }
        }
      }
      const fields = [];
      const params = [];
      let idx = 1;
      for (const k of ["name", "description", "kind", "target_value", "unit", "schedule", "schedule_days", "times_per_week", "sort_order"]) {
        if (out[k] !== undefined) { fields.push(`${k} = $${idx++}`); params.push(out[k]); }
      }
      if (body.is_active !== undefined) {
        fields.push(`is_active = $${idx++}`);
        params.push(!!body.is_active);
        fields.push(body.is_active ? "archived_at = NULL" : "archived_at = now()");
      }
      if (!fields.length) return res.status(400).json({ error: "No fields to update." });
      params.push(req.params.id);
      const r = await pool.query(`UPDATE habits SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`, params);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json(r.rows[0]);
    } catch (err) { serverError(res, err); }
  });

  // DELETE archives (keeps the log history). Logs are only removed when an
  // archived habit row is purged manually in SQL — there is no hard delete
  // through the API, matching the app's keep-your-history posture.
  router.delete("/api/habits/:id", async (req, res) => {
    try {
      const r = await pool.query(
        "UPDATE habits SET is_active = false, archived_at = now() WHERE id = $1 AND is_active = true RETURNING id",
        [req.params.id]
      );
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json({ ok: true, archived: true });
    } catch (err) { serverError(res, err); }
  });

  // ----- Logging -----------------------------------------------------------
  router.post("/api/habits/:id/log", async (req, res) => {
    try {
      const { date, value, note } = req.body || {};
      const today = todayStr();
      const logDate = date === undefined || date === null ? today : date;
      if (!DATE_RE.test(logDate)) return res.status(400).json({ error: "Invalid date. Use YYYY-MM-DD." });
      if (logDate > today) return res.status(400).json({ error: "Cannot log a future date." });
      const v = value === undefined || value === null ? 1 : Number(value);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: "Value must be a non-negative number." });
      if (note !== undefined && note !== null && (typeof note !== "string" || note.length > MAX_NOTE_LENGTH)) {
        return res.status(400).json({ error: `Note must be a string of at most ${MAX_NOTE_LENGTH} characters.` });
      }
      const habitR = await pool.query("SELECT * FROM habits WHERE id = $1", [req.params.id]);
      if (!habitR.rows.length) return res.status(404).json({ error: "Not found." });
      const habit = habitR.rows[0];

      const r = await pool.query(
        `INSERT INTO habit_logs (habit_id, log_date, value, note)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (habit_id, log_date)
         DO UPDATE SET value = EXCLUDED.value, note = COALESCE(EXCLUDED.note, habit_logs.note)
         RETURNING *`,
        [habit.id, logDate, v, note || null]
      );

      const logsR = await pool.query("SELECT log_date, value FROM habit_logs WHERE habit_id = $1", [habit.id]);
      const { current_streak, best_streak } = computeStreaks(habit, logsR.rows, today);
      if (STREAK_MILESTONES.includes(current_streak) && meetsTarget(habit, v) && logDate === today) {
        fireWebhooks("streak_milestone", {
          entity: "habit", id: habit.id, name: habit.name, streak: current_streak,
        }).catch(() => {});
      }
      res.json({ log: r.rows[0], current_streak, best_streak });
    } catch (err) { serverError(res, err); }
  });

  router.delete("/api/habits/:id/log/:date", async (req, res) => {
    try {
      if (!DATE_RE.test(req.params.date)) return res.status(400).json({ error: "Invalid date. Use YYYY-MM-DD." });
      const r = await pool.query(
        "DELETE FROM habit_logs WHERE habit_id = $1 AND log_date = $2 RETURNING id",
        [req.params.id, req.params.date]
      );
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json({ ok: true });
    } catch (err) { serverError(res, err); }
  });

  router.get("/api/habits/:id/history", async (req, res) => {
    try {
      const days = Math.min(Math.max(parseInt(req.query.days, 10) || 180, 1), 730);
      const r = await pool.query(
        `SELECT log_date, value, note FROM habit_logs
         WHERE habit_id = $1 AND log_date >= CURRENT_DATE - ($2 || ' days')::interval
         ORDER BY log_date`,
        [req.params.id, days]
      );
      res.json(r.rows);
    } catch (err) { serverError(res, err); }
  });

  // ----- Aggregates ----------------------------------------------------------
  router.get("/api/health/summary", async (req, res) => {
    try {
      res.json(await gatherHealthSummary(pool));
    } catch (err) { serverError(res, err); }
  });

  // Per-day count of habits that MET their completion bar — feeds the page's
  // 90-day heatmap. "Met" mirrors meetsTarget: quantity habits need
  // value >= target_value, boolean habits any value > 0.
  router.get("/api/health/heatmap", async (req, res) => {
    try {
      const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 7), 365);
      const r = await pool.query(
        `SELECT l.log_date AS day, COUNT(*) AS count
         FROM habit_logs l JOIN habits h ON h.id = l.habit_id
         WHERE l.log_date >= CURRENT_DATE - ($1 || ' days')::interval
           AND CASE WHEN h.kind = 'quantity' AND h.target_value IS NOT NULL
                    THEN l.value >= h.target_value ELSE l.value > 0 END
         GROUP BY l.log_date ORDER BY l.log_date`,
        [days]
      );
      res.json({ days, heatmap: r.rows });
    } catch (err) { serverError(res, err); }
  });

  // ----- Metrics -------------------------------------------------------------
  router.get("/api/health/metrics", async (req, res) => {
    try {
      const { metric } = req.query;
      if (metric) {
        const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 1), 1095);
        const r = await pool.query(
          `SELECT id, metric, value, unit, recorded_on, note FROM health_metrics
           WHERE metric = $1 AND recorded_on >= CURRENT_DATE - ($2 || ' days')::interval
           ORDER BY recorded_on`,
          [String(metric).trim().toLowerCase(), days]
        );
        return res.json(r.rows);
      }
      const r = await pool.query(
        "SELECT DISTINCT ON (metric) id, metric, value, unit, recorded_on, note FROM health_metrics ORDER BY metric, recorded_on DESC"
      );
      res.json(r.rows);
    } catch (err) { serverError(res, err); }
  });

  router.post("/api/health/metrics", async (req, res) => {
    try {
      const { metric, value, unit, date, note } = req.body || {};
      const name = typeof metric === "string" ? metric.trim().toLowerCase() : "";
      if (!name) return res.status(400).json({ error: "Metric name is required." });
      if (name.length > MAX_METRIC_NAME) return res.status(400).json({ error: `Metric name too long. Maximum ${MAX_METRIC_NAME} characters.` });
      const v = Number(value);
      if (!Number.isFinite(v)) return res.status(400).json({ error: "Value must be a number." });
      const today = todayStr();
      const recordedOn = date === undefined || date === null ? today : date;
      if (!DATE_RE.test(recordedOn)) return res.status(400).json({ error: "Invalid date. Use YYYY-MM-DD." });
      if (recordedOn > today) return res.status(400).json({ error: "Cannot record a future date." });
      if (unit !== undefined && unit !== null && (typeof unit !== "string" || unit.length > 30)) {
        return res.status(400).json({ error: "Unit must be a string of at most 30 characters." });
      }
      if (note !== undefined && note !== null && (typeof note !== "string" || note.length > MAX_NOTE_LENGTH)) {
        return res.status(400).json({ error: `Note must be a string of at most ${MAX_NOTE_LENGTH} characters.` });
      }
      const r = await pool.query(
        `INSERT INTO health_metrics (metric, value, unit, recorded_on, note)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (metric, recorded_on)
         DO UPDATE SET value = EXCLUDED.value,
                       unit = COALESCE(EXCLUDED.unit, health_metrics.unit),
                       note = COALESCE(EXCLUDED.note, health_metrics.note)
         RETURNING *`,
        [name, v, unit || null, recordedOn, note || null]
      );
      res.json(r.rows[0]);
    } catch (err) { serverError(res, err); }
  });

  router.delete("/api/health/metrics/:id", async (req, res) => {
    try {
      const r = await pool.query("DELETE FROM health_metrics WHERE id = $1 RETURNING id", [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: "Not found." });
      res.json({ ok: true });
    } catch (err) { serverError(res, err); }
  });

  return router;
};

// Helper exports attached AFTER the factory assignment (INV-19 pattern —
// assigning module.exports above would otherwise drop these).
module.exports.isDueOn = isDueOn;
module.exports.meetsTarget = meetsTarget;
module.exports.computeStreaks = computeStreaks;
module.exports.gatherHealthSummary = gatherHealthSummary;
module.exports.weekKey = weekKey;
module.exports.addDays = addDays;
