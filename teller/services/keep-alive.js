// ============================================================================
// Keep-Alive — self-ping to prevent Render free tier sleep
// ============================================================================

const { pool } = require("./database");
const hosting = require("./hosting");

let keepAliveInterval = null;

// PSC-2: the keep-alive schedule is read by keep-alive.yml every 14 minutes and
// by the self-ping below. Serving it from an in-memory cache keeps those probes
// from querying (and so waking) Neon around the clock. PATCH /api/settings
// invalidates it, so a schedule change still applies on the next probe.
const KEEP_ALIVE_CACHE_MS = 6 * 60 * 60 * 1000;
const FALLBACK_CONFIG = { keep_alive_enabled: false, keep_alive_start: 6, keep_alive_end: 0, keep_alive_timezone: "America/New_York" };
let _keepAliveCache = null; // { config, at }
async function getKeepAliveConfigCached() {
  if (_keepAliveCache && Date.now() - _keepAliveCache.at < KEEP_ALIVE_CACHE_MS) return _keepAliveCache.config;
  const { config, ok } = await readKeepAliveConfig();
  if (ok) {
    _keepAliveCache = { config, at: Date.now() };
    return config;
  }
  // A failed read is never cached (cycle-9 F10): one database blip used to be
  // stored as "disabled" for 6 hours, so the self-ping and keep-alive.yml both
  // stopped and the host slept. The last good schedule — however old — is a
  // better answer than the fallback; the next probe reads again.
  return _keepAliveCache ? _keepAliveCache.config : config;
}
function invalidateKeepAliveCache() { _keepAliveCache = null; }

// → { config, ok }: ok is false when the read failed and config is the
// fallback (keep-alive off).
async function readKeepAliveConfig() {
  try {
    const result = await pool.query(
      "SELECT keep_alive_enabled, keep_alive_start, keep_alive_end, keep_alive_timezone FROM user_settings WHERE id = 1"
    );
    return { config: result.rows[0] || { ...FALLBACK_CONFIG }, ok: true };
  } catch (err) {
    console.warn("Keep-alive settings read failed:", err && err.message);
    return { config: { ...FALLBACK_CONFIG }, ok: false };
  }
}

async function loadKeepAliveConfig() {
  return (await readKeepAliveConfig()).config;
}

function isWithinActiveHours(startHour, endHour, timezone) {
  try {
    const now = new Date();
    const localHour = parseInt(now.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: timezone }));
    if (startHour < endHour) {
      return localHour >= startHour && localHour < endHour;
    } else if (startHour > endHour) {
      return localHour >= startHour || localHour < endHour;
    }
    return true; // startHour === endHour means 24/7
  } catch {
    return true;
  }
}

// Returns true when the ping was started. An always-on host (ALWAYS_ON=true —
// services/hosting.js) never sleeps, so there is nothing to keep awake.
function startKeepAlive(port, env = process.env) {
  if (keepAliveInterval) return true;
  if (hosting.alwaysOn(env)) return false;
  // PUBLIC_URL (or Render's RENDER_EXTERNAL_URL); fall back to localhost
  const base = hosting.publicUrl(env);
  const pingUrl = base ? `${base}/health` : `http://localhost:${port}/health`;
  const INTERVAL = 14 * 60 * 1000; // 14 minutes
  keepAliveInterval = setInterval(async () => {
    const config = await getKeepAliveConfigCached();
    if (!config.keep_alive_enabled) return;
    if (!isWithinActiveHours(config.keep_alive_start, config.keep_alive_end, config.keep_alive_timezone)) {
      return;
    }
    try {
      await fetch(pingUrl, { signal: AbortSignal.timeout(10000) });
    } catch {
      // Silently ignore — ping failures are expected when server is waking up
    }
  }, INTERVAL);
  keepAliveInterval.unref(); // Don't prevent process exit
  return true;
}

module.exports = { loadKeepAliveConfig, getKeepAliveConfigCached, invalidateKeepAliveCache, isWithinActiveHours, startKeepAlive };
