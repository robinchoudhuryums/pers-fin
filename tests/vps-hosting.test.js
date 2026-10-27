// ============================================================================
// VPS move — hosting facts (services/hosting.js)
// ============================================================================
// PUBLIC_URL (falls back to Render's RENDER_EXTERNAL_URL), ALWAYS_ON (no
// keep-alive ping; the Keep Alive workflow isn't expected) and SERVER_BACKUPS
// (deploy/vps/backup.sh stamps user_settings.last_backup_at; Operator Checks
// reads it and stops expecting the Database Backup workflow and its secrets).
// ============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const hosting = require("../teller/services/hosting");
const githubOps = require("../teller/services/github-ops");
const oc = require("../teller/services/operator-checks");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const NOW = Date.parse("2026-10-22T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
const byId = (checks) => Object.fromEntries(checks.map((c) => [c.id, c]));

describe("hosting facts", () => {
  it("publicUrl prefers PUBLIC_URL, falls back to RENDER_EXTERNAL_URL, and rejects a non-http value", () => {
    assert.equal(hosting.publicUrl({ PUBLIC_URL: "https://fin.example.com/", RENDER_EXTERNAL_URL: "https://x.onrender.com" }), "https://fin.example.com");
    assert.equal(hosting.publicUrl({ RENDER_EXTERNAL_URL: "https://x.onrender.com" }), "https://x.onrender.com");
    assert.equal(hosting.publicUrl({ PUBLIC_URL: " https://fin.example.com// " }), "https://fin.example.com");
    assert.equal(hosting.publicUrl({}), null);
    assert.equal(hosting.publicUrl({ PUBLIC_URL: "fin.example.com" }), null);
    assert.equal(hosting.publicUrl({ PUBLIC_URL: "javascript:alert(1)" }), null);
  });

  it("ALWAYS_ON / SERVER_BACKUPS accept true / 1 / yes / on and nothing else", () => {
    for (const v of ["true", "TRUE", "1", "yes", "on", " true "]) assert.equal(hosting.alwaysOn({ ALWAYS_ON: v }), true, v);
    for (const v of ["", "false", "0", "no", "nope", undefined]) assert.equal(hosting.alwaysOn({ ALWAYS_ON: v }), false, String(v));
    assert.equal(hosting.serverBackups({ SERVER_BACKUPS: "true" }), true);
    assert.equal(hosting.serverBackups({}), false);
  });

  it("an always-on host starts no keep-alive ping (Perfin / the shell and standalone Per-sistant)", () => {
    const perfin = require("../teller/services/keep-alive");
    assert.equal(perfin.startKeepAlive(3000, { ALWAYS_ON: "true" }), false);
    const persistent = require("../apps/per-sistant/services/keep-alive");
    assert.equal(persistent.startKeepAlive(3001, { ALWAYS_ON: "true" }), false);
    assert.equal(persistent.publicUrl({ PUBLIC_URL: "https://fin.example.com/" }), "https://fin.example.com");
    assert.equal(persistent.publicUrl({ RENDER_EXTERNAL_URL: "https://x.onrender.com" }), "https://x.onrender.com");
  });

  it("the keep-alive schedule reports disabled on an always-on host (both apps)", () => {
    assert.match(read("teller", "server.js"), /enabled: !hosting\.alwaysOn\(\) && !!config\.keep_alive_enabled/);
    assert.match(read("apps", "per-sistant", "routes", "settings.js"), /enabled: !alwaysOn\(\) && !!cfg\.keep_alive_enabled/);
  });

  it("the insight email's dashboard link uses PUBLIC_URL", () => {
    const persistent = require("../teller/routes/persistent");
    const prev = { p: process.env.PUBLIC_URL, r: process.env.RENDER_EXTERNAL_URL };
    try {
      process.env.PUBLIC_URL = "https://fin.example.com";
      process.env.RENDER_EXTERNAL_URL = "https://old.onrender.com";
      assert.equal(persistent.perfinDashboardUrl(), "https://fin.example.com/dashboard");
    } finally {
      for (const [k, v] of [["PUBLIC_URL", prev.p], ["RENDER_EXTERNAL_URL", prev.r]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  it("Settings replaces the Keep-Alive controls with a note on an always-on host", () => {
    assert.match(read("teller", "routes", "settings.js"), /always_on: require\("\.\.\/services\/hosting"\)\.alwaysOn\(\)/);
    const ejs = read("teller", "views", "settings.ejs");
    assert.match(ejs, /id="keepalive-always-on" hidden/);
    assert.match(ejs, /if \(s\.always_on\) \{[\s\S]*?keepalive-always-on'\)\.hidden = false;[\s\S]*?#keepalive-section \.setting-row[\s\S]*?style\.display = 'none'/);
  });
});

// A minimal fake GitHub: every workflow active and recently green, all secrets
// listed in `secrets`.
function fakeGithub(secrets) {
  return async (url) => {
    const u = String(url).replace("https://api.github.com", "");
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    if (/^\/repos\/me\/pers-fin$/.test(u)) return ok({ private: true });
    if (/\/actions\/workflows\?/.test(u)) return ok({ workflows: githubOps.BACKSTOPS.map((d, i) => ({ id: i + 1, path: ".github/workflows/" + d.file, state: "active" })) });
    if (/\/actions\/secrets\?/.test(u)) return ok({ secrets: secrets.map((name) => ({ name })) });
    if (/db-backup\.yml\/runs\?status=success/.test(u)) return ok({ workflow_runs: [] });
    if (/\/actions\/workflows\/[^/]+\/runs\?/.test(u)) return ok({ workflow_runs: [{ status: "completed", conclusion: "success", updated_at: hoursAgo(0.1) }] });
    throw new Error("unexpected GitHub call " + u);
  };
}
const GH = { GITHUB_OPS_TOKEN: "t", GITHUB_OPS_REPO: "me/pers-fin" };

describe("Operator Checks on a self-hosted server", () => {
  it("without the flags nothing changes: the backup workflow is expected, with its secrets", async () => {
    const r = await githubOps.runGithubChecks({ env: GH, fetchImpl: fakeGithub(["SERVER_URL", "API_KEY"]), now: NOW });
    const c = byId(r.checks);
    assert.equal(c["backup:recent"].status, "fail");
    assert.equal(c["secrets:workflows"].status, "fail");
    assert.match(c["secrets:workflows"].detail, /NEON_DATABASE_URL/);
    assert.equal(c["workflow:keep-alive.yml"].status, "ok");
  });

  it("SERVER_BACKUPS + ALWAYS_ON: no GitHub backup check, the two workflows are info, their secrets aren't required", async () => {
    const env = { ...GH, SERVER_BACKUPS: "true", ALWAYS_ON: "true" };
    const r = await githubOps.runGithubChecks({ env, fetchImpl: fakeGithub(["SERVER_URL", "API_KEY"]), now: NOW });
    const c = byId(r.checks);
    assert.equal(c["backup:recent"], undefined);
    assert.equal(c["secrets:workflows"].status, "ok");
    assert.equal(c["workflow:db-backup.yml"].status, "info");
    assert.match(c["workflow:db-backup.yml"].detail, /backups run on the server/);
    assert.match(c["workflow:db-backup.yml"].fix, /Disable workflow/, "still enabled → suggests disabling it");
    assert.equal(c["workflow:keep-alive.yml"].status, "info");
    assert.match(c["workflow:keep-alive.yml"].detail, /always on/);
    assert.equal(c["workflow:daily-sync.yml"].status, "ok", "the other backstops are still checked");
    assert.equal(oc._failingSignature(r.checks), "", "info checks never notify");
  });

  it("the on-server backup check reads user_settings.last_backup_at", async () => {
    const env = { SERVER_BACKUPS: "true" };
    const pool = (row) => ({ query: async (sql) => { assert.match(sql, /SELECT last_backup_at FROM user_settings/); return { rows: [row] }; } });
    assert.equal(await oc.serverBackupCheck(pool({ last_backup_at: null }), {}, NOW), null, "off without SERVER_BACKUPS");
    assert.equal((await oc.serverBackupCheck(null, env, NOW)).status, "unknown");
    const none = await oc.serverBackupCheck(pool({ last_backup_at: null }), env, NOW);
    assert.equal(none.status, "fail");
    assert.match(none.fix, /backup\.sh/);
    const old = await oc.serverBackupCheck(pool({ last_backup_at: hoursAgo(40) }), env, NOW);
    assert.equal(old.status, "fail");
    assert.match(old.detail, /40h old/);
    const fresh = await oc.serverBackupCheck(pool({ last_backup_at: hoursAgo(3) }), env, NOW);
    assert.equal(fresh.status, "ok");
    const broken = await oc.serverBackupCheck({ query: async () => { throw new Error("db down"); } }, env, NOW);
    assert.equal(broken.status, "unknown");
    assert.equal(broken.id, "local:server-backup", "not a GitHub id — a read failure doesn't hold back the notification");
  });

  it("getOperatorChecks includes the on-server backup check with no GitHub token", async () => {
    oc._resetCache();
    const pool = { query: async () => ({ rows: [{ last_backup_at: new Date().toISOString() }] }) };
    const r = await oc.getOperatorChecks({ env: { SERVER_BACKUPS: "true", TOKEN_ENCRYPTION_PASSPHRASE: "x" }, pool });
    const c = byId(r.checks);
    assert.equal(c["local:server-backup"].status, "ok");
    assert.equal(r.github.configured, false);
    oc._resetCache();
  });

  it("every caller passes Perfin's pool", () => {
    const settings = read("teller", "routes", "settings.js");
    assert.equal((settings.match(/getOperatorChecks\(\{[^}]*\n\s+pool(?:: db)?,/g) || []).length, 2);
    assert.match(read("teller", "startup.js"), /getOperatorChecks\(\{\s*\n\s+pool,/);
  });

  it("the column is migrated and backup.sh stamps it after the verified loop, without failing on a stamp error", () => {
    assert.match(read("teller", "services", "database.js"), /ADD COLUMN IF NOT EXISTS last_backup_at TIMESTAMPTZ/);
    const sh = read("deploy", "vps", "backup.sh");
    const loopEnd = sh.indexOf('mv "$tmp" "$out"');
    const stamp = sh.indexOf("UPDATE user_settings SET last_backup_at = now() WHERE id = 1");
    assert.ok(loopEnd > 0 && stamp > loopEnd, "stamped only after both databases were verified");
    assert.match(sh.slice(stamp), /\|\| echo "[^"]*WARNING: couldn't record the backup time/);
  });

  it("the VPS template turns the three settings on", () => {
    const env = read("deploy", "vps", "app.env.example");
    for (const line of ["PUBLIC_URL=https://", "ALWAYS_ON=true", "SERVER_BACKUPS=true"]) assert.ok(env.includes(line), line);
    assert.doesNotMatch(env, /^RENDER_EXTERNAL_URL=/m);
  });
});
