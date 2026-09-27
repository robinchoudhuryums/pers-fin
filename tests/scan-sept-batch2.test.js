// ============================================================================
// Broad-scan (Sept 2026) Batch 2 regression tests — ingestion completeness &
// silent sync failures (Perfin)
// ============================================================================
// Behavioral pins (mock pool + stubbed Teller/Plaid clients) for:
//   BSI-7  Teller watermark held on a row-insert failure
//   BSI-8  Teller incremental floor re-reads a 7-day lookback
//   BSI-9  Teller 401/403 on every account → enrollment DISCONNECTED
//   DD-8   Teller re-link re-points teller_enrollment_id
//   DD-9   syncAllBalances registers Teller accounts opened after enrollment
//   DD-10  per-account Teller balance failures surface; 429 retried; flows recorded
//   BSI-1  Plaid registers new accounts before the cursor walk; a stuck item surfaces
//   BSI-12 Plaid mutation-during-pagination restarts from the loop-start cursor
//   BSI-10 CSV items excluded from the re-auth count; ITEM_* errors recorded
//   BSI-2 / DD-1  /api/sync covers Teller + Plaid; ONE anomaly check on the combined count
//   BSI-11 last_sync_result merges per provider; reconcile results recorded
//   BSI-3  Plaid unlink: itemRemove + registry purge + investments deactivated
// ============================================================================

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

const ROOT = path.join(__dirname, "..");
const dbModule = require("../teller/services/database");
const tellerApi = require("../teller/services/teller-api");
const plaidClientModule = require("../teller/services/plaid-client");

const originalQuery = dbModule.pool.query;
const originalConnect = dbModule.pool.connect;
const originalTellerRequest = tellerApi.tellerRequest;
const originalGetPlaidClient = plaidClientModule.getPlaidClient;

// Shared, per-test mutable stubs. The route modules are re-required AFTER the
// exports are patched so their top-level destructuring binds to the stubs.
let S;
let enr, inv;

function freshModules() {
  delete require.cache[require.resolve("../teller/routes/enrollments")];
  delete require.cache[require.resolve("../teller/routes/investments")];
  enr = require("../teller/routes/enrollments");
  inv = require("../teller/routes/investments");
}

before(() => {
  tellerApi.tellerRequest = (endpoint, token, opts) => S.teller(endpoint, token, opts);
  plaidClientModule.getPlaidClient = () => S.plaid;
  freshModules();
});
after(() => {
  tellerApi.tellerRequest = originalTellerRequest;
  plaidClientModule.getPlaidClient = originalGetPlaidClient;
  dbModule.pool.query = originalQuery;
  dbModule.pool.connect = originalConnect;
  delete require.cache[require.resolve("../teller/routes/enrollments")];
  delete require.cache[require.resolve("../teller/routes/investments")];
});
afterEach(() => {
  dbModule.pool.query = originalQuery;
  dbModule.pool.connect = originalConnect;
});

// A mock pool that logs every query and dispatches through `S.db(sql, params)`
// (returning undefined → `{ rows: [] }`).
function installPool() {
  S.log = [];
  dbModule.pool.query = async (sql, params) => {
    S.log.push({ sql, params });
    const r = await S.db(sql, params || []);
    return r || { rows: [] };
  };
  dbModule.pool.connect = async () => ({
    query: async (sql, params) => { S.log.push({ sql, params, tx: true }); return (await S.db(sql, params || [])) || { rows: [] }; },
    release() {},
  });
}
const ran = (re) => S.log.filter((q) => re.test(q.sql));

function tellerTxn(id, date, amount = "-10.00") {
  return { id, amount, date, description: "Shop " + id, status: "posted" };
}

// Minimal Teller DB: one enrollment (watermark from S.watermark) with the
// accounts in S.accounts; transaction upserts tracked in S.inserted.
function tellerDb(extra) {
  return async (sql, params) => {
    if (extra) { const r = await extra(sql, params); if (r) return r; }
    if (sql.includes("FROM teller_enrollments te") && sql.includes("status != 'SUSPENDED'")) {
      return { rows: [{ id: 7, enrollment_id: "enr_7", institution_name: "TestBank", access_token: "tok", last_synced_txn_date: S.watermark }] };
    }
    if (sql.includes("FROM linked_accounts WHERE teller_enrollment_id")) {
      return { rows: S.accounts.map((a) => ({ account_id: a })) };
    }
    if (sql.includes("INSERT INTO transactions") && sql.includes("RETURNING (xmax = 0)")) {
      if (S.failInsert && S.failInsert(params[1])) throw new Error("insert boom");
      const fresh = !S.inserted.has(params[1]);
      S.inserted.add(params[1]);
      return { rows: [{ inserted: fresh }] };
    }
    if (sql.includes("UPDATE teller_enrollments SET last_synced_txn_date")) {
      S.watermarkWrites.push(params[0]);
      return { rows: [] };
    }
    if (sql.includes("last_anomaly_check_at FROM user_settings")) return { rows: [{ last_anomaly_check_at: new Date() }] };
    return undefined;
  };
}

function resetState(over = {}) {
  S = {
    teller: async () => [],
    plaid: null,
    db: async () => undefined,
    watermark: null,
    accounts: ["acc_1"],
    inserted: new Set(),
    watermarkWrites: [],
    failInsert: null,
    ...over,
  };
  installPool();
}

// ---------------------------------------------------------------------------
// BSI-8 — 7-day lookback behind the enrollment watermark
// ---------------------------------------------------------------------------
describe("BSI-8 — Teller incremental floor re-reads a 7-day lookback", () => {
  it("lookbackFloor subtracts days from a string or a pg Date without a UTC shift", () => {
    assert.equal(enr.lookbackFloor("2026-06-10", 7), "2026-06-03");
    assert.equal(enr.lookbackFloor("2026-03-02", 7), "2026-02-23", "crosses a month boundary");
    assert.equal(enr.lookbackFloor(new Date(2026, 0, 3), 7), "2025-12-27", "pg DATE → local-midnight Date");
    assert.equal(enr.lookbackFloor(null, 7), null);
    assert.equal(enr.lookbackFloor("garbage", 7), null, "unparseable → full re-read, never a crash");
  });

  it("a charge that posts LATE (dated before the watermark) is ingested; older history is not re-read", async () => {
    resetState({ watermark: "2026-06-10" });
    S.db = tellerDb();
    S.teller = async (ep) => ep.includes("from_id") ? [] : [
      tellerTxn("t_new", "2026-06-10"),
      tellerTxn("t_late", "2026-06-05"), // late-posting sibling-account charge
      tellerTxn("t_old", "2026-05-20"),  // below watermark − 7d
    ];
    const out = await enr.syncAllEnrollments();
    assert.ok(S.inserted.has("t_late"), "late-posting charge inside the lookback must land (was dropped by a bare >= watermark floor)");
    assert.ok(!S.inserted.has("t_old"), "rows below the lookback floor are not re-read");
    assert.equal(out.transactions_added, 2);
    assert.deepEqual(S.watermarkWrites, ["2026-06-10"], "watermark still advances to the newest date");
  });
});

// ---------------------------------------------------------------------------
// BSI-7 — insert failure holds the watermark
// ---------------------------------------------------------------------------
describe("BSI-7 — Teller row-insert failure holds the watermark", () => {
  it("does not advance the watermark past a failed row and reports partial_sync_incomplete", async () => {
    resetState({ watermark: "2026-06-01", failInsert: (id) => id === "t2" });
    S.db = tellerDb();
    S.teller = async (ep) => ep.includes("from_id") ? [] : [tellerTxn("t1", "2026-06-10"), tellerTxn("t2", "2026-06-09")];
    const out = await enr.syncAllEnrollments();
    assert.deepEqual(S.watermarkWrites, [], "watermark must be held so the failed row is retried");
    assert.ok(out.errors && out.errors.some((e) => e.error === "partial_sync_incomplete"));
    assert.equal(out.enrollments_synced, 1, "a partial failure still counts as a connected enrollment");
  });
});

// ---------------------------------------------------------------------------
// BSI-9 — 401/403 on every account → DISCONNECTED
// ---------------------------------------------------------------------------
describe("BSI-9 — Teller auth failure propagates to DISCONNECTED", () => {
  const authErr = (status) => Object.assign(new Error("Teller API error " + status), { status });

  it("marks the enrollment DISCONNECTED when every account fetch 401s", async () => {
    resetState({ accounts: ["acc_1", "acc_2"] });
    S.db = tellerDb();
    S.teller = async () => { throw authErr(401); };
    const out = await enr.syncAllEnrollments();
    assert.equal(ran(/SET status = 'DISCONNECTED'/).length, 1, "enrollment must be marked DISCONNECTED");
    assert.equal(out.enrollments_synced, 0);
    assert.match(out.errors[0].error, /authorization failed \(401\)/);
  });

  it("a DISCONNECTED enrollment whose token works again is restored to GOOD", async () => {
    resetState();
    const base = tellerDb();
    S.db = async (sql, p) => sql.includes("FROM teller_enrollments te") && sql.includes("status != 'SUSPENDED'")
      ? { rows: [{ id: 7, institution_name: "TestBank", access_token: "tok", last_synced_txn_date: null, status: "DISCONNECTED" }] }
      : base(sql, p);
    S.teller = async (ep) => ep.includes("from_id") ? [] : [tellerTxn("r1", "2026-06-10")];
    await enr.syncAllEnrollments();
    assert.equal(ran(/SET status = 'GOOD'/).length, 1, "a transient 401 must not strand the enrollment (balance sync runs GOOD only)");
  });

  it("a single account 403 among healthy siblings stays a partial (retryable), not DISCONNECTED", async () => {
    resetState({ accounts: ["acc_ok", "acc_bad"] });
    S.db = tellerDb();
    S.teller = async (ep) => {
      if (ep.includes("acc_bad")) throw authErr(403);
      return ep.includes("from_id") ? [] : [tellerTxn("ok1", "2026-06-10")];
    };
    const out = await enr.syncAllEnrollments();
    assert.equal(ran(/SET status = 'DISCONNECTED'/).length, 0);
    assert.ok(out.errors.some((e) => e.error === "partial_sync_incomplete"));
  });
});

// ---------------------------------------------------------------------------
// DD-8 — re-link re-points teller_enrollment_id
// ---------------------------------------------------------------------------
describe("DD-8 — Teller re-link re-points existing accounts", () => {
  it("the /api/enroll account upsert updates teller_enrollment_id on conflict", async () => {
    resetState();
    S.db = async (sql) => sql.includes("INSERT INTO teller_enrollments") ? { rows: [{ id: 42 }] } : undefined;
    S.teller = async (ep) => ep === "/accounts" ? [{ id: "acc_same", name: "Checking", type: "depository", subtype: "checking" }] : [];
    const app = express(); app.use(express.json()); app.use(enr);
    const res = await supertest(app).post("/api/enroll").send({ accessToken: "new_tok", enrollment: { id: "enr_new", institution: { name: "Bank" } } });
    assert.equal(res.status, 200);
    const upsert = ran(/INSERT INTO linked_accounts \(teller_enrollment_id/)[0];
    assert.ok(upsert, "account upsert issued");
    assert.match(upsert.sql, /teller_enrollment_id = EXCLUDED\.teller_enrollment_id/);
    assert.equal(upsert.params[0], 42, "bound to the NEW enrollment row");
  });
});

// ---------------------------------------------------------------------------
// DD-9 / DD-10 — syncAllBalances registers new accounts + surfaces failures
// ---------------------------------------------------------------------------
describe("DD-9 / DD-10 — Teller balance sync", () => {
  it("registers an account opened after enrollment, surfaces a per-account fetch failure, and counts only matched updates", async () => {
    resetState();
    const known = new Set(["acc_old"]);
    S.db = async (sql, p) => {
      if (sql.includes("FROM teller_enrollments WHERE status = 'GOOD'")) {
        return { rows: [{ id: 7, enrollment_id: "enr_7", institution_name: "TestBank", access_token: "tok" }] };
      }
      if (sql.includes("INSERT INTO linked_accounts") && sql.includes("DO NOTHING")) {
        if (known.has(p[1])) return { rows: [] };
        known.add(p[1]);
        return { rows: [{ id: 99 }] };
      }
      if (sql.includes("UPDATE linked_accounts") && sql.includes("SET available_balance")) {
        return { rows: known.has(p[2]) ? [{ id: 1 }] : [] };
      }
      return undefined;
    };
    S.teller = async (ep) => {
      if (ep === "/accounts") return [
        { id: "acc_old", name: "Checking", type: "depository" },
        { id: "acc_new", name: "New Savings", type: "depository", subtype: "savings" },
        { id: "acc_err", name: "Broken", type: "depository" },
      ];
      if (ep.includes("acc_err")) throw Object.assign(new Error("Teller API error 500"), { status: 500 });
      return { available: "100.00", ledger: "100.00" };
    };
    const out = await enr.syncAllBalances();
    assert.equal(out.accounts_registered, 2, "acc_new (and acc_err) get linked_accounts rows");
    assert.equal(out.accounts_updated, 2, "acc_old + acc_new updated; acc_err had no balance");
    assert.ok(out.errors && out.errors.some((e) => /balance fetch failed for Broken \(500\)/.test(e.error)),
      "a per-account balance failure must reach errors[] (was log-only)");
  });

  it("the Teller client retries 429 (and still never retries other 4xx)", () => {
    const src = fs.readFileSync(path.join(ROOT, "teller/services/teller-api.js"), "utf8");
    assert.match(src, /err\.status < 500 && err\.status !== 429\) throw err/);
    assert.match(src, /retry-after/);
  });
});

// ---------------------------------------------------------------------------
// Plaid fake client
// ---------------------------------------------------------------------------
function plaidDb(extra) {
  return async (sql, params) => {
    if (extra) { const r = await extra(sql, params); if (r) return r; }
    if (sql.includes("FROM plaid_items pi") && sql.includes("WHERE pi.status = 'GOOD'")) {
      return { rows: [{ id: 3, item_id: "item_3", institution_name: "PlaidBank", access_token: "ptok" }] };
    }
    if (sql.includes("SELECT cursor FROM sync_cursors")) return { rows: [{ cursor: S.cursor }] };
    if (sql.includes("UPDATE sync_cursors SET cursor")) { S.cursor = params[0]; S.cursorWrites.push(params[0]); return { rows: [] }; }
    if (sql.includes("INSERT INTO linked_accounts") && sql.includes("DO NOTHING")) {
      if (S.plaidAccounts.has(params[1])) return { rows: [] };
      S.plaidAccounts.add(params[1]);
      return { rows: [{ id: 50 }] };
    }
    if (sql.includes("INSERT INTO transactions")) {
      // Model the transactions.account_id FK.
      if (!S.plaidAccounts.has(params[0])) throw new Error('violates foreign key constraint "transactions_account_id_fkey"');
      const fresh = !S.inserted.has(params[1]);
      S.inserted.add(params[1]);
      return { rows: [{ inserted: fresh }] };
    }
    if (sql.includes("SELECT id, account_id FROM linked_accounts WHERE plaid_item_id")) return { rows: [] };
    if (sql.includes("last_anomaly_check_at FROM user_settings")) return { rows: [{ last_anomaly_check_at: new Date() }] };
    return undefined;
  };
}
const plaidTxn = (id, account_id) => ({ transaction_id: id, account_id, amount: 12.5, date: "2026-06-10", name: "Store", pending: false });

describe("BSI-1 — Plaid registers new accounts before walking the cursor", () => {
  it("a transaction on an account the item gained after link is ingested (no FK stall)", async () => {
    resetState({ cursor: "", cursorWrites: [], plaidAccounts: new Set(["acc_known"]) });
    S.db = plaidDb();
    S.plaid = {
      accountsGet: async () => ({ data: { accounts: [
        { account_id: "acc_known", name: "Checking", type: "depository", balances: { current: 1 } },
        { account_id: "acc_new_card", name: "New Card", type: "credit", balances: { current: 2 } },
      ] } }),
      transactionsSync: async () => ({ data: { added: [plaidTxn("p1", "acc_new_card")], modified: [], removed: [], next_cursor: "c1", has_more: false } }),
      liabilitiesGet: async () => ({ data: { liabilities: {}, accounts: [] } }),
    };
    const out = await inv.syncAllPlaidTransactions();
    assert.equal(out.accounts_registered, 1);
    assert.equal(out.transactions_added, 1, "the new account's transaction lands");
    assert.equal(S.cursor, "c1", "cursor advances past the page");
    assert.equal(out.errors, undefined);
  });

  it("a stuck item (page keeps failing) is surfaced as partial_sync_incomplete instead of a clean success", async () => {
    resetState({ cursor: "c0", cursorWrites: [], plaidAccounts: new Set() });
    S.db = plaidDb(async (sql) => sql.includes("INSERT INTO linked_accounts") && sql.includes("DO NOTHING") ? { rows: [] } : undefined);
    S.plaid = {
      accountsGet: async () => { throw new Error("accountsGet down"); },
      transactionsSync: async () => ({ data: { added: [plaidTxn("p1", "acc_unknown")], modified: [], removed: [], next_cursor: "c1", has_more: false } }),
      liabilitiesGet: async () => ({ data: { liabilities: {}, accounts: [] } }),
    };
    const out = await inv.syncAllPlaidTransactions();
    assert.deepEqual(S.cursorWrites, [], "cursor held on the failed page (INV-04)");
    assert.ok(out.errors && out.errors.some((e) => e.error === "partial_sync_incomplete"));
    assert.equal(out.items_synced, 1, "still connected — counted as synced, flagged in errors[]");
  });
});

describe("BSI-12 — Plaid mutation-during-pagination restarts from the loop-start cursor", () => {
  const mutationErr = () => Object.assign(new Error("mutation"), { response: { data: { error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" } } });

  it("restarts the loop from the starting cursor and completes", async () => {
    resetState({ cursor: "start", cursorWrites: [], plaidAccounts: new Set(["a1"]) });
    S.db = plaidDb();
    const calls = [];
    let thrown = false;
    const client = {
      transactionsSync: async ({ cursor }) => {
        calls.push(cursor);
        if (cursor === "start") return { data: { added: [plaidTxn("p1", "a1")], modified: [], removed: [], next_cursor: "mid", has_more: true } };
        if (cursor === "mid" && !thrown) { thrown = true; throw mutationErr(); }
        return { data: { added: [plaidTxn("p2", "a1")], modified: [], removed: [], next_cursor: "end", has_more: false } };
      },
    };
    const out = await inv.syncPlaidItemTransactions(client, 3, "ptok");
    assert.deepEqual(calls, ["start", "mid", "start", "mid"], "after the mutation error the walk restarts at the loop-start cursor");
    assert.ok(S.cursorWrites.includes("start"), "the loop-start cursor is persisted on the restart (no stuck mid-loop cursor)");
    assert.equal(S.cursor, "end");
    assert.equal(out.incomplete, false);
    assert.equal(out.added, 2, "re-delivered rows are not double-counted (INV-01)");
  });

  it("gives up after bounded restarts, leaving the loop-start cursor saved", async () => {
    resetState({ cursor: "start", cursorWrites: [], plaidAccounts: new Set(["a1"]) });
    S.db = plaidDb();
    const client = { transactionsSync: async () => { throw mutationErr(); } };
    const out = await inv.syncPlaidItemTransactions(client, 3, "ptok");
    assert.equal(out.incomplete, true);
    assert.equal(out.incomplete_reason, "mutation_during_pagination");
    assert.equal(S.cursor, "start");
  });
});

describe("BSI-10 — Plaid re-auth signal", () => {
  it("records an ITEM_LOGIN_REQUIRED code on the item and clears it after a clean sync", async () => {
    resetState({ cursor: "", cursorWrites: [], plaidAccounts: new Set() });
    S.db = plaidDb();
    S.plaid = {
      accountsGet: async () => { throw Object.assign(new Error("login"), { response: { data: { error_code: "ITEM_LOGIN_REQUIRED", error_message: "login required" } } }); },
      transactionsSync: async () => { throw Object.assign(new Error("login"), { response: { data: { error_code: "ITEM_LOGIN_REQUIRED", error_message: "login required" } } }); },
    };
    const out = await inv.syncAllPlaidTransactions();
    const set = ran(/UPDATE plaid_items SET last_error_code = \$2/);
    assert.equal(set.length, 1);
    assert.equal(set[0].params[1], "ITEM_LOGIN_REQUIRED");
    assert.equal(out.items_synced, 0);

    resetState({ cursor: "", cursorWrites: [], plaidAccounts: new Set() });
    S.db = plaidDb();
    S.plaid = {
      accountsGet: async () => ({ data: { accounts: [] } }),
      transactionsSync: async () => ({ data: { added: [], modified: [], removed: [], next_cursor: "c", has_more: false } }),
      liabilitiesGet: async () => ({ data: { liabilities: {}, accounts: [] } }),
    };
    await inv.syncAllPlaidTransactions();
    assert.equal(ran(/SET last_error_code = NULL/).length, 1, "a successful sync clears the re-auth flag");
  });

  it("a transient (non re-auth) error does not flag the item", async () => {
    resetState({ cursor: "", cursorWrites: [], plaidAccounts: new Set() });
    S.db = plaidDb();
    S.plaid = {
      accountsGet: async () => ({ data: { accounts: [] } }),
      transactionsSync: async () => { throw Object.assign(new Error("rate"), { response: { data: { error_code: "RATE_LIMIT_EXCEEDED" } } }); },
    };
    await inv.syncAllPlaidTransactions();
    assert.equal(ran(/SET last_error_code = \$2/).length, 0);
  });

  it("data-health excludes CSV items from both Plaid counts and honors last_error_code", async () => {
    const src = fs.readFileSync(path.join(ROOT, "teller/routes/settings.js"), "utf8");
    assert.match(src, /COUNT\(\*\) FILTER \(WHERE status <> 'CSV'\)::int AS total/);
    assert.match(src, /status <> 'CSV' AND \(status <> 'GOOD' OR last_error_code IS NOT NULL\)/);
    const db = fs.readFileSync(path.join(ROOT, "teller/services/database.js"), "utf8");
    assert.match(db, /ALTER TABLE plaid_items ADD COLUMN IF NOT EXISTS last_error_code TEXT/);
  });
});

// ---------------------------------------------------------------------------
// BSI-2 / DD-1 — unified /api/sync + one anomaly check
// ---------------------------------------------------------------------------
describe("BSI-2 / DD-1 — /api/sync covers Teller + Plaid; anomaly check on the combined count", () => {
  function unifiedDb() {
    const t = tellerDb();
    const p = plaidDb();
    return async (sql, params) => (await t(sql, params)) || (await p(sql, params));
  }

  it("a Plaid-only new charge triggers the anomaly check exactly once; response combines both providers", async () => {
    resetState({ cursor: "", cursorWrites: [], plaidAccounts: new Set(["pa1"]) });
    S.db = unifiedDb();
    S.teller = async () => []; // Teller: nothing new
    S.plaid = {
      accountsGet: async () => ({ data: { accounts: [{ account_id: "pa1", name: "Card", type: "credit", balances: {} }] } }),
      transactionsSync: async () => ({ data: { added: [plaidTxn("p9", "pa1")], modified: [], removed: [], next_cursor: "c1", has_more: false } }),
      liabilitiesGet: async () => ({ data: { liabilities: {}, accounts: [] } }),
    };
    const app = express(); app.use(express.json()); app.use(enr);
    const res = await supertest(app).post("/api/sync").expect(200);
    assert.equal(res.body.transactions_added, 1, "combined count includes Plaid");
    assert.equal(res.body.teller.transactions_added, 0);
    assert.equal(res.body.plaid.transactions_added, 1);
    assert.equal(ran(/last_anomaly_check_at FROM user_settings/).length, 1, "anomaly check runs once for Plaid-only activity (DD-1)");
    assert.equal(ran(/SET last_txn_sync_at = now\(\)/).length, 1);
    const rec = ran(/UPDATE user_settings SET last_sync_result/)[0];
    const payload = JSON.parse(rec.params[0]);
    assert.ok(payload.providers.teller_txn && payload.providers.plaid_txn, "both providers recorded");
  });

  it("still 500s when nothing synced (Teller threw, no Plaid) so the daily backstop goes red", async () => {
    resetState();
    S.db = async (sql) => { if (sql.includes("FROM teller_enrollments te")) throw new Error("db down"); return undefined; };
    S.plaid = null; // Plaid not configured
    const app = express(); app.use(express.json()); app.use(enr);
    const res = await supertest(app).post("/api/sync");
    assert.equal(res.status, 500);
  });

  it("syncAllEnrollments({ skipAnomaly }) leaves the check to the caller; reconcile never runs it (INV-05)", async () => {
    resetState();
    S.db = tellerDb();
    S.teller = async (ep) => ep.includes("from_id") ? [] : [tellerTxn("n1", "2026-06-10")];
    await enr.syncAllEnrollments({ skipAnomaly: true });
    assert.equal(ran(/last_anomaly_check_at FROM user_settings/).length, 0);
    resetState();
    S.db = tellerDb();
    S.teller = async (ep) => ep.includes("from_id") ? [] : [tellerTxn("n2", "2026-06-10")];
    await enr.reconcileTeller(30);
    assert.equal(ran(/last_anomaly_check_at FROM user_settings/).length, 0);
  });

  it("the schedulers use the unified entry point", () => {
    const startup = fs.readFileSync(path.join(ROOT, "teller/startup.js"), "utf8");
    assert.match(startup, /const all = await syncAllTransactions\(\)/);
    assert.match(startup, /try \{ await syncAllTransactions\(\); \}/);
    assert.doesNotMatch(startup, /await syncAllPlaidTransactions\(\)/, "no separate Plaid txn call that would skip the shared anomaly check");
  });
});

// ---------------------------------------------------------------------------
// BSI-11 — last_sync_result merges per provider
// ---------------------------------------------------------------------------
describe("BSI-11 — last_sync_result is merged per provider", () => {
  it("a later write for OTHER providers keeps earlier providers' errors", async () => {
    resetState();
    let stored = { at: "x", errors: [], providers: { teller_txn: { at: "x", errors: [{ provider: "teller_txn", institution: "Chase", error: "partial_sync_incomplete" }] } } };
    S.db = async (sql, p) => {
      if (/SELECT last_sync_result/.test(sql)) return { rows: [{ last_sync_result: stored }] };
      if (/SET last_sync_result/.test(sql)) { stored = JSON.parse(p[0]); return { rows: [] }; }
      return undefined;
    };
    const out = await enr.recordSyncResult([
      { provider: "teller_balance", result: { accounts_updated: 3 } },
      { provider: "plaid_balance", result: { errors: [{ institution: "Amex", error: "boom" }] } },
      { provider: "plaid_holdings", result: null }, // not run → untouched
    ]);
    const errs = out.errors.map((e) => e.provider + ":" + e.error).sort();
    assert.deepEqual(errs, ["plaid_balance:boom", "teller_txn:partial_sync_incomplete"],
      "the balance write must not wipe the Teller transaction error (was last-writer-wins)");
    assert.ok(!("plaid_holdings" in out.providers));

    // Re-running teller_txn cleanly clears only that provider.
    const out2 = await enr.recordSyncResult([{ provider: "teller_txn", result: { transactions_added: 0 } }]);
    assert.deepEqual(out2.errors.map((e) => e.provider), ["plaid_balance"]);
  });

  it("a legacy flat payload is regrouped by provider rather than dropped", async () => {
    resetState();
    S.db = async (sql) => /SELECT last_sync_result/.test(sql)
      ? { rows: [{ last_sync_result: { at: "old", errors: [{ provider: "plaid_txn", institution: "X", error: "decryption_failed" }] } }] }
      : undefined;
    const out = await enr.recordSyncResult([{ provider: "teller_txn", result: { errors: [] } }]);
    assert.deepEqual(out.errors.map((e) => e.error), ["decryption_failed"]);
  });

  it("reconcile records its result and a failed leg does not stamp last_txn_sync_at", async () => {
    resetState();
    S.db = async (sql) => {
      if (sql.includes("FROM teller_enrollments te")) throw new Error("db down");
      return undefined;
    };
    const app = express(); app.use(express.json()); app.use(enr);
    const res = await supertest(app).post("/api/sync/reconcile").send({ provider: "teller" }).expect(200);
    assert.equal(res.body.teller.error, "db down");
    const rec = ran(/SET last_sync_result/)[0];
    assert.ok(rec, "reconcile outcome recorded");
    assert.equal(JSON.parse(rec.params[0]).providers.teller_reconcile.errors[0].error, "db down");
    assert.equal(ran(/last_txn_sync_at = now\(\)/).length, 0, "a failed reconcile must not green the freshness badge");
    assert.equal(ran(/SET last_reconcile_at = now\(\)/).length, 1);
  });

  it("sync-balances and the auto-sync record investment-flow results", () => {
    const e = fs.readFileSync(path.join(ROOT, "teller/routes/enrollments.js"), "utf8");
    const st = fs.readFileSync(path.join(ROOT, "teller/startup.js"), "utf8");
    assert.match(e, /provider: "plaid_flows", result: flowsResult/);
    assert.match(st, /provider: "plaid_flows", result: flowsResult/);
    assert.match(st, /flowsResult = await syncAllPlaidInvestmentFlows\(\)/);
  });
});

// ---------------------------------------------------------------------------
// BSI-3 — Plaid unlink
// ---------------------------------------------------------------------------
describe("BSI-3 — unlinking a Plaid item releases it and takes its investments down", () => {
  function unlinkDb(status) {
    return async (sql) => {
      if (sql.includes("SELECT id, item_id, institution_name, status FROM plaid_items")) {
        return { rows: [{ id: 5, item_id: "item_5", institution_name: "Schwab", status }] };
      }
      if (sql.includes("pgp_sym_decrypt(access_token_enc")) return { rows: [{ access_token: "ptok" }] };
      if (sql.includes("SELECT account_id FROM linked_accounts WHERE plaid_item_id")) return { rows: [{ account_id: "chk_1" }] };
      return undefined;
    };
  }

  it("calls itemRemove, purges the registry row, deactivates investment accounts and deletes holdings", async () => {
    resetState();
    S.db = unlinkDb("GOOD");
    let removed = null;
    S.plaid = {
      accountsGet: async () => ({ data: { accounts: [{ account_id: "chk_1" }, { account_id: "brk_1" }] } }),
      itemRemove: async ({ access_token }) => { removed = access_token; return { data: {} }; },
    };
    const app = express(); app.use(express.json()); app.use(enr);
    const res = await supertest(app).delete("/api/items/5").expect(200);
    assert.equal(res.body.plaid_item_removed, true);
    assert.equal(removed, "ptok", "the Item is released at Plaid (frees a Trial slot)");
    assert.equal(ran(/DELETE FROM plaid_investment_items WHERE item_id = \$1/)[0].params[0], "item_5");
    const deact = ran(/UPDATE investment_accounts SET is_active = false/)[0];
    assert.deepEqual(deact.params[0].sort(), ["brk_1", "chk_1"], "investment-only accounts (from accountsGet) included");
    assert.equal(ran(/DELETE FROM investment_holdings WHERE plaid_account_id = ANY/).length, 1);
    assert.equal(ran(/DELETE FROM plaid_items WHERE id = \$1/).length, 1);
  });

  it("a CSV virtual item never touches Plaid; a failing itemRemove never blocks the local unlink", async () => {
    resetState();
    S.db = unlinkDb("CSV");
    let called = false;
    S.plaid = { itemRemove: async () => { called = true; }, accountsGet: async () => ({ data: { accounts: [] } }) };
    const app = express(); app.use(express.json()); app.use(enr);
    await supertest(app).delete("/api/items/5").expect(200);
    assert.equal(called, false);

    resetState();
    S.db = unlinkDb("GOOD");
    S.plaid = {
      accountsGet: async () => ({ data: { accounts: [] } }),
      itemRemove: async () => { throw Object.assign(new Error("gone"), { response: { data: { error_code: "ITEM_NOT_FOUND" } } }); },
    };
    const res = await supertest(app).delete("/api/items/5").expect(200);
    assert.equal(res.body.plaid_item_removed, false);
    assert.equal(ran(/DELETE FROM plaid_items WHERE id = \$1/).length, 1);
  });
});
