// ============================================================================
// Cycle 8 — the E1 follow-ons
// ============================================================================
// PATCH /api/recurring-transfers/:id/forecast refusing an incoming transfer
// (400) apart from an unknown one (404); the rename re-key carrying a forecast
// setting onto the surviving row (query order and parameters over a fake db);
// the batch restore counting a legacy tombstone as `cleared`, not restored, and
// a legacy manual entry as `unrestorable`; GET /api/deleted-transactions'
// `restorable` per batch; Settings' header for a partly restorable batch and the
// cleared message, run in a vm; the migration's legacy batch backfill (its SQL
// and its ids against the route's pattern); the e2e config's PW_CHROMIUM_PATH.
// The database-backed half is tests/contract/e1-followons.contract.test.js.
// ============================================================================
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const express = require("express");
const supertest = require("supertest");

process.env.NEON_DATABASE_URL = process.env.NEON_DATABASE_URL || "postgres://mock:mock@localhost/mock";
process.env.TOKEN_ENCRYPTION_PASSPHRASE = process.env.TOKEN_ENCRYPTION_PASSPHRASE || "test-passphrase";

const dbModule = require("../teller/services/database");
const cashAlerts = require("../teller/services/cash-alerts");
const txns = require("../teller/routes/transactions");
const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const originalQuery = dbModule.pool.query;
const originalConnect = dbModule.pool.connect;
const origInvalidate = cashAlerts.invalidate;
afterEach(() => {
  dbModule.pool.query = originalQuery;
  dbModule.pool.connect = originalConnect;
  cashAlerts.invalidate = origInvalidate;
});
const mount = (mod) => { const app = express(); app.use(express.json()); app.use(require(mod)); return app; };

describe("PATCH /api/recurring-transfers/:id/forecast — direction", () => {
  function pool(updateRows, found) {
    const calls = [];
    dbModule.pool.query = async (sql, params) => {
      calls.push({ sql, params });
      if (/^UPDATE recurring_transfers/.test(sql.trim())) return { rows: updateRows };
      if (/SELECT direction FROM recurring_transfers WHERE id = \$1/.test(sql)) return { rows: found };
      return { rows: [] };
    };
    return calls;
  }

  it("writes only an outgoing transfer", async () => {
    const calls = pool([{ id: 3, direction: "outgoing", forecast_treatment: "bill" }], []);
    await supertest(mount("../teller/routes/subscriptions")).patch("/api/recurring-transfers/3/forecast").send({ treatment: "bill" }).expect(200);
    assert.match(calls[0].sql, /WHERE id = \$2 AND direction = 'outgoing'/);
    assert.equal(calls.length, 1, "no second read on success");
  });

  it("an incoming transfer is a 400; an unknown one a 404; neither invalidates", async () => {
    let invalidated = 0;
    cashAlerts.invalidate = () => { invalidated++; };
    pool([], [{ direction: "incoming" }]);
    const res = await supertest(mount("../teller/routes/subscriptions")).patch("/api/recurring-transfers/8/forecast").send({ treatment: "ignore" }).expect(400);
    assert.deepEqual(res.body, { error: "Only an outgoing transfer is in the forecast" });
    const calls = pool([], []);
    await supertest(mount("../teller/routes/subscriptions")).patch("/api/recurring-transfers/9/forecast").send({ treatment: "ignore" }).expect(404);
    assert.deepEqual(calls[1].params, [9]);
    assert.equal(invalidated, 0);
  });
});

describe("the rename re-key carries a forecast setting", () => {
  it("copies onto the surviving row before the old row is deactivated", () => {
    const src = read("teller", "routes", "merchant-rename.js");
    const body = src.slice(src.indexOf("async function rekeyDetectedRows"), src.indexOf("async function createRenameRule"));
    const at = (re) => body.search(re);
    assert.ok(at(/SET forecast_ignore = true/) > at(/UPDATE detected_subscriptions ds SET merchant_key/));
    assert.ok(at(/SET forecast_ignore = true/) < at(/UPDATE detected_subscriptions SET is_active = false/));
    assert.ok(at(/SET forecast_treatment = old\.forecast_treatment/) < at(/UPDATE recurring_transfers SET is_active = false/));
    // Only the active old rows the deactivation retires; only a survivor still on the default.
    assert.match(body, /ds\.is_active AND ds\.source != 'manual' AND ds\.forecast_ignore/);
    assert.match(body, /WHERE merchant_key = ANY\(\$1::text\[\]\) AND is_active AND forecast_treatment <> 'auto'/);
    assert.match(body, /o\.cadence_days = old\.cadence_days AND o\.direction = old\.direction/);
  });
});

// Legacy tombstones (no snapshot): csv_1 is lifted (cleared), manual_1 refused.
function legacyClient() {
  const log = [];
  return {
    log,
    release: () => {},
    query: async (sql, params) => {
      log.push({ sql, params });
      if (/SELECT transaction_id FROM deleted_transactions WHERE batch_id = \$1/.test(sql)) return { rows: [{ transaction_id: "csv_1" }, { transaction_id: "manual_1" }] };
      if (/SELECT snapshot, source, bank_changed_at, bank_removed_at FROM deleted_transactions/.test(sql)) return { rows: [{ snapshot: null, source: null, bank_changed_at: null, bank_removed_at: null }] };
      return { rows: [], rowCount: 0 };
    },
  };
}
const BATCH = "resolve_mvtn1_abc123";

describe("batch restore — legacy tombstones", () => {
  it("a lifted tombstone is `cleared`, not restored; a legacy manual entry is unrestorable", async () => {
    const c = legacyClient();
    dbModule.pool.connect = async () => c;
    const res = await supertest(mount("../teller/routes/transactions")).post(`/api/deleted-transactions/batches/${BATCH}/restore`).expect(200);
    assert.deepEqual(res.body, {
      batch_id: BATCH, restored: 0, already_present: 0, splits: 0, cleared: 1,
      skipped: [{ transaction_id: "manual_1", reason: "unrestorable", error: "This entry was deleted before undelete existed and can't be restored." }],
    });
    assert.ok(!c.log.some((x) => /merchant_rename_rules/.test(x.sql)), "nothing inserted, so no rules pass");
  });
});

describe("GET /api/deleted-transactions — restorable per batch", () => {
  it("returns the restorable count the SQL computes", async () => {
    let batchSql = "";
    dbModule.pool.query = async (sql) => {
      if (/GROUP BY batch_id/.test(sql)) { batchSql = sql; return { rows: [{ batch_id: BATCH, count: 3, deleted_at: "2026-10-20T12:00:00.000Z", restorable: 1 }] }; }
      return { rows: [] };
    };
    const res = await supertest(mount("../teller/routes/transactions")).get("/api/deleted-transactions").expect(200);
    assert.deepEqual(res.body.batches, [{ batch_id: BATCH, count: 3, deleted_at: "2026-10-20T12:00:00.000Z", restorable: 1 }]);
    assert.match(batchSql, /FILTER \(WHERE bank_removed_at IS NULL AND snapshot IS NOT NULL/);
    assert.match(batchSql, /la\.account_id = deleted_transactions\.snapshot->'row'->>'account_id'/);
  });
});

const esc = (s) => (s == null ? "" : String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"));
describe("Settings: a partly restorable batch", () => {
  const src = read("teller", "views", "settings.ejs");
  const code = src.slice(src.indexOf("var deletedItems = [];"), src.indexOf("async function loadOperatorChecks(refresh)"));
  const ctx = { esc, Number, String, Date, Array, isFinite, encodeURIComponent, document: { getElementById: () => null } };
  vm.runInNewContext(code, ctx);

  it("offers Restore all for the restorable rows and notes the rest", () => {
    const html = ctx.deletedBatchHtml({ batch_id: BATCH, count: 3, restorable: 1, deleted_at: null });
    assert.match(html, /— 3 rows · 2 can’t come back \(account gone or removed by the bank\)<button/);
    assert.match(html, /aria-label="Restore all 1 rows removed by the CSV overlap resolve"[^>]*>Restore all 1<\/button>/);
  });
  it("no button when nothing can come back; all of them without the field", () => {
    const none = ctx.deletedBatchHtml({ batch_id: BATCH, count: 2, restorable: 0, deleted_at: null });
    assert.doesNotMatch(none, /<button/);
    assert.match(none, /2 can’t come back/);
    const old = ctx.deletedBatchHtml({ batch_id: BATCH, count: 2, deleted_at: null });
    assert.match(old, />Restore all 2<\/button>/);
    assert.doesNotMatch(old, /can’t come back/);
  });
  it("the message names lifted legacy rows", () => {
    assert.equal(ctx.restoreBatchMessage({ restored: 0, cleared: 2, skipped: [] }),
      "Restored 0 transactions. 2 had no saved copy and will return with the next Reconcile Now or CSV re-import.");
  });
});

describe("the legacy batch backfill", () => {
  const db = read("teller", "services", "database.js");
  it("groups 2+ csv snapshot tombstones by deleted_at and touches only NULL rows", () => {
    const sql = db.slice(db.indexOf("UPDATE deleted_transactions d SET batch_id = g.batch_id"), db.indexOf("d.deleted_at = g.deleted_at") + 30);
    assert.match(sql, /'resolve_' \|\| substr\(md5\(deleted_at::text\), 1, 12\) \|\| '_legacy'/);
    assert.match(sql, /WHERE batch_id IS NULL AND snapshot IS NOT NULL AND source = 'csv'/);
    assert.match(sql, /GROUP BY deleted_at HAVING COUNT\(\*\) >= 2/);
    assert.match(sql, /WHERE d\.batch_id IS NULL AND d\.snapshot IS NOT NULL AND d\.source = 'csv' AND d\.deleted_at = g\.deleted_at/);
    assert.ok(db.indexOf("UPDATE deleted_transactions d SET batch_id") > db.indexOf("ADD COLUMN IF NOT EXISTS batch_id TEXT"));
  });
  it("its ids match the batch route's pattern", () => {
    for (const at of ["2026-09-01 10:00:00.123456+00", "2025-01-31 23:59:59+00"]) {
      const id = "resolve_" + crypto.createHash("md5").update(at).digest("hex").slice(0, 12) + "_legacy";
      assert.match(id, txns.BATCH_ID_RE);
    }
  });
});

describe("e2e config", () => {
  it("PW_CHROMIUM_PATH sets the executable; unset leaves the default", () => {
    const file = path.join(__dirname, "..", "e2e", "playwright.config.js");
    const load = (v) => {
      const prev = process.env.PW_CHROMIUM_PATH;
      if (v === undefined) delete process.env.PW_CHROMIUM_PATH; else process.env.PW_CHROMIUM_PATH = v;
      const src = fs.readFileSync(file, "utf8");
      const m = { exports: {} };
      vm.runInNewContext(src, { module: m, require: (x) => (x === "@playwright/test" ? { defineConfig: (c) => c } : require(x)), process, __dirname: path.dirname(file) });
      if (prev === undefined) delete process.env.PW_CHROMIUM_PATH; else process.env.PW_CHROMIUM_PATH = prev;
      return m.exports;
    };
    assert.equal(load("/opt/pw-browsers/chromium").use.launchOptions.executablePath, "/opt/pw-browsers/chromium");
    assert.equal(load(undefined).use.launchOptions, undefined);
  });
});
