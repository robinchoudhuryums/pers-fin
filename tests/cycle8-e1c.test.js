// ============================================================================
// Cycle 8 E1c (G5) — undo a whole CSV-overlap Resolve
// ============================================================================
// deleted_transactions.batch_id (one id per Resolve); POST
// /api/deleted-transactions/batches/:batch_id/restore over a fake client (each
// row through restoreDeleted in one transaction — a refused row skipped with
// its reason, the rename rules once, 400 / 404 / a throw rolled back); GET
// /api/deleted-transactions' batch_id per item and `batches`; and Settings →
// Deleted transactions' "Restore all N" run in a vm (escaped + labelled, the
// POST, the message, the reload, a refusal / a network failure re-enabling it).
// The database-backed half is tests/contract/resolve-undo-e1c.contract.test.js.
// ============================================================================
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const express = require("express");
const supertest = require("supertest");

process.env.NEON_DATABASE_URL = process.env.NEON_DATABASE_URL || "postgres://mock:mock@localhost/mock";
process.env.TOKEN_ENCRYPTION_PASSPHRASE = process.env.TOKEN_ENCRYPTION_PASSPHRASE || "test-passphrase";

const dbModule = require("../teller/services/database");
const txns = require("../teller/routes/transactions");
const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const originalQuery = dbModule.pool.query;
const originalConnect = dbModule.pool.connect;
afterEach(() => { dbModule.pool.query = originalQuery; dbModule.pool.connect = originalConnect; });
const mount = () => { const app = express(); app.use(express.json()); app.use(require("../teller/routes/transactions")); return app; };

function fakeClient(handler) {
  const log = [];
  return {
    log,
    query: async (sql, params) => { log.push({ sql, params }); const r = handler(sql, params); return r || { rows: [], rowCount: 0 }; },
    release: () => {},
  };
}
const TXN_COLS = ["account_id", "transaction_id", "amount", "date", "merchant_name", "name", "user_notes"];
const row = (id, account) => ({ account_id: account, transaction_id: id, amount: 4.5, date: "2026-10-01", merchant_name: "Cafe", name: "CAFE", user_notes: "kept" });
const BATCH = "resolve_mvtn1_abc123";

// A, B restorable (B already present); C's account is gone; D the bank removed.
function batchClient({ rows = ["A", "B", "C", "D"], throwOn = null } = {}) {
  const tomb = {
    A: { snapshot: { row: row("A", "csvacct"), splits: [{ amount: 2, category: "Food" }, { amount: 2.5, category: "Fun" }] } },
    B: { snapshot: { row: row("B", "csvacct"), splits: [] } },
    C: { snapshot: { row: row("C", "goneacct"), splits: [] } },
    D: { snapshot: { row: row("D", "csvacct"), splits: [] }, bank_removed_at: "2026-10-05T00:00:00Z" },
  };
  return fakeClient((sql, params) => {
    if (throwOn && throwOn.test(sql)) throw new Error("db down");
    if (/SELECT transaction_id FROM deleted_transactions WHERE batch_id = \$1/.test(sql)) return { rows: rows.map((id) => ({ transaction_id: id })) };
    if (/SELECT snapshot, source, bank_changed_at, bank_removed_at FROM deleted_transactions/.test(sql)) {
      const t = tomb[params[0]];
      return t ? { rows: [{ source: "csv", bank_changed_at: null, bank_removed_at: null, ...t }] } : { rows: [] };
    }
    if (/SELECT 1 FROM linked_accounts/.test(sql)) return { rows: params[0] === "goneacct" ? [] : [{}] };
    if (/information_schema\.columns/.test(sql)) {
      const cols = params[0] === "transactions" ? TXN_COLS : ["parent_transaction_id", "amount", "category"];
      return { rows: cols.map((c) => ({ column_name: c })) };
    }
    if (/INSERT INTO transactions/.test(sql)) {
      const id = JSON.parse(params[0]).transaction_id;
      return id === "B" ? { rows: [], rowCount: 0 } : { rows: [{ transaction_id: id }], rowCount: 1 };
    }
    if (/INSERT INTO transaction_splits/.test(sql)) return { rows: [], rowCount: JSON.parse(params[0]).length };
    return null;
  });
}
const sqls = (c) => c.log.map((x) => x.sql.trim());

describe("batch ids", () => {
  it("newBatchId matches the route's pattern and differs each time", () => {
    const a = txns.newBatchId(), b = txns.newBatchId();
    assert.match(a, txns.BATCH_ID_RE);
    assert.match(b, txns.BATCH_ID_RE);
    assert.notEqual(a, b);
  });
  it("Resolve tags its tombstones and returns the id; a single delete clears it on conflict", () => {
    const src = read("teller", "routes", "transactions.js");
    const resolve = src.slice(src.indexOf('router.post("/api/transactions/csv-overlap/resolve"'), src.indexOf("// DELETE /api/transactions/:id"));
    assert.match(resolve, /const batchId = newBatchId\(\);/);
    assert.match(resolve, /INSERT INTO deleted_transactions \(transaction_id, snapshot, source, batch_id\)/);
    assert.match(resolve, /batch_id = EXCLUDED\.batch_id/);
    assert.match(resolve, /\[ids, batchId\]/);
    assert.match(resolve, /res\.json\(deleted \? \{ deleted, batch_id: batchId \} : \{ deleted \}\)/);
    assert.match(src, /SET snapshot = EXCLUDED\.snapshot, source = EXCLUDED\.source, batch_id = NULL, deleted_at = now\(\)/);
    const db = read("teller", "services", "database.js");
    assert.match(db, /ALTER TABLE deleted_transactions ADD COLUMN IF NOT EXISTS batch_id TEXT/);
  });
});

describe("POST /api/deleted-transactions/batches/:batch_id/restore", () => {
  it("400s a malformed id without touching the database", async () => {
    let connected = 0;
    dbModule.pool.connect = async () => { connected++; return batchClient(); };
    for (const id of ["abc", "resolve_", "resolve_x_y;drop", "resolve_" + "a".repeat(20) + "_b"]) {
      await supertest(mount()).post(`/api/deleted-transactions/batches/${encodeURIComponent(id)}/restore`).expect(400);
    }
    assert.equal(connected, 0);
  });

  it("404 and a rollback when nothing of the batch is still deleted", async () => {
    const c = batchClient({ rows: [] });
    dbModule.pool.connect = async () => c;
    await supertest(mount()).post(`/api/deleted-transactions/batches/${BATCH}/restore`).expect(404);
    assert.deepEqual(sqls(c).filter((s) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(s)), ["BEGIN", "ROLLBACK"]);
  });

  it("restores each row in one transaction, skips the refused ones with their reasons, runs the rename rules once", async () => {
    const c = batchClient();
    dbModule.pool.connect = async () => c;
    const res = await supertest(mount()).post(`/api/deleted-transactions/batches/${BATCH}/restore`).expect(200);
    assert.deepEqual(res.body, {
      batch_id: BATCH, restored: 1, already_present: 1, splits: 2,
      skipped: [
        { transaction_id: "C", reason: "account_gone", error: "The account this transaction belonged to is no longer connected, so it can't be restored." },
        { transaction_id: "D", reason: "removed_by_bank", error: "Your bank has since removed this transaction (reversed or voided), so it isn't restored." },
      ],
    });
    const s = sqls(c);
    assert.deepEqual(s.filter((x) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(x)), ["BEGIN", "COMMIT"]);
    assert.match(c.log[1].sql, /WHERE batch_id = \$1 ORDER BY transaction_id FOR UPDATE/);
    assert.deepEqual(c.log[1].params, [BATCH]);
    assert.equal(s.filter((x) => /FROM merchant_rename_rules WHERE is_active = true/.test(x)).length, 1, "the rules run once, after the rows are back");
    // A refused row's tombstone stays: only A and B are lifted.
    const lifted = c.log.filter((x) => /^DELETE FROM deleted_transactions WHERE transaction_id = \$1$/.test(x.sql.trim())).map((x) => x.params[0]);
    assert.deepEqual(lifted, ["A", "B"]);
  });

  it("nothing restorable: no rename-rules pass, still a 200 listing every skip", async () => {
    const c = batchClient({ rows: ["C", "D"] });
    dbModule.pool.connect = async () => c;
    const res = await supertest(mount()).post(`/api/deleted-transactions/batches/${BATCH}/restore`).expect(200);
    assert.equal(res.body.restored, 0);
    assert.equal(res.body.skipped.length, 2);
    assert.ok(!sqls(c).some((x) => /merchant_rename_rules/.test(x)));
  });

  it("a throw rolls the whole batch back with a fixed 500", async () => {
    const c = batchClient({ throwOn: /INSERT INTO transaction_splits/ });
    dbModule.pool.connect = async () => c;
    const errs = [];
    const orig = console.error;
    console.error = (...a) => errs.push(a.join(" "));
    try {
      const res = await supertest(mount()).post(`/api/deleted-transactions/batches/${BATCH}/restore`).expect(500);
      assert.deepEqual(res.body, { error: "An internal error occurred." });
    } finally { console.error = orig; }
    assert.ok(sqls(c).includes("ROLLBACK"));
    assert.ok(!sqls(c).includes("COMMIT"));
  });
});

describe("GET /api/deleted-transactions — batch ids and batches", () => {
  it("each item carries its batch_id; `batches` lists every Resolve still holding a row", async () => {
    const seen = [];
    dbModule.pool.query = async (sql) => {
      seen.push(sql);
      if (/GROUP BY batch_id/.test(sql)) return { rows: [{ batch_id: BATCH, count: 3, deleted_at: "2026-10-20T12:00:00.000Z" }] };
      return { rows: [{ transaction_id: "csv_1", deleted_at: "2026-10-20T12:00:00.000Z", source: "csv", batch_id: BATCH, has_snapshot: true,
        cursor_at: "x", date: "2026-10-01", merchant: "Cafe", amount: "4.50", account_name: "Card", splits_count: 0 }] };
    };
    const res = await supertest(mount()).get("/api/deleted-transactions").expect(200);
    assert.equal(res.body.items[0].batch_id, BATCH);
    assert.deepEqual(res.body.batches, [{ batch_id: BATCH, count: 3, deleted_at: "2026-10-20T12:00:00.000Z" }]);
    const b = seen.find((x) => /GROUP BY batch_id/.test(x));
    assert.match(b, /WHERE batch_id IS NOT NULL/);
    assert.match(b, /ORDER BY MAX\(deleted_at\) DESC LIMIT 20/);
  });
});

// ---------------------------------------------------------------------------
// Settings → Deleted transactions (settings.ejs), in a vm
// ---------------------------------------------------------------------------
const esc = (s) => (s == null ? "" : String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"));
const slice = (src, from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `markers ${from} … ${to}`);
  return src.slice(a, b);
};
describe("Settings: Restore all for a Resolve", () => {
  const src = read("teller", "views", "settings.ejs");
  function load(api) {
    let handler = null;
    const els = {
      "deleted-transactions-body": { textContent: "", innerHTML: "", addEventListener: (_, fn) => { handler = fn; } },
      "deleted-transactions-count": { textContent: "" },
    };
    const calls = [], msgs = [];
    const ctx = {
      esc, isFinite, Number, String, Array, Date, encodeURIComponent,
      fmt: (n) => "$" + Number(n).toFixed(2),
      fmtDate: (d) => "D(" + d + ")",
      document: { getElementById: (id) => els[id] || null },
      apiFetch: async (url, opts) => { calls.push([url, opts && opts.method]); return api(url, opts); },
      writeOk: async (r) => r.ok,
      showMsg: (t, ok) => msgs.push([t, ok]),
      restoreTransaction: async () => ({ restored: true }),
    };
    vm.runInNewContext(slice(src, "var deletedItems = [];", "async function loadOperatorChecks(refresh)"), ctx);
    const click = async (value) => {
      const btn = { disabled: false, getAttribute: () => value };
      await handler({ target: { closest: (sel) => (sel === "[data-restore-batch]" ? btn : null) } });
      return btn;
    };
    return { ctx, els, calls, msgs, click };
  }
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const item = { transaction_id: "csv_1", deleted_at: "2026-10-20T12:00:00Z", source: "csv", legacy: false, restorable: true,
    date: "2026-10-01", merchant: "Cafe", amount: "4.50", account_name: "Card", splits_count: 0, batch_id: BATCH };
  const list = { items: [item], next: null, batches: [{ batch_id: BATCH, count: 3, deleted_at: "2026-10-20T12:00:00Z" }] };

  it("a labelled 'Restore all N' per batch above the rows; each row says it came from a resolve", async () => {
    const t = load(() => ok(list));
    await t.ctx.loadDeletedTransactions(false);
    const html = t.els["deleted-transactions-body"].innerHTML;
    assert.match(html, /<strong>Removed by a CSV overlap resolve<\/strong> — 3 rows · /);
    assert.match(html, new RegExp(`<button class="btn" data-restore-batch="${BATCH}" aria-label="Restore all 3 rows removed by the CSV overlap resolve on [^"]+"[^>]*>Restore all 3</button>`));
    assert.ok(html.indexOf("data-restore-batch") < html.indexOf("data-restore-deleted"), "the batches come first");
    assert.match(html, /by a CSV overlap resolve<button class="btn" data-restore-deleted="csv_1"/);
  });

  it("escapes a batch id and leaves the header out without batches", async () => {
    const t = load(() => ok({ items: [{ ...item, batch_id: null }], next: null, batches: [{ batch_id: '"><img>', count: 1, deleted_at: null }] }));
    await t.ctx.loadDeletedTransactions(false);
    assert.match(t.els["deleted-transactions-body"].innerHTML, /data-restore-batch="&quot;&gt;&lt;img&gt;"/);
    assert.match(t.els["deleted-transactions-body"].innerHTML, /— 1 row<button/);
    const t2 = load(() => ok({ items: [item], next: null, batches: [] }));
    await t2.ctx.loadDeletedTransactions(false);
    assert.doesNotMatch(t2.els["deleted-transactions-body"].innerHTML, /data-restore-batch/);
  });

  it("Restore all POSTs the batch, toasts the outcome and reloads the list", async () => {
    const replies = [ok(list), ok({ batch_id: BATCH, restored: 3, already_present: 0, splits: 0, skipped: [] }), ok({ items: [], next: null, batches: [] })];
    const t = load(() => replies.shift());
    await t.ctx.loadDeletedTransactions(false);
    await t.click(BATCH);
    assert.deepEqual(t.calls.slice(1), [
      [`/api/deleted-transactions/batches/${BATCH}/restore`, "POST"],
      ["/api/deleted-transactions?limit=50", undefined],
    ]);
    assert.deepEqual(t.msgs, [["Restored 3 transactions.", true]]);
    assert.equal(t.els["deleted-transactions-body"].textContent, "No deleted transactions.");
  });

  it("skipped and stale rows are named in the message, which is then not a success", async () => {
    const replies = [ok(list), ok({ restored: 1, skipped: [{ transaction_id: "x", reason: "account_gone" }], stale: 1 }), ok(list)];
    const t = load(() => replies.shift());
    await t.ctx.loadDeletedTransactions(false);
    await t.click(BATCH);
    assert.deepEqual(t.msgs, [["Restored 1 transaction. 1 couldn’t be restored (their account is gone or the bank removed them) and stay deleted. 1 changed at the bank while deleted — run Reconcile Now to refresh them.", false]]);
  });

  it("a refusal or a network failure puts the button back and reloads nothing", async () => {
    const replies = [ok(list), { ok: false, status: 404, json: async () => ({ error: "gone" }) }];
    const t = load(() => replies.shift());
    await t.ctx.loadDeletedTransactions(false);
    const b = await t.click(BATCH);
    assert.equal(b.disabled, false);
    assert.equal(t.calls.length, 2);

    let n = 0;
    const t2 = load(() => { if (n++ === 0) return ok(list); throw new Error("offline"); });
    await t2.ctx.loadDeletedTransactions(false);
    const b2 = await t2.click(BATCH);
    assert.equal(b2.disabled, false);
    assert.deepEqual(t2.msgs, [["Couldn't restore the transactions — check your connection.", false]]);
  });
});
