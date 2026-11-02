// Roadmap T2.5 U1 — transaction undelete (server side) + CSV imports that
// honour the tombstone. The database-backed half is
// tests/contract/undelete-t2-5.contract.test.js.
//
//   * DELETE /api/transactions/:id keeps the row + its splits (snapshot) and
//     the connection it came from (source) in deleted_transactions.
//   * GET /api/deleted-transactions lists them (newest first, keyset cursor).
//   * POST /api/deleted-transactions/:id/restore puts the snapshot back in one
//     transaction; a legacy tombstone is lifted with how the row returns.
//   * The CSV preview, import and CLI skip a tombstoned id.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const supertest = require("supertest");

process.env.NEON_DATABASE_URL = process.env.NEON_DATABASE_URL || "postgres://u:p@127.0.0.1:1/none";
process.env.TOKEN_ENCRYPTION_PASSPHRASE = process.env.TOKEN_ENCRYPTION_PASSPHRASE || "test-passphrase";

const dbModule = require("../teller/services/database");
const txns = require("../teller/routes/transactions");
const { makeCsvTxnIdGenerator } = require("../teller/data/csv-formats");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const originalQuery = dbModule.pool.query;
const originalConnect = dbModule.pool.connect;
afterEach(() => { dbModule.pool.query = originalQuery; dbModule.pool.connect = originalConnect; });

const mount = (mod) => { const app = express(); app.use(express.json()); app.use(require(mod)); return app; };

// A fake client that records every statement and answers through `handler`.
function fakeClient(handler) {
  const log = [];
  return {
    log,
    query: async (sql, params) => {
      log.push({ sql, params });
      const r = handler(sql, params);
      return r || { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
}
const sqls = (c) => c.log.map((x) => x.sql);

const TXN_COLS = ["id", "account_id", "transaction_id", "amount", "iso_currency_code", "date", "merchant_name", "name",
  "category", "pending", "created_at", "user_category", "user_notes", "user_merchant_name", "is_reimbursed"];
const SPLIT_COLS = ["id", "parent_transaction_id", "amount", "category", "merchant_name", "notes", "created_at"];

function catalog(sql, params) {
  if (/information_schema\.columns/.test(sql)) {
    // Answers as Postgres would: the query's own `column_name <> 'id'` applies.
    const cols = (params[0] === "transactions" ? TXN_COLS : SPLIT_COLS)
      .filter((c) => !(c === "id" && /column_name <> 'id'/.test(sql)));
    return { rows: cols.map((c) => ({ column_name: c })) };
  }
  return null;
}

const SNAPSHOT = {
  row: {
    id: 77, account_id: "acc_1", transaction_id: "txn_abc", amount: 42.5, date: "2026-09-14",
    merchant_name: "STARBUCKS", name: "STARBUCKS 123", category: ["Food"], pending: false,
    created_at: "2026-09-14T12:00:00+00:00", user_category: "Dining", user_notes: "with Sam",
    user_merchant_name: "Starbucks", is_reimbursed: false, dropped_since: "x",
  },
  splits: [
    { id: 5, parent_transaction_id: "txn_abc", amount: 30, category: "Dining", merchant_name: null, notes: "me", created_at: "2026-09-15T00:00:00+00:00" },
    { id: 6, parent_transaction_id: "txn_abc", amount: 12.5, category: "Gifts", merchant_name: null, notes: null, created_at: "2026-09-15T00:00:00+00:00" },
  ],
};

describe("T2.5 U1 — the delete keeps a snapshot", () => {
  it("snapshots the row + splits and the source under FOR UPDATE, then deletes and writes the tombstone", async () => {
    const c = fakeClient((sql) => {
      if (/FOR UPDATE OF t/.test(sql)) return { rows: [{ snapshot: SNAPSHOT, source: "teller" }] };
      return null;
    });
    dbModule.pool.connect = async () => c;
    const res = await supertest(mount("../teller/routes/transactions")).delete("/api/transactions/txn_abc").expect(200);
    assert.deepEqual(res.body, { deleted: true, transaction_id: "txn_abc" });
    const s = sqls(c);
    const snapAt = s.findIndex((x) => /FOR UPDATE OF t/.test(x));
    const delAt = s.findIndex((x) => /^DELETE FROM transactions WHERE transaction_id = \$1$/.test(x));
    const tombAt = s.findIndex((x) => /INSERT INTO deleted_transactions/.test(x));
    assert.ok(s[0] === "BEGIN" && snapAt > 0 && delAt > snapAt && tombAt > delAt && s[s.length - 1] === "COMMIT");
    assert.match(s[snapAt], /'row', to_jsonb\(t\)/);
    assert.match(s[snapAt], /jsonb_agg\(to_jsonb\(s\) ORDER BY s\.id\)/);
    assert.match(s[snapAt], /WHEN la\.teller_enrollment_id IS NOT NULL THEN 'teller'/);
    assert.match(s[snapAt], /WHEN pi\.status = 'CSV' THEN 'csv'/);
    const tomb = c.log[tombAt];
    assert.match(tomb.sql, /ON CONFLICT \(transaction_id\) DO UPDATE\s+SET snapshot = EXCLUDED\.snapshot, source = EXCLUDED\.source, batch_id = NULL, deleted_at = now\(\)/);
    assert.deepEqual(JSON.parse(tomb.params[1]), SNAPSHOT);
    assert.equal(tomb.params[2], "teller");
  });

  it("404s an unknown id without deleting or writing a tombstone", async () => {
    const c = fakeClient(() => null);
    dbModule.pool.connect = async () => c;
    await supertest(mount("../teller/routes/transactions")).delete("/api/transactions/nope").expect(404);
    assert.ok(!sqls(c).some((x) => /^DELETE FROM transactions|INSERT INTO deleted_transactions/.test(x)));
    assert.equal(sqls(c).pop(), "ROLLBACK");
  });

  it("the migration adds the snapshot and source columns", () => {
    const db = read("teller", "services", "database.js");
    assert.match(db, /ALTER TABLE deleted_transactions ADD COLUMN IF NOT EXISTS snapshot JSONB/);
    assert.match(db, /ALTER TABLE deleted_transactions ADD COLUMN IF NOT EXISTS source TEXT/);
  });
});

describe("T2.5 U1 — restore", () => {
  it("legacySource reads the id's shape", () => {
    assert.equal(txns.legacySource("csv_9f00"), "csv");
    assert.equal(txns.legacySource("manual_1700_ab"), "manual");
    assert.equal(txns.legacySource("txn_xyz"), "teller");
    assert.equal(txns.legacySource("Ab12Cd34"), null);
  });

  it("404 for an id that isn't deleted", async () => {
    const c = fakeClient(() => null);
    const out = await txns.restoreDeleted(c, "nope");
    assert.equal(out.status, 404);
    assert.ok(!sqls(c).some((x) => /^DELETE|INSERT/.test(x)));
  });

  it("re-inserts the snapshot's current columns (no id, no dropped column), its splits, and lifts the tombstone", async () => {
    const c = fakeClient((sql, params) => {
      if (/SELECT snapshot, source, bank_changed_at, bank_removed_at FROM deleted_transactions/.test(sql)) return { rows: [{ snapshot: SNAPSHOT, source: "teller" }] };
      if (/SELECT 1 FROM linked_accounts/.test(sql)) return { rows: [{}] };
      if (/INSERT INTO transactions/.test(sql)) return { rows: [{ transaction_id: "txn_abc" }], rowCount: 1 };
      if (/INSERT INTO transaction_splits/.test(sql)) return { rows: [], rowCount: 2 };
      return catalog(sql, params);
    });
    const out = await txns.restoreDeleted(c, "txn_abc");
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { restored: true, transaction_id: "txn_abc", already_present: false, splits: 2 });
    const ins = c.log.find((x) => /INSERT INTO transactions/.test(x.sql));
    assert.match(ins.sql, /jsonb_populate_record\(NULL::transactions, \$1::jsonb\)/);
    assert.match(ins.sql, /ON CONFLICT \(transaction_id\) DO NOTHING/);
    assert.ok(!/"id"/.test(ins.sql), "the serial id is not copied");
    assert.ok(!/dropped_since/.test(ins.sql), "a key that is no longer a column is dropped");
    assert.match(ins.sql, /"user_category"/);
    assert.match(ins.sql, /"user_notes"/);
    assert.deepEqual(JSON.parse(ins.params[0]), SNAPSHOT.row);
    const sp = c.log.find((x) => /INSERT INTO transaction_splits/.test(x.sql));
    assert.match(sp.sql, /jsonb_populate_recordset\(NULL::transaction_splits, \$1::jsonb\)/);
    assert.ok(!/"id"/.test(sp.sql));
    assert.equal(JSON.parse(sp.params[0]).length, 2);
    assert.ok(c.log.some((x) => /^DELETE FROM deleted_transactions WHERE transaction_id = \$1$/.test(x.sql)));
  });

  it("a row already present isn't duplicated and its splits aren't re-added", async () => {
    const c = fakeClient((sql, params) => {
      if (/SELECT snapshot, source, bank_changed_at, bank_removed_at FROM deleted_transactions/.test(sql)) return { rows: [{ snapshot: SNAPSHOT, source: "csv" }] };
      if (/SELECT 1 FROM linked_accounts/.test(sql)) return { rows: [{}] };
      return catalog(sql, params);
    });
    const out = await txns.restoreDeleted(c, "txn_abc");
    assert.deepEqual(out.body, { restored: true, transaction_id: "txn_abc", already_present: true, splits: 0 });
    assert.ok(!sqls(c).some((x) => /INSERT INTO transaction_splits/.test(x)));
  });

  it("409 with nothing written when the account is no longer connected", async () => {
    const c = fakeClient((sql) => {
      if (/SELECT snapshot, source, bank_changed_at, bank_removed_at FROM deleted_transactions/.test(sql)) return { rows: [{ snapshot: SNAPSHOT, source: "plaid" }] };
      return null;
    });
    const out = await txns.restoreDeleted(c, "txn_abc");
    assert.equal(out.status, 409);
    assert.match(out.body.error, /no longer connected/);
    assert.ok(!sqls(c).some((x) => /^INSERT|^DELETE/.test(x.trim())));
  });

  it("a legacy tombstone is lifted with how the row returns; a legacy manual entry is a 409", async () => {
    for (const [id, source, returnsOn] of [["csv_1", "csv", "csv_reimport"], ["txn_1", "teller", "reconcile"], ["Plaid9", null, "reconcile"]]) {
      const c = fakeClient((sql) => /SELECT snapshot/.test(sql) ? { rows: [{ snapshot: null, source: null }] } : null);
      const out = await txns.restoreDeleted(c, id);
      assert.equal(out.status, 200, id);
      assert.deepEqual(out.body, { restored: false, cleared: true, transaction_id: id, source, returns_on: returnsOn });
      assert.ok(c.log.some((x) => /^DELETE FROM deleted_transactions/.test(x.sql)));
      assert.ok(!c.log.some((x) => /INSERT INTO transactions/.test(x.sql)));
    }
    const c = fakeClient((sql) => /SELECT snapshot/.test(sql) ? { rows: [{ snapshot: null, source: null }] } : null);
    const out = await txns.restoreDeleted(c, "manual_1_x");
    assert.equal(out.status, 409);
    assert.equal(out.body.returns_on, "never");
    assert.ok(!c.log.some((x) => /^DELETE/.test(x.sql)), "the tombstone stays");
  });

  it("the route commits a restore and rolls back a refusal", async () => {
    const ok = fakeClient((sql, params) => {
      if (/SELECT snapshot, source/.test(sql)) return { rows: [{ snapshot: { row: SNAPSHOT.row, splits: [] }, source: "teller" }] };
      if (/SELECT 1 FROM linked_accounts/.test(sql)) return { rows: [{}] };
      if (/INSERT INTO transactions/.test(sql)) return { rows: [{ transaction_id: "txn_abc" }], rowCount: 1 };
      return catalog(sql, params);
    });
    dbModule.pool.connect = async () => ok;
    const r = await supertest(mount("../teller/routes/transactions")).post("/api/deleted-transactions/txn_abc/restore").expect(200);
    assert.equal(r.body.restored, true);
    assert.equal(sqls(ok).pop(), "COMMIT");

    const refused = fakeClient((sql) => /SELECT snapshot, source/.test(sql) ? { rows: [{ snapshot: SNAPSHOT, source: "teller" }] } : null);
    dbModule.pool.connect = async () => refused;
    await supertest(mount("../teller/routes/transactions")).post("/api/deleted-transactions/txn_abc/restore").expect(409);
    assert.equal(sqls(refused).pop(), "ROLLBACK");

    const boom = fakeClient((sql) => { if (/SELECT snapshot/.test(sql)) throw new Error("secret detail"); return null; });
    dbModule.pool.connect = async () => boom;
    const e = await supertest(mount("../teller/routes/transactions")).post("/api/deleted-transactions/x/restore").expect(500);
    assert.equal(e.body.error, "An internal error occurred.");
  });
});

describe("T2.5 U1 — the list", () => {
  it("400s a bad limit or cursor before querying", async () => {
    let queried = false;
    dbModule.pool.query = async () => { queried = true; return { rows: [] }; };
    const app = mount("../teller/routes/transactions");
    for (const q of ["limit=0", "limit=201", "limit=2.5", "limit=abc", "before=nonsense", "before=2026-09-14T12:00:00Z|x"]) {
      await supertest(app).get("/api/deleted-transactions?" + q).expect(400);
    }
    assert.equal(queried, false);
  });

  it("maps snapshot and legacy rows, and returns a cursor only when there is another page", async () => {
    let seen;
    dbModule.pool.query = async (sql, params) => {
      // Cycle-8 E1c: the Resolve batches are a second query.
      if (/GROUP BY batch_id/.test(sql)) return { rows: [] };
      seen = { sql, params };
      return { rows: [
        { transaction_id: "txn_abc", deleted_at: "2026-10-01T10:00:00.000Z", source: "teller", has_snapshot: true,
          cursor_at: "2026-10-01T10:00:00.123456Z", date: "2026-09-14", merchant: "Starbucks", amount: "42.50",
          account_name: "Checking", splits_count: 2 },
        { transaction_id: "manual_1_x", deleted_at: "2026-09-30T10:00:00.000Z", source: null, has_snapshot: false,
          cursor_at: "2026-09-30T10:00:00.000001Z", date: null, merchant: null, amount: null, account_name: null, splits_count: 0 },
        { transaction_id: "extra", deleted_at: "2026-09-29T10:00:00.000Z", source: null, has_snapshot: false, cursor_at: "x" },
      ] };
    };
    const res = await supertest(mount("../teller/routes/transactions"))
      .get("/api/deleted-transactions?limit=2&before=" + encodeURIComponent("2026-10-02T00:00:00.000000Z|zzz")).expect(200);
    assert.deepEqual(seen.params, ["2026-10-02T00:00:00.000000Z", "zzz", 3]);
    assert.match(seen.sql, /ORDER BY d\.deleted_at DESC, d\.transaction_id DESC/);
    assert.match(seen.sql, /\(d\.deleted_at, d\.transaction_id\) < \(\$1::timestamptz, \$2::text\)/);
    assert.match(seen.sql, /COALESCE\(d\.snapshot->'row'->>'user_merchant_name'/);
    assert.equal(res.body.items.length, 2);
    assert.deepEqual(res.body.items[0], {
      transaction_id: "txn_abc", deleted_at: "2026-10-01T10:00:00.000Z", source: "teller", legacy: false, restorable: true,
      date: "2026-09-14", merchant: "Starbucks", amount: 42.5, account_name: "Checking", splits_count: 2, batch_id: null,
    });
    assert.equal(res.body.items[1].legacy, true);
    assert.equal(res.body.items[1].source, "manual");
    assert.equal(res.body.items[1].restorable, false);
    assert.equal(res.body.items[1].amount, null);
    assert.equal(res.body.next, "2026-09-30T10:00:00.000001Z|manual_1_x");

    dbModule.pool.query = async () => ({ rows: [] });
    const empty = await supertest(mount("../teller/routes/transactions")).get("/api/deleted-transactions").expect(200);
    assert.deepEqual(empty.body, { items: [], next: null, batches: [] });
  });
});

describe("T2.5 U1 — CSV imports honour the tombstone", () => {
  const CSV = [
    "Transaction Date,Post Date,Description,Category,Type,Amount",
    "09/10/2026,09/11/2026,Cafe,Food & Drink,Sale,-20.00",
    "09/12/2026,09/13/2026,Gone,Misc,Sale,-7.00",
    "09/13/2026,09/14/2026,Here,Misc,Sale,-9.00",
  ].join("\n");
  const ids = () => {
    const gen = makeCsvTxnIdGenerator();
    return { cafe: gen("Chase Account", "2026-09-10", 20, "Cafe"), gone: gen("Chase Account", "2026-09-12", 7, "Gone"), here: gen("Chase Account", "2026-09-13", 9, "Here") };
  };

  it("the preview marks a deleted row 'deleted' and counts it apart from new and duplicate rows", async () => {
    const id = ids();
    dbModule.pool.query = async (sql, params) => {
      if (/FROM deleted_transactions/.test(sql)) return { rows: params[0].filter((x) => x === id.gone).map((x) => ({ transaction_id: x })) };
      if (/FROM transactions WHERE transaction_id = ANY/.test(sql)) return { rows: params[0].filter((x) => x === id.here).map((x) => ({ transaction_id: x })) };
      return { rows: [] };
    };
    const res = await supertest(mount("../teller/routes/subscriptions"))
      .post("/api/import-csv/preview").attach("file", Buffer.from(CSV), "chase.csv").expect(200);
    assert.equal(res.body.rows_new, 1);
    assert.equal(res.body.rows_duplicate, 1);
    assert.equal(res.body.rows_deleted, 1);
    assert.deepEqual(res.body.sample.map((r) => r.status), ["new", "deleted", "duplicate"]);
  });

  it("the import skips a deleted row (no insert issued) and reports rows_deleted", async () => {
    const id = ids();
    const c = fakeClient((sql, params) => {
      if (/FROM deleted_transactions WHERE transaction_id = ANY/.test(sql)) return { rows: params[0].filter((x) => x === id.gone).map((x) => ({ transaction_id: x })) };
      if (/INSERT INTO transactions/.test(sql)) return { rowCount: params[1] === id.here ? 0 : 1 };
      if (/SELECT id FROM plaid_items/.test(sql)) return { rows: [{ id: 1 }] };
      return null;
    });
    dbModule.pool.connect = async () => c;
    const res = await supertest(mount("../teller/routes/subscriptions"))
      .post("/api/import-csv").attach("file", Buffer.from(CSV), "chase.csv").expect(200);
    assert.equal(res.body.rows_imported, 1);
    assert.equal(res.body.rows_duplicate, 1);
    assert.equal(res.body.rows_deleted, 1);
    const inserts = c.log.filter((x) => /INSERT INTO transactions/.test(x.sql));
    assert.deepEqual(inserts.map((x) => x.params[1]).sort(), [id.cafe, id.here].sort());
    assert.match(inserts[0].sql, /WHERE NOT EXISTS \(SELECT 1 FROM deleted_transactions dt WHERE dt\.transaction_id = \$2::text\)/);
    assert.ok(Array.isArray(inserts[0].params[6]), "category stays a text[] parameter (DC-14)");
    const hist = c.log.find((x) => /INSERT INTO csv_imports/.test(x.sql));
    assert.equal(hist.params[4], 2, "history: not imported = duplicates + deleted");
  });

  it("the CLI skips a tombstoned id the same way", () => {
    const cli = read("scripts", "import-csv-cli.js");
    assert.match(cli, /INSERT INTO transactions[\s\S]{0,200}SELECT \$1::text, \$2::text, \$3::numeric[\s\S]{0,200}WHERE NOT EXISTS \(SELECT 1 FROM deleted_transactions dt WHERE dt\.transaction_id = \$2::text\)/);
    assert.match(cli, /\$7::text\[\]/);
    assert.match(cli, /deleted: deletedCount/);
  });
});
