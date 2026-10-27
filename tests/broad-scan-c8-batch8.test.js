// ============================================================================
// Cycle-8 broad scan Batch 8 — platform hygiene, Perfin's side
// ============================================================================
// F31: an IN-list CHECK declared inside CREATE TABLE IF NOT EXISTS is brought
// up to date on an existing table (syncInListChecks — replaced NOT VALID only
// when its values differ). F32: the error log's daily prune runs in a quiet
// minute too. F33: the landing page's status reads are single-flight and kept
// 30 s per pool, so a read that ran over its budget isn't started again by the
// next visit. The real-Postgres half of F31 (and Per-sistant's DATE parsing,
// F52) is tests/contract/c8-batch8; Per-sistant's unit half is
// apps/per-sistant/tests/broad-scan-c8-batch8.test.js.
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const db = require("../teller/services/database");

// ---------------------------------------------------------------- F31
describe("F31 — IN-list CHECKs follow the code on an existing table", () => {
  const def = (values) => "CHECK ((form = ANY (ARRAY[" + values.map((v) => "'" + v.replace(/'/g, "''") + "'::text").join(", ") + "])))";
  function fakeClient(stored) {
    const calls = [];
    return {
      calls,
      async query(sql, params) {
        calls.push(sql.replace(/\s+/g, " ").trim());
        if (/FROM pg_constraint/.test(sql)) {
          const d = stored[params[1]];
          return { rows: d === undefined ? [] : [{ def: d }] };
        }
        return { rows: [] };
      },
    };
  }
  const LISTS = { tax_documents: { form: ["W-2", "1099-K", "other"] } };

  it("reads the values out of Postgres' stored definition", () => {
    assert.deepEqual(db.checkValues(def(["W-2", "O'Brien", "other"])), ["W-2", "O'Brien", "other"]);
    assert.deepEqual(db.checkValues("CHECK ((provider = ANY (ARRAY['plaid'::text, 'teller'::text])))"), ["plaid", "teller"]);
    assert.deepEqual(db.checkValues(null), []);
  });

  it("an unchanged CHECK is left alone — no ALTER, no lock", async () => {
    const c = fakeClient({ tax_documents_form_check: def(["other", "W-2", "1099-K"]) });
    assert.deepEqual(await db.syncInListChecks(c, LISTS), []);
    assert.equal(c.calls.filter((s) => /ALTER TABLE/.test(s)).length, 0, "order doesn't matter");
  });

  it("a value added in code replaces the stored CHECK, NOT VALID", async () => {
    const c = fakeClient({ tax_documents_form_check: def(["W-2", "other"]) });
    assert.deepEqual(await db.syncInListChecks(c, LISTS), ["tax_documents_form_check"]);
    assert.deepEqual(c.calls.slice(1), [
      "ALTER TABLE tax_documents DROP CONSTRAINT IF EXISTS tax_documents_form_check",
      "ALTER TABLE tax_documents ADD CONSTRAINT tax_documents_form_check CHECK (form IN ('W-2', '1099-K', 'other')) NOT VALID",
    ]);
  });

  it("a missing CHECK is added; a quote in a value is escaped", async () => {
    const c = fakeClient({});
    await db.syncInListChecks(c, { t: { k: ["a'b"] } });
    assert.match(c.calls.at(-1), /ADD CONSTRAINT t_k_check CHECK \(k IN \('a''b'\)\) NOT VALID$/);
  });

  it("the CREATE TABLEs interpolate the same lists the sync uses, and the migration runs it", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "teller", "services", "database.js"), "utf8");
    for (const [table, cols] of Object.entries(db.CHECK_LISTS)) {
      for (const col of Object.keys(cols)) assert.match(src, new RegExp(`CHECK \\(${col} IN \\(\\$\\{inList\\(CHECK_LISTS\\.${table}\\.${col}\\)\\}\\)\\)`), table + "." + col);
    }
    assert.match(src, /const checksChanged = await syncInListChecks\(client\);/);
    assert.deepEqual(db.CHECK_LISTS.webhook_events.status, ["received", "processing", "done", "failed", "ignored"]);
  });
});

// ---------------------------------------------------------------- F32
describe("F32 — the error log prunes in a quiet minute too", () => {
  require.cache[require.resolve("../teller/routes/notifications")] = {
    id: "n", filename: "n", loaded: true, exports: { sendToAll: async () => ({ logged: true }) },
  };
  const errorLog = require("../teller/services/error-log");
  beforeEach(() => errorLog._reset());

  it("an empty buffer still prunes once a day, and makes no other query", async () => {
    const sql = [];
    errorLog._state.pool = { query: async (s) => { sql.push(s); return { rows: [] }; } };
    assert.deepEqual(await errorLog.flush(), { written: 0 });
    assert.equal(sql.length, 1);
    assert.match(sql[0], /DELETE FROM app_errors/);
    await errorLog.flush();
    assert.equal(sql.length, 1, "not again within the day");
    errorLog._state.lastPrune = Date.now() - 25 * 60 * 60 * 1000;
    await errorLog.flush();
    assert.equal(sql.length, 2);
  });

  it("still nothing before start() gives it a pool", async () => {
    assert.deepEqual(await errorLog.flush(), { written: 0 });
  });
});

// ---------------------------------------------------------------- F33
describe("F33 — landing status reads are shared and kept 30 s", () => {
  const ls = require("../shell/landing-status");
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const quietly = async (fn) => {
    const warn = console.warn; console.warn = () => {};
    try { return await fn(); } finally { console.warn = warn; }
  };

  it("two calls during one read share it; a finished read is reused within 30 s", async () => {
    const pool = {};
    let reads = 0, release;
    const fn = () => { reads++; return new Promise((r) => { release = r; }); };
    let t = 1000;
    const now = () => t;
    const a = ls.sharedRead(pool, "x", fn, now), b = ls.sharedRead(pool, "x", fn, now);
    await tick();
    release({ n: 1 });
    assert.deepEqual(await a, { n: 1 });
    assert.deepEqual(await b, { n: 1 });
    assert.equal(reads, 1);
    t += ls.CACHE_MS - 1;
    assert.deepEqual(await ls.sharedRead(pool, "x", fn, now), { n: 1 });
    assert.equal(reads, 1);
    t += 2;
    const c = ls.sharedRead(pool, "x", fn, now);
    await tick();
    release({ n: 2 });
    assert.deepEqual(await c, { n: 2 });
    assert.equal(reads, 2);
  });

  it("a failure is null and kept too (no retry storm); another pool reads on its own", async () => {
    const pool = {};
    let reads = 0;
    const r = await quietly(() => ls.sharedRead(pool, "x", () => { reads++; throw new Error("down"); }));
    assert.equal(r, null);
    assert.equal(await ls.sharedRead(pool, "x", () => { reads++; return 1; }), null);
    assert.equal(reads, 1);
    assert.equal(await ls.sharedRead({}, "x", () => 7), 7);
  });

  it("a read that ran over the budget isn't started again; the next visit gets its line", async () => {
    const perfinPool = {}, persistentPool = {};
    let summaries = 0, release;
    const deps = {
      gatherDashboardSummary: () => { summaries++; return new Promise((r) => { release = r; }); },
      taskDueCounts: async () => ({ due_today: 0, overdue: 0 }),
    };
    const first = await quietly(() => ls.landingStatus({ perfinPool, persistentPool, deps, timeoutMs: 20 }));
    assert.equal(first.perfin, null, "cut off at its budget");
    const second = await quietly(() => ls.landingStatus({ perfinPool, persistentPool, deps, timeoutMs: 20 }));
    assert.equal(second.perfin, null);
    assert.equal(summaries, 1, "the second visit waited on the same read");
    release({ attention: { items: [{ kind: "uncategorized", count: 3 }], errors: [] } });
    await new Promise((r) => setTimeout(r, 0));
    const third = await ls.landingStatus({ perfinPool, persistentPool, deps, timeoutMs: 20 });
    assert.equal(third.perfin, "3 to review");
    assert.equal(summaries, 1);
  });
});
