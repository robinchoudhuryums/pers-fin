const express = require("express");
const crypto = require("crypto");

module.exports = function ({ pool, config }) {
  const router = express.Router();
  const PERFIN_URL = config.PERFIN_URL;
  // Shared HMAC secret between Perfin and Per-sistant. Must equal the value
  // Perfin uses for `persistent_webhook_secret` / PERSISTENT_WEBHOOK_SECRET.
  const WEBHOOK_SECRET = process.env.PERSISTENT_WEBHOOK_SECRET || null;

  router.get("/api/perfin/stats", async (req, res) => {
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
      const subs = await r.json();
      const totalMonthly = subs.filter(s => s.cadence_days <= 31).reduce((sum, s) => sum + parseFloat(s.amount || 0), 0);
      const upcoming = subs.filter(s => {
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

    const { event, data = {} } = req.body || {};
    if (event === "test") {
      return res.json({ ok: true, message: "Perfin → Per-sistant webhook OK." });
    }
    if (event === "insights_generated") {
      try {
        const setR = await pool.query("SELECT perfin_webhook_recipient FROM user_settings WHERE id = 1").catch(() => ({ rows: [] }));
        const recipient = (setR.rows[0] && setR.rows[0].perfin_webhook_recipient)
          || process.env.SMTP_FROM
          || process.env.SMTP_USER
          || null;
        const subject = data.subject || "Perfin AI Financial Analysis";
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
          ["Perfin Insights", recipient, subject, body, html]
        );
        return res.json({ ok: true, stored: "scheduled", recipient });
      } catch (err) {
        console.error("Perfin webhook insights_generated error:", err.message);
        return res.status(500).json({ error: "Failed to store insight email." });
      }
    }
    res.json({ ok: true, ignored: event });
  });

  return router;
};
