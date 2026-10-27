// ============================================================================
// Broad-scan (Oct 2026, cycle 7) Batch 8 — AI trust
// ============================================================================
// The database-backed half (the goal-tracking prompt, the audit on real
// spending, the spend month, Accept with a duplicate) lives in
// tests/contract/ai-trust.contract.test.js. This file covers what needs no
// database:
// F61   a claim about a named month is not compared with this month
// F64   Ask's charge flag is set only after the usage row is written
// F65   Ask's last round can't call tools
// F66   Ask's date + served model; the spend month in APP_TIMEZONE
// F67   bounded entity capture ("Fakemart and Amazon")
// F68   the claim's own sentence decides its period; "$1.2k"
// F70   budget suggestions: real categories, once; Accept de-duplicates
// F71   ISO dates in the insight prompt
// F72   weekly digest text lists completed goals; no href="#" link
// ============================================================================

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const express = require("express");
const supertest = require("supertest");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
afterEach(() => { dbModule.pool.query = originalQuery; });

const audit = require("../teller/services/ai-audit");

// ---------------------------------------------------------------------------
describe("F61 / F68 — the period of a dollar claim", () => {
  it("a named month other than this one is cross-period; this month's name and the verb 'may' are not", () => {
    assert.equal(audit.namesOtherMonth("In September, Dining hit $450", "2026-10"), true);
    assert.equal(audit.namesOtherMonth("For 2026-09 Dining was $450", "2026-10"), true);
    assert.equal(audit.namesOtherMonth("In October, Dining hit $450", "2026-10"), false);
    assert.equal(audit.namesOtherMonth("Dining for 2026-10: $450", "2026-10"), false);
    assert.equal(audit.namesOtherMonth("you may want to keep Dining near $450", "2026-10"), false);
  });

  it("the window is the claim's own sentence + clause, not ±80/40 characters", () => {
    const t = "Your annual subscriptions cost $1,200. Dining hit $450, a rolling average of $380.";
    const claims = audit.extractDollarClaims(t);
    assert.deepEqual(claims.map((c) => audit.claimPeriodWindow(t, c)), [
      "Your annual subscriptions cost $1,200",
      "Dining hit $450",
      "Dining hit $450, a rolling average of $380",
    ]);
  });

  it("a month counts when named before the figure in its sentence or attached right after it", () => {
    const t = "Dining is $450 compared with September's $300. Groceries were $210 in August.";
    const [c450, c300, c210] = audit.extractDollarClaims(t);
    assert.equal(audit.claimNamesOtherMonth(t, c450, "2026-10"), false, "September belongs to the $300");
    assert.equal(audit.claimNamesOtherMonth(t, c300, "2026-10"), true);
    assert.equal(audit.claimNamesOtherMonth(t, c210, "2026-10"), true, "'$210 in August'");
  });

  it("k / M suffixes scale the figure", () => {
    assert.deepEqual(audit.extractDollarClaims("Rent $1.2k, car $1.5M, coffee $4.50, $15/mo, $5 more").map((c) => c.value),
      [1200, 1500000, 4.5, 15, 5]);
  });

  it("tier 1 reads the window through claimPeriodWindow + claimNamesOtherMonth", () => {
    const src = read("teller", "services", "ai-audit.js");
    assert.match(src, /const periodWindow = claimPeriodWindow\(insightText, claim\);/);
    assert.match(src, /\(CROSS_PERIOD_RE\.test\(ctx\) \|\| claimNamesOtherMonth\(insightText, claim, thisMonth\)\) && !THIS_MONTH_RE\.test\(ctx\)/);
  });
});

// ---------------------------------------------------------------------------
describe("F67 — bounded entity capture", () => {
  it("'at Fakemart and Amazon' is two claims, and a lower-case word ends a name", () => {
    const names = audit.extractMerchantNames("You shop at Fakemart and Amazon most weeks. Paid to Whole Foods Market today. Spent at Barnes & Noble.");
    assert.ok(names.includes("Fakemart"));
    assert.ok(!names.some((n) => /Fakemart and/.test(n)), names.join("|"));
    assert.ok(names.includes("Whole Foods Market"));
    assert.ok(names.includes("Barnes & Noble"));
    assert.ok(!names.some((n) => /today|most/.test(n)), names.join("|"));
  });

  it("a hallucinated name next to a known one is still unknown", () => {
    const known = new Set(["amazon"]);
    assert.equal(audit.entityKnown("fakemart", known), false);
    assert.equal(audit.entityKnown("amazon", known), true);
  });
});

// ---------------------------------------------------------------------------
describe("F64 / F65 / F66 — Ask", () => {
  let queue = [];
  let sent = [];
  class FakeAnthropic {
    constructor() {
      this.messages = { create: async (params) => {
        sent.push(JSON.parse(JSON.stringify(params)));
        const r = queue.shift();
        if (r instanceof Error) throw r;
        if (!r) throw new Error("empty");
        return r;
      } };
    }
  }
  const originalLoad = Module._load;
  before(() => {
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-key";
    Module._load = function (request) {
      if (request === "@anthropic-ai/sdk") return FakeAnthropic;
      return originalLoad.apply(this, arguments);
    };
    delete require.cache[require.resolve("../teller/routes/ask")];
  });
  after(() => {
    Module._load = originalLoad;
    delete require.cache[require.resolve("../teller/routes/ask")];
  });

  function mount(state) {
    dbModule.pool.query = async (sql, params) => {
      if (sql.includes("ai_monthly_budget_cents")) return { rows: [{ ai_monthly_budget_cents: 5000 }] };
      if (sql.includes("FROM financial_insights WHERE created_at >=")) return { rows: [] };
      if (sql.includes("insights_model")) return { rows: [{ insights_model: "haiku" }] };
      if (sql.includes("INSERT INTO financial_insights")) {
        state.attempts++;
        if (state.failInserts > 0) { state.failInserts--; throw new Error("insert failed"); }
        state.inserts.push({ sql, params });
        return { rows: [] };
      }
      return { rows: [] };
    };
    const app = express();
    app.use(express.json());
    app.use(require("../teller/routes/ask"));
    return app;
  }
  const toolTurn = { model: "claude-haiku-5-5", usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "tu", name: "get_net_worth", input: {} }] };

  it("F65: the last round is sent tool_choice none and its text is the answer", async () => {
    sent = [];
    const MAX = 6;
    queue = Array.from({ length: MAX }, () => toolTurn).concat([
      { model: "claude-haiku-5-5", usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: "end_turn", content: [{ type: "text", text: "Net worth is about $1,000." }] },
    ]);
    const state = { inserts: [], attempts: 0, failInserts: 0 };
    const res = await supertest(mount(state)).post("/api/ask").send({ question: "net worth?" });
    assert.equal(res.status, 200);
    assert.equal(res.body.answer, "Net worth is about $1,000.");
    assert.equal(sent.length, MAX + 1);
    assert.deepEqual(sent[MAX].tool_choice, { type: "none" }, "the last round can't call tools");
    assert.equal(sent[0].tool_choice, undefined, "earlier rounds keep the default (auto)");
  });

  it("F66: the system prompt carries the APP_TIMEZONE date; the usage row records the served model", async () => {
    sent = [];
    queue = [{ model: "claude-haiku-5-5-20261001", usage: { input_tokens: 7, output_tokens: 3 }, stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }];
    const state = { inserts: [], attempts: 0, failInserts: 0 };
    await supertest(mount(state)).post("/api/ask").send({ question: "hi" }).expect(200);
    const { todayStr } = require("../teller/services/financial-queries");
    assert.ok(sent[0].system.includes(`Today's date is ${todayStr()}.`));
    assert.equal(state.inserts[0].params[1], "claude-haiku-5-5-20261001");
  });

  it("F64: a failed usage write is retried by the finally block instead of being marked charged", async () => {
    queue = [{ model: "claude-haiku-5-5", usage: { input_tokens: 40, output_tokens: 10 }, stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }];
    const state = { inserts: [], attempts: 0, failInserts: 1 };
    const res = await supertest(mount(state)).post("/api/ask").send({ question: "hi" });
    assert.equal(res.status, 500, "the failed charge still surfaces");
    assert.equal(state.attempts, 2, "the finally block tried again");
    assert.equal(state.inserts.length, 1, "the tokens were charged");
    assert.equal(state.inserts[0].params[3], 40);
  });

  it("F66: monthAiSpendCents reads the APP_TIMEZONE month start", async () => {
    const { monthAiSpendCents } = require("../teller/routes/insights");
    const { currentMonth } = require("../teller/services/financial-queries");
    let seen;
    await monthAiSpendCents({ query: async (sql, params) => { seen = { sql, params }; return { rows: [] }; } });
    assert.match(seen.sql, /created_at >= \(\$1::date::timestamp AT TIME ZONE \$2\)/);
    assert.equal(seen.params[0], currentMonth() + "-01");
    assert.doesNotMatch(seen.sql, /CURRENT_DATE/);
  });
});

// ---------------------------------------------------------------------------
describe("F70 — budget suggestions and Accept", () => {
  it("the suggest tool's category is an enum of the categories sent; replies are filtered to them, once", () => {
    const src = read("teller", "routes", "budgets.js");
    assert.match(src, /category: \{ type: "string", enum: Object\.keys\(categories\) \}/);
    assert.match(src, /Object\.prototype\.hasOwnProperty\.call\(categories, s\.category\)\s+&& !seen\.has\(s\.category\) && seen\.add\(s\.category\)/);
  });

  it("Accept writes one row per category (last wins) instead of a 500", async () => {
    let insert;
    dbModule.pool.query = async (sql, params) => {
      if (/INSERT INTO budgets/.test(sql)) {
        insert = { sql, params };
        return { rows: [{ category: params[0], monthly_limit: params[1] }] };
      }
      return { rows: [] };
    };
    const app = express(); app.use(express.json()); app.use(require("../teller/routes/budgets"));
    const res = await supertest(app).post("/api/budgets/accept").send({ budgets: [
      { category: "Dining", monthly_limit: 300 }, { category: "Dining ", monthly_limit: 250 }, { category: 7, monthly_limit: 1 },
    ] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(insert.params, ["Dining", 250, null]);
  });
});

// ---------------------------------------------------------------------------
describe("F71 / F72 / F62 — prompt and email text", () => {
  it("dates in the insight prompt go through isoDate", () => {
    const src = read("teller", "routes", "insights.js");
    for (const re of [/" on " \+ isoDate\(r\.date\)/, /", Due " \+ isoDate\(c\.next_payment_due_date\)/,
      /", target date: " \+ isoDate\(g\.target_date\)/, /", " \+ isoDate\(latest\.checked_at\) \+ "\)"/]) {
      assert.match(src, re);
    }
    const { isoDate } = require("../teller/services/csv-export");
    assert.equal(isoDate(new Date(2026, 11, 31)), "2026-12-31");
  });

  it("the goal prompt uses deriveGoalProgress (funding-linked goals)", () => {
    const { deriveGoalProgress } = require("../teller/routes/goals");
    const g = { current_amount: "10", funding_account_id: 3, funding_account_balance: "5000", goal_baseline_amount: "1000" };
    assert.equal(deriveGoalProgress(g).current, 4000);
    assert.match(read("teller", "routes", "insights.js"), /const current = deriveGoalProgress\(g\)\.current;/);
  });

  it("the weekly digest text lists completed goals", () => {
    const { renderWeeklyDigestText } = require("../teller/routes/insights-email");
    const text = renderWeeklyDigestText({ trends: [], pending_actions: [], alerts: [],
      completed_goals: [{ goal_name: "Emergency fund", completed_date: "2026-09-30" }] });
    assert.match(text, /RECENTLY COMPLETED\n  \+ Emergency fund \(2026-09-30\)/);
  });

  it("the insight email links the dashboard only when its address is known", () => {
    const { renderInsightEmail } = require("../teller/routes/insights-email");
    assert.doesNotMatch(renderInsightEmail("x", [], null), /href="#"|Open Dashboard/);
    assert.match(renderInsightEmail("x", [], null, "https://app.example/perfin/dashboard"),
      /<a href="https:\/\/app\.example\/perfin\/dashboard"[^>]*>Open Dashboard<\/a>/);
    const persistent = require("../teller/routes/persistent");
    const prev = process.env.RENDER_EXTERNAL_URL;
    try {
      delete process.env.RENDER_EXTERNAL_URL;
      assert.equal(persistent.perfinDashboardUrl(), null);
      process.env.RENDER_EXTERNAL_URL = "https://app.example/";
      assert.equal(persistent.perfinDashboardUrl(), "https://app.example/dashboard");
    } finally {
      if (prev === undefined) delete process.env.RENDER_EXTERNAL_URL; else process.env.RENDER_EXTERNAL_URL = prev;
    }
  });
});
