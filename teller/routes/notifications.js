// ============================================================================
// Routes: Web Push Notifications
// ============================================================================

const express = require("express");
const router = express.Router();
const { pool } = require("../services/database");

let webpush;
try {
  webpush = require("web-push");
} catch {
  webpush = null;
}

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL = process.env.VAPID_EMAIL || "mailto:admin@perfin.app";

if (webpush && VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
}

function pushConfigured() {
  return !!(webpush && VAPID_PUBLIC && VAPID_PRIVATE);
}

// GET /api/notifications/vapid — return public VAPID key for client subscription
router.get("/api/notifications/vapid", (_req, res) => {
  if (!pushConfigured()) {
    return res.status(501).json({ error: "Push notifications not configured. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY." });
  }
  res.json({ publicKey: VAPID_PUBLIC });
});

// POST /api/notifications/subscribe — store push subscription
router.post("/api/notifications/subscribe", async (req, res) => {
  const { subscription } = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: "subscription object with endpoint is required" });
  }
  try {
    await pool.query(
      `INSERT INTO push_subscriptions (endpoint, keys, created_at)
       VALUES ($1, $2, now())
       ON CONFLICT (endpoint) DO UPDATE SET keys = $2, created_at = now()`,
      [subscription.endpoint, JSON.stringify(subscription)]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// DELETE /api/notifications/subscribe — remove push subscription
router.delete("/api/notifications/subscribe", async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: "endpoint is required" });
  try {
    await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/notifications/test — send a test notification
router.post("/api/notifications/test", async (_req, res) => {
  if (!pushConfigured()) {
    return res.status(501).json({ error: "Push not configured." });
  }
  try {
    const result = await pool.query("SELECT endpoint, keys FROM push_subscriptions");
    let sent = 0, failed = 0;
    for (const row of result.rows) {
      try {
        const sub = JSON.parse(row.keys);
        await webpush.sendNotification(sub, JSON.stringify({
          title: "Perfin",
          body: "Push notifications are working!",
          icon: "/logo.svg",
          tag: "test",
        }));
        sent++;
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [row.endpoint]);
        }
        failed++;
      }
    }
    res.json({ sent, failed, total: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Notification Log — in-app notification history
// ============================================================================

// GET /api/notifications — list notification history
router.get("/api/notifications", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const unreadOnly = req.query.unread === "true";
  try {
    const condition = unreadOnly ? "WHERE is_read = false" : "";
    const result = await pool.query(
      `SELECT * FROM notification_log ${condition} ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    const unreadCount = await pool.query(
      "SELECT COUNT(*) AS count FROM notification_log WHERE is_read = false"
    );
    res.json({
      notifications: result.rows,
      unread_count: parseInt(unreadCount.rows[0].count),
    });
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// PATCH /api/notifications/:id/read — mark a notification as read
router.patch("/api/notifications/:id/read", async (req, res) => {
  try {
    await pool.query("UPDATE notification_log SET is_read = true WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/notifications/read-all — mark all notifications as read
router.post("/api/notifications/read-all", async (_req, res) => {
  try {
    await pool.query("UPDATE notification_log SET is_read = true WHERE is_read = false");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// Utility: send notification to all subscribers (called internally)
// Also logs to notification_log for in-app history.
async function sendToAll(payload) {
  // Always log to notification_log, even if push isn't configured. This row is
  // ALSO the dedup marker that sentRecently() reads, so the return value carries
  // `logged` — if this insert fails, the marker didn't persist and a dedup-gated
  // caller (e.g. the budget-alert scheduler) must not treat the alert as
  // recorded, or it would re-fire on the next tick (F24).
  let logged = false;
  try {
    await pool.query(
      "INSERT INTO notification_log (type, title, body, data) VALUES ($1, $2, $3, $4)",
      [payload.tag || "general", payload.title || "", payload.body || "", JSON.stringify(payload.data || {})]
    );
    logged = true;
  } catch (err) {
    console.error("notification_log insert error:", err.message);
  }

  if (!pushConfigured()) return { sent: 0, failed: 0, logged };
  try {
    const result = await pool.query("SELECT endpoint, keys FROM push_subscriptions");
    let sent = 0, failed = 0;
    for (const row of result.rows) {
      try {
        const sub = JSON.parse(row.keys);
        await webpush.sendNotification(sub, JSON.stringify(payload));
        sent++;
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [row.endpoint]);
        }
        failed++;
      }
    }
    return { sent, failed, logged };
  } catch (err) {
    console.error("sendToAll push delivery error:", err.message);
    return { sent: 0, failed: 0, logged };
  }
}

// Utility: has a notification with this tag been sent within the last N hours?
// Backed by notification_log (sendToAll stores payload.tag in the `type`
// column), so the dedup window survives restarts. Fails open (returns false)
// on a query error — a missed dedup is one extra notification, while failing
// closed would silently suppress real alerts.
async function sentRecently(tag, hours = 24) {
  try {
    const r = await pool.query(
      "SELECT 1 FROM notification_log WHERE type = $1 AND created_at > now() - make_interval(hours => $2) LIMIT 1",
      [tag, hours]
    );
    return r.rows.length > 0;
  } catch (err) {
    console.error("sentRecently check error:", err.message);
    return false;
  }
}

module.exports = router;
module.exports.sendToAll = sendToAll;
module.exports.sentRecently = sentRecently;
