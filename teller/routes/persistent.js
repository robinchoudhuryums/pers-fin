// ============================================================================
// Routes: Per-sistant Integration (Perfin → Per-sistant)
// ============================================================================
// Webhook sender for financial events, SSO token exchange, and
// productivity context enrichment for AI insights.

const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const { pool, ENCRYPTION_PASSPHRASE } = require("../services/database");

// ---------------------------------------------------------------------------
// Helper: get Per-sistant config from DB
// The webhook secret is stored encrypted (pgp_sym_encrypt with
// TOKEN_ENCRYPTION_PASSPHRASE); we decrypt on read.
// ---------------------------------------------------------------------------
async function getPersistentConfig() {
  try {
    // Read url/enabled WITHOUT decrypting first, so a passphrase mismatch on the
    // secret can't collapse the whole config to null (SN-3) — that masked a
    // decryption failure as "not configured". The decrypt happens separately
    // below and a failure is surfaced via `decryptFailed`.
    const r = await pool.query(
      `SELECT persistent_url, persistent_webhook_enabled,
              (persistent_webhook_secret_enc IS NOT NULL) AS has_secret
         FROM user_settings WHERE id = 1`
    );
    const s = r.rows[0];
    if (!s || !s.persistent_url) return null;
    const url = s.persistent_url.replace(/\/+$/, "");
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    } catch { return null; }
    let secret = null;
    let decryptFailed = false;
    if (s.has_secret) {
      try {
        const d = await pool.query(
          "SELECT pgp_sym_decrypt(persistent_webhook_secret_enc, $1) AS secret FROM user_settings WHERE id = 1",
          [ENCRYPTION_PASSPHRASE || ""]
        );
        secret = d.rows[0]?.secret || null;
        if (!secret) decryptFailed = true; // NULL decrypt == wrong/empty passphrase
      } catch {
        decryptFailed = true; // pgp_sym_decrypt throws on a wrong key
      }
    }
    return { url, secret, enabled: s.persistent_webhook_enabled, decryptFailed };
  } catch {
    return null;
  }
}

// Under the unified shell both apps share a process; the shell registers
// Per-sistant's pg Pool here so digest/insight emails are delivered DIRECTLY
// into Per-sistant's `emails` table — no HTTP webhook, no persistent_url, no
// shared HMAC secret required. Standalone deployments leave this null and fall
// back to the signed HTTP webhook below.
let _embeddedPersistentPool = null;
function setEmbeddedPersistentPool(p) { _embeddedPersistentPool = p; }

// The email-bearing events all carry { subject, html_body, plain_text }.
const EMAIL_EVENTS = new Set(["insights_generated", "weekly_summary", "daily_summary", "critical_alert"]);

// In-process delivery — mirrors what apps/per-sistant/routes/perfin.js does on
// receipt of the HTTP webhook (recipient resolution + emails-table insert), but
// against the wired pool so no network round-trip or signature is involved.
async function deliverDigestInProcess(event, data) {
  const pp = _embeddedPersistentPool;
  try {
    const setR = await pp.query(
      "SELECT perfin_webhook_recipient FROM user_settings WHERE id = 1"
    ).catch(() => ({ rows: [] }));
    const recipient = (setR.rows[0] && setR.rows[0].perfin_webhook_recipient)
      || process.env.SMTP_FROM || process.env.SMTP_USER || null;
    const fallbackSubject = event === "weekly_summary"
      ? "Perfin: Your Weekly Financial Digest"
      : event === "daily_summary"
        ? "Perfin: Yesterday's Activity"
        : "Perfin AI Financial Analysis";
    const sendName = {
      weekly_summary: "Perfin Weekly Digest",
      daily_summary: "Perfin Daily Digest",
      insights_generated: "Perfin Insights",
      critical_alert: "Perfin Alerts",
    }[event] || "Perfin";
    const subject = (data && data.subject) || fallbackSubject;
    const body = (data && data.plain_text) || "(no body)";
    const html = (data && data.html_body) || null;
    if (!recipient) {
      // No destination configured — save as a draft so the content isn't lost,
      // matching the receiver's behavior.
      await pp.query(
        "INSERT INTO emails (recipient_email, subject, body, body_html, status) VALUES ($1, $2, $3, $4, 'draft')",
        ["unset@localhost", subject, body, html]
      );
      return { sent: true, delivery: "in_process", stored: "draft", reason: "no_recipient_configured" };
    }
    await pp.query(
      "INSERT INTO emails (recipient_name, recipient_email, subject, body, body_html, status, scheduled_at) VALUES ($1, $2, $3, $4, $5, 'scheduled', now())",
      [sendName, recipient, subject, body, html]
    );
    return { sent: true, delivery: "in_process", stored: "scheduled", recipient };
  } catch (err) {
    console.error(`deliverDigestInProcess[${event}]: ${err.message}`);
    return { sent: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Helper: critical-alert email (opt-in via Settings → Notifications)
// ---------------------------------------------------------------------------
// Sends an immediate email for events the user shouldn't have to discover via
// the bell: budget exceeded (100%+) and 3x anomaly charges. Reuses the digest
// email channel (in-process under the shell, HTTP webhook standalone), so it
// inherits the same recipient resolution. Never throws; disabled by default.
function escAlertHtml(t) {
  return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
async function sendCriticalAlertEmail(title, body) {
  try {
    const s = await pool.query(
      "SELECT critical_alert_emails_enabled FROM user_settings WHERE id = 1"
    );
    if (!s.rows[0] || !s.rows[0].critical_alert_emails_enabled) {
      return { sent: false, reason: "disabled" };
    }
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#080b12;font-family:Inter,system-ui,sans-serif;">
      <div style="max-width:640px;margin:0 auto;padding:32px 24px;">
        <h1 style="color:#eb6b6b;font-size:18px;margin:0 0 12px;">${escAlertHtml(title)}</h1>
        <div style="background:#0f1320;border:1px solid #663333;border-radius:12px;padding:20px;color:#cccccc;font-size:13px;line-height:1.7;white-space:pre-line;">${escAlertHtml(body)}</div>
        <p style="color:#555555;font-size:10px;margin:16px 0 0;">Perfin critical alert — toggle off under Settings &rarr; Notifications.</p>
      </div>
    </body></html>`;
    return await sendPerSistantWebhook("critical_alert", {
      subject: "Perfin alert: " + title,
      html_body: html,
      plain_text: title + "\n\n" + body,
    });
  } catch (err) {
    console.error("sendCriticalAlertEmail error:", err.message);
    return { sent: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Helper: send webhook to Per-sistant
// ---------------------------------------------------------------------------
async function sendPerSistantWebhook(event, data) {
  // Embedded fast-path: deliver the email directly via the wired pool. Bypasses
  // the persistent_url/secret prerequisite entirely under the unified shell.
  // (The "test" event stays on the HTTP path — it exists to probe the webhook
  // config, which only matters for standalone deployments.)
  if (_embeddedPersistentPool && EMAIL_EVENTS.has(event)) {
    return deliverDigestInProcess(event, data);
  }
  const config = await getPersistentConfig();
  if (!config || !config.enabled) return { sent: false, reason: "not_configured" };
  // A configured-but-undecryptable secret means TOKEN_ENCRYPTION_PASSPHRASE no
  // longer matches the stored ciphertext (e.g. after a rotation). Surface it
  // distinctly (SN-3) instead of letting it fall through to "missing_secret",
  // which would imply the operator never set it.
  if (config.decryptFailed) {
    console.error(
      `sendPerSistantWebhook[${event}]: webhook secret decryption failed — ` +
      "TOKEN_ENCRYPTION_PASSPHRASE no longer matches the stored ciphertext. " +
      "Re-save the Per-sistant webhook secret under Settings → Per-sistant integration."
    );
    return { sent: false, reason: "decryption_failed" };
  }
  // Refuse to dispatch without the shared HMAC secret. The Per-sistant
  // receiver rejects unsigned requests (returns 503), so sending unsigned
  // was always a silent failure: insight emails would disappear with no
  // surface on the Perfin side and a 503 logged only on the receiver.
  // Now we short-circuit with an explicit reason so callers (and the
  // /api/insights/status feed eventually) can tell why delivery failed.
  if (!config.secret) {
    console.error(
      `sendPerSistantWebhook[${event}]: refusing to send unsigned — ` +
      "persistent_webhook_secret not configured. Set it via Settings → " +
      "Per-sistant integration so the receiver can verify the HMAC."
    );
    return { sent: false, reason: "missing_secret" };
  }
  const payload = { event, data, timestamp: new Date().toISOString() };
  const body = JSON.stringify(payload);
  const headers = {
    "Content-Type": "application/json",
    "x-webhook-signature": crypto.createHmac("sha256", config.secret).update(body).digest("hex"),
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(`${config.url}/api/perfin/webhook`, {
      method: "POST", headers, body, signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!r.ok) {
      console.error(`sendPerSistantWebhook[${event}]: receiver returned ${r.status}`);
    }
    return { sent: r.ok, status: r.status };
  } catch (err) {
    clearTimeout(timeout);
    console.error(`sendPerSistantWebhook[${event}]: ${err.message}`);
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

// Direct in-process queries against the Per-sistant DB — used when both apps
// share a process (the unified shell wires `persistentPool` onto Perfin's app).
// HTTP self-fetches were silently 401ing through the shell's auth gate.
async function queryPersistentStats(persistentPool) {
  const [todos, emails, notes] = await Promise.all([
    persistentPool.query(
      "SELECT count(*) FILTER (WHERE NOT completed) as pending, count(*) FILTER (WHERE completed) as done, count(*) FILTER (WHERE NOT completed AND priority = 'urgent') as urgent, count(*) FILTER (WHERE NOT completed AND due_date <= CURRENT_DATE) as overdue FROM todos WHERE deleted_at IS NULL"
    ),
    persistentPool.query(
      "SELECT count(*) FILTER (WHERE status = 'draft') as drafts, count(*) FILTER (WHERE status = 'scheduled') as scheduled, count(*) FILTER (WHERE status = 'sent') as sent FROM emails WHERE deleted_at IS NULL"
    ),
    persistentPool.query(
      "SELECT count(*) as total FROM notes WHERE deleted_at IS NULL"
    ),
  ]);
  return { todos: todos.rows[0], emails: emails.rows[0], notes: notes.rows[0] };
}

async function queryPersistentReview(persistentPool) {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 7);
  const ws = weekStart.toISOString().split("T")[0];
  const we = weekEnd.toISOString().split("T")[0];
  const [completed, created, sent, overdue] = await Promise.all([
    persistentPool.query("SELECT count(*) AS cnt FROM todos WHERE deleted_at IS NULL AND completed_at >= $1 AND completed_at < $2", [ws, we]),
    persistentPool.query("SELECT count(*) AS cnt FROM todos WHERE deleted_at IS NULL AND created_at >= $1 AND created_at < $2", [ws, we]),
    persistentPool.query("SELECT count(*) AS cnt FROM emails WHERE deleted_at IS NULL AND sent_at >= $1 AND sent_at < $2", [ws, we]),
    persistentPool.query("SELECT count(*) AS cnt FROM todos WHERE deleted_at IS NULL AND due_date < $1 AND NOT completed", [ws]),
  ]);
  return {
    tasks_completed_count: parseInt(completed.rows[0].cnt, 10),
    tasks_created_count: parseInt(created.rows[0].cnt, 10),
    emails_sent_count: parseInt(sent.rows[0].cnt, 10),
    overdue_count: parseInt(overdue.rows[0].cnt, 10),
  };
}

// ---------------------------------------------------------------------------
// GET /api/persistent/status — Check Per-sistant connectivity
// ---------------------------------------------------------------------------
router.get("/api/persistent/status", async (req, res) => {
  // Embedded fast path — both apps share a process; if Per-sistant's pool is
  // wired into req.app, it's "connected" by definition.
  const persistentPool = req.app.get("persistentPool");
  if (persistentPool) {
    const cfg = await getPersistentConfig();
    return res.json({
      connected: true,
      embedded: true,
      uptime: Math.floor(process.uptime()),
      webhook_enabled: cfg ? cfg.enabled : false,
    });
  }
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
  // Embedded fast path: query Per-sistant's DB directly. The HTTP fetch path
  // 401s through the shell auth gate when both apps share a process, which
  // silently degraded the AI insights productivity-context enrichment to
  // an empty object.
  const persistentPool = req.app.get("persistentPool");
  if (persistentPool) {
    try {
      const [stats, review] = await Promise.all([
        queryPersistentStats(persistentPool).catch(() => null),
        queryPersistentReview(persistentPool).catch(() => null),
      ]);
      const context = { connected: true, embedded: true };
      if (stats) {
        context.tasks = stats.todos;
        context.emails = stats.emails;
        context.notes = stats.notes;
      }
      if (review) {
        context.week = {
          tasks_completed: review.tasks_completed_count,
          tasks_created: review.tasks_created_count,
          emails_sent: review.emails_sent_count,
          overdue: review.overdue_count,
        };
      }
      return res.json(context);
    } catch (err) {
      console.error("productivity-context (embedded) error:", err.message);
      return res.json({ connected: false });
    }
  }
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
// SSO_SECRET is the documented shared secret between Perfin and Per-sistant.
// Both sides must set the same value or token validation will fail.
const SSO_SECRET = process.env.SSO_SECRET || null;

// In-memory nonce tracking prevents token replay within the 60-second TTL.
// Tokens include a random nonce; validate records used nonces and rejects
// duplicates. The Map self-cleans every 2 minutes so memory is bounded.
const _usedNonces = new Map();
setInterval(() => {
  const cutoff = Date.now() - 120000; // keep nonces for 2× the TTL
  for (const [nonce, ts] of _usedNonces) {
    if (ts < cutoff) _usedNonces.delete(nonce);
  }
}, 120000).unref();

router.post("/api/sso/generate", (req, res) => {
  if (!AUTH_SECRET) return res.status(400).json({ error: "Auth not configured." });
  if (!SSO_SECRET) return res.status(500).json({ error: "SSO_SECRET not configured." });
  if (!req.session || !req.session.authenticated) return res.status(401).json({ error: "Not authenticated." });
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(12).toString("hex");
  const payload = `sso:${timestamp}:${nonce}`;
  const signature = crypto.createHmac("sha256", SSO_SECRET).update(payload).digest("hex");
  res.json({ token: `${payload}:${signature}`, expires_in: 60 });
});

const ssoLimiter = require("express-rate-limit")({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many SSO attempts, please try again later." },
});
router.post("/api/sso/validate", ssoLimiter, async (req, res) => {
  if (!AUTH_SECRET) return res.status(400).json({ error: "Auth not configured." });
  if (!SSO_SECRET) return res.status(500).json({ error: "SSO_SECRET not configured." });
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "Token required." });
  // Token format: sso:<timestamp>:<nonce>:<signature>
  const parts = token.split(":");
  if (parts.length !== 4 || parts[0] !== "sso") return res.status(401).json({ error: "Invalid token format." });
  const timestamp = parseInt(parts[1], 10);
  const nonce = parts[2];
  const providedSig = parts[3];
  if (Date.now() - timestamp > 60000) return res.status(401).json({ error: "Token expired." });
  // Replay check: reject if this nonce has been used before.
  // Reserve the nonce immediately (atomic check-and-set) to prevent concurrent
  // requests with the same token from both passing the check. If signature
  // verification fails, we remove the reservation so the nonce isn't burned.
  if (_usedNonces.has(nonce)) return res.status(401).json({ error: "Token already used." });
  _usedNonces.set(nonce, Date.now()); // Reserve immediately
  const payload = `sso:${timestamp}:${nonce}`;
  const expected = crypto.createHmac("sha256", SSO_SECRET).update(payload).digest("hex");
  const sigBuf = Buffer.from(providedSig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    _usedNonces.delete(nonce); // Release reservation — bad signature shouldn't burn nonce
    return res.status(401).json({ error: "Invalid token." });
  }
  // Nonce stays consumed — signature is valid, token is now used.
  let timeout = 15;
  try {
    const r = await pool.query("SELECT session_timeout_minutes FROM user_settings WHERE id = 1");
    if (r.rows.length) timeout = r.rows[0].session_timeout_minutes;
  } catch (err) { console.error("SSO settings query error:", err.message); }
  req.session.authenticated = true;
  req.session.lastActivity = Date.now();
  req.session.timeoutMinutes = timeout;
  res.json({ ok: true });
});

// Export both the router and the webhook sender function (for use by other routes)
module.exports = router;
module.exports.sendCriticalAlertEmail = sendCriticalAlertEmail;
module.exports.sendPerSistantWebhook = sendPerSistantWebhook;
module.exports.setEmbeddedPersistentPool = setEmbeddedPersistentPool;
