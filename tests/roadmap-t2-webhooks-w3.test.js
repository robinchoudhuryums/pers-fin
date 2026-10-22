// ============================================================================
// Roadmap T2.1 — W3: a Plaid SYNC_UPDATES_AVAILABLE webhook syncs that item
// ============================================================================
// Mock pool + a stubbed Plaid client, driving the REAL code:
//  - syncPlaidItem(id): only that GOOD item (its own token), under the Plaid
//    lock (waits for a running all-items sync), plaid_items.last_synced_at
//    stamped only when the walk reached the end, no global last_txn_sync_at /
//    last_sync_result write; an unknown item is { ok:false, error:'not_found' };
//  - coalescing: requests while an item's sync is in flight share it and make
//    it go round exactly once more; another item is not coalesced;
//  - syncAllPlaidTransactions still aggregates every item through
//    syncOnePlaidItem (counts, decryption failure, per-item stamp);
//  - runPostSyncSteps: nothing for 0 rows; rename rules before the anomaly
//    check; two at once run one after the other; syncAllTransactions uses it;
//  - the handler: SYNC_UPDATES_AVAILABLE → that item → post-sync steps → done;
//    an unknown / non-GOOD item and every other event → ignored; a failed item
//    sync still names + checks the rows it added, then fails the event;
//  - the production router: a verified event recorded, answered 200, then
//    the item synced and the row finished 'done'.
// The database-backed half is tests/contract/webhooks-w3.contract.test.js.

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const dbModule = require("../teller/services/database");
const plaidClientModule = require("../teller/services/plaid-client");
const notifications = require("../teller/routes/notifications");
const rename = require("../teller/routes/merchant-rename");

const originalQuery = dbModule.pool.query;
const originalGetPlaidClient = plaidClientModule.getPlaidClient;
const originalSendToAll = notifications.sendToAll;
const originalApplyRename = rename.applyRenameRules;

let S;
let inv;
let enr;
before(() => {
  plaidClientModule.getPlaidClient = () => S.plaid;
  for (const m of ["investments", "enrollments", "plaid-webhook-events", "webhooks"]) {
    delete require.cache[require.resolve("../teller/routes/" + m)];
  }
  inv = require("../teller/routes/investments");
  enr = require("../teller/routes/enrollments");
});
after(() => {
  plaidClientModule.getPlaidClient = originalGetPlaidClient;
  dbModule.pool.query = originalQuery;
  notifications.sendToAll = originalSendToAll;
  rename.applyRenameRules = originalApplyRename;
});
afterEach(() => {
  dbModule.pool.query = originalQuery;
  notifications.sendToAll = originalSendToAll;
  rename.applyRenameRules = originalApplyRename;
});

const ITEMS = [
  { id: 7, item_id: "it_7", institution_name: "Capital Bank", access_token: "tok_7" },
  { id: 8, item_id: "it_8", institution_name: "Other Bank", access_token: "tok_8" },
];
const txn = (id) => ({ account_id: "acc_7", transaction_id: id, amount: 12.5, date: "2026-10-20", name: "COFFEE" });

// One ordered log of DB queries and Plaid calls.
function setup({ items = ITEMS, pages = {}, db } = {}) {
  S = { log: [], sent: [] };
  S.plaid = {
    accountsGet: async (req) => { S.log.push({ plaid: "accountsGet", token: req.access_token }); return { data: { accounts: [] } }; },
    transactionsSync: async (req) => {
      S.log.push({ plaid: "transactionsSync", token: req.access_token });
      const p = pages[req.access_token];
      const page = typeof p === "function" ? await p() : p;
      return { data: { added: [], modified: [], removed: [], next_cursor: "c1", has_more: false, ...(page || {}) } };
    },
    liabilitiesGet: async () => { throw Object.assign(new Error("n/a"), { response: { data: { error_code: "NO_LIABILITY_ACCOUNTS" } } }); },
  };
  dbModule.pool.query = async (sql, params = []) => {
    S.log.push({ sql, params });
    if (db) { const r = await db(sql, params); if (r) return r; }
    if (sql.includes("FROM plaid_items pi") && sql.includes("WHERE pi.status = 'GOOD'")) {
      if (sql.includes("AND pi.id = $2")) return { rows: items.filter((i) => i.id === params[1]) };
      return { rows: items };
    }
    if (sql.includes("SELECT cursor FROM sync_cursors")) return { rows: [{ cursor: "" }] };
    if (sql.includes("RETURNING (xmax = 0) AS inserted")) return { rows: [{ inserted: true }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  notifications.sendToAll = async (payload) => { S.sent.push(payload); return { sent: 1 }; };
}
const ran = (re) => S.log.filter((q) => q.sql && re.test(q.sql));
const plaidCalls = (name) => S.log.filter((q) => q.plaid === name);
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
const tick = () => new Promise((r) => setImmediate(r));

describe("W3 — syncPlaidItem: one item, on demand", () => {
  it("syncs only that GOOD item with its own token, stamps its last_synced_at, and writes nothing global", async () => {
    setup({ pages: { tok_7: { added: [txn("t1")] } } });
    const r = await inv.syncPlaidItem(7);
    assert.equal(r.ok, true);
    assert.equal(r.runs, 1);
    assert.equal(r.added, 1);
    assert.equal(r.failed, false);
    assert.deepEqual(plaidCalls("transactionsSync").map((c) => c.token), ["tok_7"]);
    const sel = ran(/FROM plaid_items pi/)[0];
    assert.match(sel.sql, /perfin_try_decrypt\(pi\.access_token_enc, \$1\)/);
    assert.match(sel.sql, /WHERE pi\.status = 'GOOD' AND pi\.id = \$2/);
    assert.equal(sel.params[1], 7);
    const stamp = ran(/UPDATE plaid_items SET last_synced_at = now\(\) WHERE id = \$1/);
    assert.equal(stamp.length, 1);
    assert.deepEqual(stamp[0].params, [7]);
    assert.equal(ran(/last_txn_sync_at|last_sync_result/).length, 0, "a webhook sync records nothing globally");
    assert.equal(ran(/last_anomaly_check_at/).length, 0, "post-sync steps are the caller's");
  });

  it("an unknown item is not_found and calls Plaid for nothing", async () => {
    setup();
    assert.deepEqual(await inv.syncPlaidItem(99), { ok: false, error: "not_found" });
    assert.equal(plaidCalls("transactionsSync").length + plaidCalls("accountsGet").length, 0);
  });

  it("a walk that stopped on a failed row is not stamped and is reported", async () => {
    setup({
      pages: { tok_7: { added: [txn("t1")] } },
      db: async (sql) => { if (sql.includes("RETURNING (xmax = 0) AS inserted")) throw new Error("row boom"); },
    });
    const quiet = console.error; console.error = () => {};
    let r;
    try { r = await inv.syncPlaidItem(7); } finally { console.error = quiet; }
    assert.deepEqual(r.errors, [{ institution: "Capital Bank", error: "partial_sync_incomplete" }]);
    assert.equal(ran(/SET last_synced_at/).length, 0);
  });

  it("waits for a running all-items sync (the Plaid lock)", async () => {
    const g = gate();
    let first = true;
    setup({ pages: { tok_7: async () => { if (first) { first = false; await g.p; } return {}; } } });
    const all = inv.syncAllPlaidTransactions();
    await tick(); await tick();
    const one = inv.syncPlaidItem(8);
    await tick(); await tick();
    assert.deepEqual(plaidCalls("transactionsSync").map((c) => c.token), ["tok_7"], "the item sync is queued behind the lock");
    g.open();
    await all;
    await one;
    assert.deepEqual(plaidCalls("transactionsSync").map((c) => c.token), ["tok_7", "tok_8", "tok_8"]);
  });

  it("requests while an item's sync runs share it and make it go round exactly once more", async () => {
    const g = gate();
    let n = 0;
    setup({ pages: { tok_7: async () => { n++; if (n === 1) await g.p; return { added: [txn("t" + n)] }; } } });
    const a = inv.syncPlaidItem(7);
    await tick(); await tick();
    const b = inv.syncPlaidItem(7);
    const c = inv.syncPlaidItem(7);
    assert.equal(b, a);
    assert.equal(c, a);
    g.open();
    const r = await a;
    assert.equal(r.runs, 2);
    assert.equal(r.added, 2);
    assert.equal(plaidCalls("transactionsSync").length, 2);
    // Finished → the next request starts a fresh sync.
    const d = await inv.syncPlaidItem(7);
    assert.equal(d.runs, 1);
    assert.equal(plaidCalls("transactionsSync").length, 3);
  });

  it("a different item is not coalesced", async () => {
    setup();
    const [a, b] = await Promise.all([inv.syncPlaidItem(7), inv.syncPlaidItem(8)]);
    assert.equal(a.runs, 1);
    assert.equal(b.runs, 1);
    assert.deepEqual(plaidCalls("transactionsSync").map((c) => c.token).sort(), ["tok_7", "tok_8"]);
  });
});

describe("W3 — syncAllPlaidTransactions goes through syncOnePlaidItem", () => {
  it("aggregates every item, counts a decryption failure, stamps each clean item", async () => {
    setup({
      items: [ITEMS[0], { id: 9, item_id: "it_9", institution_name: "Locked Bank", access_token: null }],
      pages: { tok_7: { added: [txn("t1"), txn("t2")] } },
    });
    const r = await inv.syncAllPlaidTransactions();
    assert.equal(r.items_synced, 1);
    assert.equal(r.transactions_added, 2);
    assert.deepEqual(r.errors, [{ institution: "Locked Bank", error: "decryption_failed" }]);
    assert.deepEqual(ran(/SET last_synced_at/).map((q) => q.params[0]), [7]);
  });

  it("a thrown item sync is a failed item and records its re-auth code", async () => {
    setup({
      items: [ITEMS[0]],
      pages: { tok_7: async () => { throw Object.assign(new Error("login"), { response: { data: { error_code: "ITEM_LOGIN_REQUIRED", error_message: "login required" } } }); } },
    });
    const quiet = console.error; console.error = () => {};
    let r;
    try { r = await inv.syncAllPlaidTransactions(); } finally { console.error = quiet; }
    assert.equal(r.items_synced, 0);
    assert.deepEqual(r.errors, [{ institution: "Capital Bank", error: "login required" }]);
    assert.equal(ran(/UPDATE plaid_items SET last_error_code = \$2/).length, 1);
    assert.equal(ran(/SET last_synced_at/).length, 0);
  });
});

describe("W3 — runPostSyncSteps", () => {
  let anomalySelects = 0;
  function postSyncDb() {
    anomalySelects = 0;
    return async (sql) => {
      if (sql.includes("SELECT last_anomaly_check_at FROM user_settings")) { anomalySelects++; return { rows: [{ last_anomaly_check_at: null }] }; }
    };
  }

  it("does nothing when no rows were added", async () => {
    setup({ db: postSyncDb() });
    let renamed = 0;
    rename.applyRenameRules = async () => { renamed++; };
    await enr.runPostSyncSteps(0);
    await enr.runPostSyncSteps(undefined);
    assert.equal(renamed, 0);
    assert.equal(anomalySelects, 0);
  });

  it("names the new rows before the anomaly check; a rename error doesn't stop the check", async () => {
    setup({ db: postSyncDb() });
    const order = [];
    rename.applyRenameRules = async () => { order.push("rename"); throw new Error("rule boom"); };
    const real = dbModule.pool.query;
    dbModule.pool.query = async (sql, p) => { if (sql.includes("last_anomaly_check_at FROM")) order.push("anomaly"); return real(sql, p); };
    const quiet = console.error; console.error = () => {};
    try { await enr.runPostSyncSteps(3); } finally { console.error = quiet; }
    assert.deepEqual(order, ["rename", "anomaly"]);
  });

  it("two at once run one after the other (the second reads the advanced watermark)", async () => {
    setup({ db: postSyncDb() });
    const g = gate();
    const order = [];
    let calls = 0;
    rename.applyRenameRules = async () => { calls++; order.push("rename" + calls); if (calls === 1) await g.p; };
    const real = dbModule.pool.query;
    dbModule.pool.query = async (sql, p) => {
      if (sql.includes("last_anomaly_check_at FROM")) order.push("check");
      if (sql.includes("UPDATE user_settings SET last_anomaly_check_at")) order.push("advance");
      return real(sql, p);
    };
    const a = enr.runPostSyncSteps(1);
    const b = enr.runPostSyncSteps(1);
    await tick(); await tick();
    assert.deepEqual(order, ["rename1"], "the second waits for the first");
    g.open();
    await Promise.all([a, b]);
    assert.deepEqual(order, ["rename1", "check", "advance", "rename2", "check", "advance"]);
  });

  it("syncAllTransactions runs it once over the combined count; the rename pin moved with it", () => {
    const src = read("teller/routes/enrollments.js");
    const once = src.slice(src.indexOf("async function syncAllTransactionsOnce()"), src.indexOf("// runPostSyncSteps —"));
    assert.match(once, /await runPostSyncSteps\(tellerAdded \+ plaidAdded\);/);
    assert.doesNotMatch(once, /runAnomalyCheck\(\)/);
    assert.match(src, /module\.exports\.runPostSyncSteps = runPostSyncSteps;/);
  });
});

describe("W3 — the Plaid event handler", () => {
  const { createPlaidEventHandler } = require("../teller/routes/plaid-webhook-events");
  function handlerWith({ rows = [{ id: 7 }], result = { ok: true, added: 2, failed: false } } = {}) {
    const calls = { db: [], sync: [], post: [] };
    const h = createPlaidEventHandler({
      db: { query: async (sql, params) => { calls.db.push({ sql, params }); return { rows }; } },
      syncItem: async (id) => { calls.sync.push(id); return result; },
      postSync: async (n) => { calls.post.push(n); },
    });
    return { h, calls };
  }
  const SYNC = { type: "TRANSACTIONS", code: "SYNC_UPDATES_AVAILABLE", subject: "it_7" };

  it("SYNC_UPDATES_AVAILABLE syncs that GOOD item, runs the post-sync steps, and is done", async () => {
    const { h, calls } = handlerWith();
    assert.deepEqual(await h(SYNC, { id: 1, provider: "plaid" }), { status: "done" });
    assert.match(calls.db[0].sql, /FROM plaid_items WHERE item_id = \$1 AND status = 'GOOD'/);
    assert.deepEqual(calls.db[0].params, ["it_7"]);
    assert.deepEqual(calls.sync, [7]);
    assert.deepEqual(calls.post, [2]);
  });

  it("an unknown or non-GOOD item (a CSV item, one unlinked since) is ignored", async () => {
    const { h, calls } = handlerWith({ rows: [] });
    assert.deepEqual(await h(SYNC), { status: "ignored" });
    assert.deepEqual(calls.sync, []);
    const noSubject = handlerWith();
    assert.deepEqual(await noSubject.h({ ...SYNC, subject: null }), { status: "ignored" });
    assert.equal(noSubject.calls.db.length, 0);
  });

  it("every other event is ignored without a query (item events come with W4)", async () => {
    const { h, calls } = handlerWith();
    for (const ev of [
      { type: "TRANSACTIONS", code: "DEFAULT_UPDATE", subject: "it_7" },
      { type: "ITEM", code: "ERROR", subject: "it_7" },
      { type: "HOLDINGS", code: "DEFAULT_UPDATE", subject: "it_7" },
      {},
    ]) assert.deepEqual(await h(ev), { status: "ignored" });
    assert.equal(calls.db.length, 0);
  });

  it("an item gone by the time its sync ran is ignored", async () => {
    const { h, calls } = handlerWith({ result: { ok: false, error: "not_found" } });
    assert.deepEqual(await h(SYNC), { status: "ignored" });
    assert.deepEqual(calls.post, []);
  });

  it("a failed item sync still names + checks what it added, then fails the event", async () => {
    const { h, calls } = handlerWith({ result: { ok: true, added: 1, failed: true } });
    await assert.rejects(() => h(SYNC), /Plaid item sync failed/);
    assert.deepEqual(calls.post, [1]);
  });

  it("the router's default Plaid handler is this one, required lazily", () => {
    const src = read("teller/routes/webhooks.js");
    assert.match(src, /plaid: \(event, ctx\) => require\("\.\/plaid-webhook-events"\)\.handlePlaidEvent\(event, ctx\)/);
    assert.doesNotMatch(src, /^\s*teller:/m, "Teller events wait for W5");
  });
});

describe("W3 — through the production router", () => {
  it("a verified SYNC_UPDATES_AVAILABLE is answered 200, then the item is synced and the row is done", async () => {
    const statuses = [];
    let finished;
    const done = new Promise((r) => { finished = r; });
    setup({
      pages: { tok_7: { added: [txn("t1")] } },
      db: async (sql, params) => {
        if (sql.includes("INSERT INTO webhook_events")) return { rows: [{ id: 41 }] };
        if (sql.includes("SELECT id FROM plaid_items WHERE item_id = $1")) return { rows: ITEMS.filter((i) => i.item_id === params[0]).map((i) => ({ id: i.id })) };
        if (sql.includes("UPDATE webhook_events SET status = $2")) { statuses.push(params[1]); finished(); }
        if (sql.includes("UPDATE webhook_events SET status = 'processing'")) statuses.push("processing");
      },
    });
    rename.applyRenameRules = async () => 0;
    const { createWebhookRouter } = require("../teller/routes/webhooks");
    const router = createWebhookRouter({
      verifiers: { plaid: { configured: () => true, verify: async () => ({ ok: true, dedupeKey: "jwt:x", event: { type: "TRANSACTIONS", code: "SYNC_UPDATES_AVAILABLE", subject: "it_7" } }) } },
    });
    const app = express();
    app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
    app.use(router);
    const res = await supertest(app).post("/api/webhooks/plaid").send({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "it_7" });
    assert.equal(res.status, 200);
    await done;
    assert.deepEqual(statuses, ["processing", "done"]);
    assert.deepEqual(plaidCalls("transactionsSync").map((c) => c.token), ["tok_7"]);
    assert.equal(ran(/SELECT last_anomaly_check_at FROM user_settings/).length, 1, "one anomaly check for the row it added");
    assert.equal(ran(/last_txn_sync_at|last_sync_result/).length, 0);
  });
});
