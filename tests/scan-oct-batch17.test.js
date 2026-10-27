// ============================================================================
// Cycle-7 (Oct 2026) Batch 17 — operator visibility (G1 remaining + ST4)
// ============================================================================
// G1   the app reads the repository's GitHub Actions state with a read-only
//      token: a disabled or failing backstop workflow, no recent backup,
//      missing workflow secrets (names only) and a public repository become
//      checks — fail-soft ("unknown" with a reason), cached 6h, single-flight.
// ST4  the "operator doctor": those checks plus local ones (the compromised
//      Teller cert, TOKEN_ENCRYPTION_PASSPHRASE, SHELL_PIN length, timezone /
//      push / calendar-feed notes) and the Knowledge index's parse version,
//      surfaced in GET /api/operator-checks, GET /api/data-health's issues and
//      Settings → Sync Health, with one notification per change in the failing
//      set. The database-backed half is tests/contract/operator-checks.contract.
// ============================================================================

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const dbModule = require("../teller/services/database");
const githubOps = require("../teller/services/github-ops");
const oc = require("../teller/services/operator-checks");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const TOKEN = "ghp_SECRET_TOKEN_VALUE";
const ENV = { GITHUB_OPS_TOKEN: TOKEN, GITHUB_OPS_REPO: "me/pers-fin", TOKEN_ENCRYPTION_PASSPHRASE: "x" };
const NOW = Date.parse("2026-10-21T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();

let origQuery;
before(() => { origQuery = dbModule.pool.query; });
after(() => { dbModule.pool.query = origQuery; });

// A fake GitHub API: a healthy repo by default, overridden per test.
function fakeGithub(over = {}) {
  const calls = [];
  const state = {
    repo: { private: true },
    workflows: githubOps.BACKSTOPS.map((d, i) => ({ id: i + 1, path: ".github/workflows/" + d.file, state: "active" })),
    runs: {}, // file → workflow_runs
    backupSuccess: [{ status: "completed", conclusion: "success", updated_at: hoursAgo(5) }],
    secrets: ["SERVER_URL", "API_KEY", "NEON_DATABASE_URL", "BACKUP_ENCRYPTION_PASSPHRASE", "PERSISTENT_DATABASE_URL"],
    fail: {}, // path regex source → status (or "timeout")
    ...over,
  };
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    const u = String(url).replace("https://api.github.com", "");
    for (const [re, status] of Object.entries(state.fail)) {
      if (new RegExp(re).test(u)) {
        if (status === "timeout") { const e = new Error("t"); e.name = "TimeoutError"; throw e; }
        return { ok: false, status, json: async () => ({ message: "nope " + TOKEN }) };
      }
    }
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    if (/^\/repos\/me\/pers-fin$/.test(u)) return ok(state.repo);
    if (/\/actions\/workflows\?/.test(u)) return ok({ workflows: state.workflows });
    if (/\/actions\/secrets\?/.test(u)) return ok({ secrets: state.secrets.map((name) => ({ name })) });
    if (/db-backup\.yml\/runs\?status=success/.test(u)) return ok({ workflow_runs: state.backupSuccess });
    const m = u.match(/\/actions\/workflows\/([^/]+)\/runs\?/);
    if (m) {
      const def = githubOps.BACKSTOPS.find((d) => d.file === m[1]);
      const fresh = def.cadenceMs < 3600 * 1000 ? 1 : Math.round(def.cadenceMs / 3600000 / 2);
      return ok({ workflow_runs: state.runs[m[1]] || [{ status: "completed", conclusion: "success", updated_at: hoursAgo(fresh) }] });
    }
    throw new Error("unexpected GitHub call " + u);
  };
  return { fetchImpl, calls, state };
}
const byId = (checks) => Object.fromEntries(checks.map((c) => [c.id, c]));

// ---------------------------------------------------------------------------
describe("G1 — GitHub checks", () => {
  it("a healthy repository: every check ok; the request is read-only, authenticated and time-limited", async () => {
    const g = fakeGithub();
    const r = await githubOps.runGithubChecks({ env: ENV, fetchImpl: g.fetchImpl, now: NOW });
    assert.equal(r.configured, true);
    assert.equal(r.ok, true);
    assert.deepEqual(r.checks.filter((c) => c.status !== "ok").map((c) => c.id), []);
    assert.equal(r.checks.length, 3 + githubOps.BACKSTOPS.length);
    for (const c of g.calls) {
      assert.equal(c.opts.method, undefined, "GET only");
      assert.equal(c.opts.headers.Authorization, "Bearer " + TOKEN);
      assert.ok(c.opts.signal instanceof AbortSignal);
    }
  });

  it("not configured: no call is made", async () => {
    const g = fakeGithub();
    const r = await githubOps.runGithubChecks({ env: { GITHUB_OPS_REPO: "me/pers-fin" }, fetchImpl: g.fetchImpl, now: NOW });
    assert.deepEqual([r.configured, r.checks.length, g.calls.length], [false, 0, 0]);
    assert.match(r.reason, /GITHUB_OPS_TOKEN is not set/);
    const bad = await githubOps.runGithubChecks({ env: { GITHUB_OPS_TOKEN: "t", GITHUB_OPS_REPO: "pers-fin" }, fetchImpl: g.fetchImpl, now: NOW });
    assert.match(bad.reason, /owner\/repo/);
  });

  it("a disabled backstop fails (critical) or warns (optional); failing and stale runs warn", async () => {
    const g = fakeGithub();
    g.state.workflows.find((w) => w.path.endsWith("db-backup.yml")).state = "disabled_inactivity";
    g.state.workflows.find((w) => w.path.endsWith("keep-alive.yml")).state = "disabled_inactivity";
    g.state.runs["daily-sync.yml"] = [
      { status: "in_progress", updated_at: hoursAgo(0) },
      { status: "completed", conclusion: "failure", updated_at: hoursAgo(20) },
    ];
    g.state.runs["weekly-reconcile.yml"] = [{ status: "completed", conclusion: "success", updated_at: hoursAgo(24 * 20) }];
    g.state.runs["job-radar.yml"] = [];
    const c = byId((await githubOps.runGithubChecks({ env: ENV, fetchImpl: g.fetchImpl, now: NOW })).checks);
    assert.equal(c["workflow:db-backup.yml"].status, "fail");
    assert.match(c["workflow:db-backup.yml"].detail, /disabled by GitHub after 60 days/);
    assert.match(c["workflow:db-backup.yml"].fix, /Enable workflow/);
    assert.equal(c["workflow:keep-alive.yml"].status, "warn");
    assert.equal(c["workflow:daily-sync.yml"].status, "warn");
    assert.match(c["workflow:daily-sync.yml"].detail, /"failure"/, "the latest COMPLETED run is judged, not the one in progress");
    assert.equal(c["workflow:weekly-reconcile.yml"].status, "warn");
    assert.match(c["workflow:weekly-reconcile.yml"].detail, /hasn't completed a run in 480h/);
    assert.equal(c["workflow:job-radar.yml"].status, "warn");
    assert.match(c["workflow:job-radar.yml"].detail, /no completed run yet/);
  });

  it("backups: none ever, or the last success older than 36h, is a fail", async () => {
    let g = fakeGithub({ backupSuccess: [] });
    let c = byId((await githubOps.runGithubChecks({ env: ENV, fetchImpl: g.fetchImpl, now: NOW })).checks);
    assert.equal(c["backup:recent"].status, "fail");
    assert.match(c["backup:recent"].detail, /has ever succeeded/);
    g = fakeGithub({ backupSuccess: [{ status: "completed", conclusion: "success", updated_at: hoursAgo(40) }] });
    c = byId((await githubOps.runGithubChecks({ env: ENV, fetchImpl: g.fetchImpl, now: NOW })).checks);
    assert.equal(c["backup:recent"].status, "fail");
    assert.match(c["backup:recent"].detail, /40h old/);
    assert.ok(g.calls.some((x) => /db-backup\.yml\/runs\?status=success&per_page=1/.test(x.url)));
  });

  it("secrets: a missing required name fails and names its workflows; an optional one is a note", async () => {
    const g = fakeGithub({ secrets: ["SERVER_URL", "API_KEY", "NEON_DATABASE_URL"] });
    const c = byId((await githubOps.runGithubChecks({ env: ENV, fetchImpl: g.fetchImpl, now: NOW })).checks);
    assert.equal(c["secrets:workflows"].status, "fail");
    assert.match(c["secrets:workflows"].detail, /BACKUP_ENCRYPTION_PASSPHRASE — needed by Database Backup/);
    const ok = byId((await githubOps.runGithubChecks({ env: ENV, fetchImpl: fakeGithub({ secrets: ["SERVER_URL", "API_KEY", "NEON_DATABASE_URL", "BACKUP_ENCRYPTION_PASSPHRASE"] }).fetchImpl, now: NOW })).checks);
    assert.equal(ok["secrets:workflows"].status, "ok");
    assert.match(ok["secrets:workflows"].detail, /Optional, not set: PERSISTENT_DATABASE_URL/);
  });

  it("a public repository warns", async () => {
    const c = byId((await githubOps.runGithubChecks({ env: ENV, fetchImpl: fakeGithub({ repo: { private: false } }).fetchImpl, now: NOW })).checks);
    assert.equal(c["repo:visibility"].status, "warn");
    assert.match(c["repo:visibility"].fix, /private/);
  });

  it("fail-soft: a 401 is one reason with no checks; a 403 or a timeout makes that check unknown; the token is never echoed", async () => {
    const rejected = await githubOps.runGithubChecks({ env: ENV, fetchImpl: fakeGithub({ fail: { "^/repos/me/pers-fin$": 401 } }).fetchImpl, now: NOW });
    assert.deepEqual([rejected.configured, rejected.ok, rejected.checks.length], [true, false, 0]);
    assert.match(rejected.reason, /token was rejected/);

    const partial = await githubOps.runGithubChecks({
      env: ENV, now: NOW,
      fetchImpl: fakeGithub({ fail: { "/actions/secrets": 403, "daily-sync\\.yml/runs": "timeout" } }).fetchImpl,
    });
    const c = byId(partial.checks);
    assert.equal(c["secrets:workflows"].status, "unknown");
    assert.match(c["secrets:workflows"].fix, /"Secrets" repository permission/);
    assert.equal(c["workflow:daily-sync.yml"].status, "unknown");
    assert.match(c["workflow:daily-sync.yml"].detail, /GitHub timeout/);
    assert.equal(c["backup:recent"].status, "ok", "the other checks still ran");
    assert.ok(!JSON.stringify([rejected, partial]).includes(TOKEN), "no token (or response body) in any result");
  });
});

// ---------------------------------------------------------------------------
describe("ST4 — local and Knowledge checks", () => {
  it("passphrase, PIN, timezone, push and calendar feed", () => {
    const c = byId(oc.localChecks({ SHELL_PIN: "1234" }));
    assert.equal(c["local:token-passphrase"].status, "fail");
    assert.equal(c["local:shell-pin"].status, "warn");
    assert.equal(c["local:timezone"].status, "info");
    assert.equal(c["local:push"].status, "info");
    assert.equal(c["local:calendar-feed"].status, "info");
    const good = byId(oc.localChecks({ TOKEN_ENCRYPTION_PASSPHRASE: "p", SHELL_PIN: "123456", APP_TIMEZONE: "America/New_York", VAPID_PUBLIC_KEY: "a", VAPID_PRIVATE_KEY: "b", CALENDAR_FEED_TOKEN: "c", HEARTBEAT_URL: "https://hc-ping.com/x" }));
    assert.deepEqual(Object.values(good).filter((x) => x.status !== "ok").map((x) => x.id), []);
    assert.equal(byId(oc.localChecks({}))["local:shell-pin"], undefined, "no SHELL_PIN (standalone) → no PIN check");
  });

  it("the compromised Teller cert is a fail with the F14 wording", () => {
    const api = require("../teller/services/teller-api");
    const orig = api.tellerCertStatus;
    try {
      api.tellerCertStatus = () => ({ configured: true, compromised: true, fingerprint: "x" });
      assert.match(byId(oc.localChecks({}))["local:teller-cert"].detail, /exposed in git history/);
      assert.equal(byId(oc.localChecks({}))["local:teller-cert"].status, "fail");
      api.tellerCertStatus = () => ({ configured: false, compromised: false, fingerprint: null });
      assert.equal(byId(oc.localChecks({}))["local:teller-cert"], undefined);
    } finally { api.tellerCertStatus = orig; }
  });

  it("Knowledge: never / older version warns, current is ok, no vault or no Per-sistant is omitted, a read error is unknown", async () => {
    const current = require("../apps/per-sistant/services/vault-sync").VAULT_PARSE_VERSION;
    const pool = (row) => ({ query: async (sql) => { assert.match(sql, /vault_parse_version FROM user_settings/); if (row instanceof Error) throw row; return { rows: [row] }; } });
    const never = await oc.knowledgeCheck(pool({ vault_enabled: true, vault_repo: "me/v", vault_parse_version: null }));
    assert.equal(never.status, "warn");
    assert.match(never.fix, /Reindex now/);
    assert.equal((await oc.knowledgeCheck(pool({ vault_enabled: true, vault_repo: "me/v", vault_parse_version: current - 1 }))).status, "warn");
    assert.equal((await oc.knowledgeCheck(pool({ vault_enabled: true, vault_repo: "me/v", vault_parse_version: current }))).status, "ok");
    assert.equal(await oc.knowledgeCheck(pool({ vault_enabled: false, vault_repo: null, vault_parse_version: null })), null);
    assert.equal(await oc.knowledgeCheck(null), null);
    assert.equal((await oc.knowledgeCheck(pool(new Error("column missing")))).status, "unknown");
  });
});

// ---------------------------------------------------------------------------
describe("ST4 — cache, issues and notification", () => {
  beforeEach(() => oc._resetCache());

  it("GitHub results are cached for 6h; force re-reads; cachedOnly never waits", async () => {
    const g = fakeGithub();
    const env = { ...ENV };
    const pending = await oc.getOperatorChecks({ env, fetchImpl: g.fetchImpl, cachedOnly: true });
    assert.equal(pending.github.pending, true, "the first cachedOnly call returns at once");
    await oc._refreshGithub({ env, fetchImpl: g.fetchImpl }); // the background refresh it started (single-flight)
    const n = g.calls.length;
    assert.equal(n, 3 + 1 + githubOps.BACKSTOPS.length, "one refresh, not two");
    const cached = await oc.getOperatorChecks({ env, fetchImpl: g.fetchImpl, cachedOnly: true });
    assert.equal(cached.github.pending, false);
    await oc.getOperatorChecks({ env, fetchImpl: g.fetchImpl });
    assert.equal(g.calls.length, n, "a fresh cache is not re-read");
    await oc.getOperatorChecks({ env, fetchImpl: g.fetchImpl, force: true });
    assert.equal(g.calls.length, 2 * n);
  });

  it("toIssues: warn / fail become warnings tagged operator; info doesn't; GitHub off is one info line", () => {
    const issues = oc.toIssues({
      github: { configured: false, ok: false, pending: false },
      checks: [
        { id: "a", label: "A", status: "fail", detail: "bad" },
        { id: "b", label: "B", status: "warn", detail: "meh" },
        { id: "c", label: "C", status: "info", detail: "fyi" },
        { id: "d", label: "D", status: "ok", detail: "fine" },
      ],
    });
    assert.deepEqual(issues.map((i) => [i.severity, i.check]), [["warning", "a"], ["warning", "b"], ["info", "github"]]);
    assert.ok(issues.every((i) => i.source === "operator"));
    assert.match(issues[0].message, /^A: bad$/);
    assert.deepEqual(oc.toIssues({ github: { configured: true, ok: false, pending: false, reason: "x" }, checks: [] }).map((i) => i.severity), ["warning"]);
  });

  it("notifyIfChanged: once per change in the failing set; skipped while GitHub is unreadable; a failed send keeps the old signature", async () => {
    let stored = "";
    const writes = [];
    const pool = { query: async (sql, params) => {
      if (/SELECT operator_checks_signature/.test(sql)) return { rows: [{ operator_checks_signature: stored }] };
      if (/UPDATE user_settings SET operator_checks_signature/.test(sql)) { stored = params[0]; writes.push(params[0]); return { rows: [] }; }
      throw new Error("unexpected " + sql);
    } };
    const sent = [];
    const sendToAll = async (n) => sent.push(n);
    const gh = { configured: true, ok: true, pending: false };
    const failing = { github: gh, checks: [{ id: "backup:recent", label: "Database backup", status: "fail" }, { id: "local:timezone", label: "Timezone", status: "info" }] };

    assert.equal((await oc.notifyIfChanged(pool, failing, { sendToAll })).notified, true);
    assert.equal(sent[0].tag, "operator-checks");
    assert.equal(sent[0].data.url, "/settings#sync-health");
    assert.match(sent[0].title, /1 need attention/);
    assert.equal((await oc.notifyIfChanged(pool, failing, { sendToAll })).notified, false, "unchanged → no second push");
    assert.equal(sent.length, 1);

    const unreadable = { github: gh, checks: [{ id: "backup:recent", label: "x", status: "unknown" }] };
    assert.equal((await oc.notifyIfChanged(pool, unreadable, { sendToAll })).skipped, "github_unreadable");
    assert.equal(stored, "backup:recent", "an unreadable round doesn't reset the signature");

    const healthy = { github: gh, checks: [{ id: "backup:recent", label: "x", status: "ok" }] };
    await oc.notifyIfChanged(pool, healthy, { sendToAll });
    assert.equal(stored, "");
    assert.equal(sent.length, 1, "recovery is silent");

    const r = await oc.notifyIfChanged(pool, failing, { sendToAll: async () => { throw new Error("push down"); } });
    assert.equal(r.skipped, "notify_failed");
    assert.equal(stored, "", "kept, so the next round retries");
  });
});

// ---------------------------------------------------------------------------
describe("ST4 — routes and wiring", () => {
  beforeEach(() => oc._resetCache());

  it("GET /api/data-health lists operator issues (cert incl.) and the checks; it never waits on GitHub", async () => {
    const api = require("../teller/services/teller-api");
    const orig = api.tellerCertStatus;
    api.tellerCertStatus = () => ({ configured: true, compromised: true, fingerprint: "x" });
    const prevTok = process.env.GITHUB_OPS_TOKEN;
    process.env.GITHUB_OPS_TOKEN = TOKEN; process.env.GITHUB_OPS_REPO = "me/pers-fin";
    const origFetch = global.fetch;
    let fetched = 0;
    global.fetch = () => { fetched++; return new Promise(() => {}); }; // GitHub hangs
    try {
      dbModule.pool.query = async (sql) => {
        if (/FROM user_settings/.test(sql)) return { rows: [{ last_txn_sync_at: new Date(), last_balance_sync_at: new Date() }] };
        return { rows: [{ total: 0, disconnected: 0, not_good: 0 }] };
      };
      const app = express(); app.use(require("../teller/routes/settings"));
      const res = await supertest(app).get("/api/data-health").expect(200);
      assert.ok(res.body.issues.some((i) => i.source === "operator" && /Teller certificate in use is the one exposed in git history/.test(i.message)));
      assert.equal(res.body.operator_checks.github.pending, true, "answered without waiting for GitHub");
      assert.ok(fetched > 0, "and started a background refresh");
      assert.ok(!JSON.stringify(res.body).includes(TOKEN));
    } finally {
      api.tellerCertStatus = orig; global.fetch = origFetch;
      if (prevTok === undefined) delete process.env.GITHUB_OPS_TOKEN; else process.env.GITHUB_OPS_TOKEN = prevTok;
      delete process.env.GITHUB_OPS_REPO;
      oc._resetCache();
    }
  });

  it("GET /api/operator-checks returns the checks; ?refresh=1 forces", async () => {
    const calls = [];
    const orig = oc.getOperatorChecks;
    oc.getOperatorChecks = async (opts) => { calls.push(opts); return { checked_at: "t", github: { configured: false }, checks: [] }; };
    try {
      const app = express(); app.use(require("../teller/routes/settings"));
      const res = await supertest(app).get("/api/operator-checks?refresh=1").expect(200);
      assert.deepEqual(res.body.checks, []);
      assert.equal(calls[0].force, true);
      await supertest(app).get("/api/operator-checks").expect(200);
      assert.equal(calls[1].force, false);
    } finally { oc.getOperatorChecks = orig; }
  });

  it("the watchdog refreshes and notifies; Settings renders the list; the migration adds the signature column", () => {
    const startup = read("teller", "startup.js");
    assert.match(startup, /operatorChecks\.getOperatorChecks\(\{\s*pool,\s*persistentPool: require\("\.\/routes\/persistent"\)\.getEmbeddedPersistentPool\(\),/);
    assert.match(startup, /await operatorChecks\.notifyIfChanged\(pool, result, \{ sendToAll \}\)/);
    const view = read("teller", "views", "settings.ejs");
    assert.match(view, /id="operator-checks-btn"/);
    assert.match(view, /apiFetch\('\/api\/operator-checks' \+ \(refresh \? '\?refresh=1' : ''\)\)/);
    assert.match(view, /i\.source !== 'operator'/, "Sync Health's issue list doesn't repeat them");
    assert.match(read("teller", "services", "database.js"), /ADD COLUMN IF NOT EXISTS operator_checks_signature TEXT/);
    assert.doesNotMatch(read("teller", "services", "github-ops.js"), /console\.\w+\([^)]*token/i, "the token is never logged");
  });
});
