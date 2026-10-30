// ============================================================================
// Operator checks (cycle-7 G1 + ST4) — the "operator doctor"
// ============================================================================
// One list of the operator-side state the app could not see before:
//   - GitHub (services/github-ops.js): backstop workflows disabled or failing,
//     no recent backup, missing workflow secrets, a public repository;
//   - local: the compromised Teller certificate (F14 — moved here so there is
//     one source), TOKEN_ENCRYPTION_PASSPHRASE, a short SHELL_PIN, and info
//     notes for APP_TIMEZONE / push / the calendar feed;
//   - bank webhooks (roadmap T2.1 W6, services/webhook-status.js): Plaid
//     connections not registered at the current address (warn), Plaid / Teller
//     webhooks off or quiet for 7 days (info);
//   - go-live (cycle-8 E4a, ST5 — token-free): the Teller cert missing while
//     Teller connections exist or close to expiry, the two databases shared on
//     purpose, PUBLIC_URL's shape, API_KEY / SHELL_SECRET strength, the Plaid
//     credentials for PLAID_ENV, the Teller webhook secret, and the last backup
//     recorded in user_settings (backup.sh or db-backup.yml) — never a value;
//   - Knowledge: an index built under older vault parsing rules
//     (Per-sistant's user_settings.vault_parse_version < VAULT_PARSE_VERSION),
//     read-only through the wired Per-sistant pool (INV-25).
//
// Each check is { id, label, status: ok|info|warn|fail|unknown, detail, fix }.
// The GitHub part is cached for 6h (a refresh is ~10 API calls) and
// single-flight; GET /api/data-health reads the cache only (it never waits on
// GitHub) and starts a background refresh when the cache is stale, while GET
// /api/operator-checks and the watchdog wait for fresh results. The watchdog
// pushes one notification when the set of failing checks changes.

const githubOps = require("./github-ops");
const hosting = require("./hosting");
const webhookStatus = require("./webhook-status");

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let githubCache = null;      // { at, result }
let githubInFlight = null;   // Promise while a refresh runs

async function refreshGithub(opts = {}) {
  if (githubInFlight) return githubInFlight;
  githubInFlight = (async () => {
    try {
      const result = await githubOps.runGithubChecks(opts);
      githubCache = { at: Date.now(), result };
      return githubCache;
    } finally {
      githubInFlight = null;
    }
  })();
  return githubInFlight;
}

const CERT_EXPIRY_WARN_MS = 30 * 24 * 60 * 60 * 1000;
const CERT_FIX = "Teller dashboard → Certificates → create a new certificate; set TELLER_CERT / TELLER_KEY (base64) on Render.";

function localChecks(env = process.env, now = Date.now()) {
  const checks = [];
  try {
    const { tellerCertStatus } = require("./teller-api");
    const cert = tellerCertStatus();
    if (cert.configured) {
      const expires = cert.expires_at ? new Date(cert.expires_at).getTime() : NaN;
      const day = Number.isFinite(expires) ? new Date(expires).toISOString().slice(0, 10) : null;
      if (cert.compromised) {
        checks.push({ id: "local:teller-cert", label: "Teller certificate", status: "fail",
          detail: "The Teller certificate in use is the one exposed in git history — generate a new one in the Teller dashboard and update TELLER_CERT / TELLER_KEY.",
          fix: CERT_FIX });
      } else if (Number.isFinite(expires) && expires <= now) {
        // Cycle-8 E4a (ST5): an expired certificate fails every Teller call.
        checks.push({ id: "local:teller-cert", label: "Teller certificate", status: "fail",
          detail: `The Teller certificate expired on ${day} — every Teller sync fails until it is replaced.`, fix: CERT_FIX });
      } else if (Number.isFinite(expires) && expires - now <= CERT_EXPIRY_WARN_MS) {
        checks.push({ id: "local:teller-cert", label: "Teller certificate", status: "warn",
          detail: `The Teller certificate expires on ${day}.`, fix: CERT_FIX });
      } else {
        checks.push({ id: "local:teller-cert", label: "Teller certificate", status: "ok",
          detail: "Not the certificate exposed in git history" + (day ? `; valid until ${day}.` : "."), fix: null });
      }
    }
  } catch (e) { console.error("operator-checks cert check failed:", e.message); }

  checks.push(env.TOKEN_ENCRYPTION_PASSPHRASE
    ? { id: "local:token-passphrase", label: "Token encryption passphrase", status: "ok", detail: "TOKEN_ENCRYPTION_PASSPHRASE is set.", fix: null }
    : { id: "local:token-passphrase", label: "Token encryption passphrase", status: "fail",
        detail: "TOKEN_ENCRYPTION_PASSPHRASE is not set — bank tokens can't be stored or read.",
        fix: "Set TOKEN_ENCRYPTION_PASSPHRASE on Render (the same value the tokens were stored with)." });

  if (env.SHELL_PIN !== undefined) {
    const len = String(env.SHELL_PIN).length;
    checks.push(len < 6
      ? { id: "local:shell-pin", label: "App PIN length", status: "warn", detail: `SHELL_PIN is ${len} characters — anyone can lock PIN login, and a short PIN is quicker to guess.`, fix: "Use a PIN of at least 6 digits (SHELL_PIN on Render)." }
      : { id: "local:shell-pin", label: "App PIN length", status: "ok", detail: `SHELL_PIN is ${len} characters.`, fix: null });
  }

  const tz = env.APP_TIMEZONE ? String(env.APP_TIMEZONE).trim() : "";
  if (!tz || tz.toUpperCase() === "UTC") {
    checks.push({ id: "local:timezone", label: "Timezone", status: "info", detail: "APP_TIMEZONE is UTC — months, \"today\" and digest times follow UTC, not your local day.", fix: "Set APP_TIMEZONE to your IANA zone (e.g. America/New_York) on Render." });
  }
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    checks.push({ id: "local:push", label: "Push notifications", status: "info", detail: "VAPID keys aren't set, so alerts reach the in-app bell only.", fix: "npx web-push generate-vapid-keys; set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY." });
  }
  if (!require("./uptime").heartbeatUrl(env)) {
    checks.push({ id: "local:heartbeat", label: "Uptime heartbeat", status: "info",
      detail: "HEARTBEAT_URL isn't set, so nothing outside the app notices if it stops running or a scheduled job keeps failing.",
      fix: "Create a check at healthchecks.io (period 1 hour, grace 1 hour) and set HEARTBEAT_URL to its ping URL — on an always-on server, or with keep-alive on (a sleeping host stops pinging)." });
  }
  if (!env.CALENDAR_FEED_TOKEN) {
    checks.push({ id: "local:calendar-feed", label: "Calendar feed", status: "info", detail: "CALENDAR_FEED_TOKEN isn't set, so the /calendar.ics bill feed is off.", fix: null });
  }
  return checks;
}

// The Knowledge index's parser version vs the current one. Omitted when there
// is no Per-sistant (standalone Perfin) or no vault configured.
async function knowledgeCheck(persistentPool) {
  if (!persistentPool) return null;
  const id = "knowledge:reindex";
  const label = "Knowledge index";
  let current;
  try {
    current = require("../../apps/per-sistant/services/vault-sync").VAULT_PARSE_VERSION;
  } catch (e) {
    return null; // Per-sistant code isn't in this deployment
  }
  try {
    const r = await persistentPool.query("SELECT vault_enabled, vault_repo, vault_parse_version FROM user_settings WHERE id = 1");
    const s = r.rows[0];
    if (!s || !s.vault_enabled || !s.vault_repo) return null;
    const stored = s.vault_parse_version == null ? null : Number(s.vault_parse_version);
    if (stored === null || stored < current) {
      return { id, label, status: "warn",
        detail: stored === null
          ? "The vault has never been fully reindexed under the current parsing rules — files indexed earlier keep their old privacy classification."
          : `The vault was last fully reindexed under parsing rules v${stored}; the app now uses v${current}.`,
        fix: "Per-sistant → Knowledge → \"Reindex now\" (or POST /per-sistant/api/rag/reindex) once." };
    }
    return { id, label, status: "ok", detail: `Fully reindexed under the current parsing rules (v${current}).`, fix: null };
  } catch (e) {
    return { id, label, status: "unknown", detail: "Couldn't read the Knowledge settings: " + e.message, fix: null };
  }
}

// The last backup recorded in user_settings.last_backup_at — stamped after each
// verified run by deploy/vps/backup.sh (last_backup_source 'server') and, since
// cycle-8 E4a (ST5), by .github/workflows/db-backup.yml ('github'). Runs with
// SERVER_BACKUPS=true, and whenever the GitHub checks are off (no token) — so a
// Render deployment sees its backups without a token. With a token and no
// SERVER_BACKUPS the GitHub backup check is the one (no duplicate). Same 36h
// limit as the GitHub check.
const BACKUP_SOURCE_WORDS = { server: "on the server", github: "GitHub Actions" };

async function backupCheck(pool, env = process.env, now = Date.now()) {
  const onServer = hosting.serverBackups(env);
  if (!onServer && githubOps._config(env).configured) return null;
  const id = "local:backup";
  const label = "Database backup";
  const fix = onServer
    ? "On the server: run /opt/pers-fin/backup.sh by hand and check its log, and that /etc/cron.d/pers-fin-backup exists (deploy/vps/RUNBOOK.md → Backups)."
    : "Set the NEON_DATABASE_URL and BACKUP_ENCRYPTION_PASSPHRASE repository secrets, enable the Database Backup workflow (Actions → Database Backup → Enable workflow) and run it once.";
  if (!pool) return { id, label, status: "unknown", detail: "Couldn't read the backup record (no database connection).", fix: null };
  try {
    const r = await pool.query("SELECT last_backup_at, last_backup_source FROM user_settings WHERE id = 1");
    const row = r.rows[0] || {};
    const at = row.last_backup_at;
    if (!at) return { id, label, status: "fail", detail: "No backup has been recorded yet — there may be no backup of either database.", fix };
    const age = now - new Date(at).getTime();
    const hours = Math.round(age / 3600000);
    const where = BACKUP_SOURCE_WORDS[row.last_backup_source] ? ` (${BACKUP_SOURCE_WORDS[row.last_backup_source]})` : "";
    if (age > githubOps.BACKUP_MAX_AGE_MS) return { id, label, status: "fail", detail: `The last backup${where} is ${hours}h old.`, fix };
    return { id, label, status: "ok", detail: `Last backup ${hours}h ago${where}.`, fix: null };
  } catch (e) {
    return { id, label, status: "unknown", detail: "Couldn't read the backup record: " + e.message, fix: null };
  }
}

// Go-live checks (cycle-8 E4a, ST5): the deployment's own setup, read from the
// environment and the databases only — no network, no token, never a secret's
// value (a threshold is named, a value never). Each part is fail-soft.
const API_KEY_MIN = 24;
const SHELL_SECRET_MIN = 32;
const TELLER_WEBHOOK_SECRET_MIN = 16;
const PLAID_SECRET_VARS = { production: "PLAID_SECRET_PROD", development: "PLAID_SECRET_DEV", sandbox: "PLAID_SECRET_SANDBOX" };

async function countRows(pool, sql) {
  if (!pool) return null;
  try {
    const r = await pool.query(sql);
    return Number(r.rows[0] && r.rows[0].n) || 0;
  } catch (e) {
    console.error("operator-checks go-live read failed:", e.message);
    return null;
  }
}

async function goLiveChecks({ pool = null, persistentPool = null, env = process.env } = {}) {
  const checks = [];
  const set = (name) => String(env[name] || "").trim();

  // The Teller cert missing while Teller connections exist (localChecks covers
  // a configured cert — compromised / expired / expiring).
  try {
    const cert = require("./teller-api").tellerCertStatus();
    if (!cert.configured) {
      const n = await countRows(pool, "SELECT COUNT(*)::int AS n FROM teller_enrollments WHERE status <> 'SUSPENDED'");
      if (n > 0) {
        checks.push({ id: "local:teller-cert", label: "Teller certificate", status: "fail",
          detail: `${n} Teller connection(s) exist but no Teller certificate is configured — every Teller sync fails.`,
          fix: "Set TELLER_CERT / TELLER_KEY (base64 of certificate.pem / private_key.pem) on Render, or TELLER_CERT_PATH / TELLER_KEY_PATH." });
      }
    }
  } catch (e) { console.error("operator-checks cert check failed:", e.message); }

  // The two databases (under the shell only — a Per-sistant pool is wired).
  if (persistentPool) {
    try {
      const { sameDatabase } = require("../../shell/boot-checks");
      const perfin = set("NEON_DATABASE_URL");
      const persistent = set("PERSISTENT_DATABASE_URL");
      const shared = !persistent || (perfin && sameDatabase(perfin, persistent));
      checks.push(shared
        ? { id: "local:databases", label: "App databases", status: "warn",
            detail: "Perfin and Per-sistant share one database (ALLOW_SHARED_DATABASE) — their settings and their AI budgets are one row.",
            fix: "Give Per-sistant its own database: set PERSISTENT_DATABASE_URL to it and remove ALLOW_SHARED_DATABASE." }
        : { id: "local:databases", label: "App databases", status: "ok", detail: "Perfin and Per-sistant use separate databases.", fix: null });
    } catch (e) { console.error("operator-checks database check failed:", e.message); }
  }

  // PUBLIC_URL's shape.
  const pub = set("PUBLIC_URL");
  if (!pub) {
    checks.push({ id: "local:public-url", label: "Public address", status: "info",
      detail: "PUBLIC_URL isn't set — bank webhooks are off and links in emails use RENDER_EXTERNAL_URL (or none).",
      fix: "Set PUBLIC_URL to the app's https address (e.g. https://app.example.com) when you want bank webhooks." });
  } else {
    let problem = null;
    let origin = null;
    try {
      const u = new URL(pub);
      origin = u.origin;
      if (u.protocol !== "https:") problem = "doesn't start with https://";
      else if (u.username || u.password) problem = "carries a user name or password";
      else if ((u.pathname && u.pathname !== "/") || u.search || u.hash) problem = "has a path, query or fragment — it must be the site's origin only";
    } catch {
      problem = "isn't a valid URL";
    }
    checks.push(problem
      ? { id: "local:public-url", label: "Public address", status: "warn", detail: `PUBLIC_URL ${problem}.`,
          fix: "Set PUBLIC_URL to the app's https origin, e.g. https://app.example.com (no path, no trailing route)." }
      : { id: "local:public-url", label: "Public address", status: "ok", detail: `PUBLIC_URL is ${origin}.`, fix: null });
  }

  // API_KEY — the GitHub backstops (daily sync, weekly reconcile, Knowledge
  // reindex, Job Radar) reach the app with it.
  const apiKey = set("API_KEY");
  checks.push(!apiKey
    ? { id: "local:api-key", label: "API key", status: "warn",
        detail: "API_KEY isn't set — the GitHub backstop workflows (daily sync, weekly reconcile) can't reach the app.",
        fix: "Set API_KEY on Render to a long random value (openssl rand -hex 32) and the same value as the API_KEY repository secret." }
    : apiKey.length < API_KEY_MIN
      ? { id: "local:api-key", label: "API key", status: "warn", detail: `API_KEY is shorter than ${API_KEY_MIN} characters.`,
          fix: "Replace it with a long random value (openssl rand -hex 32) on Render and in the API_KEY repository secret." }
      : { id: "local:api-key", label: "API key", status: "ok", detail: "API_KEY is set.", fix: null });

  // SHELL_SECRET (the shell refuses to boot without it, so only its strength).
  const shellSecret = set("SHELL_SECRET");
  if (shellSecret) {
    checks.push(shellSecret.length < SHELL_SECRET_MIN
      ? { id: "local:shell-secret", label: "Session signing secret", status: "warn",
          detail: `SHELL_SECRET is shorter than ${SHELL_SECRET_MIN} characters — session cookies are signed with it.`,
          fix: "Set SHELL_SECRET to openssl rand -hex 32 on Render (everyone signs in again)." }
      : { id: "local:shell-secret", label: "Session signing secret", status: "ok", detail: "SHELL_SECRET is long enough.", fix: null });
  }

  // Plaid: the secret for PLAID_ENV, and sandbox while real connections exist.
  if (set("PLAID_CLIENT_ID")) {
    const plaidEnv = (set("PLAID_ENV") || "sandbox").toLowerCase();
    const secretVar = PLAID_SECRET_VARS[plaidEnv];
    if (!secretVar) {
      checks.push({ id: "local:plaid-config", label: "Plaid configuration", status: "warn",
        detail: "PLAID_ENV isn't production, development or sandbox — the sandbox secret is used.",
        fix: "Set PLAID_ENV=production (with PLAID_SECRET_PROD) for real bank connections." });
    } else if (!set(secretVar)) {
      checks.push({ id: "local:plaid-config", label: "Plaid configuration", status: "fail",
        detail: `PLAID_ENV is ${plaidEnv} but ${secretVar} isn't set — Plaid calls use the wrong secret and fail.`,
        fix: `Set ${secretVar} on Render (Plaid dashboard → Keys).` });
    } else {
      const good = plaidEnv === "sandbox"
        ? await countRows(pool, "SELECT COUNT(*)::int AS n FROM plaid_items WHERE status = 'GOOD'")
        : 0;
      checks.push(good > 0
        ? { id: "local:plaid-config", label: "Plaid configuration", status: "warn",
            detail: `PLAID_ENV is sandbox while ${good} Plaid connection(s) exist — real banks need production.`,
            fix: "Set PLAID_ENV=production and PLAID_SECRET_PROD on Render." }
        : { id: "local:plaid-config", label: "Plaid configuration", status: "ok", detail: `PLAID_ENV is ${plaidEnv} and its secret is set.`, fix: null });
    }
  }

  // The Teller webhook secret's strength (present / absent is webhooks:teller).
  const tws = set("TELLER_WEBHOOK_SECRET");
  if (tws) {
    const parts = tws.split(",").map((p) => p.trim()).filter(Boolean);
    checks.push(parts.length === 0 || parts.some((p) => p.length < TELLER_WEBHOOK_SECRET_MIN)
      ? { id: "local:teller-webhook-secret", label: "Teller webhook secret", status: "warn",
          detail: `A TELLER_WEBHOOK_SECRET value is shorter than ${TELLER_WEBHOOK_SECRET_MIN} characters — use the secret the Teller dashboard shows.`,
          fix: "Copy the webhook signing secret from the Teller dashboard into TELLER_WEBHOOK_SECRET (comma-separate two during a rotation)." }
      : { id: "local:teller-webhook-secret", label: "Teller webhook secret", status: "ok", detail: "TELLER_WEBHOOK_SECRET is set.", fix: null });
  }
  return checks;
}

// opts: { pool, persistentPool, force, cachedOnly, env, fetchImpl,
//         webhookStatus (a getWebhookStatus result the caller already read) }
async function getOperatorChecks(opts = {}) {
  const env = opts.env || process.env;
  let gh = githubCache;
  const stale = !gh || Date.now() - gh.at > CACHE_TTL_MS;
  if (opts.cachedOnly) {
    if (stale) refreshGithub({ env, fetchImpl: opts.fetchImpl }).catch((e) => console.error("operator-checks refresh failed:", e.message));
  } else if (stale || opts.force) {
    gh = await refreshGithub({ env, fetchImpl: opts.fetchImpl });
  }
  const github = gh
    ? { configured: gh.result.configured, ok: gh.result.ok, reason: gh.result.reason, checked_at: new Date(gh.at).toISOString(), pending: false }
    : { configured: githubOps._config(env).configured, ok: false, reason: null, checked_at: null, pending: true };
  const checks = [...(gh ? gh.result.checks : []), ...localChecks(env)];
  try {
    checks.push(...await goLiveChecks({ pool: opts.pool, persistentPool: opts.persistentPool, env }));
  } catch (e) { console.error("operator-checks go-live checks failed:", e.message); }
  const sb = await backupCheck(opts.pool, env);
  if (sb) checks.push(sb);
  // Bank webhooks (roadmap T2.1 W6) — needs the database; fail-soft (the
  // status reader logs and leaves a failed part empty).
  if (opts.webhookStatus || opts.pool) {
    try {
      const ws = opts.webhookStatus || await webhookStatus.getWebhookStatus(opts.pool, { env });
      checks.push(...webhookStatus.webhookChecks(ws));
    } catch (e) { console.error("operator-checks webhook check failed:", e.message); }
  }
  const k = await knowledgeCheck(opts.persistentPool);
  if (k) checks.push(k);
  return { checked_at: new Date().toISOString(), github, checks };
}

// data-health issues for a result: every warn / fail check, plus one info
// line when the GitHub checks aren't configured or can't authenticate.
function toIssues(result) {
  const issues = [];
  for (const c of result.checks) {
    if (c.status === "warn" || c.status === "fail") {
      issues.push({ severity: "warning", source: "operator", check: c.id, message: `${c.label}: ${c.detail}` });
    }
  }
  const g = result.github;
  if (!g.pending && !g.configured) {
    issues.push({ severity: "info", source: "operator", check: "github", message: "GitHub checks are off — set GITHUB_OPS_TOKEN (read-only) and GITHUB_OPS_REPO so the app can see disabled workflows and missing backups." });
  } else if (!g.pending && !g.ok) {
    issues.push({ severity: "warning", source: "operator", check: "github", message: `GitHub checks failed: ${g.reason}.` });
  }
  return issues;
}

const GITHUB_ID_RE = /^(workflow|backup|secrets|repo):/;

function failingSignature(checks) {
  return checks.filter((c) => c.status === "warn" || c.status === "fail").map((c) => c.id).sort().join("|");
}

// Push one notification when the set of failing checks changes. Skipped while
// the GitHub part is unreadable (a GitHub outage would otherwise drop and then
// re-add its failing checks, notifying twice). Returns { notified, signature }.
async function notifyIfChanged(pool, result, { sendToAll } = {}) {
  const g = result.github;
  const githubUnknown = result.checks.some((c) => GITHUB_ID_RE.test(c.id) && c.status === "unknown");
  if (g.pending || (g.configured && (!g.ok || githubUnknown))) {
    return { notified: false, skipped: "github_unreadable" };
  }
  const signature = failingSignature(result.checks);
  let prev = "";
  try {
    const r = await pool.query("SELECT operator_checks_signature FROM user_settings WHERE id = 1");
    prev = (r.rows[0] && r.rows[0].operator_checks_signature) || "";
  } catch (e) {
    console.error("operator-checks signature read failed:", e.message);
    return { notified: false, skipped: "read_failed" };
  }
  if (signature === prev) return { notified: false, signature };
  let notified = false;
  if (signature && typeof sendToAll === "function") {
    const failing = result.checks.filter((c) => c.status === "warn" || c.status === "fail");
    try {
      await sendToAll({
        title: `Operator checks: ${failing.length} need attention`,
        body: failing.slice(0, 4).map((c) => c.label).join(", ") + (failing.length > 4 ? ", …" : "") + " — see Settings → Sync Health.",
        tag: "operator-checks",
        data: { url: "/settings#sync-health" },
      });
      notified = true;
    } catch (e) {
      console.error("operator-checks notify failed:", e.message);
      return { notified: false, skipped: "notify_failed" }; // keep the old signature so it retries
    }
  }
  await pool.query("UPDATE user_settings SET operator_checks_signature = $1 WHERE id = 1", [signature])
    .catch((e) => console.error("operator-checks signature write failed:", e.message));
  return { notified, signature };
}

module.exports = {
  getOperatorChecks,
  toIssues,
  notifyIfChanged,
  localChecks,
  knowledgeCheck,
  goLiveChecks,
  backupCheck,
  CACHE_TTL_MS,
  // exported for tests
  _failingSignature: failingSignature,
  _resetCache() { githubCache = null; githubInFlight = null; },
  _refreshGithub: refreshGithub,
};
