// ============================================================================
// Roadmap T2.1 — W5: Teller webhook events
// ============================================================================
//  - the handler: transactions.processed syncs the enrollment the event names
//    (payload enrollment_id, else the enrollments owning its account ids) then
//    the shared post-sync steps; enrollment.disconnected marks a GOOD
//    enrollment DISCONNECTED with ONE notification (reason in words);
//    webhook.test is done; everything else, unknown / suspended enrollments and
//    an empty event are ignored; a failed sync fails the event after the
//    post-sync steps
//  - syncTellerEnrollment(id) with the REAL Teller sync engine (stubbed Teller
//    client + mock pool): only that enrollment, its last_synced_at stamped only
//    after a clean sync, nothing global, not_found, coalescing; and
//    syncAllEnrollments unchanged through syncOneTellerEnrollment (counts,
//    decryption failure, DISCONNECTED on a 401 everywhere)
//  - the verifier's reason + account ids (never the transactions)
// The database-backed half is tests/contract/webhooks-w5.contract.test.js.

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const dbModule = require("../teller/services/database");
const tellerApi = require("../teller/services/teller-api");
const { createTellerEventHandler, reasonText } = require("../teller/routes/teller-webhook-events");
const { createTellerVerifier } = require("../teller/services/webhook-verify");

const originalQuery = dbModule.pool.query;
const originalTellerRequest = tellerApi.tellerRequest;

let S;
let enr;
before(() => {
  tellerApi.tellerRequest = (endpoint, token, opts) => S.teller(endpoint, token, opts);
  delete require.cache[require.resolve("../teller/routes/enrollments")];
  enr = require("../teller/routes/enrollments");
});
after(() => {
  tellerApi.tellerRequest = originalTellerRequest;
  dbModule.pool.query = originalQuery;
});
afterEach(() => { dbModule.pool.query = originalQuery; });

// ---------------------------------------------------------------------------
describe("W5 — the Teller event handler", () => {
  function handlerWith({ rows = [{ id: 7, institution_name: "Chase", status: "GOOD" }], updated = [{ id: 7 }], results = {} } = {}) {
    const calls = { db: [], sync: [], post: [], notify: [] };
    const h = createTellerEventHandler({
      db: { query: async (sql, params) => {
        calls.db.push({ sql, params });
        if (/^UPDATE teller_enrollments/.test(sql)) return { rows: updated };
        return { rows };
      } },
      syncEnrollment: async (id) => { calls.sync.push(id); return results[id] || { ok: true, added: 2, failed: false }; },
      postSync: async (n) => { calls.post.push(n); },
      notify: async (n) => { calls.notify.push(n); },
    });
    return { h, calls };
  }

  it("transactions.processed with an enrollment id syncs it, runs the post-sync steps, and is done", async () => {
    const { h, calls } = handlerWith();
    assert.deepEqual(await h({ type: "transactions.processed", subject: "enr_7", account_ids: [] }), { status: "done" });
    assert.match(calls.db[0].sql, /FROM teller_enrollments WHERE enrollment_id = \$1 AND status <> 'SUSPENDED'/);
    assert.deepEqual(calls.db[0].params, ["enr_7"]);
    assert.deepEqual(calls.sync, [7]);
    assert.deepEqual(calls.post, [2]);
  });

  it("without an enrollment id, the enrollments owning the transactions' accounts are synced", async () => {
    const { h, calls } = handlerWith({ rows: [{ id: 7, status: "GOOD" }, { id: 9, status: "DISCONNECTED" }] });
    assert.deepEqual(await h({ type: "transactions.processed", subject: null, account_ids: ["acc_1", "acc_2"] }), { status: "done" });
    assert.match(calls.db[0].sql, /JOIN teller_enrollments te ON te\.id = la\.teller_enrollment_id/);
    assert.match(calls.db[0].sql, /la\.account_id = ANY\(\$1::text\[\]\) AND te\.status <> 'SUSPENDED'/);
    assert.deepEqual(calls.db[0].params, [["acc_1", "acc_2"]]);
    assert.deepEqual(calls.sync, [7, 9]);
    assert.deepEqual(calls.post, [4], "one post-sync pass over the combined count");
  });

  it("nothing to find, or an enrollment gone while queued, is ignored", async () => {
    let t = handlerWith({ rows: [] });
    assert.deepEqual(await t.h({ type: "transactions.processed", subject: "enr_x" }), { status: "ignored" });
    t = handlerWith();
    assert.deepEqual(await t.h({ type: "transactions.processed", subject: null, account_ids: [] }), { status: "ignored" });
    assert.equal(t.calls.db.length, 0);
    t = handlerWith({ results: { 7: { ok: false, error: "not_found" } } });
    assert.deepEqual(await t.h({ type: "transactions.processed", subject: "enr_7" }), { status: "ignored" });
    assert.deepEqual(t.calls.post, []);
  });

  it("a failed sync still names + checks what it added, then fails the event", async () => {
    const { h, calls } = handlerWith({ results: { 7: { ok: true, added: 1, failed: true } } });
    await assert.rejects(() => h({ type: "transactions.processed", subject: "enr_7" }), /Teller enrollment sync failed/);
    assert.deepEqual(calls.post, [1]);
  });

  it("enrollment.disconnected marks a GOOD enrollment DISCONNECTED and notifies once, with the reason in words", async () => {
    const { h, calls } = handlerWith();
    assert.deepEqual(await h({ type: "enrollment.disconnected", subject: "enr_7", reason: "disconnected.credentials_invalid" }), { status: "done" });
    const upd = calls.db.find((c) => /^UPDATE/.test(c.sql));
    assert.match(upd.sql, /SET status = 'DISCONNECTED', updated_at = now\(\) WHERE id = \$1 AND status = 'GOOD' RETURNING id/);
    assert.equal(calls.notify.length, 1);
    assert.equal(calls.notify[0].tag, "teller-disconnected-7");
    assert.equal(calls.notify[0].data.url, "/accounts");
    assert.match(calls.notify[0].body, /Chase was disconnected at Teller — the bank login changed\. Open Accounts and connect it again with Teller Connect\./);
  });

  it("an enrollment already disconnected, a lost race, an unknown one and no subject send nothing", async () => {
    let t = handlerWith({ rows: [{ id: 7, institution_name: "Chase", status: "DISCONNECTED" }] });
    assert.deepEqual(await t.h({ type: "enrollment.disconnected", subject: "enr_7" }), { status: "done" });
    assert.equal(t.calls.db.filter((c) => /^UPDATE/.test(c.sql)).length, 0);
    t = handlerWith({ updated: [] });
    assert.deepEqual(await t.h({ type: "enrollment.disconnected", subject: "enr_7" }), { status: "done" });
    assert.equal(t.calls.notify.length, 0);
    t = handlerWith({ rows: [] });
    assert.deepEqual(await t.h({ type: "enrollment.disconnected", subject: "enr_x" }), { status: "ignored" });
    assert.deepEqual(await t.h({ type: "enrollment.disconnected", subject: null }), { status: "ignored" });
    assert.equal(t.calls.notify.length, 0);
  });

  it("webhook.test is done; other types are ignored", async () => {
    const { h, calls } = handlerWith();
    assert.deepEqual(await h({ type: "webhook.test" }), { status: "done" });
    for (const type of ["account.number_verification.processed", "something.new", undefined]) {
      assert.deepEqual(await h({ type }), { status: "ignored" });
    }
    assert.equal(calls.db.length, 0);
  });

  it("disconnect reasons in words", () => {
    assert.equal(reasonText("disconnected.account_locked"), "the bank account is locked");
    assert.equal(reasonText("disconnected.user_action.mfa_required"), "the bank needs you to sign in again");
    assert.equal(reasonText("disconnected.enrollment_inactive"), "the connection was inactive too long");
    assert.equal(reasonText("disconnected"), null);
    assert.equal(reasonText(null), null);
  });

  it("the router's default Teller handler is this one", () => {
    assert.match(read("teller/routes/webhooks.js"), /teller: \(event, ctx\) => require\("\.\/teller-webhook-events"\)\.handleTellerEvent\(event, ctx\)/);
  });
});

// ---------------------------------------------------------------------------
describe("W5 — syncTellerEnrollment with the real Teller sync engine", () => {
  const ENR = { id: 7, enrollment_id: "enr_7", institution_name: "Chase", access_token: "tok_7", last_synced_txn_date: null, status: "GOOD" };
  const tx = (id) => ({ id, account_id: "acc_1", amount: "-12.50", date: "2026-10-20", description: "Coffee " + id, status: "posted", details: {} });
  function setup({ enrollments = [ENR], txns = [tx("t1")], teller } = {}) {
    S = { log: [], inserted: new Set() };
    S.teller = teller || (async (endpoint) => (/from_id/.test(endpoint) ? [] : (/\/transactions/.test(endpoint) ? txns : [])));
    dbModule.pool.query = async (sql, params = []) => {
      S.log.push({ sql, params });
      if (sql.includes("FROM teller_enrollments te") && sql.includes("status != 'SUSPENDED'")) {
        if (sql.includes("AND te.id = $2")) return { rows: enrollments.filter((e) => e.id === params[1]) };
        return { rows: enrollments };
      }
      if (sql.includes("FROM linked_accounts WHERE teller_enrollment_id")) return { rows: [{ account_id: "acc_1" }] };
      if (sql.includes("INSERT INTO transactions") && sql.includes("RETURNING (xmax = 0)")) {
        const fresh = !S.inserted.has(params[1]); S.inserted.add(params[1]);
        return { rows: [{ inserted: fresh }] };
      }
      return { rows: [], rowCount: 0 };
    };
  }
  const ran = (re) => S.log.filter((q) => re.test(q.sql));
  const quiet = async (fn) => { const e = console.error, l = console.log; console.error = () => {}; console.log = () => {}; try { return await fn(); } finally { console.error = e; console.log = l; } };

  it("syncs only that enrollment, stamps its last_synced_at, and writes nothing global", async () => {
    setup({ enrollments: [ENR, { ...ENR, id: 8, enrollment_id: "enr_8", access_token: "tok_8" }] });
    const r = await quiet(() => enr.syncTellerEnrollment(7));
    assert.equal(r.ok, true);
    assert.equal(r.runs, 1);
    assert.equal(r.added, 1);
    assert.equal(r.failed, false);
    const sel = ran(/FROM teller_enrollments te/)[0];
    assert.match(sel.sql, /perfin_try_decrypt\(te\.access_token_enc, \$1\)/);
    assert.match(sel.sql, /WHERE te\.status != 'SUSPENDED' AND te\.id = \$2/);
    assert.deepEqual(ran(/SET last_synced_at = now\(\) WHERE id = \$1/).map((q) => q.params), [[7]]);
    assert.equal(ran(/last_txn_sync_at|last_sync_result|last_anomaly_check_at/).length, 0);
  });

  it("not_found for an unknown or suspended enrollment", async () => {
    setup();
    assert.deepEqual(await enr.syncTellerEnrollment(99), { ok: false, error: "not_found" });
  });

  it("a partial failure is reported and not stamped", async () => {
    setup({ teller: async () => { throw Object.assign(new Error("teller 500"), { status: 500 }); } });
    const r = await quiet(() => enr.syncTellerEnrollment(7));
    assert.equal(ran(/SET last_synced_at/).length, 0);
    assert.ok(r.errors.length > 0);
  });

  it("requests during a run share it and make it go round exactly once more", async () => {
    let open;
    const gate = new Promise((res) => { open = res; });
    let calls = 0;
    setup({ teller: async (endpoint) => {
      if (/from_id/.test(endpoint)) return [];
      calls++;
      if (calls === 1) await gate;
      return [tx("t" + calls)];
    } });
    const a = quiet(() => enr.syncTellerEnrollment(7));
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    const b = enr.syncTellerEnrollment(7);
    const c = enr.syncTellerEnrollment(7);
    assert.equal(b, c);
    open();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.runs, 2);
    assert.equal(rb, ra);
    assert.equal(calls, 2);
  });

  it("syncAllEnrollments is unchanged through syncOneTellerEnrollment: counts, decryption failure, DISCONNECTED on a 401", async () => {
    setup({ enrollments: [ENR, { ...ENR, id: 9, enrollment_id: "enr_9", institution_name: "Locked", access_token: null }] });
    let r = await quiet(() => enr.syncAllEnrollments({ skipAnomaly: true }));
    assert.equal(r.enrollments_synced, 1);
    assert.equal(r.transactions_added, 1);
    assert.deepEqual(r.errors, [{ institution: "Locked", error: "decryption_failed" }]);
    setup({ teller: async () => { throw Object.assign(new Error("unauthorized"), { status: 401 }); } });
    r = await quiet(() => enr.syncAllEnrollments({ skipAnomaly: true }));
    assert.equal(r.enrollments_synced, 0);
    assert.equal(ran(/SET status = 'DISCONNECTED'/).length, 1);
  });
});

// ---------------------------------------------------------------------------
describe("W5 — the Teller verifier's event fields", () => {
  it("carries the disconnect reason and the transactions' account ids — never the transactions", async () => {
    const secret = "s";
    const v = createTellerVerifier({ secrets: () => [secret] });
    const body = { id: "wh_1", type: "transactions.processed", payload: { transactions: [
      { id: "t1", account_id: "acc_1", amount: "-9.99", description: "SECRET MERCHANT" },
      { id: "t2", account_id: "acc_1" }, { id: "t3", account_id: "acc_2" }, { id: "t4" }, null,
    ] } };
    const raw = Buffer.from(JSON.stringify(body));
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
    const r = await v.verify({ headers: { "teller-signature": `t=${t},v1=${sig}` }, rawBody: raw, body });
    assert.equal(r.ok, true);
    assert.deepEqual(r.event, { type: "transactions.processed", code: null, subject: null, reason: null, account_ids: ["acc_1", "acc_2"] });
    assert.doesNotMatch(JSON.stringify(r.event), /SECRET MERCHANT|9\.99/);
  });
});
