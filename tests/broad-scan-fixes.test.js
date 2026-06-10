// ============================================================================
// Broad-scan implementation regression tests (F1-F5, 2026-06 scan)
// ============================================================================
// Pins the fixes from the June 2026 broad-scan session:
//   F1 — nightly encrypted DB backup workflow exists and covers both DBs
//   F2 — missing TOKEN_ENCRYPTION_PASSPHRASE is fatal at boot (with escape hatch)
//   F3 — compromised-cert fingerprint check on the loaded Teller cert
//   F4 — job heartbeats + missed-job watchdog (services/job-health.js)
//   F5 — budget alerts dedupe via sentRecently (one per tag per 24h)
// ============================================================================

const { describe, it, before, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const ROOT = path.join(__dirname, "..");

// ---------------------------------------------------------------------------
// F1 — backup workflow
// ---------------------------------------------------------------------------
describe("F1 — db-backup workflow", () => {
  const wfPath = path.join(ROOT, ".github", "workflows", "db-backup.yml");

  it("exists and runs on a schedule", () => {
    const src = fs.readFileSync(wfPath, "utf8");
    assert.match(src, /schedule:/, "backup must run on a cron schedule");
    assert.match(src, /workflow_dispatch/, "backup must support manual dispatch");
  });

  it("dumps both databases and encrypts before upload", () => {
    const src = fs.readFileSync(wfPath, "utf8");
    assert.match(src, /pg_dump "\$DB_URL"/, "must use pg_dump");
    assert.match(src, /NEON_DATABASE_URL/, "must back up Perfin's DB");
    assert.match(src, /PERSISTENT_DATABASE_URL/, "must back up Per-sistant's DB");
    assert.match(src, /openssl enc -aes-256-cbc -pbkdf2/, "dumps must be encrypted");
    assert.match(src, /BACKUP_ENCRYPTION_PASSPHRASE/, "encryption keyed by dedicated secret");
    assert.match(src, /retention-days:\s*90/, "artifacts must have 90-day retention");
    // Plaintext dump must be removed before the artifact upload step.
    assert.match(src, /rm "perfin-\$DATE\.dump"/, "plaintext perfin dump must be deleted");
    assert.match(src, /path:\s*'\*\.dump\.enc'/, "only encrypted files are uploaded");
  });
});

// ---------------------------------------------------------------------------
// F2 — fail-fast on missing TOKEN_ENCRYPTION_PASSPHRASE
// ---------------------------------------------------------------------------
describe("F2 — TOKEN_ENCRYPTION_PASSPHRASE is fatal at boot", () => {
  it("database.js exits when the passphrase is missing, with an explicit escape hatch", () => {
    const src = fs.readFileSync(path.join(ROOT, "teller", "services", "database.js"), "utf8");
    // The missing-passphrase branch must exit, not warn-and-continue …
    const block = src.match(/if \(!ENCRYPTION_PASSPHRASE\) \{[\s\S]*?\n\}/);
    assert.ok(block, "missing-passphrase guard must exist");
    assert.match(block[0], /process\.exit\(1\)/, "missing passphrase must be fatal");
    // … unless the operator explicitly opted into booting without it.
    assert.match(block[0], /ALLOW_MISSING_TOKEN_PASSPHRASE/, "escape hatch must exist for local debug");
  });
});

// ---------------------------------------------------------------------------
// F3 — compromised-cert fingerprint check
// ---------------------------------------------------------------------------
describe("F3 — compromised Teller cert detection", () => {
  const { certFingerprintSha256, COMPROMISED_CERT_SHA256 } = require("../teller/services/teller-api");

  it("computes the SHA-256 of the DER bytes inside a PEM certificate block", () => {
    const der = Buffer.from("not-a-real-cert-but-der-bytes-for-hashing");
    const pem = "-----BEGIN CERTIFICATE-----\n" +
      der.toString("base64").match(/.{1,64}/g).join("\n") +
      "\n-----END CERTIFICATE-----\n";
    const expected = crypto.createHash("sha256").update(der).digest("hex");
    assert.equal(certFingerprintSha256(pem), expected);
    assert.equal(certFingerprintSha256(Buffer.from(pem)), expected, "accepts Buffers too");
  });

  it("returns null for non-PEM input", () => {
    assert.equal(certFingerprintSha256("hello"), null);
    assert.equal(certFingerprintSha256(""), null);
  });

  it("pins the known-compromised fingerprint and checks it at load time", () => {
    assert.match(COMPROMISED_CERT_SHA256, /^[0-9a-f]{64}$/, "fingerprint is lowercase sha256 hex");
    const src = fs.readFileSync(path.join(ROOT, "teller", "services", "teller-api.js"), "utf8");
    assert.match(src, /certFingerprintSha256\(cert\)\s*===\s*COMPROMISED_CERT_SHA256/,
      "getTlsAgent must compare the loaded cert against the compromised fingerprint");
  });
});

// ---------------------------------------------------------------------------
// F4 — job heartbeats + missed-job watchdog
// ---------------------------------------------------------------------------
describe("F4 — job-health watchdog", () => {
  const jobHealth = require("../teller/services/job-health");
  const HOUR = 60 * 60 * 1000;

  beforeEach(() => jobHealth._memoryTicks.clear());

  function mockPool({ rows = [] } = {}) {
    const calls = [];
    return {
      calls,
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (/^SELECT job_name/i.test(sql.trim())) return { rows };
        return { rows: [] };
      },
    };
  }

  it("flush persists in-memory ticks via UPSERT", async () => {
    jobHealth.tick("bank-auto-sync");
    const pool = mockPool();
    await jobHealth.flush(pool);
    const upserts = pool.calls.filter(c => /INSERT INTO job_runs/i.test(c.sql));
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].params[0], "bank-auto-sync");
    assert.match(upserts[0].sql, /ON CONFLICT \(job_name\)/i);
    assert.match(upserts[0].sql, /GREATEST\(job_runs\.last_run_at, EXCLUDED\.last_run_at\)/i,
      "a stale flush must never move a heartbeat backwards");
  });

  it("flags a job stale past its threshold and notifies once per signature", async () => {
    const staleAt = new Date(Date.now() - 50 * HOUR).toISOString();
    const rows = [{ job_name: "bank-auto-sync", last_run_at: staleAt, last_error: null }];
    const pool = mockPool({ rows });
    const sent = [];
    const sendToAll = async (p) => sent.push(p);

    const { missed } = await jobHealth.checkMissedJobs(pool, { sendToAll });
    assert.equal(missed.length, 1);
    assert.equal(missed[0].job, "bank-auto-sync");
    assert.ok(missed[0].stale_hours >= 49);
    assert.equal(sent.length, 1, "first detection must notify");
    assert.equal(sent[0].tag, "jobs-missed");

    // Same outage on the next pass: signature unchanged → no second notify.
    const rows2 = [
      { job_name: "bank-auto-sync", last_run_at: staleAt, last_error: null },
      { job_name: "_watchdog", last_run_at: new Date().toISOString(), last_error: "bank-auto-sync" },
    ];
    const pool2 = mockPool({ rows: rows2 });
    const sent2 = [];
    const r2 = await jobHealth.checkMissedJobs(pool2, { sendToAll: async (p) => sent2.push(p) });
    assert.equal(r2.missed.length, 1, "still missed");
    assert.equal(sent2.length, 0, "unchanged signature must not re-notify");
  });

  it("does not alarm on fresh heartbeats or never-seen jobs", async () => {
    const rows = [{ job_name: "bank-auto-sync", last_run_at: new Date().toISOString(), last_error: null }];
    const pool = mockPool({ rows });
    const sent = [];
    const { missed } = await jobHealth.checkMissedJobs(pool, { sendToAll: async (p) => sent.push(p) });
    assert.equal(missed.length, 0, "fresh rows + absent rows are both fine");
    assert.equal(sent.length, 0);
  });

  it("overnight free-tier sleep stays under the alarm threshold", async () => {
    // 12h gap = a normal night asleep; threshold is max(4×interval, 36h).
    const rows = [{ job_name: "net-worth-snapshot", last_run_at: new Date(Date.now() - 12 * HOUR).toISOString(), last_error: null }];
    const { missed } = await jobHealth.checkMissedJobs(mockPool({ rows }), {});
    assert.equal(missed.length, 0, "12h staleness must not alarm");
  });

  it("startup.js ticks every scheduled job before its gates", () => {
    const src = fs.readFileSync(path.join(ROOT, "teller", "startup.js"), "utf8");
    for (const job of Object.keys(jobHealth.JOB_INTERVALS_MS)) {
      assert.ok(src.includes(`jobHealth.tick("${job}")`), `startup.js must tick "${job}"`);
    }
    assert.match(src, /checkMissedJobs/, "startup.js must run the watchdog");
    // Ticks are in-memory only — the Neon idle-gate must stay intact, so no
    // tick may be implemented as a direct DB write inside the interval.
    assert.match(src, /jobHealth\.tick\("sheets-auto-sync"\);\n\s*if \(!isUserActive\(\)\) return;/,
      "tick must come BEFORE the activity gate (heartbeat = scheduler liveness)");
  });
});

// ---------------------------------------------------------------------------
// F5 — budget-alert dedup
// ---------------------------------------------------------------------------
describe("F5 — budget alert dedup (sentRecently)", () => {
  let dbModule, originalPoolQuery, notifications;

  before(() => {
    dbModule = require("../teller/services/database");
    originalPoolQuery = dbModule.pool.query;
    notifications = require("../teller/routes/notifications");
  });

  afterEach(() => {
    dbModule.pool.query = originalPoolQuery;
  });

  it("returns true when a notification with the tag exists in the window", async () => {
    let captured;
    dbModule.pool.query = async (sql, params) => {
      captured = { sql, params };
      return { rows: [{ "?column?": 1 }] };
    };
    assert.equal(await notifications.sentRecently("budget-over-dining", 24), true);
    assert.match(captured.sql, /FROM notification_log/i);
    assert.match(captured.sql, /type = \$1/i, "dedup keys on the type column (sendToAll stores payload.tag there)");
    assert.deepEqual(captured.params, ["budget-over-dining", 24]);
  });

  it("returns false when nothing recent exists", async () => {
    dbModule.pool.query = async () => ({ rows: [] });
    assert.equal(await notifications.sentRecently("budget-warn-dining", 24), false);
  });

  it("fails open on a query error (missed dedup beats suppressed alert)", async () => {
    dbModule.pool.query = async () => { throw new Error("boom"); };
    assert.equal(await notifications.sentRecently("budget-over-dining", 24), false);
  });

  it("startup.js gates both budget-alert severities through sentRecently", () => {
    const src = fs.readFileSync(path.join(ROOT, "teller", "startup.js"), "utf8");
    assert.match(src, /sendToAll, sentRecently\s*\}\s*=\s*require\("\.\/routes\/notifications"\)/,
      "budget alert job must import sentRecently");
    const overBlock = src.match(/tag = "budget-over-[\s\S]{0,200}/);
    const warnBlock = src.match(/tag = "budget-warn-[\s\S]{0,200}/);
    assert.ok(overBlock && /sentRecently\(tag, 24\)/.test(overBlock[0]), "over-budget path must dedupe");
    assert.ok(warnBlock && /sentRecently\(tag, 24\)/.test(warnBlock[0]), "warning path must dedupe");
  });
});
