// ============================================================================
// GitHub operator checks (cycle-7 G1) — read-only view of the repo's Actions
// ============================================================================
// The critical scheduled jobs have out-of-process GitHub Actions backstops
// (INV-53), but nothing in the app could see them: in Oct 2026 four of them
// were disabled by GitHub for inactivity and Database Backup had never
// produced a backup, and the only place that showed it was the Actions tab.
//
// This client reads, with a fine-grained token that can only READ:
//   - each backstop workflow's state (active / disabled_*) and its latest run;
//   - the last SUCCESSFUL Database Backup run;
//   - which repository secrets exist — NAMES only (the API never returns a
//     secret's value, and nothing here asks for one);
//   - whether the repository is public.
//
// Configuration: GITHUB_OPS_TOKEN (Actions: read, Metadata: read, Secrets:
// read) + GITHUB_OPS_REPO ("owner/repo"). The token is read from the
// environment on every call, never stored, never logged and never returned —
// error messages carry only the HTTP status. Every failure is fail-soft: a
// check whose call failed is "unknown" with the reason, never a throw.

const API = "https://api.github.com";
const TIMEOUT_MS = 10000;
const HOUR = 60 * 60 * 1000;

// The backstop workflows (file name → what it guards). `cadenceMs` is the
// cron interval; a latest run older than max(2 × cadence, 6h) is stale
// (GitHub delays scheduled runs, often by hours for the 14-minute keep-alive).
// `critical` decides whether a DISABLED workflow is a fail or a warn — the
// keep-alive ping and Job Radar refresh are optional features.
const BACKSTOPS = [
  { file: "daily-sync.yml", label: "Daily Sync", cadenceMs: 24 * HOUR, critical: true,
    secrets: ["SERVER_URL", "API_KEY"] },
  { file: "weekly-reconcile.yml", label: "Weekly Reconcile", cadenceMs: 7 * 24 * HOUR, critical: true,
    secrets: ["SERVER_URL", "API_KEY"] },
  { file: "db-backup.yml", label: "Database Backup", cadenceMs: 24 * HOUR, critical: true,
    secrets: ["NEON_DATABASE_URL", "BACKUP_ENCRYPTION_PASSPHRASE"], optionalSecrets: ["PERSISTENT_DATABASE_URL"] },
  { file: "knowledge-reindex.yml", label: "Knowledge Reindex", cadenceMs: 12 * HOUR, critical: false,
    secrets: ["SERVER_URL", "API_KEY"] },
  { file: "keep-alive.yml", label: "Keep Alive", cadenceMs: 14 * 60 * 1000, critical: false,
    secrets: ["SERVER_URL", "API_KEY"] },
  { file: "job-radar.yml", label: "Job Radar Refresh", cadenceMs: 7 * 24 * HOUR, critical: false,
    secrets: ["SERVER_URL", "API_KEY"] },
];
const BACKUP_MAX_AGE_MS = 36 * HOUR;
const MIN_STALE_MS = 6 * HOUR;

function config(env = process.env) {
  const token = env.GITHUB_OPS_TOKEN ? String(env.GITHUB_OPS_TOKEN).trim() : "";
  const repo = env.GITHUB_OPS_REPO ? String(env.GITHUB_OPS_REPO).trim() : "";
  const repoOk = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
  return { token, repo, configured: !!token && repoOk, repoOk };
}

// One GET. Throws Error("GitHub <status>") / Error("GitHub timeout") — never
// the token, never the response body.
async function ghGet(path, { token, fetchImpl }) {
  const f = fetchImpl || fetch;
  let res;
  try {
    res = await f(API + path, {
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "perfin-operator-checks",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const err = new Error(e && (e.name === "TimeoutError" || e.name === "AbortError") ? "GitHub timeout" : "GitHub unreachable");
    err.status = 0;
    throw err;
  }
  if (!res.ok) {
    const err = new Error("GitHub " + res.status);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function reasonFor(err) {
  if (!err) return "unknown error";
  if (err.status === 401) return "the GitHub token was rejected (expired or revoked?)";
  if (err.status === 403) return "the GitHub token lacks the permission for this check";
  if (err.status === 404) return "not found — check GITHUB_OPS_REPO and the token's repository access";
  return err.message || "unknown error";
}

const ageHours = (ms) => Math.round(ms / HOUR);

// Workflow state + latest completed run for one backstop.
function workflowCheck(wf, def, runs, runsErr, now) {
  const id = "workflow:" + def.file;
  const label = "Workflow: " + def.label;
  const fixEnable = `GitHub → Actions → ${def.label} → "Enable workflow" (making the repository private stops GitHub disabling it for inactivity).`;
  if (!wf) {
    return { id, label, status: "warn", detail: `${def.file} was not found in the repository's workflows.`, fix: "Check that the workflow file exists on the default branch." };
  }
  if (wf.state && wf.state !== "active") {
    const why = wf.state === "disabled_inactivity" ? "disabled by GitHub after 60 days without repository activity"
      : wf.state === "disabled_manually" ? "disabled by hand" : wf.state;
    return { id, label, status: def.critical ? "fail" : "warn", detail: `${def.label} is ${why}, so its backstop never runs.`, fix: fixEnable };
  }
  if (runsErr) return { id, label, status: "unknown", detail: "Couldn't read its runs: " + reasonFor(runsErr), fix: null };
  const completed = (runs || []).find((r) => r.status === "completed");
  if (!completed) {
    return { id, label, status: "warn", detail: `${def.label} is enabled but has no completed run yet.`, fix: "Run it once from the Actions tab (workflow_dispatch) to confirm it works." };
  }
  const at = new Date(completed.updated_at || completed.created_at).getTime();
  const age = now - at;
  if (completed.conclusion !== "success") {
    return { id, label, status: "warn", detail: `${def.label}'s latest run ended "${completed.conclusion}" ${ageHours(age)}h ago.`, fix: "Open the run in the Actions tab to see which step failed." };
  }
  const staleAfter = Math.max(2 * def.cadenceMs, MIN_STALE_MS);
  if (age > staleAfter) {
    return { id, label, status: "warn", detail: `${def.label} hasn't completed a run in ${ageHours(age)}h.`, fix: "Check the workflow's schedule and recent runs in the Actions tab." };
  }
  return { id, label, status: "ok", detail: `Enabled; last run succeeded ${ageHours(age)}h ago.`, fix: null };
}

function backupCheck(successRuns, err, now) {
  const id = "backup:recent";
  const label = "Database backup";
  if (err) return { id, label, status: "unknown", detail: "Couldn't read the backup runs: " + reasonFor(err), fix: null };
  const last = (successRuns || [])[0];
  const fix = "Set the backup secrets (NEON_DATABASE_URL, BACKUP_ENCRYPTION_PASSPHRASE), enable Database Backup and run it once from the Actions tab.";
  if (!last) return { id, label, status: "fail", detail: "No Database Backup run has ever succeeded — there is no backup of either database.", fix };
  const age = now - new Date(last.updated_at || last.created_at).getTime();
  if (age > BACKUP_MAX_AGE_MS) {
    return { id, label, status: "fail", detail: `The last successful backup is ${ageHours(age)}h old.`, fix };
  }
  return { id, label, status: "ok", detail: `Last successful backup ${ageHours(age)}h ago.`, fix: null };
}

function secretsCheck(names, err) {
  const id = "secrets:workflows";
  const label = "Workflow secrets";
  if (err) return { id, label, status: "unknown", detail: "Couldn't list the repository secrets: " + reasonFor(err), fix: err.status === 403 ? "Give the token the read-only \"Secrets\" repository permission." : null };
  const have = new Set(names);
  const missing = [];
  for (const def of BACKSTOPS) {
    for (const s of def.secrets) if (!have.has(s) && !missing.includes(s)) missing.push(s);
  }
  if (missing.length) {
    const users = BACKSTOPS.filter((d) => d.secrets.some((s) => missing.includes(s))).map((d) => d.label);
    return { id, label, status: "fail", detail: `Missing repository secret(s): ${missing.join(", ")} — needed by ${users.join(", ")}.`, fix: "GitHub → Settings → Secrets and variables → Actions → New repository secret." };
  }
  const optional = BACKSTOPS.flatMap((d) => d.optionalSecrets || []).filter((s) => !have.has(s));
  return { id, label, status: "ok", detail: "Every backstop's required secrets are set." + (optional.length ? ` (Optional, not set: ${optional.join(", ")}.)` : ""), fix: null };
}

function visibilityCheck(repo, err) {
  const id = "repo:visibility";
  const label = "Repository visibility";
  if (err) return { id, label, status: "unknown", detail: "Couldn't read the repository: " + reasonFor(err), fix: null };
  if (repo && repo.private === false) {
    return { id, label, status: "warn", detail: "The repository is PUBLIC: its Actions logs are world-readable and GitHub disables its scheduled workflows after 60 days without activity.", fix: "GitHub → Settings → Danger Zone → Change visibility to private, then delete old Actions logs." };
  }
  return { id, label, status: "ok", detail: "The repository is private.", fix: null };
}

const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));

// All GitHub checks. Returns { configured, ok, reason, checks }. Never throws.
async function runGithubChecks({ env = process.env, fetchImpl, now = Date.now() } = {}) {
  const cfg = config(env);
  if (!cfg.configured) {
    return {
      configured: false, ok: false,
      reason: !cfg.token ? "GITHUB_OPS_TOKEN is not set" : "GITHUB_OPS_REPO must be owner/repo",
      checks: [],
    };
  }
  const ctx = { token: cfg.token, fetchImpl };
  const base = "/repos/" + cfg.repo;
  const [repoR, wfR, secretsR, backupR, ...runsR] = await Promise.all([
    settle(ghGet(base, ctx)),
    settle(ghGet(base + "/actions/workflows?per_page=100", ctx)),
    settle(ghGet(base + "/actions/secrets?per_page=100", ctx)),
    settle(ghGet(base + "/actions/workflows/db-backup.yml/runs?status=success&per_page=1", ctx)),
    ...BACKSTOPS.map((d) => settle(ghGet(base + "/actions/workflows/" + d.file + "/runs?per_page=5&exclude_pull_requests=true", ctx))),
  ]);

  // The token itself failing (401 on the repo read) makes every check moot.
  if (repoR.error && (repoR.error.status === 401 || repoR.error.status === 404)) {
    return { configured: true, ok: false, reason: reasonFor(repoR.error), checks: [] };
  }

  const checks = [];
  checks.push(visibilityCheck(repoR.value, repoR.error));
  checks.push(backupCheck(backupR.value && backupR.value.workflow_runs, backupR.error, now));
  checks.push(secretsCheck(secretsR.value && (secretsR.value.secrets || []).map((s) => s.name), secretsR.error));
  const workflows = (wfR.value && wfR.value.workflows) || [];
  BACKSTOPS.forEach((def, i) => {
    if (wfR.error) {
      checks.push({ id: "workflow:" + def.file, label: "Workflow: " + def.label, status: "unknown", detail: "Couldn't list the workflows: " + reasonFor(wfR.error), fix: null });
      return;
    }
    const wf = workflows.find((w) => String(w.path || "").endsWith("/" + def.file));
    checks.push(workflowCheck(wf, def, runsR[i].value && runsR[i].value.workflow_runs, runsR[i].error, now));
  });
  return { configured: true, ok: true, reason: null, checks };
}

module.exports = {
  runGithubChecks,
  BACKSTOPS,
  BACKUP_MAX_AGE_MS,
  // exported for tests
  _config: config,
  _ghGet: ghGet,
};
