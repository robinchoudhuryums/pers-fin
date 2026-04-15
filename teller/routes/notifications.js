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

// Utility: send notification to all subscribers (called internally)
async function sendToAll(payload) {
  if (!pushConfigured()) return { sent: 0, failed: 0 };
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
    return { sent, failed };
  } catch {
    return { sent: 0, failed: 0 };
  }
}

module.exports = router;
module.exports.sendToAll = sendToAll;
