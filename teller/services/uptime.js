// ============================================================================
// Uptime (roadmap T1.4) — a database-backed health probe and a heartbeat
// ============================================================================
// GET /health (the shell) only says the process answers. Two additions:
//
//   deep health — GET /health/deep runs `SELECT 1` on both databases, each
//     bounded by DEEP_TIMEOUT_MS, and caches the outcome for DEEP_CACHE_MS so
//     a monitor (or anyone — it is public, like /health) can't turn it into a
//     database load. The response is yes/no fields only, never an error
//     message. On Render + Neon point an uptime monitor at the shallow /health
//     instead: probing the database every few minutes keeps Neon from
//     suspending and uses up its free compute hours.
//
//   heartbeat — with HEARTBEAT_URL set (e.g. a healthchecks.io check), a
//     HEARTBEAT_MS tick pings it while every scheduled job's latest run in
//     this process succeeded, and pings <url>/fail when one failed
//     (services/job-health.js failingJobs — memory only, no database call, so
//     it doesn't keep Neon awake). The monitoring service alerts on /fail and
//     when pings STOP (the process died or hung). Not activity-gated. On a
//     sleeping host (Render free tier) pings stop whenever it sleeps, so use
//     it on an always-on server or with keep-alive on.

const DEEP_TIMEOUT_MS = 3000;
const DEEP_CACHE_MS = 60 * 1000;
const HEARTBEAT_MS = 30 * 60 * 1000;
const HEARTBEAT_TIMEOUT_MS = 10000;

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function probe(pool, timeoutMs) {
  if (!pool) return null; // not wired (standalone) — reported as null, not a failure
  try {
    await withTimeout(pool.query("SELECT 1"), timeoutMs);
    return true;
  } catch (err) {
    console.error("deep health: database probe failed:", err && err.message);
    return false;
  }
}

// { ok, perfin_db, persistent_db } — booleans (null = not wired).
async function deepHealth({ perfinPool, persistentPool, timeoutMs = DEEP_TIMEOUT_MS } = {}) {
  const [perfin, persistent] = await Promise.all([probe(perfinPool, timeoutMs), probe(persistentPool, timeoutMs)]);
  return { ok: perfin !== false && persistent !== false, perfin_db: perfin, persistent_db: persistent };
}

// Express handler with a cached, single-flight probe.
function deepHealthHandler({ perfinPool, persistentPool, cacheMs = DEEP_CACHE_MS, timeoutMs = DEEP_TIMEOUT_MS } = {}) {
  let cache = null;      // { at, result }
  let inFlight = null;
  return async function healthDeep(_req, res) {
    if (!cache || Date.now() - cache.at > cacheMs) {
      if (!inFlight) {
        inFlight = deepHealth({ perfinPool, persistentPool, timeoutMs })
          .then((result) => { cache = { at: Date.now(), result }; return result; })
          .finally(() => { inFlight = null; });
      }
      await inFlight;
    }
    res.set("Cache-Control", "no-store");
    res.status(cache.result.ok ? 200 : 503).json(cache.result);
  };
}

// HEARTBEAT_URL as a validated base URL, or null.
function heartbeatUrl(env = process.env) {
  const raw = String(env.HEARTBEAT_URL || "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s/]+/i.test(raw) ? raw : null;
}

// One ping: <url> when no job is failing, <url>/fail when one is. Never throws.
async function pingHeartbeat({ env = process.env, failingJobs, fetchImpl } = {}) {
  const base = heartbeatUrl(env);
  if (!base) return { sent: false, reason: "not_configured" };
  const failing = typeof failingJobs === "function" ? failingJobs() : [];
  const url = failing.length ? base + "/fail" : base;
  try {
    const res = await (fetchImpl || fetch)(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS) });
    if (!res.ok) console.error("heartbeat ping answered HTTP " + res.status);
    return { sent: res.ok, status: res.status, failing };
  } catch (err) {
    console.error("heartbeat ping failed:", err && err.name === "TimeoutError" ? "timeout" : err && err.message);
    return { sent: false, reason: "network", failing };
  }
}

let heartbeatTimer = null;
function startHeartbeat({ env = process.env, failingJobs, intervalMs = HEARTBEAT_MS } = {}) {
  if (heartbeatTimer || !heartbeatUrl(env)) return false;
  const beat = () => pingHeartbeat({ env, failingJobs });
  beat();
  heartbeatTimer = setInterval(beat, intervalMs);
  if (heartbeatTimer.unref) heartbeatTimer.unref();
  return true;
}
function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

module.exports = {
  deepHealth,
  deepHealthHandler,
  heartbeatUrl,
  pingHeartbeat,
  startHeartbeat,
  stopHeartbeat,
  DEEP_CACHE_MS,
  HEARTBEAT_MS,
};
