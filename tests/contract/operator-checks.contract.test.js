// Real-Postgres contract tests for cycle-7 Batch 17 (G1 + ST4 — operator checks):
//  - the Knowledge reindex check reads Per-sistant's database through the
//    wired persistentPool: "never reindexed" until a real full vault sync
//    stamps vault_parse_version (db/029), then ok;
//  - GitHub problems (a disabled backup workflow, no successful backup, a
//    public repo) reach GET /api/operator-checks and GET /api/data-health's
//    issues, and notifyIfChanged writes the signature column + one
//    notification_log row, not a second one for the same failing set.
// GitHub is a stubbed global fetch; nothing leaves the machine.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, persistentDb, perfinApp } = require("./_setup");

const TOKEN = "ghp_contract_token";
const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

describe("Operator checks on real Postgres", { skip: SKIP }, () => {
  let pool, ppool, app, oc, vault, origFetch;
  const github = { repoPrivate: false, backupState: "disabled_inactivity", backups: [] };

  before(async () => {
    pool = await perfinDb("operator");
    ppool = await persistentDb("operator");
    app = perfinApp();
    app.set("persistentPool", ppool);
    oc = require("../../teller/services/operator-checks");
    vault = require("../../apps/per-sistant/services/vault-sync");
    process.env.GITHUB_OPS_TOKEN = TOKEN;
    process.env.GITHUB_OPS_REPO = "me/pers-fin";
    origFetch = global.fetch;
    const files = require("../../teller/services/github-ops").BACKSTOPS.map((d) => d.file);
    global.fetch = async (url) => {
      const u = String(url).replace("https://api.github.com", "");
      const ok = (body) => ({ ok: true, status: 200, json: async () => body });
      if (u === "/repos/me/pers-fin") return ok({ private: github.repoPrivate });
      if (u.startsWith("/repos/me/pers-fin/actions/workflows?")) {
        return ok({ workflows: files.map((f, i) => ({ id: i, path: ".github/workflows/" + f, state: f === "db-backup.yml" ? github.backupState : "active" })) });
      }
      if (u.startsWith("/repos/me/pers-fin/actions/secrets?")) return ok({ secrets: ["SERVER_URL", "API_KEY", "NEON_DATABASE_URL", "BACKUP_ENCRYPTION_PASSPHRASE"].map((name) => ({ name })) });
      if (/db-backup\.yml\/runs\?status=success/.test(u)) return ok({ workflow_runs: github.backups });
      if (/\/actions\/workflows\/[^/]+\/runs\?/.test(u)) return ok({ workflow_runs: [{ status: "completed", conclusion: "success", updated_at: hoursAgo(1) }] });
      throw new Error("unexpected fetch " + u);
    };
    oc._resetCache();
  });
  after(async () => {
    global.fetch = origFetch;
    delete process.env.GITHUB_OPS_TOKEN;
    delete process.env.GITHUB_OPS_REPO;
    if (oc) oc._resetCache();
    if (pool) await pool.end();
    if (ppool) await ppool.end();
  });

  it("the Knowledge check asks for a reindex until a full vault sync stamps the parse version", async () => {
    await ppool.query("INSERT INTO user_settings (id) VALUES (1) ON CONFLICT DO NOTHING");
    await ppool.query("UPDATE user_settings SET vault_enabled = true, vault_repo = 'me/vault', vault_branch = 'main' WHERE id = 1");
    const check = async () => (await supertest(app).get("/api/operator-checks").expect(200)).body.checks.find((c) => c.id === "knowledge:reindex");
    assert.equal((await check()).status, "warn");

    const prev = process.env.VAULT_GITHUB_TOKEN;
    process.env.VAULT_GITHUB_TOKEN = "vault-token";
    try {
      const fetchImpl = async (url) => {
        const u = String(url).replace("https://api.github.com", "");
        const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });
        if (/\/branches\/main$/.test(u)) return ok({ commit: { sha: "H1" } });
        if (/\/git\/trees\/H1/.test(u)) return ok({ tree: [{ type: "blob", path: "a.md" }] });
        if (/\/contents\/a\.md/.test(u)) return ok({ encoding: "base64", content: Buffer.from("# A\nhello").toString("base64") });
        throw new Error("unexpected vault fetch " + u);
      };
      const r = await vault.syncVault(ppool, { full: true, fetchImpl });
      assert.equal(r.ok, true, JSON.stringify(r));
    } finally {
      if (prev === undefined) delete process.env.VAULT_GITHUB_TOKEN; else process.env.VAULT_GITHUB_TOKEN = prev;
    }
    const stored = (await ppool.query("SELECT vault_parse_version FROM user_settings WHERE id = 1")).rows[0].vault_parse_version;
    assert.equal(stored, vault.VAULT_PARSE_VERSION);
    assert.equal((await check()).status, "ok");
  });

  it("GitHub problems reach operator-checks and data-health, and notify once per failing set", async () => {
    const res = await supertest(app).get("/api/operator-checks?refresh=1").expect(200);
    const byId = Object.fromEntries(res.body.checks.map((c) => [c.id, c]));
    assert.equal(byId["workflow:db-backup.yml"].status, "fail");
    assert.equal(byId["backup:recent"].status, "fail");
    assert.equal(byId["repo:visibility"].status, "warn");
    assert.equal(byId["secrets:workflows"].status, "ok");
    assert.ok(!JSON.stringify(res.body).includes(TOKEN));

    const dh = (await supertest(app).get("/api/data-health").expect(200)).body;
    const op = dh.issues.filter((i) => i.source === "operator").map((i) => i.check);
    for (const id of ["workflow:db-backup.yml", "backup:recent", "repo:visibility"]) assert.ok(op.includes(id), id);
    assert.equal(dh.ok, false);

    const { sendToAll } = require("../../teller/routes/notifications");
    const result = await oc.getOperatorChecks({ persistentPool: ppool });
    const first = await oc.notifyIfChanged(pool, result, { sendToAll });
    assert.equal(first.notified, true);
    const again = await oc.notifyIfChanged(pool, result, { sendToAll });
    assert.equal(again.notified, false);
    const logged = (await pool.query("SELECT title, data FROM notification_log WHERE type = 'operator-checks' OR title LIKE 'Operator checks:%'")).rows;
    assert.equal(logged.length, 1);
    assert.match(logged[0].title, /^Operator checks: \d+ need attention$/);
    const sig = (await pool.query("SELECT operator_checks_signature FROM user_settings WHERE id = 1")).rows[0].operator_checks_signature;
    assert.match(sig, /backup:recent/);

    // Fixed on GitHub → the signature clears silently.
    github.repoPrivate = true; github.backupState = "active"; github.backups = [{ status: "completed", conclusion: "success", updated_at: hoursAgo(2) }];
    const fixed = await oc.getOperatorChecks({ persistentPool: ppool, force: true });
    await oc.notifyIfChanged(pool, fixed, { sendToAll });
    const after = (await pool.query("SELECT operator_checks_signature FROM user_settings WHERE id = 1")).rows[0].operator_checks_signature;
    assert.doesNotMatch(after || "", /backup:recent|repo:visibility|db-backup/);
  });
});
