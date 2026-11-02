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

// push_subscriptions.keys is JSONB, which node-pg already returns as an
// OBJECT — JSON.parse(object) threw "[object Object] is not valid JSON" for
// every subscriber, so no push was ever delivered and dead subscriptions were
// never pruned (F74). Accept a string too (legacy TEXT column / tests).
function subscriptionFromRow(row) {
  return typeof row.keys === "string" ? JSON.parse(row.keys) : row.keys;
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
        const sub = subscriptionFromRow(row);
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
    // Log the detail, answer generically (cycle-7 F16 — it echoed err.message).
    console.error("Test notification error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
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
// notification_log retention (cycle-7 F86 — the table grew without bound):
// READ notifications older than NOTIFICATION_RETENTION_DAYS are deleted, at
// most once a day, on the next send. Unread ones stay until read. The longest
// dedup window sentRecently() is asked for is days, far inside this.
const NOTIFICATION_RETENTION_DAYS = 180;
let lastNotificationPruneAt = 0;
async function pruneNotificationLog(now = Date.now()) {
  if (now - lastNotificationPruneAt < 24 * 60 * 60 * 1000) return;
  lastNotificationPruneAt = now;
  try {
    await pool.query(
      "DELETE FROM notification_log WHERE is_read = true AND created_at < now() - make_interval(days => $1)",
      [NOTIFICATION_RETENTION_DAYS]
    );
  } catch (err) {
    console.error("notification_log prune error:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Quiet hours and mutes (cycle-8 E3b, G2 — services/notify-prefs.js). They act
// on the INTERRUPTION only: every notification is still written to
// notification_log exactly as before (the bell, and the dedup marker every
// caller's `logged` check relies on); push_state records what happened to
// its push — sent / held (quiet hours) / muted / none (push not configured).
// ---------------------------------------------------------------------------
const notifyPrefs = require("../services/notify-prefs");
const NOTIFY_TZ = process.env.APP_TIMEZONE || "UTC";
const PREFS_TTL_MS = 60 * 1000;
const HOLD_MAX_HOURS = 12; // a hold older than this stays in the bell, never pushed late
const RELEASE_BATCH = 200;
let prefsCache = null; // { prefs, at }
// The release job's in-memory gate (startup.js): true at boot (rows held before
// a restart), set by every hold, cleared once a release finds nothing left.
let heldPending = true;
let holdGeneration = 0;
let releaseNotBefore = 0; // epoch ms — while quiet, no read until the end

// The settings row's quiet hours + muted kinds, cached 60 s. A failed read is
// null — decide() then holds and mutes nothing: a settings outage never
// silences an alert.
async function readNotifyPrefs({ fresh = false } = {}) {
  if (!fresh && prefsCache && Date.now() - prefsCache.at < PREFS_TTL_MS) return prefsCache.prefs;
  try {
    const r = await pool.query("SELECT notify_quiet_hours, notify_muted_types FROM user_settings WHERE id = 1");
    const prefs = notifyPrefs.normalizePrefs(r.rows[0] || null);
    prefsCache = { prefs, at: Date.now() };
    return prefs;
  } catch (err) {
    console.error("notification prefs read error:", err.message);
    return null;
  }
}

// PATCH /api/settings calls this when notify_quiet_hours / notify_muted_types
// change: the next send reads them again, and a release waiting for the end of
// quiet hours checks at once (switching quiet hours off releases what's held).
function invalidateNotifyPrefs() {
  prefsCache = null;
  releaseNotBefore = 0;
}

// Push one payload to every subscription. A 410/404 prunes it.
async function pushToSubscribers(payload) {
  try {
    const result = await pool.query("SELECT endpoint, keys FROM push_subscriptions");
    let sent = 0, failed = 0;
    for (const row of result.rows) {
      try {
        const sub = subscriptionFromRow(row);
        await webpush.sendNotification(sub, JSON.stringify(payload));
        sent++;
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [row.endpoint]);
        } else {
          // Anything else is a real delivery failure — say so (F74 hid here).
          console.error("push delivery error:", err.statusCode || "", err.message);
        }
        failed++;
      }
    }
    return { sent, failed };
  } catch (err) {
    console.error("sendToAll push delivery error:", err.message);
    return { sent: 0, failed: 0, error: true };
  }
}

// One real-world item, one alert (cycle-8 E3d, ST2). A notification about an
// item Perfin also keeps as a Per-sistant linked task (payload.item — the task's
// key without "perfin:", e.g. "housing:2026-11") is COVERED while that task is
// open: the task is the surface, so the row is logged read and not pushed.
// Read through the shell-wired Per-sistant pool; standalone (no pool) or a
// failed read → not covered, so the push goes out.
const ITEM_RE = /^[a-z][a-z-]*:[A-Za-z0-9._:-]{1,160}$/;
function itemKey(item) {
  // Without the "perfin:" prefix — the lookup adds it.
  return typeof item === "string" && ITEM_RE.test(item) && !item.startsWith("perfin:") ? item : null;
}
async function itemCovered(item) {
  if (!item) return false;
  let pp = null;
  try { pp = require("./persistent").getEmbeddedPersistentPool(); } catch { pp = null; } // no Per-sistant wiring → standalone
  if (!pp) return false;
  try {
    const r = await pp.query(
      `SELECT 1 FROM todos WHERE source_key = $1 AND NOT completed
          AND deleted_at IS NULL AND NOT source_detached LIMIT 1`,
      ["perfin:" + item]
    );
    return r.rows.length > 0;
  } catch (err) {
    console.error("linked task lookup for a notification failed:", err.message);
    return false;
  }
}

// Also logs to notification_log for in-app history. opts.now: the clock (tests).
// payload.item (optional): the real-world item, see itemCovered.
async function sendToAll(payload, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const kind = notifyPrefs.kindOf(payload.tag);
  const item = itemKey(payload.item);
  const prefs = await readNotifyPrefs();
  let state = notifyPrefs.decide({ kind, prefs, now, tz: NOTIFY_TZ });
  if (item && state !== "muted" && (await itemCovered(item))) state = "covered";
  if (!pushConfigured() && state !== "muted" && state !== "covered") state = "none";

  // Always log to notification_log, even if push isn't configured. This row is
  // ALSO the dedup marker that sentRecently() reads, so the return value carries
  // `logged` — if this insert fails, the marker didn't persist and a dedup-gated
  // caller (e.g. the budget-alert scheduler) must not treat the alert as
  // recorded, or it would re-fire on the next tick (F24). A held / muted push
  // doesn't change that: the row is written the same way.
  let logged = false;
  try {
    // A covered row is written read — the task is the surface, so the bell's
    // unread count doesn't repeat it.
    await pool.query(
      `INSERT INTO notification_log (type, title, body, data, push_state, item_key, is_read)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [payload.tag || "general", payload.title || "", payload.body || "", JSON.stringify(payload.data || {}), state, item, state === "covered"]
    );
    logged = true;
  } catch (err) {
    console.error("notification_log insert error:", err.message);
  }
  await pruneNotificationLog();

  if (state === "muted" || state === "none" || state === "covered") return { sent: 0, failed: 0, logged, push_state: state };
  if (state === "held") {
    if (logged) {
      heldPending = true;
      holdGeneration++;
      const mins = notifyPrefs.minutesUntilQuietEnd(now, prefs && prefs.quiet, NOTIFY_TZ);
      if (mins > 0) releaseNotBefore = now.getTime() + mins * 60 * 1000;
      return { sent: 0, failed: 0, logged, push_state: "held" };
    }
    // No row to release later — deliver now rather than lose it.
    state = "sent";
  }
  const { item: _item, ...pushPayload } = payload;
  const r = await pushToSubscribers(pushPayload);
  return { sent: r.sent, failed: r.failed, logged, push_state: state };
}

// The release job's gate (in memory — no query while nothing is held or quiet
// hours are still running).
function releaseDue(now = Date.now()) {
  return heldPending && now >= releaseNotBefore;
}

// Push what quiet hours held, once they've ended: one held notification as
// itself, several as ONE summary. A hold older than HOLD_MAX_HOURS is left in
// the bell (expired); a kind muted since is marked muted. Rows are marked sent
// only after the push went out — a failed delivery leaves them held for the
// next run. Returns { ok, outcome: quiet | none | released | expired | failed,
// released, expired, error? }.
async function releaseHeldNotifications({ now = new Date() } = {}) {
  const gen = holdGeneration;
  const prefs = await readNotifyPrefs({ fresh: true });
  if (prefs && notifyPrefs.isQuiet(now, prefs.quiet, NOTIFY_TZ)) {
    releaseNotBefore = now.getTime() + notifyPrefs.minutesUntilQuietEnd(now, prefs.quiet, NOTIFY_TZ) * 60 * 1000;
    return { ok: true, outcome: "quiet", released: 0, expired: 0 };
  }
  const exp = await pool.query(
    `UPDATE notification_log SET push_state = 'expired'
      WHERE push_state = 'held' AND created_at < $1::timestamptz - make_interval(hours => $2)
      RETURNING id`,
    [now.toISOString(), HOLD_MAX_HOURS]
  );
  const expired = exp.rows.length;
  const held = (await pool.query(
    `SELECT id, type, title, body, data, item_key FROM notification_log
      WHERE push_state = 'held' ORDER BY created_at, id LIMIT $1`,
    [RELEASE_BATCH]
  )).rows;
  const done = () => { if (holdGeneration === gen && held.length < RELEASE_BATCH) heldPending = false; };

  const muted = prefs ? held.filter((h) => prefs.muted.includes(notifyPrefs.kindOf(h.type))) : [];
  if (muted.length) {
    await pool.query("UPDATE notification_log SET push_state = 'muted' WHERE id = ANY($1::int[]) AND push_state = 'held'", [muted.map((h) => h.id)]);
  }
  // An item whose linked task opened while its push was held is covered now (E3d).
  const covered = [];
  for (const h of held) {
    if (h.item_key && !muted.includes(h) && (await itemCovered(h.item_key))) covered.push(h);
  }
  if (covered.length) {
    await pool.query("UPDATE notification_log SET push_state = 'covered', is_read = true WHERE id = ANY($1::int[]) AND push_state = 'held'", [covered.map((h) => h.id)]);
  }
  const rows = held.filter((h) => !muted.includes(h) && !covered.includes(h));
  if (!rows.length) { done(); return { ok: true, outcome: expired ? "expired" : "none", released: 0, expired }; }
  const ids = rows.map((h) => h.id);
  if (!pushConfigured()) {
    await pool.query("UPDATE notification_log SET push_state = 'none' WHERE id = ANY($1::int[]) AND push_state = 'held'", [ids]);
    done();
    return { ok: true, outcome: "none", released: 0, expired };
  }
  const dataOf = (h) => (typeof h.data === "string" ? JSON.parse(h.data || "{}") : h.data) || {};
  const payload = rows.length === 1
    ? { title: rows[0].title, body: rows[0].body, tag: rows[0].type, data: dataOf(rows[0]) }
    : {
        title: rows.length + " notifications during quiet hours",
        body: rows.slice(-3).reverse().map((h) => h.title).join(" · ") + (rows.length > 3 ? " · +" + (rows.length - 3) + " more" : ""),
        tag: "quiet-summary",
        data: { url: dataOf(rows[rows.length - 1]).url || "/dashboard" },
      };
  const r = await pushToSubscribers(payload);
  if (r.error || (r.sent === 0 && r.failed > 0)) {
    return { ok: false, outcome: "failed", released: 0, expired, error: "The held notifications couldn't be pushed — they'll be retried." };
  }
  await pool.query("UPDATE notification_log SET push_state = 'sent' WHERE id = ANY($1::int[]) AND push_state = 'held'", [ids]);
  done();
  return { ok: true, outcome: "released", released: rows.length, expired };
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
module.exports.pruneNotificationLog = pruneNotificationLog;
module.exports.NOTIFICATION_RETENTION_DAYS = NOTIFICATION_RETENTION_DAYS;
module.exports.readNotifyPrefs = readNotifyPrefs;
module.exports.invalidateNotifyPrefs = invalidateNotifyPrefs;
module.exports.releaseDue = releaseDue;
module.exports.releaseHeldNotifications = releaseHeldNotifications;
module.exports.HOLD_MAX_HOURS = HOLD_MAX_HOURS;
module.exports.itemCovered = itemCovered;
// Tests: the in-memory release gate.
module.exports._release = {
  state: () => ({ heldPending, releaseNotBefore, holdGeneration }),
  reset(v = {}) { heldPending = v.heldPending ?? true; releaseNotBefore = v.releaseNotBefore ?? 0; prefsCache = null; },
};
