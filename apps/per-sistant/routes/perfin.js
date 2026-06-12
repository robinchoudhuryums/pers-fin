const express = require("express");
const crypto = require("crypto");

// Replay/expiry guard for inbound Perfin webhooks (SN-1). Perfin signs a
// payload that includes a `timestamp`; reject anything outside a 5-minute
// window, and track recently-seen signatures in a self-cleaning TTL map so a
// captured signed POST can't be replayed to re-queue digest emails. Mirrors
// the SSO nonce-replay protection on the Perfin side.
const WEBHOOK_REPLAY_WINDOW_MS = 5 * 60 * 1000;
const _seenWebhookSigs = new Map();
setInterval(() => {
  const cutoff = Date.now() - 2 * WEBHOOK_REPLAY_WINDOW_MS;
  for (const [sig, ts] of _seenWebhookSigs) if (ts < cutoff) _seenWebhookSigs.delete(sig);
}, WEBHOOK_REPLAY_WINDOW_MS).unref();

module.exports = function ({ pool, config }) {
  const router = express.Router();
  const PERFIN_URL = config.PERFIN_URL;
  // Shared HMAC secret between Perfin and Per-sistant. Must equal the value
  // Perfin uses for `persistent_webhook_secret` / PERSISTENT_WEBHOOK_SECRET.
  const WEBHOOK_SECRET = process.env.PERSISTENT_WEBHOOK_SECRET || null;

  router.get("/api/perfin/stats", async (req, res) => {
    // Embedded mode: query Perfin's DB directly. The HTTP-fetch path below
    // 401s through the shell auth gate when both apps share a process, so
    // the widget showed "not connected" indefinitely.
    const perfinPool = req.app.get("perfinPool");
    if (perfinPool) {
      try {
        const result = await perfinPool.query(`
          SELECT display_name, amount, cadence_days, next_expected
          FROM detected_subscriptions
          WHERE is_active = true AND is_dismissed = false AND cancelled_at IS NULL
        `);
        const now = new Date();
        const subs = result.rows;
        const totalMonthly = subs
          .filter(s => parseInt(s.cadence_days) <= 31)
          .reduce((sum, s) => sum + parseFloat(s.amount || 0), 0);
        const upcoming = subs.filter(s => {
          if (!s.next_expected) return false;
          const next = new Date(s.next_expected);
          const diff = (next - now) / 86400000;
          return diff >= 0 && diff <= 7;
        }).map(s => ({
          display_name: s.display_name,
          amount: s.amount,
          cadence_days: s.cadence_days,
          next_expected: s.next_expected,
        }));
        return res.json({
          connected: true,
          total_subscriptions: subs.length,
          monthly_cost: totalMonthly.toFixed(2),
          upcoming_this_week: upcoming.length,
          upcoming,
        });
      } catch (err) {
        console.error("perfin stats (embedded) error:", err.message);
        return res.json({ connected: false });
      }
    }
    // Standalone fallback — HTTP fetch against a separately-deployed Perfin.
    const perfinUrl = PERFIN_URL || (await pool.query("SELECT perfin_url FROM user_settings WHERE id = 1").catch(() => ({rows:[]}))).rows[0]?.perfin_url;
    if (!perfinUrl) return res.json({ connected: false });
    // Validate URL to prevent SSRF
    try { const u = new URL(perfinUrl); if (u.protocol !== "http:" && u.protocol !== "https:") return res.json({ connected: false }); }
    catch { return res.json({ connected: false }); }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const r = await fetch(`${perfinUrl}/api/subscriptions?filter=active`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!r.ok) return res.json({ connected: false });
      // Perfin's GET /api/subscriptions returns `{ subscriptions: [...], summary: {...} }`,
      // not a bare array. Earlier code assumed an array and `subs.filter()` threw,
      // so the standalone widget path silently returned `{connected: false}`.
      const body = await r.json();
      const subs = Array.isArray(body) ? body : (body.subscriptions || []);
      const totalMonthly = subs.filter(s => s.cadence_days <= 31).reduce((sum, s) => sum + parseFloat(s.amount || 0), 0);
      const upcoming = subs.filter(s => {
        if (!s.next_expected) return false;
        const next = new Date(s.next_expected);
        const now = new Date();
        const diff = (next - now) / 86400000;
        return diff >= 0 && diff <= 7;
      });
      res.json({ connected: true, total_subscriptions: subs.length, monthly_cost: totalMonthly.toFixed(2), upcoming_this_week: upcoming.length, upcoming });
    } catch {
      res.json({ connected: false });
    }
  });

  // Report whether the webhook receiver is ready (used by settings UI).
  router.get("/api/perfin/webhook/status", async (_req, res) => {
    res.json({ configured: !!WEBHOOK_SECRET });
  });

  // Receive webhooks from Perfin. Perfin signs the exact JSON body with
  // HMAC-SHA256 using the shared secret and posts it here. We verify the
  // signature against req.rawBody (captured by the express.json verify hook
  // in server.js), then handle the event. Currently handled:
  //   - "insights_generated": queue a scheduled email with Perfin's
  //     pre-rendered HTML so SMTP delivers it to the user.
  //   - "test": connectivity probe used by Perfin's settings UI.
  router.post("/api/perfin/webhook", async (req, res) => {
    if (!WEBHOOK_SECRET) {
      return res.status(503).json({ error: "PERSISTENT_WEBHOOK_SECRET not configured on Per-sistant." });
    }
    const provided = req.get("x-webhook-signature") || "";
    // req.rawBody is populated by the global express.json verify hook. Fall
    // back to a fresh stringify for tests/unusual clients but warn, since
    // that comparison can drift from the sender's byte-exact signature.
    const raw = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body || {});
    const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
    let valid = false;
    try {
      const a = Buffer.from(provided);
      const b = Buffer.from(expected);
      valid = a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch { valid = false; }
    if (!valid) return res.status(401).json({ error: "Invalid signature." });

    // Replay/expiry guard (SN-1): the signed body carries a `timestamp`.
    // Reject stale/future timestamps and signatures we've already processed.
    const ts = Date.parse((req.body && req.body.timestamp) || "");
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > WEBHOOK_REPLAY_WINDOW_MS) {
      return res.status(401).json({ error: "Webhook timestamp missing, stale, or in the future." });
    }
    if (_seenWebhookSigs.has(expected)) {
      return res.status(401).json({ error: "Webhook already processed (replay)." });
    }
    _seenWebhookSigs.set(expected, Date.now());

    const { event, data = {} } = req.body || {};
    if (event === "test") {
      return res.json({ ok: true, message: "Perfin → Per-sistant webhook OK." });
    }
    if (event === "insights_generated" || event === "weekly_summary" || event === "daily_summary" || event === "critical_alert") {
      // All four events share the same { subject, html_body, plain_text } shape.
      // insights_generated fires per scheduled-cadence insight run; weekly_summary
      // is a once-per-week digest from the running_summary; daily_summary is the
      // optional once-per-day "what changed yesterday" digest from gatherWhatsNew;
      // critical_alert is the immediate budget-exceeded / anomaly email. We mail
      // all four the same way — the difference is just the subject line and
      // payload contents, which Perfin's side already composes. (critical_alert
      // was missing here while Perfin's EMAIL_EVENTS sent it — a standalone
      // deployment silently 200-and-dropped critical alerts; the embedded
      // in-process path was unaffected. Found by the June 2026 seams audit.)
      try {
        const setR = await pool.query("SELECT perfin_webhook_recipient FROM user_settings WHERE id = 1").catch(() => ({ rows: [] }));
        const recipient = (setR.rows[0] && setR.rows[0].perfin_webhook_recipient)
          || process.env.SMTP_FROM
          || process.env.SMTP_USER
          || null;
        const fallbackSubject = event === "weekly_summary"
          ? "Perfin: Your Weekly Financial Digest"
          : event === "daily_summary"
            ? "Perfin: Yesterday's Activity"
            : event === "critical_alert"
              ? "Perfin: Critical Alert"
              : "Perfin AI Financial Analysis";
        const sendNameByEvent = {
          weekly_summary: "Perfin Weekly Digest",
          daily_summary:  "Perfin Daily Digest",
          insights_generated: "Perfin Insights",
          critical_alert: "Perfin Alerts",
        };
        const subject = data.subject || fallbackSubject;
        const body = data.plain_text || "(no body)";
        const html = data.html_body || null;
        if (!recipient) {
          // No destination configured yet — save as draft so the insight isn't lost.
          await pool.query(
            "INSERT INTO emails (recipient_email, subject, body, body_html, status) VALUES ($1, $2, $3, $4, 'draft')",
            ["unset@localhost", subject, body, html]
          );
          return res.json({ ok: true, stored: "draft", reason: "no_recipient_configured" });
        }
        await pool.query(
          "INSERT INTO emails (recipient_name, recipient_email, subject, body, body_html, status, scheduled_at) VALUES ($1, $2, $3, $4, $5, 'scheduled', now())",
          [sendNameByEvent[event] || "Perfin", recipient, subject, body, html]
        );
        return res.json({ ok: true, stored: "scheduled", recipient });
      } catch (err) {
        console.error(`Perfin webhook ${event} error:`, err.message);
        return res.status(500).json({ error: "Failed to store email." });
      }
    }
    res.json({ ok: true, ignored: event });
  });

  return router;
};
