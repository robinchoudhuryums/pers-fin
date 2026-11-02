// Cycle 8 E4a (ST5) — go-live checks without a GitHub token.
// Operator Checks reads the deployment's own setup from the environment and the
// databases only (never the network, never a secret's value): the Teller cert
// missing while Teller connections exist, expired or close to expiry; the two
// apps' databases shared on purpose; PUBLIC_URL's shape; API_KEY / SHELL_SECRET
// strength; the Plaid secret for PLAID_ENV and sandbox with real connections;
// the Teller webhook secret's parts; and the last backup recorded in
// user_settings — stamped by backup.sh ('server') and now by db-backup.yml
// ('github') — which runs whenever the GitHub checks are off.
process.env.NEON_DATABASE_URL = process.env.NEON_DATABASE_URL || "postgres://test:test@127.0.0.1:1/test";
process.env.TOKEN_ENCRYPTION_PASSPHRASE = process.env.TOKEN_ENCRYPTION_PASSPHRASE || "test-passphrase";
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const oc = require("../teller/services/operator-checks");
const api = require("../teller/services/teller-api");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const byId = (checks) => Object.fromEntries(checks.map((c) => [c.id, c]));
const NOW = Date.parse("2026-10-30T12:00:00Z");
const DAY = 86400000;
const GH = { GITHUB_OPS_TOKEN: "t", GITHUB_OPS_REPO: "me/pers-fin" };

// A throwaway self-signed certificate (no key kept), valid until 2036-10-27.
const FIXTURE_CERT = `-----BEGIN CERTIFICATE-----
MIIBbjCCARSgAwIBAgIBATAKBggqhkjOPQQDAjAWMRQwEgYDVQQDDAtlNGEtZml4
dHVyZTAeFw0yNjEwMzAxNjAyMDNaFw0zNjEwMjcxNjAyMDNaMBYxFDASBgNVBAMM
C2U0YS1maXh0dXJlMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAETqrM2b/oDuWc
ig8xmhrjwUWbFTr2Giu6DuZdeTD9t9TWdgi1l1Edrh1y8nY1aIGqlmFSws8Y2UAY
VKJn8O5iaKNTMFEwHQYDVR0OBBYEFCpFFoW9nyKpcmnELOGBpR8Q8cYkMB8GA1Ud
IwQYMBaAFCpFFoW9nyKpcmnELOGBpR8Q8cYkMA8GA1UdEwEB/wQFMAMBAf8wCgYI
KoZIzj0EAwIDSAAwRQIhANTTB9tf8MdERXok0Cp9RjwZ8pNbBFcFooJSepHtX9xk
AiB8w4mQuDq9xSPKIeGR0+F5X41FB1pUYg/p89AtE8MQGg==
-----END CERTIFICATE-----
`;

// A pool that answers the go-live counts and the backup read.
function fakePool({ teller = 0, plaidGood = 0, backup = {}, fail = false } = {}) {
  const seen = [];
  return {
    seen,
    query: async (sql) => {
      seen.push(sql);
      if (fail) throw new Error("db down");
      if (/FROM teller_enrollments/.test(sql)) return { rows: [{ n: teller }] };
      if (/FROM plaid_items/.test(sql)) return { rows: [{ n: plaidGood }] };
      if (/last_backup_at/.test(sql)) return { rows: [backup] };
      return { rows: [] };
    },
  };
}

let origCert;
function certIs(status) { api.tellerCertStatus = () => status; }
beforeEach(() => { origCert = api.tellerCertStatus; oc._resetCache(); });
afterEach(() => { api.tellerCertStatus = origCert; oc._resetCache(); });

describe("the Teller certificate", () => {
  it("certExpiresAt reads validTo from a PEM; anything unreadable is null, never a throw", () => {
    assert.equal(api.certExpiresAt(FIXTURE_CERT), "2036-10-27T16:02:03.000Z");
    assert.equal(api.certExpiresAt(Buffer.from(FIXTURE_CERT)), "2036-10-27T16:02:03.000Z");
    assert.equal(api.certExpiresAt("not a certificate"), null);
    assert.equal(api.certExpiresAt(Buffer.alloc(0)), null);
  });

  it("localChecks: expired fails, within 30 days warns, later is ok with its date; the compromised cert wins", () => {
    const at = (ms) => new Date(NOW + ms).toISOString();
    certIs({ configured: true, compromised: false, fingerprint: "f", expires_at: at(-DAY) });
    let c = byId(oc.localChecks({}, NOW))["local:teller-cert"];
    assert.equal(c.status, "fail");
    assert.match(c.detail, /expired on 2026-10-29/);
    certIs({ configured: true, compromised: false, fingerprint: "f", expires_at: at(20 * DAY) });
    c = byId(oc.localChecks({}, NOW))["local:teller-cert"];
    assert.equal(c.status, "warn");
    assert.match(c.detail, /expires on 2026-11-19/);
    certIs({ configured: true, compromised: false, fingerprint: "f", expires_at: at(31 * DAY) });
    c = byId(oc.localChecks({}, NOW))["local:teller-cert"];
    assert.equal(c.status, "ok");
    assert.match(c.detail, /valid until 2026-11-30/);
    certIs({ configured: true, compromised: true, fingerprint: "f", expires_at: at(-DAY) });
    assert.match(byId(oc.localChecks({}, NOW))["local:teller-cert"].detail, /exposed in git history/);
    certIs({ configured: true, compromised: false, fingerprint: "f", expires_at: null });
    c = byId(oc.localChecks({}, NOW))["local:teller-cert"];
    assert.equal(c.status, "ok", "an unknown expiry isn't a finding");
    assert.doesNotMatch(c.detail, /valid until/);
  });

  it("goLiveChecks: no cert while Teller connections exist fails; no connections, or a configured cert, adds nothing", async () => {
    certIs({ configured: false, compromised: false, fingerprint: null });
    let c = byId(await oc.goLiveChecks({ pool: fakePool({ teller: 2 }), env: {} }))["local:teller-cert"];
    assert.equal(c.status, "fail");
    assert.match(c.detail, /2 Teller connection\(s\) exist/);
    assert.match(c.fix, /TELLER_CERT/);
    const pool = fakePool({ teller: 0 });
    assert.equal(byId(await oc.goLiveChecks({ pool, env: {} }))["local:teller-cert"], undefined);
    assert.match(pool.seen.join("\n"), /status <> 'SUSPENDED'/);
    certIs({ configured: true, compromised: false, fingerprint: "f", expires_at: null });
    const p2 = fakePool({ teller: 2 });
    assert.equal(byId(await oc.goLiveChecks({ pool: p2, env: {} }))["local:teller-cert"], undefined);
    assert.equal(p2.seen.some((s) => /teller_enrollments/.test(s)), false, "no read when a cert is configured");
  });
});

describe("the databases, PUBLIC_URL and secrets", () => {
  beforeEach(() => certIs({ configured: true, compromised: false, fingerprint: "f", expires_at: null }));

  it("databases: only under the shell; separate ok, shared (or no Per-sistant URL) a warn", async () => {
    const perfin = "postgres://u:p@db.example:5432/perfin";
    assert.equal(byId(await oc.goLiveChecks({ env: { NEON_DATABASE_URL: perfin } }))["local:databases"], undefined, "standalone");
    const ps = fakePool();
    let c = byId(await oc.goLiveChecks({ persistentPool: ps, env: { NEON_DATABASE_URL: perfin, PERSISTENT_DATABASE_URL: "postgres://u:p@db.example:5432/persistent" } }))["local:databases"];
    assert.equal(c.status, "ok");
    c = byId(await oc.goLiveChecks({ persistentPool: ps, env: { NEON_DATABASE_URL: perfin, PERSISTENT_DATABASE_URL: "postgres://other:x@db.example/perfin", ALLOW_SHARED_DATABASE: "true" } }))["local:databases"];
    assert.equal(c.status, "warn");
    assert.match(c.detail, /share one database/);
    c = byId(await oc.goLiveChecks({ persistentPool: ps, env: { NEON_DATABASE_URL: perfin, ALLOW_SHARED_DATABASE: "true" } }))["local:databases"];
    assert.equal(c.status, "warn");
    assert.equal(ps.seen.length, 0, "the Per-sistant pool isn't queried");
  });

  it("PUBLIC_URL: unset info, a usable https origin ok, anything else a warn that never echoes credentials", async () => {
    const check = async (v) => byId(await oc.goLiveChecks({ env: v === undefined ? {} : { PUBLIC_URL: v } }))["local:public-url"];
    assert.equal((await check(undefined)).status, "info");
    const ok = await check("https://app.example.com/");
    assert.equal(ok.status, "ok");
    assert.match(ok.detail, /https:\/\/app\.example\.com\.$/);
    for (const [v, re] of [
      ["http://app.example.com", /https/],
      ["https://admin:hunter2@app.example.com", /user name or password/],
      ["https://app.example.com/perfin", /path, query or fragment/],
      ["https://app.example.com?x=1", /path, query or fragment/],
      ["app.example.com", /valid URL/],
    ]) {
      const c = await check(v);
      assert.equal(c.status, "warn", v);
      assert.match(c.detail, re, v);
      assert.ok(!JSON.stringify(c).includes("hunter2"), "no credentials in the check");
    }
  });

  it("API_KEY: unset or under 24 characters a warn; SHELL_SECRET under 32 a warn, omitted when unset", async () => {
    let c = byId(await oc.goLiveChecks({ env: {} }));
    assert.equal(c["local:api-key"].status, "warn");
    assert.match(c["local:api-key"].detail, /backstop workflows/);
    assert.equal(c["local:shell-secret"], undefined);
    c = byId(await oc.goLiveChecks({ env: { API_KEY: "short-key-123", SHELL_SECRET: "s".repeat(31) } }));
    assert.equal(c["local:api-key"].status, "warn");
    assert.match(c["local:api-key"].detail, /shorter than 24 characters/);
    assert.equal(c["local:shell-secret"].status, "warn");
    c = byId(await oc.goLiveChecks({ env: { API_KEY: "k".repeat(24), SHELL_SECRET: "s".repeat(32) } }));
    assert.equal(c["local:api-key"].status, "ok");
    assert.equal(c["local:shell-secret"].status, "ok");
  });

  it("Plaid: omitted without a client id; the env's secret missing fails; an unknown env warns; sandbox with real connections warns", async () => {
    const plaid = async (env, pool = fakePool()) => byId(await oc.goLiveChecks({ pool, env }))["local:plaid-config"];
    assert.equal(await plaid({}), undefined);
    let c = await plaid({ PLAID_CLIENT_ID: "id", PLAID_ENV: "production", PLAID_SECRET_SANDBOX: "sb" });
    assert.equal(c.status, "fail");
    assert.match(c.detail, /PLAID_SECRET_PROD isn't set/);
    c = await plaid({ PLAID_CLIENT_ID: "id", PLAID_ENV: "live", PLAID_SECRET_SANDBOX: "sb" });
    assert.equal(c.status, "warn");
    c = await plaid({ PLAID_CLIENT_ID: "id", PLAID_SECRET_SANDBOX: "sb" }, fakePool({ plaidGood: 3 }));
    assert.equal(c.status, "warn");
    assert.match(c.detail, /sandbox while 3 Plaid connection/);
    assert.equal((await plaid({ PLAID_CLIENT_ID: "id", PLAID_SECRET_SANDBOX: "sb" }, fakePool({ plaidGood: 0 }))).status, "ok");
    const prodPool = fakePool({ plaidGood: 3 });
    assert.equal((await plaid({ PLAID_CLIENT_ID: "id", PLAID_ENV: "Production", PLAID_SECRET_PROD: "p" }, prodPool)).status, "ok");
    assert.equal(prodPool.seen.some((s) => /plaid_items/.test(s)), false, "production doesn't count items");
  });

  it("the Teller webhook secret: each part at least 16 characters; omitted when unset", async () => {
    const tws = async (v) => byId(await oc.goLiveChecks({ env: v === undefined ? {} : { TELLER_WEBHOOK_SECRET: v } }))["local:teller-webhook-secret"];
    assert.equal(await tws(undefined), undefined);
    assert.equal((await tws("x".repeat(16))).status, "ok");
    assert.equal((await tws(`${"x".repeat(16)}, short`)).status, "warn", "a rotation pair with a short part");
    assert.equal((await tws(" , ")).status, "warn");
  });

  it("no check ever carries a secret's value", async () => {
    const env = {
      API_KEY: "KEYVALUE-abcdefghijklmnopqrstuvwxyz", SHELL_SECRET: "SHELLVALUE-" + "s".repeat(40),
      TELLER_WEBHOOK_SECRET: "TWSVALUE", PLAID_CLIENT_ID: "PLAIDIDVALUE", PLAID_ENV: "production", PLAID_SECRET_PROD: "PLAIDSECRETVALUE",
      PUBLIC_URL: "https://USERVALUE:PASSVALUE@app.example.com/x",
      NEON_DATABASE_URL: "postgres://DBUSER:DBPASS@db.example/perfin", PERSISTENT_DATABASE_URL: "postgres://DBUSER:DBPASS@db.example/perfin",
      ALLOW_SHARED_DATABASE: "true",
    };
    const text = JSON.stringify(await oc.goLiveChecks({ pool: fakePool(), persistentPool: fakePool(), env }));
    for (const v of ["KEYVALUE", "SHELLVALUE", "TWSVALUE", "PLAIDIDVALUE", "PLAIDSECRETVALUE", "USERVALUE", "PASSVALUE", "DBUSER", "DBPASS"]) {
      assert.ok(!text.includes(v), v);
    }
  });

  it("a failing database read omits the counted checks instead of throwing", async () => {
    certIs({ configured: false, compromised: false, fingerprint: null });
    const quiet = console.error; console.error = () => {};
    try {
      const c = byId(await oc.goLiveChecks({ pool: fakePool({ fail: true }), env: { PLAID_CLIENT_ID: "id", PLAID_SECRET_SANDBOX: "sb" } }));
      assert.equal(c["local:teller-cert"], undefined);
      assert.equal(c["local:plaid-config"].status, "ok");
    } finally { console.error = quiet; }
  });
});

describe("the backup record", () => {
  const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

  it("runs without a GitHub token, naming its source; with a token and no SERVER_BACKUPS the GitHub check is the one", async () => {
    let c = await oc.backupCheck(fakePool({ backup: { last_backup_at: hoursAgo(5), last_backup_source: "github" } }), {}, NOW);
    assert.equal(c.id, "local:backup");
    assert.equal(c.status, "ok");
    assert.match(c.detail, /5h ago \(GitHub Actions\)/);
    c = await oc.backupCheck(fakePool({ backup: { last_backup_at: null } }), {}, NOW);
    assert.equal(c.status, "fail");
    assert.match(c.detail, /No backup has been recorded/);
    assert.match(c.fix, /Database Backup workflow/);
    c = await oc.backupCheck(fakePool({ backup: { last_backup_at: hoursAgo(50), last_backup_source: null } }), {}, NOW);
    assert.equal(c.status, "fail");
    assert.match(c.detail, /The last backup is 50h old/);
    assert.equal(await oc.backupCheck(fakePool(), { ...GH }, NOW), null);
    c = await oc.backupCheck(fakePool({ backup: { last_backup_at: hoursAgo(2), last_backup_source: "github" } }), { ...GH, SERVER_BACKUPS: "true" }, NOW);
    assert.equal(c.status, "ok", "any recorded backup counts");
  });

  it("getOperatorChecks carries the go-live and backup checks, and their failures reach data-health", async () => {
    certIs({ configured: true, compromised: false, fingerprint: "f", expires_at: null });
    const r = await oc.getOperatorChecks({ cachedOnly: true, env: { TOKEN_ENCRYPTION_PASSPHRASE: "p" }, pool: fakePool({ backup: { last_backup_at: null } }) });
    const c = byId(r.checks);
    assert.equal(c["local:api-key"].status, "warn");
    assert.equal(c["local:backup"].status, "fail");
    assert.equal(c["local:public-url"].status, "info");
    const issues = oc.toIssues(r).map((i) => i.check);
    assert.ok(issues.includes("local:api-key") && issues.includes("local:backup"));
    assert.ok(!issues.includes("local:public-url"), "info is not an issue");
    assert.match(oc._failingSignature(r.checks), /local:api-key/);
  });

  it("db-backup.yml records the backup last, quietly, and a failed stamp is a warning", () => {
    const yml = read(".github", "workflows", "db-backup.yml");
    const upload = yml.indexOf("- name: Upload encrypted backups");
    const step = yml.indexOf("- name: Record the backup");
    assert.ok(upload > 0 && step > upload, "after both dumps were verified and uploaded");
    const body = yml.slice(step);
    assert.match(body, /DB_URL: \$\{\{ secrets\.NEON_DATABASE_URL \}\}/);
    assert.match(body, /psql "\$DB_URL" -qtAc "UPDATE user_settings SET last_backup_at = now\(\), last_backup_source = 'github' WHERE id = 1" >\/dev\/null 2>&1/);
    assert.match(body, /::warning::/);
    assert.doesNotMatch(body, /echo[^\n]*\$DB_URL/, "the URL is never printed");
    assert.doesNotMatch(body, /exit 1/, "a failed stamp doesn't fail the backup");
  });

  it("backup.sh stamps its source; the migration adds the column; reset-fresh keeps the record", () => {
    assert.match(read("deploy", "vps", "backup.sh"), /last_backup_source = 'server'/);
    assert.match(read("teller", "services", "database.js"), /ADD COLUMN IF NOT EXISTS last_backup_source TEXT/);
    const reset = read("scripts", "reset-fresh.js");
    const keep = reset.indexOf("to_jsonb(s) ->> 'last_backup_at'");
    const del = reset.indexOf('DELETE FROM user_settings"');
    const restore = reset.indexOf("UPDATE user_settings SET last_backup_at = $1, last_backup_source = $2 WHERE id = 1");
    assert.ok(keep > 0 && keep < del && del < restore, "read before the delete, written back after the default row");
  });
});
