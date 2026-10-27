// ============================================================================
// Cycle-8 broad scan, Batch 3 — renames, restores and price alerts
// ============================================================================
//   F41  a new rename rule re-keys only the subscriptions it fully vacated and
//        takes rows another rule renamed
//   F46  a price change survives a detection run with no new charge
//   F47  a charge more than 10% above the price alerts before detection moves
//   F5   a restored row takes its rule's CURRENT name (or loses a gone rule's)
//   F43  a reconcile applies the rename rules to the rows it recovers
//   F4   CSV-overlap Resolve tombstones what it deletes
//   F6   a deleted id the bank removed isn't restored; one it changed is stale
//   F54  income top sources group by the display name
// The database half runs on real Postgres in
// tests/contract/c8-batch3.contract.test.js.
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
const originalConnect = dbModule.pool.connect;
afterEach(() => { dbModule.pool.query = originalQuery; dbModule.pool.connect = originalConnect; });

const txns = require("../teller/routes/transactions");

function fakeClient(handler) {
  const log = [];
  return {
    log,
    query: async (sql, params) => {
      log.push({ sql, params });
      return handler(sql, params) || { rows: [], rowCount: 0 };
    },
  };
}
const SNAP = (extra = {}) => ({
  row: { account_id: "acc_1", transaction_id: "txn_1", amount: 9.99, date: "2026-10-01", merchant_name: "NETFLIX.COM", name: "NETFLIX.COM", ...extra },
  splits: [],
});
const CATALOG = ["account_id", "transaction_id", "amount", "date", "merchant_name", "name", "user_merchant_name", "user_merchant_rule_id"];
function restoreClient({ snapshot = SNAP(), changed = null, removed = null, rule = null } = {}) {
  return fakeClient((sql, params) => {
    if (/SELECT snapshot, source, bank_changed_at, bank_removed_at FROM deleted_transactions/.test(sql)) {
      return { rows: [{ snapshot, source: "plaid", bank_changed_at: changed, bank_removed_at: removed }] };
    }
    if (/SELECT 1 FROM linked_accounts/.test(sql)) return { rows: [{}] };
    if (/information_schema\.columns/.test(sql)) return { rows: CATALOG.map((c) => ({ column_name: c })) };
    if (/INSERT INTO transactions/.test(sql)) return { rows: [{ transaction_id: "txn_1" }], rowCount: 1 };
    if (/SELECT rename_to, is_active FROM merchant_rename_rules/.test(sql)) return { rows: rule ? [rule] : [] };
    return null;
  });
}

// ---------------------------------------------------------------------------
describe("F6 — the bank's later changes to a deleted Plaid row", () => {
  it("a row the bank removed is a 409 and nothing is written", async () => {
    const c = restoreClient({ removed: new Date() });
    const out = await txns.restoreDeleted(c, "txn_1");
    assert.equal(out.status, 409);
    assert.equal(out.body.reason, "removed_by_bank");
    assert.ok(!c.log.some((x) => /^\s*(INSERT|DELETE|UPDATE)/.test(x.sql)));
  });
  it("a row the bank changed is restored and flagged stale; an unchanged one isn't", async () => {
    const stale = await txns.restoreDeleted(restoreClient({ changed: new Date() }), "txn_1");
    assert.equal(stale.status, 200);
    assert.equal(stale.body.stale, true);
    const fresh = await txns.restoreDeleted(restoreClient(), "txn_1");
    assert.equal(fresh.body.stale, undefined);
  });
  it("Plaid's modified / removed handlers mark the tombstone", () => {
    const src = read("teller", "routes", "investments.js");
    assert.match(src, /UPDATE deleted_transactions SET bank_changed_at = now\(\) WHERE transaction_id = \$1/);
    assert.match(src, /UPDATE deleted_transactions SET bank_removed_at = now\(\) WHERE transaction_id = \$1/);
    const db = read("teller", "services", "database.js");
    assert.match(db, /ALTER TABLE deleted_transactions ADD COLUMN IF NOT EXISTS bank_changed_at TIMESTAMPTZ/);
    assert.match(db, /ALTER TABLE deleted_transactions ADD COLUMN IF NOT EXISTS bank_removed_at TIMESTAMPTZ/);
  });
  it("the restore toast tells you to reconcile a stale row", () => {
    const ctx = { window: {}, document: { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] }, navigator: {}, localStorage: { getItem: () => null, setItem() {} }, console };
    ctx.window = ctx; ctx.self = ctx;
    const win = { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
    Object.assign(ctx, win);
    vm.createContext(ctx);
    try { vm.runInContext(read("teller", "public", "perfin-shared.js"), ctx); } catch { /* the DOM wiring past the exports is irrelevant here */ }
    const msg = ctx.restoreMessage || ctx.window.restoreMessage;
    assert.equal(typeof msg, "function");
    assert.match(msg({ restored: true, stale: true }), /Your bank changed it since you deleted it — run Reconcile Now/);
    assert.doesNotMatch(msg({ restored: true }), /bank changed/);
  });
});

// ---------------------------------------------------------------------------
describe("F5 — a restored row follows its rename rule as it is now", () => {
  const updates = (c) => c.log.filter((x) => /^UPDATE transactions SET user_merchant_name/.test(x.sql));
  it("an active rule's current name is applied", async () => {
    const c = restoreClient({ snapshot: SNAP({ user_merchant_name: "Old name", user_merchant_rule_id: 4 }), rule: { rename_to: "Netflix", is_active: true } });
    await txns.restoreDeleted(c, "txn_1");
    const u = updates(c);
    assert.equal(u.length, 1);
    assert.deepEqual(u[0].params, ["txn_1", "Netflix"]);
  });
  it("a deleted or switched-off rule's rename is cleared", async () => {
    for (const rule of [null, { rename_to: "Netflix", is_active: false }]) {
      const c = restoreClient({ snapshot: SNAP({ user_merchant_name: "Old name", user_merchant_rule_id: 4 }), rule });
      await txns.restoreDeleted(c, "txn_1");
      assert.match(updates(c)[0].sql, /SET user_merchant_name = NULL, user_merchant_rule_id = NULL/);
    }
  });
  it("a hand-renamed row keeps its name; every rule then applies", async () => {
    const c = restoreClient({ snapshot: SNAP({ user_merchant_name: "My name" }) });
    await txns.restoreDeleted(c, "txn_1");
    assert.equal(updates(c).length, 0);
    assert.ok(c.log.some((x) => /FROM merchant_rename_rules WHERE is_active = true/.test(x.sql)), "applyRenameRules ran on the client");
  });
});

// ---------------------------------------------------------------------------
describe("F41 — a new rename rule", () => {
  const rename = require("../teller/routes/merchant-rename");
  function pool(beforeKeys, stillCarried) {
    const log = [];
    return {
      log,
      query: async (sql, params) => {
        log.push({ sql, params });
        if (/SELECT DISTINCT/.test(sql) && /user_merchant_rule_id IS NOT NULL/.test(sql)) return { rows: beforeKeys.map((k) => ({ k })) };
        if (/INSERT INTO merchant_rename_rules/.test(sql)) return { rows: [{ id: 9, merchant_pattern: params[0], match_type: params[1], rename_to: params[2] }] };
        if (/= ANY\(\$1::text\[\]\)/.test(sql) && /SELECT DISTINCT/.test(sql)) return { rows: stillCarried.map((k) => ({ k })) };
        return { rows: [], rowCount: 0 };
      },
    };
  }
  it("takes rows another rule renamed, and re-keys only the keys no row still carries", async () => {
    const db = pool(["Amazon", "AMAZON PRIME"], ["Amazon"]);
    await rename.createRenameRule({ pattern: "AMAZON PRIME", matchType: "exact", renameTo: "Prime Video" }, db);
    const release = db.log.find((x) => /SET user_merchant_name = NULL, user_merchant_rule_id = NULL/.test(x.sql));
    assert.ok(release, "rows owned by another rule are released");
    assert.match(release.sql, /user_merchant_rule_id <> \$2/);
    assert.deepEqual(release.params, ["AMAZON PRIME", 9]);
    const rekeyAt = db.log.findIndex((x) => /UPDATE detected_subscriptions/.test(x.sql));
    assert.ok(rekeyAt > -1);
    const keys = db.log[rekeyAt].params[0];
    assert.deepEqual(keys, ["AMAZON PRIME"], "Amazon is still carried by the broad rule's other rows — not moved");
  });
});

// ---------------------------------------------------------------------------
describe("F46 / F47 — price changes", () => {
  it("the detection upsert keeps prior_amount and the flag until a later charge", () => {
    const src = read("scripts", "detect-subscriptions.js");
    assert.match(src, /prior_amount\s+= CASE WHEN EXCLUDED\.amount <> detected_subscriptions\.amount\s+THEN detected_subscriptions\.amount\s+ELSE detected_subscriptions\.prior_amount END/);
    assert.match(src, /WHEN EXCLUDED\.last_charged > detected_subscriptions\.last_charged THEN false\s+ELSE detected_subscriptions\.amount_changed END/);
  });
  it("the watchdog's early rise: 10–50% above, not a utility, once per charged amount", () => {
    const src = read("teller", "routes", "subscriptions.js");
    const at = src.indexOf("t.amount > ds.amount * 1.10");
    assert.ok(at > -1);
    const q = src.slice(at - 800, at + 800);
    assert.match(q, /t\.amount <= ds\.amount \* 1\.5/);
    assert.match(q, /ds\.category <> 'utility'/);
    assert.match(q, /ds\.price_alerted_amount IS DISTINCT FROM c\.amount/);
  });
});

// ---------------------------------------------------------------------------
describe("F43 — a reconcile renames the rows it recovers", () => {
  const tellerApi = require("../teller/services/teller-api");
  const originalTellerRequest = tellerApi.tellerRequest;
  let enr, log, rows;
  before(() => {
    tellerApi.tellerRequest = async (endpoint) => (endpoint.includes("/transactions") && !endpoint.includes("from_id") ? rows : []);
    delete require.cache[require.resolve("../teller/routes/enrollments")];
    enr = require("../teller/routes/enrollments");
  });
  after(() => {
    tellerApi.tellerRequest = originalTellerRequest;
    delete require.cache[require.resolve("../teller/routes/enrollments")];
  });
  beforeEach(() => {
    log = [];
    dbModule.pool.query = async (sql) => {
      log.push(sql);
      if (sql.includes("FROM teller_enrollments te") && sql.includes("status != 'SUSPENDED'")) {
        return { rows: [{ id: 7, enrollment_id: "enr_7", institution_name: "TestBank", access_token: "tok", last_synced_txn_date: "2026-10-01", status: "GOOD" }] };
      }
      if (sql.includes("FROM linked_accounts WHERE teller_enrollment_id")) return { rows: [{ account_id: "a1" }] };
      if (sql.includes("INSERT INTO transactions") && sql.includes("RETURNING (xmax = 0)")) return { rows: [{ inserted: true }] };
      return { rows: [] };
    };
    dbModule.pool.connect = async () => ({ query: dbModule.pool.query, release() {} });
  });
  const ranRules = () => log.some((s) => /FROM merchant_rename_rules WHERE is_active = true/.test(s));

  it("the Teller reconcile applies the rules after recovering a row — and never the anomaly check", async () => {
    rows = [{ id: "t1", account_id: "a1", amount: "-12.00", date: "2026-10-20", description: "NETFLIX.COM", status: "posted" }];
    const r = await enr.reconcileTeller(30);
    assert.equal(r.transactions_added, 1);
    assert.ok(ranRules());
    assert.ok(!log.some((s) => /last_anomaly_check_at/.test(s)), "INV-05");
  });
  it("nothing recovered → no rename pass", async () => {
    rows = [];
    await enr.reconcileTeller(30);
    assert.ok(!ranRules());
  });
  it("the Plaid reconcile renames what its walk added", () => {
    const src = read("teller", "routes", "investments.js");
    const fn = src.slice(src.indexOf("async function reconcilePlaidTransactions"));
    assert.match(fn.slice(0, fn.indexOf("\n}\n")), /await renameNewRows\(result && result\.transactions_added\)/);
  });
});

// ---------------------------------------------------------------------------
describe("F4 — CSV-overlap Resolve tombstones what it deletes", () => {
  it("snapshots + tombstones the rows, then deletes them, in one transaction", () => {
    const src = read("teller", "routes", "transactions.js");
    const at = src.indexOf('router.post("/api/transactions/csv-overlap/resolve"');
    const body = src.slice(at, src.indexOf("\n});", at));
    const tomb = body.indexOf("INSERT INTO deleted_transactions");
    const del = body.indexOf("DELETE FROM transactions");
    assert.ok(body.includes('"BEGIN"') && tomb > -1 && del > tomb && body.includes('"COMMIT"'));
    assert.match(body, /\$\{SOURCE_SQL\}/);
  });
});

// ---------------------------------------------------------------------------
describe("F54 — income top sources group by the display name", () => {
  it("the route and the Sheets mirror both read the rename", () => {
    const route = read("teller", "routes", "spending-analytics.js");
    const sheets = read("scripts", "sheets-sync.js");
    for (const src of [route, sheets]) {
      const at = src.indexOf("a rename wins (cycle-8 F54)");
      assert.ok(at > -1);
      assert.match(src.slice(at, at + 1200), /GROUP BY COALESCE\(t\.user_merchant_name, t\.merchant_name, t\.name\)/);
    }
  });
});
