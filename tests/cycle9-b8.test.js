// ============================================================================
// Cycle 9 (Nov 2026 broad scan) Batch 8 — the two Perfin items
// ============================================================================
// F26  an AI categorize batch that comes back with no tool block is charged
//      AND stamped (it used to be re-sent and re-charged every run); each row
//      carries a plain date
// F27  the stale sweeps touch only rows they change; deleting a rename rule
//      and POST /api/categorize/review are one transaction each; a non-string
//      name on a manual-bill PATCH is a 400
// The Per-sistant half of Batch 8 is apps/per-sistant/tests/cycle9-b8.test.js;
// the database-backed half is tests/contract/c9-batch8.contract.test.js.
// ============================================================================

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const express = require("express");
const supertest = require("supertest");

const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
const originalConnect = dbModule.pool.connect;
const realError = console.error;
afterEach(() => { dbModule.pool.query = originalQuery; dbModule.pool.connect = originalConnect; console.error = realError; });

function mountApp(mod) {
  const app = express();
  app.use(express.json());
  app.use(require(mod));
  return app;
}
// A client whose statements are logged; `fail` makes the matching one throw.
function txClient(log, answer, fail) {
  return {
    query: async (sql, params) => {
      log.push({ sql, params });
      if (fail && fail.test(sql)) throw new Error("boom");
      return (answer && answer(sql, params)) || { rows: [], rowCount: 0 };
    },
    release() { log.push({ sql: "RELEASE" }); },
  };
}
const verbs = (log) => log.map((c) => c.sql.trim().split(/\s+/).slice(0, 3).join(" "));
// These routes must run on their transaction client: a statement on the pool fails the test at once.
const poolOff = () => { dbModule.pool.query = async () => { throw new Error("the route must use its transaction client"); }; };

// ---------------------------------------------------------------------------
// F26
// ---------------------------------------------------------------------------
describe("F26 — an AI batch with no tool block", () => {
  let queue = [], calls = [];
  class FakeAnthropic {
    constructor() {
      this.messages = { create: async (req) => {
        calls.push(req);
        const r = queue.shift();
        if (!r) throw new Error("FakeAnthropic: response queue empty");
        return r;
      } };
    }
  }
  const originalLoad = Module._load;
  let runCategorize;
  before(() => {
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-key";
    Module._load = function (request) {
      if (request === "@anthropic-ai/sdk") return FakeAnthropic;
      return originalLoad.apply(this, arguments);
    };
    delete require.cache[require.resolve("../teller/routes/categorize")];
    runCategorize = require("../teller/routes/categorize").runCategorize;
  });
  after(() => {
    Module._load = originalLoad;
    delete require.cache[require.resolve("../teller/routes/categorize")];
  });
  afterEach(() => { queue = []; calls = []; });

  function pool(state) {
    return async (sql, params) => {
      if (sql.includes("SELECT COUNT(*) AS uncategorized")) return { rows: [{ uncategorized: 2 }] };
      if (sql.includes("FROM categorization_rules WHERE is_active")) return { rows: [] };
      if (sql.includes("ai_monthly_budget_cents")) return { rows: [{ ai_monthly_budget_cents: 5000 }] };
      if (sql.includes("FROM financial_insights WHERE created_at >=")) return { rows: [] };
      if (sql.includes("AS merchant") && sql.includes("ORDER BY date DESC")) {
        state.batches.push(sql);
        return { rows: [
          { transaction_id: "tx1", merchant: "Foo Store", amount: 10, date: new Date(2026, 10, 16), txn_day: "2026-11-16", category: null },
          { transaction_id: "tx2", merchant: "Bar Cafe", amount: 4.5, date: new Date(2026, 10, 15), txn_day: "2026-11-15", category: ["food"] },
        ] };
      }
      if (sql.includes("INSERT INTO financial_insights")) { state.charged.push(params); return { rows: [] }; }
      if (sql.includes("SET ai_skipped_at = now()")) { state.stamped.push(params[0]); return { rowCount: 2, rows: [] }; }
      if (sql.includes("user_category_source = 'ai'")) { state.aiUpdates.push(params); return { rowCount: 1, rows: [] }; }
      return { rows: [], rowCount: 0 };
    };
  }
  const prose = () => ({ model: "claude-haiku-5-5", stop_reason: "end_turn", usage: { input_tokens: 120, output_tokens: 20 }, content: [{ type: "text", text: "Here are my thoughts." }] });

  it("is charged once and its rows are stamped, so the next run doesn't send them again", async () => {
    console.error = () => {};
    const state = { batches: [], charged: [], stamped: [], aiUpdates: [] };
    dbModule.pool.query = pool(state);
    queue = [prose(), prose()]; // the call and its one re-ask (services/claude.js) both answer in prose
    const result = await runCategorize();
    assert.equal(result.ok, true);
    assert.equal(result.categorized_by_ai, 0);
    assert.equal(calls.length, 2);
    assert.equal(state.charged.length, 1, "the spend is recorded");
    assert.equal(state.charged[0][2], 280, "both calls' tokens");
    assert.deepEqual(state.stamped, [["tx1", "tx2"]], "every row of the batch is stamped");
    assert.equal(state.batches.length, 1, "the loop stops; no second page");
    assert.deepEqual(state.aiUpdates, []);
  });
  it("each prompt line carries the plain date, not a JS Date string", async () => {
    const state = { batches: [], charged: [], stamped: [], aiUpdates: [] };
    dbModule.pool.query = pool(state);
    queue = [{ model: "claude-haiku-5-5", usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: "tool_use", id: "c1", name: "categorize_transactions",
      input: { categories: [{ index: 1, category: "Shopping" }, { index: 2, category: "Food & Drink" }] } }] }];
    await runCategorize();
    const text = calls[0].messages[0].content;
    assert.match(text, /1\. Foo Store — \$10\.00 on 2026-11-16\n2\. Bar Cafe — \$4\.50 on 2026-11-15 \[bank hint: food\]/);
    assert.doesNotMatch(text, /GMT|Coordinated Universal Time/);
    assert.match(state.batches[0], /to_char\(date, 'YYYY-MM-DD'\) AS txn_day/);
    assert.deepEqual(state.stamped, [], "nothing to stamp when every row was answered");
    assert.equal(state.aiUpdates.length, 2);
  });
});

// ---------------------------------------------------------------------------
// F27
// ---------------------------------------------------------------------------
describe("F27 — the stale sweeps touch only rows they change", () => {
  async function sweepOf(run, table) {
    const log = [];
    await run({ query: async (sql) => { log.push(sql); return { rows: [], rowCount: 0 }; } });
    return log.find((sql) => new RegExp("UPDATE " + table + "\\s+SET is_active = false, updated_at = now\\(\\)\\s+WHERE last_").test(sql));
  }
  it("subscriptions", async () => {
    const sql = await sweepOf(require("../scripts/detect-subscriptions").detectSubscriptions, "detected_subscriptions");
    assert.ok(sql, "the stale sweep ran");
    assert.match(sql, /AND source != 'manual'\s+AND is_active = true/);
  });
  it("recurring transfers", async () => {
    const sql = await sweepOf(require("../scripts/detect-transfers").detectRecurringTransfers, "recurring_transfers");
    assert.ok(sql, "the stale sweep ran");
    assert.match(sql, /AND is_active = true/);
  });
});

describe("F27 — deleting a rename rule is one transaction", () => {
  const answer = (sql) => {
    if (/^DELETE FROM merchant_rename_rules/.test(sql)) return { rows: [{ id: 7 }] };
    if (/^UPDATE transactions SET user_merchant_name = NULL/.test(sql)) return { rows: [], rowCount: 3 };
    return null;
  };
  it("delete, revert and re-apply run between BEGIN and COMMIT on one client", async () => {
    const log = [];
    poolOff();
    dbModule.pool.connect = async () => txClient(log, answer);
    const r = await supertest(mountApp("../teller/routes/merchant-rename")).delete("/api/merchant-rename-rules/7").expect(200);
    assert.deepEqual(r.body, { ok: true, reverted: 3, renamed: 0 });
    const v = verbs(log);
    assert.equal(v[0], "BEGIN");
    assert.deepEqual(v.slice(-2), ["COMMIT", "RELEASE"]);
    assert.ok(v.indexOf("DELETE FROM merchant_rename_rules") < v.indexOf("UPDATE transactions SET"));
    assert.ok(log.some((c) => /FROM merchant_rename_rules WHERE is_active = true/.test(c.sql)), "the other rules re-apply inside it");
  });
  it("a failure while reverting rolls the delete back", async () => {
    poolOff();
    const log = [];
    console.error = () => {};
    dbModule.pool.connect = async () => txClient(log, answer, /^UPDATE transactions SET user_merchant_name = NULL/);
    await supertest(mountApp("../teller/routes/merchant-rename")).delete("/api/merchant-rename-rules/7").expect(500);
    const v = verbs(log);
    assert.ok(v.includes("ROLLBACK") && !v.includes("COMMIT"));
  });
  it("an unknown rule is a 404 with nothing committed", async () => {
    poolOff();
    const log = [];
    dbModule.pool.connect = async () => txClient(log, () => null);
    await supertest(mountApp("../teller/routes/merchant-rename")).delete("/api/merchant-rename-rules/99").expect(404);
    const v = verbs(log);
    assert.ok(v.includes("ROLLBACK") && !v.includes("COMMIT"));
  });
});

describe("F27 — POST /api/categorize/review is one transaction", () => {
  const answer = (sql) => {
    if (/^UPDATE transactions SET user_category/.test(sql.trim())) return { rows: [{ transaction_id: "tx1", merchant: "Blue Bottle" }] };
    return null;
  };
  const body = { transaction_id: "tx1", category: "Food & Drink", create_rule: true };
  it("the category, the rule and the superseded rules commit together", async () => {
    const log = [];
    poolOff();
    dbModule.pool.connect = async () => txClient(log, answer);
    const r = await supertest(mountApp("../teller/routes/categorize")).post("/api/categorize/review").send(body).expect(200);
    assert.deepEqual(r.body, { ok: true, transaction_id: "tx1", category: "Food & Drink", rule_created: true });
    const v = verbs(log);
    assert.deepEqual([v[0], v[v.length - 2], v[v.length - 1]], ["BEGIN", "COMMIT", "RELEASE"]);
    assert.ok(log.some((c) => /INSERT INTO categorization_rules/.test(c.sql)));
    assert.ok(log.some((c) => /UPDATE categorization_rules SET is_active = false/.test(c.sql)));
  });
  it("a failing rule insert leaves the category unapplied", async () => {
    poolOff();
    const log = [];
    console.error = () => {};
    dbModule.pool.connect = async () => txClient(log, answer, /INSERT INTO categorization_rules/);
    await supertest(mountApp("../teller/routes/categorize")).post("/api/categorize/review").send(body).expect(500);
    const v = verbs(log);
    assert.ok(v.includes("ROLLBACK") && !v.includes("COMMIT"));
  });
  it("an unknown transaction is a 404; without Remember only the category is written", async () => {
    poolOff();
    const miss = [];
    dbModule.pool.connect = async () => txClient(miss, () => null);
    await supertest(mountApp("../teller/routes/categorize")).post("/api/categorize/review").send(body).expect(404);
    assert.ok(verbs(miss).includes("ROLLBACK"));
    const log = [];
    dbModule.pool.connect = async () => txClient(log, answer);
    const r = await supertest(mountApp("../teller/routes/categorize")).post("/api/categorize/review")
      .send({ transaction_id: "tx1", category: "Food & Drink" }).expect(200);
    assert.equal(r.body.rule_created, false);
    assert.ok(!log.some((c) => /categorization_rules/.test(c.sql)));
  });
});

describe("F27 — a manual bill's name must be a string", () => {
  it("a non-string or blank name is a 400 (it used to leave the request hanging); a real one is trimmed", async () => {
    const calls = [];
    dbModule.pool.query = async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: 3, name: params[0] }] }; };
    const app = mountApp("../teller/routes/subscriptions");
    for (const name of [123, { a: 1 }, ["x"], true, "", "   ", null]) {
      const r = await supertest(app).patch("/api/manual-bills/3").send({ name });
      assert.equal(r.status, 400, JSON.stringify(name));
      assert.equal(r.body.error, "name must be a non-empty string");
    }
    assert.equal(calls.filter((c) => /UPDATE manual_bills/.test(c.sql)).length, 0);
    const ok = await supertest(app).patch("/api/manual-bills/3").send({ name: "  Water  " }).expect(200);
    assert.equal(ok.body.name, "Water");
  });
});
