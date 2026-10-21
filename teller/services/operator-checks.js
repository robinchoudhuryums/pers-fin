// ============================================================================
// Operator checks (cycle-7 G1 + ST4) — the "operator doctor"
// ============================================================================
// One list of the operator-side state the app could not see before:
//   - GitHub (services/github-ops.js): backstop workflows disabled or failing,
//     no recent backup, missing workflow secrets, a public repository;
//   - local: the compromised Teller certificate (F14 — moved here so there is
//     one source), TOKEN_ENCRYPTION_PASSPHRASE, a short SHELL_PIN, and info
//     notes for APP_TIMEZONE / push / the calendar feed;
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

function localChecks(env = process.env) {
  const checks = [];
  try {
    const { tellerCertStatus } = require("./teller-api");
    const cert = tellerCertStatus();
    if (cert.configured) {
      checks.push(cert.compromised
        ? { id: "local:teller-cert", label: "Teller certificate", status: "fail",
            detail: "The Teller certificate in use is the one exposed in git history — generate a new one in the Teller dashboard and update TELLER_CERT / TELLER_KEY.",
            fix: "Teller dashboard → Certificates → create a new certificate; set TELLER_CERT / TELLER_KEY (base64) on Render." }
        : { id: "local:teller-cert", label: "Teller certificate", status: "ok", detail: "Not the certificate exposed in git history.", fix: null });
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

// opts: { persistentPool, force, cachedOnly, env, fetchImpl }
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
  CACHE_TTL_MS,
  // exported for tests
  _failingSignature: failingSignature,
  _resetCache() { githubCache = null; githubInFlight = null; },
  _refreshGithub: refreshGithub,
};
