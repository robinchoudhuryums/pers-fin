// ============================================================================
// Hosting facts — what the deployment's host provides (the VPS move)
// ============================================================================
// The app was written for Render's free tier: Render sets RENDER_EXTERNAL_URL,
// the process sleeps when idle (so a keep-alive ping exists), and backups run
// from GitHub Actions (db-backup.yml) because nothing else can reach Neon.
// A self-hosted deployment (deploy/vps/) says what it provides instead:
//
//   PUBLIC_URL      the public https address. Falls back to RENDER_EXTERNAL_URL,
//                   so a Render deployment needs nothing new.
//   ALWAYS_ON       "true" when the host never sleeps: no keep-alive ping, the
//                   Settings section explains it isn't needed, and Operator
//                   Checks doesn't expect the Keep Alive workflow.
//   SERVER_BACKUPS  "true" when deploy/vps/backup.sh takes the backups: it
//                   stamps user_settings.last_backup_at after each verified
//                   run, Operator Checks reads that stamp, and it doesn't
//                   expect the Database Backup workflow or its secrets.

const TRUE_RE = /^(1|true|yes|on)$/i;

function envFlag(env, name) {
  return TRUE_RE.test(String((env || {})[name] || "").trim());
}

// The public base URL without a trailing slash, or null when unknown / not
// http(s).
function publicUrl(env = process.env) {
  const raw = String(env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s/]+/i.test(raw) ? raw : null;
}

// The base URL bank webhooks are registered at (roadmap T2.1 W4): PUBLIC_URL
// ONLY, never the RENDER_EXTERNAL_URL fallback — setting PUBLIC_URL is how the
// operator opts in (a sleeping free-tier host would be woken by every event).
function webhookBaseUrl(env = process.env) {
  return publicUrl({ PUBLIC_URL: (env || {}).PUBLIC_URL });
}

const alwaysOn = (env = process.env) => envFlag(env, "ALWAYS_ON");
const serverBackups = (env = process.env) => envFlag(env, "SERVER_BACKUPS");

module.exports = { publicUrl, webhookBaseUrl, alwaysOn, serverBackups, envFlag };
