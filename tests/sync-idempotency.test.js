// ============================================================================
// Behavioral idempotency tests — Sync Integrity (S1 / INV-01 / INV-03 / INV-04)
// ============================================================================
// Closes the test-quality gap T1: the documented "re-sync is idempotent;
// second run reports 0 added; cursor unchanged" invariant was previously
// pinned ONLY by source-string assertions (assert.match(src, /xmax = 0/)), and
// the one reconcile test ran against EMPTY enrollments so it could not catch a
// count regression. These tests RUN a sync twice over the same fixture rows
// and assert the second pass adds 0 with no duplicate inserts.
//
// Pattern: monkey-patch the shared `pool.query` (services/database) + the
// Teller HTTP client so the sync helpers operate over an in-memory "table"
// (a Set of transaction_ids). A genuine insert returns `inserted: true`
// (xmax = 0); an ON-CONFLICT re-delivery returns `inserted: false`. If the
// production code ever miscounts updates as inserts, run #2 reports > 0 and
// these tests fail — which a source-string match could not detect.

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const dbModule = require("../teller/services/database");
const originalPoolQuery = dbModule.pool.query;

afterEach(() => {
  dbModule.pool.query = originalPoolQuery;
});

// ---------------------------------------------------------------------------
// Teller — syncAllEnrollments (the documented S1 entry point + scheduler call)
// ---------------------------------------------------------------------------
describe("Teller syncAllEnrollments is idempotent (S1 / INV-01 / INV-03)", () => {
  // A fixed page of three posted transactions, newest-first (Teller order).
  const TELLER_PAGE = [
    { id: "tt1", amount: "-12.34", date: "2026-06-10", description: "Coffee", status: "posted", details: { counterparty: { name: "Cafe" }, category: "dining" } },
    { id: "tt2", amount: "-50.00", date: "2026-06-09", description: "Groceries", status: "posted" },
    { id: "tt3", amount: "-9.99", date: "2026-06-08", description: "Music", status: "posted" },
  ];

  let tellerApi, originalTellerRequest, syncAllEnrollments;
  let state;

  before(() => {
    tellerApi = require("../teller/services/teller-api");
    originalTellerRequest = tellerApi.tellerRequest;
    // Patch the export, then re-require enrollments so its destructured
    // `const { tellerRequest } = require(...)` binds to our stub.
    tellerApi.tellerRequest = async (endpoint) =>
      endpoint.includes("from_id") ? [] : TELLER_PAGE.slice();
    delete require.cache[require.resolve("../teller/routes/enrollments")];
    syncAllEnrollments = require("../teller/routes/enrollments").syncAllEnrollments;
  });

  after(() => {
    if (tellerApi && originalTellerRequest) tellerApi.tellerRequest = originalTellerRequest;
    delete require.cache[require.resolve("../teller/routes/enrollments")];
  });

  beforeEach(() => {
    state = { insertedIds: new Set(), watermark: null, watermarkWrites: [] };
    dbModule.pool.query = async (sql, params) => {
      // 1. Enrollment list (returns the current persisted watermark)
      if (sql.includes("FROM teller_enrollments te") && sql.includes("status != 'SUSPENDED'")) {
        return { rows: [{ id: 1, enrollment_id: "enr_1", institution_name: "TestBank", access_token: "tok", last_synced_txn_date: state.watermark }] };
      }
      // 2. Accounts for the enrollment
      if (sql.includes("FROM linked_accounts WHERE teller_enrollment_id")) {
        return { rows: [{ account_id: "acc_1" }] };
      }
      // 3. Transaction upsert — the heart of INV-01
      if (sql.includes("INSERT INTO transactions") && sql.includes("RETURNING (xmax = 0)")) {
        const txnId = params[1];
        const fresh = !state.insertedIds.has(txnId);
        state.insertedIds.add(txnId);
        return { rows: [{ inserted: fresh }] };
      }
      // 4. Watermark advance
      if (sql.includes("UPDATE teller_enrollments SET last_synced_txn_date")) {
        state.watermark = params[0];
        state.watermarkWrites.push(params[0]);
        return { rows: [] };
      }
      // 5/6/7. Anomaly block — return no candidates so sendToAll is never reached
      if (sql.includes("last_anomaly_check_at FROM user_settings")) return { rows: [{ last_anomaly_check_at: new Date() }] };
      if (sql.includes("avg_tbl")) return { rows: [] };
      if (sql.includes("UPDATE user_settings SET last_anomaly_check_at")) return { rows: [] };
      return { rows: [] };
    };
  });

  it("first run inserts every transaction; second run adds 0 with no duplicates", async () => {
    const run1 = await syncAllEnrollments();
    assert.equal(run1.transactions_added, 3, "first sync inserts all 3 rows");
    assert.equal(run1.enrollments_synced, 1);
    assert.equal(run1.errors, undefined);
    assert.equal(state.insertedIds.size, 3);

    const run2 = await syncAllEnrollments();
    assert.equal(run2.transactions_added, 0, "re-sync of unchanged data must add 0 (INV-01: xmax=0 counts inserts only)");
    assert.equal(state.insertedIds.size, 3, "no duplicate transaction_ids materialized");
  });

  it("the incremental watermark is stable across a no-op re-sync (cursor unchanged)", async () => {
    await syncAllEnrollments();
    await syncAllEnrollments();
    // Both runs settle the watermark on the newest transaction date; the no-op
    // second run must not move it (and the >= filter re-includes the watermark
    // day safely — INV-03).
    assert.deepEqual(
      [...new Set(state.watermarkWrites)],
      ["2026-06-10"],
      "watermark must remain at the newest txn date on the idempotent re-sync"
    );
  });
});

// ---------------------------------------------------------------------------
// Plaid — syncPlaidItemTransactions (the reconcile re-delivery case, INV-01/04)
// ---------------------------------------------------------------------------
describe("Plaid syncPlaidItemTransactions is idempotent (INV-01 / INV-04)", () => {
  let syncPlaidItemTransactions;
  let state;

  // A fake transactionsSync that ALWAYS re-delivers the same two posted txns in
  // `added` with has_more:false — modelling a reconcile / cursor-reset where
  // Plaid resends rows we already hold. INV-01 requires these to NOT be counted
  // as new (xmax = 0).
  const PLAID_ADDED = [
    { transaction_id: "pp1", account_id: "pacc_1", amount: 21.5, date: "2026-06-10", name: "Store A", category: ["Shops"] },
    { transaction_id: "pp2", account_id: "pacc_1", amount: 8.0, date: "2026-06-09", name: "Store B", category: ["Shops"] },
  ];
  const fakeClient = {
    transactionsSync: async () => ({
      data: { added: PLAID_ADDED.slice(), modified: [], removed: [], next_cursor: "cursor-1", has_more: false },
    }),
  };

  before(() => {
    syncPlaidItemTransactions = require("../teller/routes/investments").syncPlaidItemTransactions;
  });

  beforeEach(() => {
    state = { insertedIds: new Set(), cursorWrites: [] };
    dbModule.pool.query = async (sql, params) => {
      if (sql.includes("SELECT cursor FROM sync_cursors")) return { rows: [{ cursor: "" }] };
      if (sql.includes("INSERT INTO transactions") && sql.includes("RETURNING (xmax = 0)")) {
        const txnId = params[1];
        const fresh = !state.insertedIds.has(txnId);
        state.insertedIds.add(txnId);
        return { rows: [{ inserted: fresh }] };
      }
      if (sql.includes("UPDATE sync_cursors SET cursor")) {
        state.cursorWrites.push(params[0]);
        return { rows: [] };
      }
      return { rows: [] };
    };
  });

  it("re-delivered (reconcile) rows are upserted but not counted as added", async () => {
    assert.equal(typeof syncPlaidItemTransactions, "function", "syncPlaidItemTransactions must be exported for testing");
    const run1 = await syncPlaidItemTransactions(fakeClient, 1, "tok");
    assert.equal(run1.added, 2, "first sync counts both genuine inserts");
    assert.equal(state.insertedIds.size, 2);

    const run2 = await syncPlaidItemTransactions(fakeClient, 1, "tok");
    assert.equal(run2.added, 0, "re-delivered existing rows in `added` must count 0 (INV-01)");
    assert.equal(state.insertedIds.size, 2, "no duplicate rows materialized on the reconcile re-pull");
  });
});
