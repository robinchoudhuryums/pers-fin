// ============================================================================
// Per-sistant — Helper Functions
// ============================================================================

const { pool } = require("./db");
const { isValidWebhookUrl } = require("./config");

// 'YYYY-MM-DD' of a Date using LOCAL getters — node-pg returns a DATE column
// as LOCAL midnight, so local getters give the stored calendar day in any
// server timezone (toISOString() shifted it whenever TZ ≠ UTC).
function ymdLocal(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

// The anchor day-of-month for a recurring chain (PD-2): the stored
// recurrence_anchor_day, else the instance's own due day.
function recurrenceAnchorDay(todo) {
  const a = parseInt(todo && todo.recurrence_anchor_day, 10);
  if (a >= 1 && a <= 31) return a;
  return todo && todo.due_date ? new Date(todo.due_date).getDate() : null;
}

// Next occurrence. Monthly/yearly step on the month INDEX and clamp the day to
// the target month's length, re-applying `anchorDay` (the chain's original
// day-of-month) each time (PD-2): Jan 31 → Feb 28 → Mar 31, and Feb 29 yearly
// → Feb 28 → … → Feb 29 on the next leap year. setMonth/setFullYear used to
// overflow (Jan 31 + 1 month → Mar 3) and the chain never returned.
function advanceRecurrence(date, rule, interval, anchorDay) {
  const d = new Date(date);
  // Floor at 1 (F9 defense-in-depth): a zero/negative interval would make the
  // date stand still or step backwards, and callers (calendar projections,
  // recurring auto-roll) rely on "date advanced" as their loop progress.
  // Routes + the DB CHECK reject bad values at write time.
  const n = Math.max(1, parseInt(interval, 10) || 1);
  if (rule === "daily" || rule === "custom_days") d.setDate(d.getDate() + n);
  else if (rule === "weekdays") {
    let count = 0;
    while (count < n) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0 && d.getDay() !== 6) count++; }
  }
  else if (rule === "weekly" || rule === "custom_weeks") d.setDate(d.getDate() + 7 * n);
  else if (rule === "monthly" || rule === "custom_months" || rule === "yearly") {
    const months = rule === "yearly" ? 12 * n : n;
    const day = Math.min(31, Math.max(1, parseInt(anchorDay, 10) || d.getDate()));
    const t = d.getFullYear() * 12 + d.getMonth() + months;
    const y = Math.floor(t / 12), m = t % 12;
    const last = new Date(y, m + 1, 0).getDate();
    return new Date(y, m, Math.min(day, last), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
  }
  return d;
}

// Midnight roll of MISSED recurring instances (PB-10), run by server.js's cron
// in APP_TIMEZONE with `today` = the local 'YYYY-MM-DD' (it used to run at UTC
// midnight — 5pm in Los Angeles, before the user could finish the task — and
// compare against Postgres' UTC CURRENT_DATE). A rolled instance is marked
// MISSED (completed = true so it leaves the active list, but completed_at NULL
// + missed = true) instead of completed, so analytics and the weekly review no
// longer count it as done. The next instance is the first occurrence ON OR
// AFTER today, carrying the chain's anchor day (PD-2). Claims each row
// atomically (PS-11) so it can't race complete-recurring.
// The next instance's due date when a recurring task is completed or skipped
// on `today` ('YYYY-MM-DD', APP_TIMEZONE): one step from its due date, then
// caught up past today (PD-3). Completing a daily task due Sep 20 on Sep 27
// used to create an instance due Sep 21 — overdue on arrival, so the midnight
// roll marked it missed and wiped the streak just earned. Returns a Date.
function nextDueAfter(todo, today) {
  const rule = todo.recurrence_rule;
  const interval = todo.recurrence_interval || 1;
  const anchor = recurrenceAnchorDay(todo);
  let nextDue = advanceRecurrence(todo.due_date ? new Date(todo.due_date) : new Date(today + "T00:00:00"), rule, interval, anchor);
  let catchupLimit = 366;
  while (ymdLocal(nextDue) <= today && catchupLimit-- > 0) {
    nextDue = advanceRecurrence(nextDue, rule, interval, anchor);
  }
  return nextDue;
}

async function rollMissedRecurring(db, today) {
  const r = await db.query(
    "SELECT * FROM todos WHERE deleted_at IS NULL AND recurring = true AND completed = false AND due_date < $1",
    [today]
  );
  let rolled = 0;
  for (const todo of r.rows) {
    const claim = await db.query(
      "UPDATE todos SET completed = true, completed_at = NULL, missed = true, streak_count = 0 WHERE id = $1 AND completed = false RETURNING id",
      [todo.id]
    );
    if (!claim.rows.length) continue;
    const rule = todo.recurrence_rule;
    const interval = todo.recurrence_interval || 1;
    const anchor = recurrenceAnchorDay(todo);
    let nextDue = advanceRecurrence(new Date(todo.due_date), rule, interval, anchor);
    let catchupLimit = 365;
    while (ymdLocal(nextDue) < today && catchupLimit-- > 0) {
      nextDue = advanceRecurrence(nextDue, rule, interval, anchor);
    }
    await db.query(
      "INSERT INTO todos (title, description, priority, horizon, category, due_date, recurring, recurrence_rule, recurrence_interval, recurrence_parent_id, streak_count, best_streak, recurrence_anchor_day) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12)",
      [todo.title, todo.description, todo.priority, todo.horizon, todo.category, ymdLocal(nextDue), true, rule, interval, todo.recurrence_parent_id || todo.id, todo.best_streak || 0, anchor]
    );
    rolled++;
  }
  return { rolled };
}

async function sendWebhook(webhook, payload) {
  try {
    // SSRF guard at SEND time (PSB2) — mirror sendSlackNotification. Stored URLs
    // are validated on create/PATCH, but re-checking here closes the gap if a
    // row ever lands outside the validated routes, and matches the documented
    // "validated before each send" invariant. Blocks private/loopback/
    // link-local/metadata targets.
    if (!isValidWebhookUrl(webhook.url)) {
      console.error("sendWebhook: url failed SSRF validation — skipping webhook", webhook.id);
      await pool.query("UPDATE webhooks SET last_triggered = now(), last_status = 0 WHERE id = $1", [webhook.id]).catch(() => {});
      return { ok: false, status: 0, error: "url_failed_validation" };
    }
    const headers = { "Content-Type": "application/json", ...(webhook.headers || {}) };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const r = await fetch(webhook.url, {
      method: "POST", headers, body: JSON.stringify(payload), signal: controller.signal,
    });
    clearTimeout(timeout);
    await pool.query("UPDATE webhooks SET last_triggered = now(), last_status = $1 WHERE id = $2", [r.status, webhook.id]);
    return { ok: r.ok, status: r.status };
  } catch (err) {
    await pool.query("UPDATE webhooks SET last_triggered = now(), last_status = 0 WHERE id = $1", [webhook.id]);
    return { ok: false, status: 0, error: err.message };
  }
}

async function fireWebhooks(eventType, data) {
  try {
    const webhooks = await pool.query("SELECT * FROM webhooks WHERE enabled = true AND $1 = ANY(events)", [eventType]);
    for (const wh of webhooks.rows) {
      sendWebhook(wh, { event: eventType, timestamp: new Date().toISOString(), data }).catch(() => {});
    }
  } catch {}
}

async function sendSlackNotification(message) {
  try {
    const settings = await pool.query("SELECT slack_webhook_url FROM user_settings WHERE id = 1");
    const url = settings.rows[0]?.slack_webhook_url;
    if (!url) return;
    // SSRF guard (PB-5): the Slack URL is a server-side fetch target, so run it
    // through the same validator as webhooks (blocks private/loopback/metadata
    // ranges). Skip silently on a bad/internal URL rather than firing the request.
    if (!isValidWebhookUrl(url)) {
      console.error("sendSlackNotification: slack_webhook_url failed SSRF validation — skipping.");
      return;
    }
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
  } catch {}
}

async function runAutomations(triggerType, entity, entityType) {
  try {
    const rules = await pool.query("SELECT * FROM automations WHERE trigger_type = $1 AND enabled = true", [triggerType]);
    for (const rule of rules.rows) {
      const cond = rule.conditions || {};
      let match = true;
      if (cond.category && entity.category !== cond.category) match = false;
      if (cond.priority && entity.priority !== cond.priority) match = false;
      if (cond.title_contains && !(entity.title || '').toLowerCase().includes(cond.title_contains.toLowerCase())) match = false;
      if (cond.horizon && entity.horizon !== cond.horizon) match = false;
      if (!match) continue;
      const data = rule.action_data || {};
      if (rule.action_type === 'set_priority' && data.priority && entity.id) {
        await pool.query("UPDATE todos SET priority = $1 WHERE id = $2", [data.priority, entity.id]);
      } else if (rule.action_type === 'set_category' && data.category && entity.id) {
        await pool.query("UPDATE todos SET category = $1 WHERE id = $2", [data.category, entity.id]);
      } else if (rule.action_type === 'set_horizon' && data.horizon && entity.id) {
        await pool.query("UPDATE todos SET horizon = $1 WHERE id = $2", [data.horizon, entity.id]);
      } else if (rule.action_type === 'add_tag' && data.tag && entity.id && entityType === 'note') {
        await pool.query("UPDATE notes SET tags = array_append(COALESCE(tags, ARRAY[]::TEXT[]), $1) WHERE id = $2 AND NOT ($1 = ANY(COALESCE(tags, ARRAY[]::TEXT[])))", [data.tag, entity.id]);
      } else if (rule.action_type === 'create_todo' && data.title) {
        await pool.query("INSERT INTO todos (title, priority, horizon, category) VALUES ($1, $2, $3, $4)", [data.title, data.priority || 'medium', data.horizon || 'short', data.category || null]);
      }
    }
  } catch (err) { console.error("Automation error:", err.message); }
}

module.exports = { advanceRecurrence, recurrenceAnchorDay, ymdLocal, nextDueAfter, rollMissedRecurring, sendWebhook, fireWebhooks, sendSlackNotification, runAutomations };
