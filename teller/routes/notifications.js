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
// A waiting push (held for quiet hours, or one that reached no device and is
// being retried) is given up on — left in the bell — once it has waited this
// long past the END of the quiet window it was created in, or past its own
// creation when it wasn't created in one (cycle-9 F44: the 12 hours used to
// count from creation, so with a quiet window of 12 hours or more every push
// held early in the window was marked expired at release and never pushed).
const HOLD_MAX_HOURS = 12;
// The states the release job picks up: 'held' (quiet hours) and 'retry' (the
// push failed on every device — cycle-9 F46).
const WAITING_STATES = "('held', 'retry')";
const RELEASE_BATCH = 200;
let prefsCache = null; // { prefs, at }
// The release job's in-memory gate (startup.js): true at boot (rows held before
// a restart), set by every hold, cleared once a release finds nothing left.
let heldPending = true;
let holdGeneration = 0;
let releaseNotBefore = 0; // epoch ms — while quiet, no read until the end
// A retry of a kind quiet hours never hold (a PIN lockout) may be waiting: the
// release job then runs during quiet hours too, for those rows only. True at
// boot (one may have been left by the last process); cleared once a run finds
// none.
let urgentRetry = true;
const bypassesQuiet = (type) => !!notifyPrefs.kindInfo(notifyPrefs.kindOf(type)).bypassQuiet;

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

// A send failure that can pass: no HTTP status (network, timeout), 408, 429 or
// a 5xx. Any other 4xx — a 400, a 401 / 403 (the push service refuses this
// server's VAPID key for that subscription), a 413 — fails the same way on the
// next try, so it is not retried.
function passingPushError(err) {
  const s = err && err.statusCode;
  return !Number.isInteger(s) || s === 408 || s === 429 || s >= 500;
}

// Push one payload to every subscription. A 410/404 prunes it (counted in
// `gone` as well as `failed` — a subscription that no longer exists is not a
// delivery to retry); a failure that won't pass (passingPushError false, or a
// stored subscription that can't be read) is counted in `lasting`.
async function pushToSubscribers(payload) {
  try {
    const result = await pool.query("SELECT endpoint, keys FROM push_subscriptions");
    let sent = 0, failed = 0, gone = 0, lasting = 0;
    for (const row of result.rows) {
      let sub;
      try {
        sub = subscriptionFromRow(row);
      } catch (err) {
        lasting++; failed++;
        console.error("push delivery error: a stored subscription can't be read —", err.message);
        continue;
      }
      try {
        await webpush.sendNotification(sub, JSON.stringify(payload));
        sent++;
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          gone++;
          await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [row.endpoint]);
        } else if (!passingPushError(err)) {
          lasting++;
          console.error("push delivery error (not retried — remove and re-register push on that device):", err.statusCode, err.message);
        } else {
          // Anything else is a real delivery failure — say so (F74 hid here).
          console.error("push delivery error:", err.statusCode || "", err.message);
        }
        failed++;
      }
    }
    return { sent, failed, gone, lasting };
  } catch (err) {
    console.error("sendToAll push delivery error:", err.message);
    return { sent: 0, failed: 0, gone: 0, lasting: 0, error: true };
  }
}
// Nothing reached a device AND at least one send failed for a reason that can
// pass (a push service 5xx / timeout, the subscription read itself) — worth
// another try. No subscription at all, only dead ones, or only failures that
// won't pass (a refused VAPID key), is not.
function pushFailedEverywhere(r) {
  return !!r.error || (r.sent === 0 && (r.failed - (r.gone || 0) - (r.lasting || 0)) > 0);
}

// One real-world item, one alert (cycle-8 E3d, ST2). A notification about an
// item Perfin also keeps as a Per-sistant linked task (payload.item — the task's
// key without "perfin:", e.g. "housing:2026-11") is COVERED while that task is
// open: the task is the surface, so the row is logged read and not pushed.
// Read through the shell-wired Per-sistant pool; standalone (no pool) or a
// failed read → not covered, so the push goes out. "Open" is Per-sistant's own
// predicate (services/linked-tasks.openLinkedItems — not completed, not trashed,
// and since cycle-9 F45 due today or earlier;
// a task you reopened by hand still counts), the one its notification check and
// briefing use, so the two apps never disagree about the same task (seams audit
// #4 A2: this read also required NOT source_detached, so a hand-reopened rent
// task hid Per-sistant's reminder while Perfin still pushed).
const ITEM_RE = /^[a-z][a-z-]*:[A-Za-z0-9._:-]{1,160}$/;
function itemKey(item) {
  // Without the "perfin:" prefix — the lookup adds it.
  return typeof item === "string" && ITEM_RE.test(item) && !item.startsWith("perfin:") ? item : null;
}
// Cycle-9 F45: covered only while the task is SHOWING — due on `today` or
// earlier (openLinkedItems' surfacingOn). A task due later is silent, so the
// push goes out; a task with no due date never covers.
function localDay(now) {
  const at = now instanceof Date ? now : new Date();
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: NOTIFY_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  } catch {
    return at.toISOString().slice(0, 10); // an unknown zone → UTC
  }
}
// `item` may be a list: the notification's own item first, then the other
// items that stand for the same thing (the rent push: every unpaid month) — a
// showing task for any of them covers.
async function itemCovered(item, today = localDay()) {
  const items = (Array.isArray(item) ? item : [item]).filter(Boolean);
  if (!items.length) return false;
  let pp = null;
  try { pp = require("./persistent").getEmbeddedPersistentPool(); } catch { pp = null; } // no Per-sistant wiring → standalone
  if (!pp) return false;
  try {
    const { openLinkedItems } = require("../../apps/per-sistant/services/linked-tasks");
    // openLinkedItems is fail-soft itself (logs, empty set).
    return (await openLinkedItems(pp, items, { surfacingOn: today })).size > 0;
  } catch (err) {
    console.error("linked task lookup for a notification failed:", err.message);
    return false;
  }
}

// The other items a notification's linked-task cover may come from (see
// itemCovered): well-formed keys only, never the item itself, at most 24.
function coverItems(list, item) {
  if (!item || !Array.isArray(list)) return [];
  return [...new Set(list.map(itemKey).filter((k) => k && k !== item))].slice(0, 24);
}

// Also logs to notification_log for in-app history. opts.now: the clock (tests).
// payload.item (optional): the real-world item, see itemCovered;
// payload.cover_items (optional, with item): other items standing for the same
// thing — kept in the row's data so a held push is checked the same way.
async function sendToAll(payload, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const kind = notifyPrefs.kindOf(payload.tag);
  const item = itemKey(payload.item);
  const also = coverItems(payload.cover_items, item);
  const prefs = await readNotifyPrefs();
  let state = notifyPrefs.decide({ kind, prefs, now, tz: NOTIFY_TZ });
  if (item && state !== "muted" && (await itemCovered([item, ...also], localDay(now)))) state = "covered";
  if (!pushConfigured() && state !== "muted" && state !== "covered") state = "none";
  // A held push remembers when its quiet hours end (hold_until), by the
  // settings in force now.
  const holdMins = state === "held" ? notifyPrefs.minutesUntilQuietEnd(now, prefs && prefs.quiet, NOTIFY_TZ) : 0;
  const holdUntil = holdMins > 0 ? new Date(now.getTime() + holdMins * 60 * 1000) : null;

  // Always log to notification_log, even if push isn't configured. This row is
  // ALSO the dedup marker that sentRecently() reads, so the return value carries
  // `logged` — if this insert fails, the marker didn't persist and a dedup-gated
  // caller (e.g. the budget-alert scheduler) must not treat the alert as
  // recorded, or it would re-fire on the next tick (F24). A held / muted push
  // doesn't change that: the row is written the same way.
  let logged = false;
  let rowId = null;
  try {
    // A covered row is written read — the task is the surface, so the bell's
    // unread count doesn't repeat it.
    const data = also.length ? { ...(payload.data || {}), cover_items: also } : payload.data || {};
    const ins = await pool.query(
      `INSERT INTO notification_log (type, title, body, data, push_state, item_key, is_read, hold_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [payload.tag || "general", payload.title || "", payload.body || "", JSON.stringify(data), state, item, state === "covered", holdUntil]
    );
    logged = true;
    rowId = ins && ins.rows && ins.rows[0] ? ins.rows[0].id : null;
  } catch (err) {
    console.error("notification_log insert error:", err.message);
  }
  await pruneNotificationLog();

  if (state === "muted" || state === "none" || state === "covered") return { sent: 0, failed: 0, logged, push_state: state };
  if (state === "held") {
    if (logged) {
      heldPending = true;
      holdGeneration++;
      if (holdUntil) releaseNotBefore = holdUntil.getTime();
      return { sent: 0, failed: 0, logged, push_state: "held" };
    }
    // No row to release later — deliver now rather than lose it.
    state = "sent";
  }
  const { item: _item, cover_items: _cover, ...pushPayload } = payload;
  const r = await pushToSubscribers(pushPayload);
  // 'sent' means a device took it (seams audit #4 A1): with no live
  // subscription — or every send failing — nothing reached anyone, and
  // Per-sistant's check (perfinPushedItems) must not stay quiet for the item.
  if (r.sent === 0) {
    // Cycle-9 F46: a push that FAILED on every device (not "nobody is
    // subscribed") is kept for the release job to try again — the caller sees
    // `logged` and moves its own watermark on, so nothing else would ever
    // retry it. Without a row there is nothing to retry from.
    state = pushFailedEverywhere(r) && rowId != null ? "retry" : "none";
    if (rowId != null) {
      try {
        await pool.query(`UPDATE notification_log SET push_state = '${state}' WHERE id = ANY($1::int[]) AND push_state = 'sent'`, [[rowId]]);
        if (state === "retry") {
          heldPending = true;
          holdGeneration++;
          // Quiet hours never hold this kind, so its retry doesn't wait for them either.
          if (bypassesQuiet(payload.tag)) urgentRetry = true;
        }
      } catch (err) {
        console.error("notification_log push_state update error:", err.message);
        state = "none";
      }
    }
  }
  return { sent: r.sent, failed: r.failed, logged, push_state: state };
}

// The release job's gate (in memory — no query while nothing is held or quiet
// hours are still running).
function releaseDue(now = Date.now()) {
  return heldPending && (urgentRetry || now >= releaseNotBefore);
}

// When a waiting row could first have gone out — the 12-hour limit counts from
// here. The LATER of: the end of the quiet hours it was created in by today's
// settings (so a window you lengthened since isn't cut short), and the end
// recorded at the hold (hold_until — so a window you moved since, which no
// longer contains the row's creation, still counts). Its creation time when it
// was created in neither (a retry), and always for a kind quiet hours never hold.
function holdWindowEnd(h, prefs) {
  const created = h.created_at instanceof Date ? h.created_at : new Date(h.created_at);
  if (!Number.isFinite(created.getTime())) return null;
  let end = created.getTime();
  if (!bypassesQuiet(h.type)) {
    const mins = prefs ? notifyPrefs.minutesUntilQuietEnd(created, prefs.quiet, NOTIFY_TZ) : 0;
    end += mins * 60 * 1000;
    const stored = h.hold_until == null ? NaN : new Date(h.hold_until).getTime();
    if (Number.isFinite(stored) && stored > end) end = stored;
  }
  return new Date(end);
}
function holdExpired(h, prefs, now) {
  const end = holdWindowEnd(h, prefs);
  // An unreadable time can't be shown to be recent — don't push it late.
  return !end || now.getTime() - end.getTime() > HOLD_MAX_HOURS * 60 * 60 * 1000;
}

// Push what is waiting — what quiet hours held, once they've ended, and what
// failed on every device (F46): one notification as itself, several as ONE
// summary. One that has waited more than HOLD_MAX_HOURS past the end of its
// quiet window is left in the bell — 'expired' when quiet hours held it,
// 'failed' when it was a retry; a kind muted since is marked muted. Rows are
// marked sent only after the push went out — a failed delivery leaves them
// waiting for the next run. During quiet hours only the retries of kinds quiet
// hours never hold (a PIN lockout) are tried; everything else waits for the end.
// Returns { ok, outcome: quiet | none | released | expired | failed, released,
// expired, error? }.
async function releaseHeldNotifications({ now = new Date() } = {}) {
  const gen = holdGeneration;
  const prefs = await readNotifyPrefs({ fresh: true });
  const quiet = !!(prefs && notifyPrefs.isQuiet(now, prefs.quiet, NOTIFY_TZ));
  const quietEnd = quiet ? now.getTime() + notifyPrefs.minutesUntilQuietEnd(now, prefs.quiet, NOTIFY_TZ) * 60 * 1000 : 0;
  const stillQuiet = () => {
    if (holdGeneration === gen) urgentRetry = false;
    releaseNotBefore = quietEnd;
    return { ok: true, outcome: "quiet", released: 0, expired: 0 };
  };
  if (quiet && !urgentRetry) return stillQuiet();
  let waiting = (await pool.query(
    `SELECT id, type, title, body, data, item_key, push_state, created_at, hold_until FROM notification_log
      WHERE push_state IN ${quiet ? "('retry')" : WAITING_STATES} ORDER BY created_at, id LIMIT $1`,
    [RELEASE_BATCH]
  )).rows;
  const full = waiting.length >= RELEASE_BATCH;
  if (quiet) {
    waiting = waiting.filter((h) => bypassesQuiet(h.type));
    if (!waiting.length) return stillQuiet();
  }
  // Expiry is decided per row, against the end of the quiet window it was
  // created in (F44).
  const stale = waiting.filter((h) => holdExpired(h, prefs, now));
  for (const [from, to] of [["held", "expired"], ["retry", "failed"]]) {
    const ids = stale.filter((h) => (h.push_state === "retry" ? "retry" : "held") === from).map((h) => h.id);
    if (ids.length) await pool.query(`UPDATE notification_log SET push_state = '${to}' WHERE id = ANY($1::int[]) AND push_state = '${from}'`, [ids]);
  }
  const expired = stale.length;
  const held = waiting.filter((h) => !stale.includes(h));
  // Nothing left waiting (that this run may push): close the gate. During
  // quiet hours only the urgent part is settled — what quiet hours hold still
  // waits for their end.
  const done = () => {
    if (holdGeneration !== gen || full) return;
    urgentRetry = false;
    if (quiet) releaseNotBefore = quietEnd;
    else heldPending = false;
  };

  const muted = prefs ? held.filter((h) => prefs.muted.includes(notifyPrefs.kindOf(h.type))) : [];
  if (muted.length) {
    await pool.query(`UPDATE notification_log SET push_state = 'muted' WHERE id = ANY($1::int[]) AND push_state IN ${WAITING_STATES}`, [muted.map((h) => h.id)]);
  }
  const dataOf = (h) => (typeof h.data === "string" ? JSON.parse(h.data || "{}") : h.data) || {};
  // An item whose linked task opened (or came due) while its push waited is
  // covered now (E3d) — its own item or one of the row's cover_items.
  const covered = [];
  for (const h of held) {
    if (!h.item_key || muted.includes(h)) continue;
    if (await itemCovered([h.item_key, ...coverItems(dataOf(h).cover_items, h.item_key)], localDay(now))) covered.push(h);
  }
  if (covered.length) {
    await pool.query(`UPDATE notification_log SET push_state = 'covered', is_read = true WHERE id = ANY($1::int[]) AND push_state IN ${WAITING_STATES}`, [covered.map((h) => h.id)]);
  }
  const rows = held.filter((h) => !muted.includes(h) && !covered.includes(h));
  if (!rows.length) { done(); return { ok: true, outcome: expired ? "expired" : "none", released: 0, expired }; }
  const ids = rows.map((h) => h.id);
  if (!pushConfigured()) {
    await pool.query(`UPDATE notification_log SET push_state = 'none' WHERE id = ANY($1::int[]) AND push_state IN ${WAITING_STATES}`, [ids]);
    done();
    return { ok: true, outcome: "none", released: 0, expired };
  }
  const pushData = (h) => { const { cover_items: _c, ...d } = dataOf(h); return d; };
  const payload = rows.length === 1
    ? { title: rows[0].title, body: rows[0].body, tag: rows[0].type, data: pushData(rows[0]) }
    : {
        // "during quiet hours" only when that is why every one of them waited.
        title: rows.length + (rows.every((h) => h.push_state !== "retry") ? " notifications during quiet hours" : " notifications waiting"),
        body: rows.slice(-3).reverse().map((h) => h.title).join(" · ") + (rows.length > 3 ? " · +" + (rows.length - 3) + " more" : ""),
        tag: "quiet-summary",
        data: { url: dataOf(rows[rows.length - 1]).url || "/dashboard" },
      };
  const r = await pushToSubscribers(payload);
  if (pushFailedEverywhere(r)) {
    return { ok: false, outcome: "failed", released: 0, expired, error: "The held notifications couldn't be pushed — they'll be retried." };
  }
  // No live subscription (or only ones that refuse this server) → nothing was
  // delivered: 'none', not 'sent' (A1).
  const delivered = r.sent > 0 ? "sent" : "none";
  await pool.query(`UPDATE notification_log SET push_state = '${delivered}' WHERE id = ANY($1::int[]) AND push_state IN ${WAITING_STATES}`, [ids]);
  done();
  return { ok: true, outcome: delivered === "sent" ? "released" : "none", released: delivered === "sent" ? rows.length : 0, expired };
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
module.exports.passingPushError = passingPushError;
// Tests: the in-memory release gate.
module.exports._release = {
  state: () => ({ heldPending, releaseNotBefore, holdGeneration, urgentRetry }),
  reset(v = {}) { heldPending = v.heldPending ?? true; releaseNotBefore = v.releaseNotBefore ?? 0; urgentRetry = v.urgentRetry ?? heldPending; prefsCache = null; },
};
