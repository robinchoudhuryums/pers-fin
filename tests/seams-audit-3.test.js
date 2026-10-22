// ============================================================================
// Seams & Invariants audit #3 (Oct 2026) — Perfin-side pins
// ============================================================================
//  X1  WebAuthn credential ids stored as the authenticator's base64url id
//      (registration double-encoded them, so no login ever matched) + the
//      one-shot migration repair of double-encoded rows
//  C1  GET /api/items lists only linked items (manual accounts used to group
//      into a null "plaid" item whose buttons answered 400 / 500)
//  O2  the background reconcile's error is a fixed sentence (INV-127)
//  S1  one reconcile at a time: either route 409s while one runs, a
//      synchronous run never writes the job slot, the weekly heal skips
//  S2  the insights seasonal window's oldest month is whole
//  S3  rename rules run after a single-Item Plaid sync (exchanges, update)
//  S4  recordSyncResult writes are serialized — two at once keep both
//  S5  GET /api/tax-deductions defaults to the APP_TIMEZONE year
//  S6  goal milestones read progress through deriveGoalProgress
//  X3  the in-process digest recipient is the first VALID address in the chain
//  C4  "since you last looked" balance rows carry source_id
//  X6  the shutdown error-log flush waits for a flush already in flight
//  INV-104  standalone API key compare is a digest compare
// The database-backed half is tests/contract/seams3.contract.test.js.
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

const dbModule = require("../teller/services/database");
const plaidClientModule = require("../teller/services/plaid-client");
const ids = require("../teller/services/webauthn-ids");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error("timed out waiting");
}

// ---------------------------------------------------------------------------
describe("X1 — WebAuthn credential ids", () => {
  const realId = Buffer.from("0123456789abcdef0123456789abcdef", "hex").toString("base64url");
  const doubled = Buffer.from(realId).toString("base64url");

  it("legacyCredentialId recovers the real id from a double-encoded row and leaves a real id alone", () => {
    assert.equal(ids.legacyCredentialId(doubled), realId);
    assert.equal(ids.legacyCredentialId(realId), null);
    assert.equal(ids.legacyCredentialId(null), null);
    assert.equal(ids.legacyCredentialId("short"), null);
    for (let i = 0; i < 200; i++) {
      const r = require("crypto").randomBytes(16 + (i % 48)).toString("base64url");
      assert.equal(ids.legacyCredentialId(r), null, "a random real id is never mistaken for a legacy one");
    }
  });

  it("repairCredentialIds rewrites a double-encoded row, and drops one whose real id already exists", async () => {
    const other = Buffer.from("ffeeddccbbaa99887766554433221100", "hex").toString("base64url");
    const rows = [
      { id: 1, credential_id: doubled },
      { id: 2, credential_id: Buffer.from(other).toString("base64url") },
      { id: 3, credential_id: other },
    ];
    const client = {
      query: async (sql, params) => {
        if (/^SELECT id, credential_id/.test(sql)) return { rows: rows.map((r) => ({ ...r })) };
        if (/^SELECT 1 FROM webauthn_credentials/.test(sql)) return { rows: rows.filter((r) => r.credential_id === params[0]) };
        if (/^DELETE/.test(sql)) { rows.splice(rows.findIndex((r) => r.id === params[0]), 1); return {}; }
        if (/^UPDATE/.test(sql)) { rows.find((r) => r.id === params[1]).credential_id = params[0]; return {}; }
        throw new Error("unexpected " + sql);
      },
    };
    assert.equal(await ids.repairCredentialIds(client), 2);
    assert.deepEqual(rows.map((r) => [r.id, r.credential_id]), [[1, realId], [3, other]]);
    assert.equal(await ids.repairCredentialIds(client), 0, "idempotent");
  });

  it("registration stores credential.id as given; the migration runs the repair", () => {
    const login = read("teller", "pages", "login.js");
    assert.match(login, /const credentialIdBase64 = credential\.id;/);
    assert.doesNotMatch(login, /Buffer\.from\(credential\.id\)\.toString\("base64url"\)/);
    assert.match(read("teller", "services", "database.js"), /require\("\.\/webauthn-ids"\)\.repairCredentialIds\(client\)/);
  });
});

// ---------------------------------------------------------------------------
describe("Bank sync seams (C1, O2, S1, S3, S4)", () => {
  const originalQuery = dbModule.pool.query;
  const originalGetPlaidClient = plaidClientModule.getPlaidClient;
  let enr, gate, calls;
  before(() => {
    plaidClientModule.getPlaidClient = () => null;
    delete require.cache[require.resolve("../teller/routes/enrollments")];
    delete require.cache[require.resolve("../teller/routes/investments")];
    enr = require("../teller/routes/enrollments");
  });
  after(() => {
    plaidClientModule.getPlaidClient = originalGetPlaidClient;
    dbModule.pool.query = originalQuery;
  });
  beforeEach(() => {
    calls = [];
    gate = null;
    dbModule.pool.query = async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM teller_enrollments/.test(sql)) {
        if (gate) await gate.promise;
        return { rows: [] };
      }
      if (/SELECT last_sync_result FROM user_settings/.test(sql)) return { rows: [{ last_sync_result: null }] };
      return { rows: [], rowCount: 0 };
    };
  });
  const app = () => { const a = express(); a.use(express.json()); a.use(enr); return a; };
  const hold = () => { let release; const promise = new Promise((r) => { release = r; }); gate = { promise }; return () => { gate = null; release(); }; };

  it("C1: GET /api/items leaves manual accounts out", async () => {
    await supertest(app()).get("/api/items");
    const q = calls.find((c) => /FROM linked_accounts la/.test(c.sql) && /GROUP BY te\.id/.test(c.sql));
    assert.ok(q, "the items query ran");
    assert.match(q.sql, /WHERE la\.teller_enrollment_id IS NOT NULL OR la\.plaid_item_id IS NOT NULL/);
  });

  it("S1: while a background reconcile runs, both a synchronous and a background start are 409", async () => {
    const release = hold();
    const a = app();
    try {
      const start = await supertest(a).post("/api/sync/reconcile").send({ provider: "teller", background: true }).expect(202);
      await waitFor(async () => enr._bgJobs.reconcile.phase === "Re-fetching Teller transactions");
      const sync = await supertest(a).post("/api/sync/reconcile").send({ provider: "all" }).timeout(1000).expect(409);
      assert.equal(sync.body.id, start.body.id);
      await supertest(a).post("/api/sync/reconcile").send({ background: true }).timeout(1000).expect(409);
      assert.equal(enr.reconcileBusy(), true);
    } finally { release(); }
    await waitFor(async () => !enr._bgJobs.reconcile.running);
    assert.equal(enr.reconcileBusy(), false);
  });

  it("S1: a synchronous reconcile holds the guard and never writes the job slot", async () => {
    const before = { ...enr._bgJobs.reconcile };
    const release = hold();
    const a = app();
    const p = supertest(a).post("/api/sync/reconcile").send({ provider: "teller" }).then((r) => r);
    try {
      await waitFor(async () => enr.reconcileBusy());
      const busy = await supertest(a).post("/api/sync/reconcile").send({ background: true }).timeout(1000).expect(409);
      assert.equal(busy.body.id, null, "not a background job — no id to follow");
    } finally { release(); }
    assert.equal((await p).status, 200);
    assert.deepEqual(enr._bgJobs.reconcile, before, "the slot is untouched (no 'Finalizing' left behind)");
  });

  it("S1: the weekly in-process heal skips while a reconcile runs, and holds the guard itself", () => {
    const src = read("teller", "startup.js");
    const tick = src.slice(src.indexOf('jobHealth.tick("self-healing-reconcile")'));
    assert.ok(tick.indexOf("if (reconcileBusy()) return;") < tick.indexOf("withReconcileGuard(() => reconcileTeller(90))"));
  });

  it("O2: the background reconcile's error is a fixed sentence; errors[] names who failed, never the text", async () => {
    dbModule.pool.query = async (sql) => {
      if (/FROM teller_enrollments/.test(sql)) throw new Error('Teller API error 500: {"secret":"body"}');
      if (/SELECT last_sync_result FROM user_settings/.test(sql)) return { rows: [{ last_sync_result: null }] };
      return { rows: [], rowCount: 0 };
    };
    await supertest(app()).post("/api/sync/reconcile").send({ provider: "teller", background: true }).expect(202);
    await waitFor(async () => !enr._bgJobs.reconcile.running);
    const st = enr._bgJobs.reconcile;
    assert.match(st.error, /^1 item\(s\) failed — see Settings → Sync Health\.$/);
    assert.doesNotMatch(JSON.stringify(st.errors), /secret/);
    assert.deepEqual(st.errors, [{ provider: "teller", institution: null }]);
  });

  it("S4: two recordSyncResult calls at once keep both providers", async () => {
    let stored = null;
    dbModule.pool.query = async (sql, params) => {
      if (/SELECT last_sync_result FROM user_settings/.test(sql)) {
        const snap = stored;
        await new Promise((r) => setTimeout(r, 10)); // both read before either writes, unless serialized
        return { rows: [{ last_sync_result: snap }] };
      }
      if (/UPDATE user_settings SET last_sync_result/.test(sql)) { stored = JSON.parse(params[0]); return { rowCount: 1 }; }
      return { rows: [] };
    };
    await Promise.all([
      enr.recordSyncResult([{ provider: "teller_txn", result: { errors: [{ institution: "Chase", error: "decryption_failed" }] } }]),
      enr.recordSyncResult([{ provider: "plaid_balance", result: { errors: [] } }]),
    ]);
    assert.deepEqual(Object.keys(stored.providers).sort(), ["plaid_balance", "teller_txn"]);
    assert.equal(stored.errors.length, 1);
  });

  it("S3: the link exchanges and update-complete apply rename rules to the rows they inserted", () => {
    const src = read("teller", "routes", "investments.js");
    assert.match(src, /async function renameNewRows\(added\) \{\s*if \(!\(added > 0\)\) return;/);
    assert.equal((src.match(/await renameNewRows\(syncResult\.added\);/g) || []).length, 2, "exchange-transactions + hosted-link-complete");
    assert.match(src, /const sync = await syncPlaidItemTransactions\(client, item\.id, item\.access_token\);\s*await renameNewRows\(sync\.added\);/);
  });
});

// ---------------------------------------------------------------------------
describe("Analytics / AI seams (S2, S5, S6)", () => {
  it("S2: the seasonal window starts on the 1st, 24 months before this month", () => {
    const src = read("teller", "routes", "insights.js");
    assert.match(src, /"t\.date >= \$1::date - INTERVAL '24 months' AND t\.date < \$1::date"/);
    assert.doesNotMatch(src, /CURRENT_DATE - INTERVAL '24 months'/);
  });

  it("S5: GET /api/tax-deductions defaults to the APP_TIMEZONE year", () => {
    const src = read("teller", "routes", "insights.js");
    const route = src.slice(src.indexOf('router.get("/api/tax-deductions"'));
    assert.match(route, /parseInt\(req\.query\.year\) \|\| parseInt\(todayStr\(\)\.slice\(0, 4\), 10\)/);
  });

  it("S6: goal milestones use deriveGoalProgress (a balance-less funding account falls back to the stored value)", () => {
    const src = read("teller", "startup.js");
    const job = src.slice(src.indexOf('jobHealth.tick("goal-milestones")'), src.indexOf('jobHealth.result("goal-milestones", { ok: true })'));
    assert.match(job, /deriveGoalProgress\(g\)\.current \/ target/);
    assert.doesNotMatch(job, /GREATEST\(0, COALESCE\(la\.available_balance/);
    const { deriveGoalProgress } = require("../teller/routes/goals");
    assert.equal(deriveGoalProgress({ current_amount: 400, funding_account_id: 7, funding_account_balance: null }).current, 400);
  });
});

// ---------------------------------------------------------------------------
describe("Cross-app seams (X3, C4, INV-104)", () => {
  const persistent = require("../teller/routes/persistent");
  const saved = { from: process.env.SMTP_FROM, user: process.env.SMTP_USER };
  after(() => {
    for (const [k, v] of [["SMTP_FROM", saved.from], ["SMTP_USER", saved.user]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    persistent.setEmbeddedPersistentPool(null);
  });
  function pp(recipient) {
    const inserts = [];
    return { inserts, query: async (sql, params) => {
      if (/SELECT perfin_webhook_recipient/.test(sql)) return { rows: [{ perfin_webhook_recipient: recipient }] };
      if (/INSERT INTO emails/.test(sql)) inserts.push({ sql, params });
      return { rows: [] };
    } };
  }

  it("X3: a display-form SMTP_FROM is skipped for a valid SMTP_USER", async () => {
    process.env.SMTP_FROM = "Perfin <me@example.com>";
    process.env.SMTP_USER = "me@example.com";
    const pool = pp(null);
    persistent.setEmbeddedPersistentPool(pool);
    const r = await persistent.sendPerSistantWebhook("weekly_summary", { subject: "s", plain_text: "b" });
    assert.equal(r.sent, true);
    assert.equal(r.recipient, "me@example.com");
    assert.match(pool.inserts[0].sql, /'scheduled'/);
  });

  it("X3: with no valid address in the chain it is still a draft, reported not sent", async () => {
    process.env.SMTP_FROM = "Perfin <me@example.com>";
    delete process.env.SMTP_USER;
    const pool = pp(null);
    persistent.setEmbeddedPersistentPool(pool);
    const r = await persistent.sendPerSistantWebhook("daily_summary", { subject: "s", plain_text: "b" });
    assert.deepEqual([r.sent, r.stored, r.reason], [false, "draft", "invalid_recipient"]);
  });

  it("C4: the whats-new balance rows carry source_id", () => {
    assert.match(read("teller", "routes", "whats-new.js"), /source_id: r\.source_id,/);
  });

  it("INV-104: standalone Perfin's x-api-key compare is a fixed-length digest compare", () => {
    const src = read("teller", "server.js");
    assert.match(src, /crypto\.timingSafeEqual\(digest\(provided\), digest\(API_KEY\)\)/);
  });
});

// ---------------------------------------------------------------------------
describe("X6 — the shutdown flush drains a flush in flight", () => {
  const errorLog = require("../teller/services/error-log");
  after(() => errorLog._reset());

  it("drain: true writes what was captured during an in-flight flush; a plain flush would skip it", async () => {
    errorLog._reset();
    let release;
    const slow = new Promise((r) => { release = r; });
    const written = [];
    errorLog._state.pool = { query: async (sql, params) => {
      if (/INSERT INTO app_errors/.test(sql)) {
        if (written.length === 0) await slow;
        written.push(params[2]);
        return { rows: [{ inserted: false, reopened: false }] };
      }
      return { rows: [], rowCount: 0 };
    } };
    errorLog.capture(["first error"], { source: "perfin" });
    const periodic = errorLog.flush({ notify: false });
    errorLog.capture(["captured during the flush"], { source: "perfin" });
    assert.deepEqual(await errorLog.flush({ notify: false }), { written: 0 }, "a plain flush is still a no-op while one runs");
    const drained = errorLog.flush({ notify: false, drain: true });
    release();
    await periodic;
    assert.equal((await drained).written, 1);
    assert.deepEqual(written, ["first error", "captured during the flush"]);
    assert.match(read("shell", "index.js"), /await errorLog\.flush\(\{ notify: false, drain: true \}\)/);
  });
});
