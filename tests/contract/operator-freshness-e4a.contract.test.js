// Real-Postgres contract tests for cycle-8 E4a (ST5 — go-live checks and the
// token-free backup record):
//  - a fresh database has no backup recorded, so without a GitHub token the
//    backup check fails; db-backup.yml's own stamp (the exact UPDATE the
//    workflow runs) turns it ok, naming GitHub Actions; a stamp older than 36h
//    fails again;
//  - reset-fresh's read of the record (to_jsonb, so it runs on any schema)
//    returns the stamp from the real table;
//  - a GOOD Plaid item under PLAID_ENV=sandbox warns, a CSV item doesn't count,
//    and a Teller enrollment with no certificate configured fails — both
//    through GET /api/operator-checks and data-health's issues.
// GitHub is never configured here (no GITHUB_OPS_TOKEN), so nothing is fetched.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

const ENV_KEYS = ["GITHUB_OPS_TOKEN", "GITHUB_OPS_REPO", "SERVER_BACKUPS", "PLAID_CLIENT_ID", "PLAID_ENV",
  "PLAID_SECRET_SANDBOX", "TELLER_CERT", "TELLER_KEY", "TELLER_CERT_PATH", "TELLER_KEY_PATH"];

describe("cycle-8 E4a go-live checks on real Postgres", { skip: SKIP }, () => {
  let pool, app, oc, api, saved, origCert;

  before(async () => {
    pool = await perfinDb("operator_e4a");
    app = perfinApp();
    oc = require("../../teller/services/operator-checks");
    api = require("../../teller/services/teller-api");
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    // No certificate configured, whatever the machine has on disk.
    origCert = api.tellerCertStatus;
    api.tellerCertStatus = () => ({ configured: false, compromised: false, fingerprint: null });
    oc._resetCache();
  });
  after(async () => {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    if (api) api.tellerCertStatus = origCert;
    if (oc) oc._resetCache();
    if (pool) await pool.end();
  });

  const backupCheck = async () => (await supertest(app).get("/api/operator-checks?refresh=1").expect(200))
    .body.checks.find((c) => c.id === "local:backup");

  it("a fresh database fails the backup check without a token; db-backup.yml's stamp clears it", async () => {
    await pool.query("INSERT INTO user_settings (id) VALUES (1) ON CONFLICT DO NOTHING");
    const missing = await backupCheck();
    assert.equal(missing.status, "fail");
    assert.match(missing.detail, /No backup has been recorded/);

    // The workflow's statement, read out of the workflow file itself.
    const yml = fs.readFileSync(path.join(__dirname, "../../.github/workflows/db-backup.yml"), "utf8");
    const stamp = yml.match(/-qtAc "(UPDATE user_settings SET last_backup_at = now\(\), last_backup_source = 'github' WHERE id = 1)"/);
    assert.ok(stamp, "db-backup.yml's stamp statement");
    await pool.query(stamp[1]);

    const ok = await backupCheck();
    assert.equal(ok.status, "ok");
    assert.match(ok.detail, /GitHub Actions/);

    const dh = (await supertest(app).get("/api/data-health").expect(200)).body;
    assert.ok(!dh.issues.some((i) => i.check === "local:backup"));

    await pool.query("UPDATE user_settings SET last_backup_at = now() - interval '40 hours' WHERE id = 1");
    const stale = await backupCheck();
    assert.equal(stale.status, "fail");
    assert.match(stale.detail, /40h old/);
    const dh2 = (await supertest(app).get("/api/data-health").expect(200)).body;
    assert.ok(dh2.issues.some((i) => i.check === "local:backup" && i.severity === "warning"));
  });

  it("reset-fresh's read of the backup record works on the real schema", async () => {
    await pool.query("UPDATE user_settings SET last_backup_at = now(), last_backup_source = 'server' WHERE id = 1");
    const src = fs.readFileSync(path.join(__dirname, "../../scripts/reset-fresh.js"), "utf8");
    const sql = src.match(/"(SELECT to_jsonb\(s\) ->> 'last_backup_at'[^"]+)"/);
    assert.ok(sql, "reset-fresh's SELECT");
    const row = (await pool.query(sql[1])).rows[0];
    assert.ok(row.last_backup_at);
    assert.equal(row.last_backup_source, "server");
  });

  it("a GOOD Plaid item under sandbox warns and a Teller enrollment without a certificate fails", async () => {
    process.env.PLAID_CLIENT_ID = "client";
    process.env.PLAID_ENV = "sandbox";
    process.env.PLAID_SECRET_SANDBOX = "secret-sandbox-value";
    try {
      const PASS = process.env.TOKEN_ENCRYPTION_PASSPHRASE;
      const checks = async () => Object.fromEntries((await supertest(app).get("/api/operator-checks?refresh=1").expect(200))
        .body.checks.map((c) => [c.id, c]));

      // Only a CSV virtual item: sandbox is fine, no Teller check.
      await pool.query("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status) VALUES ('csv_1','CSV Bank', pgp_sym_encrypt('x', $1), 'CSV')", [PASS]);
      let c = await checks();
      assert.equal(c["local:plaid-config"].status, "ok");
      assert.equal(c["local:teller-cert"], undefined);

      await pool.query("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status) VALUES ('p_real','Real Bank', pgp_sym_encrypt('x', $1), 'GOOD')", [PASS]);
      await pool.query("INSERT INTO teller_enrollments (enrollment_id, institution_name, access_token_enc, status) VALUES ('e_1','Teller Bank', pgp_sym_encrypt('t', $1), 'GOOD')", [PASS]);
      c = await checks();
      assert.equal(c["local:plaid-config"].status, "warn");
      assert.match(c["local:plaid-config"].detail, /sandbox while 1 Plaid connection/);
      assert.equal(c["local:teller-cert"].status, "fail");
      const body = JSON.stringify(c);
      assert.ok(!body.includes("secret-sandbox-value"));

      const dh = (await supertest(app).get("/api/data-health").expect(200)).body;
      const op = dh.issues.filter((i) => i.source === "operator").map((i) => i.check);
      assert.ok(op.includes("local:plaid-config"));
      assert.ok(op.includes("local:teller-cert"));

      // A suspended enrollment doesn't need the certificate.
      await pool.query("UPDATE teller_enrollments SET status = 'SUSPENDED'");
      c = await checks();
      assert.equal(c["local:teller-cert"], undefined);
    } finally {
      delete process.env.PLAID_CLIENT_ID; delete process.env.PLAID_ENV; delete process.env.PLAID_SECRET_SANDBOX;
    }
  });
});
