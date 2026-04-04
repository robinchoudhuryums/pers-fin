// ============================================================================
// Routes: Per-sistant Integration (Perfin → Per-sistant)
// ============================================================================
// Webhook sender for financial events, SSO token exchange, and
// productivity context enrichment for AI insights.

const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const { pool } = require("../services/database");

// ---------------------------------------------------------------------------
// Helper: get Per-sistant config from DB
// ---------------------------------------------------------------------------
async function getPersistentConfig() {
  try {
    const r = await pool.query("SELECT persistent_url, persistent_webhook_secret, persistent_webhook_enabled FROM user_settings WHERE id = 1");
    const s = r.rows[0];
    if (!s || !s.persistent_url) return null;
    const url = s.persistent_url.replace(/\/+$/, "");
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    } catch { return null; }
    return { url, secret: s.persistent_webhook_secret, enabled: s.persistent_webhook_enabled };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helper: send webhook to Per-sistant
// ---------------------------------------------------------------------------
async function sendPerSistantWebhook(event, data) {
  const config = await getPersistentConfig();
  if (!config || !config.enabled) return { sent: false, reason: "not_configured" };
  const payload = { event, data, timestamp: new Date().toISOString() };
  const body = JSON.stringify(payload);
  const headers = { "Content-Type": "application/json" };
  if (config.secret) {
    headers["x-webhook-signature"] = crypto.createHmac("sha256", config.secret).update(body).digest("hex");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(`${config.url}/api/perfin/webhook`, {
      method: "POST", headers, body, signal: controller.signal,
    });
    clearTimeout(timeout);
    return { sent: r.ok, status: r.status };
  } catch (err) {
    clearTimeout(timeout);
    return { sent: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// POST /api/persistent/webhook/test — Test webhook connectivity
// ---------------------------------------------------------------------------
router.post("/api/persistent/webhook/test", async (req, res) => {
  const result = await sendPerSistantWebhook("test", { message: "Perfin webhook test" });
  res.json(result);
});

// ---------------------------------------------------------------------------
// POST /api/persistent/webhook/send — Manually trigger a webhook event
// ---------------------------------------------------------------------------
router.post("/api/persistent/webhook/send", async (req, res) => {
  const { event, data } = req.body;
  if (!event) return res.status(400).json({ error: "Event type required." });
  const result = await sendPerSistantWebhook(event, data || {});
  res.json(result);
});

// ---------------------------------------------------------------------------
// GET /api/persistent/status — Check Per-sistant connectivity
// ---------------------------------------------------------------------------
router.get("/api/persistent/status", async (req, res) => {
  const config = await getPersistentConfig();
  if (!config) return res.json({ connected: false });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const r = await fetch(`${config.url}/api/health`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!r.ok) return res.json({ connected: false, url: config.url, status: r.status });
    const data = await r.json();
    res.json({ connected: true, url: config.url, webhook_enabled: config.enabled, uptime: data.uptime });
  } catch {
    clearTimeout(timeout);
    res.json({ connected: false, url: config.url });
  }
});

// ---------------------------------------------------------------------------
// GET /api/persistent/productivity-context — Fetch task context for AI insights
// ---------------------------------------------------------------------------
router.get("/api/persistent/productivity-context", async (req, res) => {
  const config = await getPersistentConfig();
  if (!config) return res.json({ connected: false });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const [statsR, reviewR] = await Promise.all([
      fetch(`${config.url}/api/stats`, { signal: controller.signal }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`${config.url}/api/review`, { signal: controller.signal }).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    clearTimeout(timeout);
    const context = { connected: true };
    if (statsR) {
      context.tasks = statsR.todos;
      context.emails = statsR.emails;
      context.notes = statsR.notes;
    }
    if (reviewR) {
      context.week = {
        tasks_completed: reviewR.tasks_completed?.length || 0,
        tasks_created: reviewR.tasks_created_count,
        emails_sent: reviewR.emails_sent_count,
        overdue: reviewR.overdue_tasks?.length || 0,
      };
    }
    res.json(context);
  } catch {
    clearTimeout(timeout);
    res.json({ connected: false });
  }
});

// ---------------------------------------------------------------------------
// SSO — Same approach as Per-sistant side
// ---------------------------------------------------------------------------
const SESSION_PASSWORD = process.env.SESSION_PASSWORD;
const SESSION_PIN = process.env.SESSION_PIN;
const AUTH_SECRET = SESSION_PASSWORD || SESSION_PIN || null;
const SESSION_SECRET = process.env.SESSION_SECRET || "";

router.post("/api/sso/generate", (req, res) => {
  if (!AUTH_SECRET) return res.status(400).json({ error: "Auth not configured." });
  if (!req.session || !req.session.authenticated) return res.status(401).json({ error: "Not authenticated." });
  const timestamp = Date.now();
  const payload = `sso:${timestamp}`;
  const secret = SESSION_SECRET + AUTH_SECRET;
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  res.json({ token: `${payload}:${signature}`, expires_in: 60 });
});

const ssoLimiter = require("express-rate-limit")({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many SSO attempts, please try again later." },
});
router.post("/api/sso/validate", ssoLimiter, async (req, res) => {
  if (!AUTH_SECRET) return res.status(400).json({ error: "Auth not configured." });
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "Token required." });
  const parts = token.split(":");
  if (parts.length !== 3 || parts[0] !== "sso") return res.status(401).json({ error: "Invalid token format." });
  const timestamp = parseInt(parts[1], 10);
  const providedSig = parts[2];
  if (Date.now() - timestamp > 60000) return res.status(401).json({ error: "Token expired." });
  const payload = `sso:${timestamp}`;
  const secret = SESSION_SECRET + AUTH_SECRET;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  const sigBuf = Buffer.from(providedSig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return res.status(401).json({ error: "Invalid token." });
  }
  let timeout = 15;
  try {
    const r = await pool.query("SELECT session_timeout_minutes FROM user_settings WHERE id = 1");
    if (r.rows.length) timeout = r.rows[0].session_timeout_minutes;
  } catch {}
  req.session.authenticated = true;
  req.session.lastActivity = Date.now();
  req.session.timeoutMinutes = timeout;
  res.json({ ok: true });
});

// Export both the router and the webhook sender function (for use by other routes)
module.exports = router;
module.exports.sendPerSistantWebhook = sendPerSistantWebhook;
