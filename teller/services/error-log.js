// ============================================================================
// In-app error log (roadmap T1.4)
// ============================================================================
// Server errors used to reach only the host's log stream: 291 console.error
// calls in Perfin, Per-sistant's serverError, the shell's error handler and its
// unhandled-rejection logger — none of which anyone reads. The shell installs a
// wrapper around console.error (install()); every call is still printed, and is
// also recorded here:
//
//   - grouped by a FINGERPRINT — the source app plus the message's first line
//     with numbers, long hex ids and quoted values blanked — so one failing
//     query logged 500 times is one row with a count;
//   - counted in memory and written in ONE batch per minute (flush), so an
//     error storm doesn't become a write storm;
//   - stored in Perfin's app_errors table (message, one sample stack, count,
//     first / last seen, resolved / notified times), shown in Settings →
//     Sync Health → Recent errors with a Resolve button. A resolved error that
//     happens again reopens;
//   - announced by one notification per NEW or REOPENED fingerprint, at most
//     NOTIFY_PER_DAY in any 24 hours.
//
// Recording can never throw into the caller and never recurses: capture() is
// re-entrancy guarded, and this module reports its own problems with the
// ORIGINAL console.error under an "[error-log]" prefix that capture ignores.
// Everything stays in the app's own database — nothing is sent to a third party.

const crypto = require("crypto");

const FLUSH_MS = 60 * 1000;
const MAX_BUFFER = 100;          // distinct fingerprints held between flushes
const MAX_MESSAGE = 300;
const MAX_SAMPLE = 2000;
const NOTIFY_PER_DAY = 5;
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
// Lines that are not server errors. The first is this module's own reporting.
const IGNORE = [/^\[error-log\]/, /^Forced shutdown after timeout/];

const buffer = new Map(); // fingerprint → { fingerprint, source, message, sample, count, firstAt, lastAt }
const state = {
  pool: null, timer: null, flushing: false, inFlight: null, capturing: false, dropped: 0,
  origError: null, lastPrune: 0,
};

function selfLog(...args) {
  const out = state.origError || console.error;
  out.call(console, "[error-log]", ...args);
}

// First line, with the parts that vary between occurrences blanked.
function normalize(message) {
  return String(message || "").split("\n")[0]
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "?")
    .replace(/\b[0-9a-f]{8,}\b/gi, "#")
    .replace(/\d+(\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function fingerprint(source, message) {
  return crypto.createHash("sha1").update(source + "|" + normalize(message)).digest("hex").slice(0, 16);
}

// console.error's arguments → { message, sample }.
function describe(args) {
  const parts = [];
  let stack = null;
  for (const a of args) {
    if (a instanceof Error) {
      parts.push(a.message || a.name || "Error");
      if (!stack && a.stack) stack = a.stack;
    } else if (typeof a === "string") {
      parts.push(a);
    } else {
      let text;
      try { text = JSON.stringify(a); } catch (e) { text = String(a); }
      parts.push(text === undefined ? String(a) : text);
    }
  }
  const full = parts.join(" ").trim();
  return {
    message: full.split("\n")[0].slice(0, MAX_MESSAGE) || "(empty error message)",
    sample: (stack || full).slice(0, MAX_SAMPLE),
  };
}

// Which app logged it, from the caller's stack frame.
function sourceOf(stackText) {
  const frames = String(stackText || "").split("\n").slice(1);
  for (const f of frames) {
    if (f.includes("error-log.js") || f.includes("node:")) continue;
    if (f.includes("/apps/per-sistant/")) return "per-sistant";
    if (f.includes("/shell/")) return "shell";
    if (f.includes("/teller/")) return "perfin";
    if (f.includes("/scripts/")) return "scripts";
  }
  return "app";
}

// Record one console.error call. Never throws.
function capture(args, { source, now = Date.now() } = {}) {
  if (state.capturing) return;
  state.capturing = true;
  try {
    const { message, sample } = describe(args);
    if (IGNORE.some((re) => re.test(message))) return;
    const src = source || sourceOf(new Error().stack);
    const fp = fingerprint(src, message);
    const entry = buffer.get(fp);
    if (entry) {
      entry.count += 1;
      entry.lastAt = now;
      entry.message = message;
      entry.sample = sample;
    } else if (buffer.size < MAX_BUFFER) {
      buffer.set(fp, { fingerprint: fp, source: src, message, sample, count: 1, firstAt: now, lastAt: now });
    } else {
      state.dropped += 1;
    }
  } catch (err) {
    selfLog("capture failed:", err && err.message);
  } finally {
    state.capturing = false;
  }
}

// Wrap console.error. Returns an uninstall function; installing twice is a no-op.
function install(target = console) {
  if (state.origError) return () => {};
  const orig = target.error;
  state.origError = orig;
  target.error = function errorWithLog(...args) {
    orig.apply(target, args);
    capture(args);
  };
  return () => { target.error = orig; state.origError = null; };
}

// The previous resolved_at decides "reopened": a row resolved before this
// batch's newest occurrence is unresolved again and announced again.
const UPSERT_SQL = `
  WITH prev AS (SELECT resolved_at FROM app_errors WHERE fingerprint = $1)
  INSERT INTO app_errors (fingerprint, source, message, sample, count, first_seen, last_seen)
  VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), to_timestamp($7 / 1000.0))
  ON CONFLICT (fingerprint) DO UPDATE SET
    source = EXCLUDED.source,
    message = EXCLUDED.message,
    sample = EXCLUDED.sample,
    count = app_errors.count + EXCLUDED.count,
    last_seen = GREATEST(app_errors.last_seen, EXCLUDED.last_seen),
    resolved_at = CASE WHEN app_errors.resolved_at IS NOT NULL AND EXCLUDED.last_seen > app_errors.resolved_at
                       THEN NULL ELSE app_errors.resolved_at END
  RETURNING (xmax = 0) AS inserted,
            ((SELECT resolved_at FROM prev) IS NOT NULL AND app_errors.resolved_at IS NULL) AS reopened`;

// Write the buffered errors, announce new / reopened ones, prune old rows.
// Never throws. Entries that couldn't be written go back into the buffer.
// `drain: true` (the shutdown flush) first waits for a periodic flush already
// writing — it used to return at once, losing up to a minute of errors
// (seams audit #3).
async function flush(opts = {}) {
  if (opts.drain) while (state.inFlight) await state.inFlight;
  const owns = !state.flushing;
  const p = flushOnce(opts);
  if (owns) state.inFlight = p;
  try { return await p; } finally { if (state.inFlight === p) state.inFlight = null; }
}

async function flushOnce({ notify = true } = {}) {
  const pool = state.pool;
  if (!pool || state.flushing) return { written: 0 };
  // Cycle-8 F32: the daily prune also runs in a quiet minute — it used to run
  // only after a flush that had new errors, so a log that stopped erroring kept
  // its old rows. pruneIfDue reads the database at most once a day.
  if (buffer.size === 0) { await pruneIfDue(pool); return { written: 0 }; }
  state.flushing = true;
  const entries = [...buffer.values()];
  buffer.clear();
  const announce = [];
  let written = 0;
  try {
    for (const e of entries) {
      const r = await pool.query(UPSERT_SQL, [e.fingerprint, e.source, e.message, e.sample, e.count, e.firstAt, e.lastAt]);
      written += 1;
      const row = r.rows[0] || {};
      if (row.inserted || row.reopened) announce.push({ ...e, reopened: !row.inserted });
    }
  } catch (err) {
    selfLog("write failed:", err && err.message);
    for (const e of entries.slice(written)) {
      if (!buffer.has(e.fingerprint) && buffer.size < MAX_BUFFER) buffer.set(e.fingerprint, e);
    }
  } finally {
    state.flushing = false;
  }
  if (state.dropped > 0) {
    selfLog(`${state.dropped} error line(s) dropped — more than ${MAX_BUFFER} distinct errors in one minute.`);
    state.dropped = 0;
  }
  if (notify && announce.length) await announceErrors(pool, announce);
  await pruneIfDue(pool);
  return { written };
}

async function announceErrors(pool, list) {
  try {
    const { sendToAll } = require("../routes/notifications");
    for (const e of list) {
      const c = await pool.query("SELECT count(*)::int AS n FROM app_errors WHERE notified_at > now() - interval '24 hours'");
      if ((c.rows[0] && c.rows[0].n) >= NOTIFY_PER_DAY) return;
      await sendToAll({
        title: e.reopened ? "A server error is back" : "New server error",
        body: `${e.source}: ${e.message.slice(0, 120)} — see Settings → Sync Health.`,
        tag: "app-error-" + e.fingerprint,
        data: { url: "/settings#recent-errors" },
      });
      await pool.query("UPDATE app_errors SET notified_at = now() WHERE fingerprint = $1", [e.fingerprint]);
    }
  } catch (err) {
    selfLog("notify failed:", err && err.message);
  }
}

async function pruneIfDue(pool, now = Date.now()) {
  if (now - state.lastPrune < PRUNE_EVERY_MS) return;
  state.lastPrune = now;
  try {
    await pool.query(`DELETE FROM app_errors
      WHERE (resolved_at IS NOT NULL AND resolved_at < now() - interval '30 days')
         OR last_seen < now() - interval '90 days'`);
  } catch (err) {
    selfLog("prune failed:", err && err.message);
  }
}

// Start periodic flushing (the shell calls this once migrations have run).
function start({ pool, intervalMs = FLUSH_MS } = {}) {
  state.pool = pool || null;
  if (state.timer || !state.pool) return;
  state.timer = setInterval(() => { flush().catch((e) => selfLog("flush failed:", e && e.message)); }, intervalMs);
  if (state.timer.unref) state.timer.unref();
}

function stop() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

// --- Read / resolve (Settings → Sync Health) --------------------------------

async function listErrors(pool, { limit = 20, includeResolved = false } = {}) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const r = await pool.query(
    `SELECT fingerprint, source, message, sample, count, first_seen, last_seen, resolved_at
       FROM app_errors ${includeResolved ? "" : "WHERE resolved_at IS NULL"}
      ORDER BY last_seen DESC LIMIT $1`,
    [n]
  );
  return r.rows;
}

// Unresolved errors seen in the last `hours`.
async function recentUnresolvedCount(pool, hours = 24) {
  const r = await pool.query(
    "SELECT count(*)::int AS n FROM app_errors WHERE resolved_at IS NULL AND last_seen > now() - make_interval(hours => $1)",
    [hours]
  );
  return (r.rows[0] && r.rows[0].n) || 0;
}

async function resolveError(pool, fp) {
  if (!/^[0-9a-f]{16}$/.test(String(fp || ""))) return { ok: false, status: 400, error: "Unknown error id." };
  const r = await pool.query("UPDATE app_errors SET resolved_at = now() WHERE fingerprint = $1 RETURNING fingerprint", [fp]);
  return r.rowCount ? { ok: true } : { ok: false, status: 404, error: "Not found." };
}

module.exports = {
  install,
  capture,
  flush,
  start,
  stop,
  listErrors,
  recentUnresolvedCount,
  resolveError,
  NOTIFY_PER_DAY,
  // exported for tests
  _normalize: normalize,
  _fingerprint: fingerprint,
  _describe: describe,
  _sourceOf: sourceOf,
  _buffer: buffer,
  _state: state,
  _reset() {
    buffer.clear();
    stop();
    state.pool = null; state.flushing = false; state.inFlight = null; state.capturing = false;
    state.dropped = 0; state.lastPrune = 0;
  },
};
