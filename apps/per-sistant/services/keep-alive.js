// ============================================================================
// Keep-Alive — self-ping to prevent Render free tier sleep
// ============================================================================

const { pool } = require("../db");

let keepAliveInterval = null;

async function loadKeepAliveConfig() {
  try {
    const result = await pool.query(
      "SELECT keep_alive_enabled, keep_alive_start, keep_alive_end, keep_alive_timezone FROM user_settings WHERE id = 1"
    );
    return result.rows[0] || { keep_alive_enabled: false, keep_alive_start: 6, keep_alive_end: 0, keep_alive_timezone: "America/New_York" };
  } catch {
    return { keep_alive_enabled: false, keep_alive_start: 6, keep_alive_end: 0, keep_alive_timezone: "America/New_York" };
  }
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

// An always-on host (ALWAYS_ON=true) never sleeps, so there is nothing to keep
// awake. The public address is PUBLIC_URL, else Render's RENDER_EXTERNAL_URL
// (the same rule as Perfin's teller/services/hosting.js). Returns true when
// the ping was started.
const alwaysOn = (env = process.env) => /^(1|true|yes|on)$/i.test(String(env.ALWAYS_ON || "").trim());
function publicUrl(env = process.env) {
  const raw = String(env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s/]+/i.test(raw) ? raw : null;
}

function startKeepAlive(port, env = process.env) {
  if (keepAliveInterval) return true;
  if (alwaysOn(env)) return false;
  const base = publicUrl(env);
  const pingUrl = base ? `${base}/api/health` : `http://localhost:${port}/api/health`;
  const INTERVAL = 14 * 60 * 1000; // 14 minutes
  keepAliveInterval = setInterval(async () => {
    const config = await loadKeepAliveConfig();
    if (!config.keep_alive_enabled) return;
    if (!isWithinActiveHours(config.keep_alive_start, config.keep_alive_end, config.keep_alive_timezone)) {
      return;
    }
    try {
      await fetch(pingUrl, { signal: AbortSignal.timeout(10000) }); // PB-19: never hang the tick
    } catch (err) {
      console.warn("Keep-alive ping failed:", err.message);
    }
  }, INTERVAL);
  keepAliveInterval.unref(); // Don't prevent process exit
  return true;
}

module.exports = { loadKeepAliveConfig, isWithinActiveHours, startKeepAlive, alwaysOn, publicUrl };
