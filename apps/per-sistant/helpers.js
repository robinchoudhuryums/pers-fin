// ============================================================================
// Per-sistant — Helper Functions
// ============================================================================

const { pool } = require("./db");

function advanceRecurrence(date, rule, interval) {
  const d = new Date(date);
  const n = interval || 1;
  if (rule === "daily" || rule === "custom_days") d.setDate(d.getDate() + n);
  else if (rule === "weekdays") {
    let count = 0;
    while (count < n) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0 && d.getDay() !== 6) count++; }
  }
  else if (rule === "weekly" || rule === "custom_weeks") d.setDate(d.getDate() + 7 * n);
  else if (rule === "monthly" || rule === "custom_months") d.setMonth(d.getMonth() + n);
  else if (rule === "yearly") d.setFullYear(d.getFullYear() + n);
  return d;
}

async function sendWebhook(webhook, payload) {
  try {
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

module.exports = { advanceRecurrence, sendWebhook, fireWebhooks, sendSlackNotification, runAutomations };
