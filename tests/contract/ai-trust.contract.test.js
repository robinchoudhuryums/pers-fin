// Real-Postgres contract tests for the cycle-7 Batch 8 AI-trust fixes: the
// goal-tracking prompt on funding-derived progress with ISO dates (F62/F71),
// the audit on real spending — a named other month, an earlier sentence's
// period word, a hallucinated merchant next to a known one (F61/F67/F68) —
// the AI spend month (F66) and Accept with a repeated category (F70). Only the
// Anthropic SDK is stubbed.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

const anthropicQueue = [];
const sentParams = [];
class FakeAnthropic {
  constructor() {
    this.messages = { create: async (params) => {
      sentParams.push(params);
      const r = anthropicQueue.shift();
      if (!r) throw new Error("FakeAnthropic: response queue empty");
      return r;
    } };
  }
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

describe("AI trust on real Postgres", { skip: SKIP }, () => {
  let pool, app, insights, audit, originalLoad, today, thisMonth;
  const q = (s, p) => pool.query(s, p);

  before(async () => {
    process.env.ANTHROPIC_API_KEY = "contract-test-key";
    originalLoad = Module._load;
    Module._load = function (request) {
      if (request === "@anthropic-ai/sdk") return FakeAnthropic;
      return originalLoad.apply(this, arguments);
    };
    pool = await perfinDb("aitrust");
    const fq = require("../../teller/services/financial-queries");
    today = fq.todayStr();
    thisMonth = fq.currentMonth();
    insights = require("../../teller/routes/insights");
    audit = require("../../teller/services/ai-audit");
    app = perfinApp();
    await q("INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual, current_balance) VALUES ('sav','Savings','depository','savings',true,5000), ('card','Card','credit','credit card',true,0)");
    await q(`INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending, user_category)
             VALUES ('card','t_dining',50,$1,'Amazon','AMAZON',false,'Dining')`, [today]);
  });
  after(async () => {
    if (originalLoad) Module._load = originalLoad;
    if (pool) await pool.end();
  });

  it("F62 + F71: the goal prompt shows balance − baseline and an ISO target date", async () => {
    await q(`INSERT INTO financial_goals (name, type, target_amount, current_amount, target_date, funding_account_id, goal_baseline_amount)
             VALUES ('House', 'savings', 10000, 10, '2027-06-30', (SELECT id FROM linked_accounts WHERE account_id='sav'), 1000)`);
    anthropicQueue.push({
      content: [{ type: "tool_use", id: "tu", name: "generate_financial_insight", input: {
        insights_text: "## Overview\nSteady month.",
        summary: { trends: [], completed_goals: [], pending_actions: [], alerts: [] },
      } }],
      stop_reason: "tool_use", usage: { input_tokens: 900, output_tokens: 100 },
    });
    const r = await insights.generateInsights();
    assert.equal(r.ok, true, JSON.stringify(r));
    const prompt = JSON.stringify(sentParams[sentParams.length - 1].messages);
    assert.match(prompt, /House \(savings\): \$4000\.00 \/ \$10000\.00 \(40%\)/, "funding-derived, not the stored $10");
    assert.match(prompt, /target date: 2027-06-30/);
    assert.doesNotMatch(prompt, /GMT/);
  });

  it("F61 + F67 + F68: the audit judges each claim by its own month, sentence and name", async () => {
    const other = MONTHS[(Number(thisMonth.slice(5, 7)) + 5) % 12]; // never this month
    const run = async (text) => (await audit.auditInsight(text, null)).findings;

    const named = await run(`In ${other}, Dining hit $450.`);
    assert.equal(named.filter((f) => f.check === "arithmetic").length, 0, "a named other month isn't this month's spend");

    const sameSentenceThisMonth = await run(`Dining hit $450 this month.`);
    assert.equal(sameSentenceThisMonth.filter((f) => f.check === "arithmetic" && f.severity === "critical").length, 1);

    const earlierSentence = await run("Your annual subscriptions cost $1,200. Dining hit $450.");
    assert.equal(earlierSentence.filter((f) => f.check === "arithmetic" && f.severity === "critical").length, 1,
      "the previous sentence's 'annual' no longer hides this claim");

    const kSuffix = await run("Dining hit $1.2k.");
    const k = kSuffix.find((f) => f.check === "arithmetic");
    assert.ok(k && /\$1200\.00/.test(k.claim), JSON.stringify(kSuffix));

    const entities = await run("Most of it went to Fakemart and Amazon.");
    const unknown = entities.filter((f) => f.check === "entity_existence").map((f) => f.claim);
    assert.deepEqual(unknown, ["Fakemart"]);
  });

  it("F66: the AI spend month counts this month's usage only", async () => {
    await q("DELETE FROM financial_insights");
    await q(`INSERT INTO financial_insights (insight_text, model_used, tokens_used, input_tokens, output_tokens, entry_type, created_at)
             VALUES ('now', 'claude-haiku-4-5', 1000000, 1000000, 0, 'ask', now()),
                    ('old', 'claude-haiku-4-5', 1000000, 1000000, 0, 'ask', ($1::date - interval '1 day'))`, [thisMonth + "-01"]);
    assert.equal(Math.round(await insights.monthAiSpendCents(pool)), 100, "$1 this month; last month's row excluded");
  });

  it("F70: Accept with the same category twice writes one budget (last wins)", async () => {
    const res = await supertest(app).post("/api/budgets/accept").send({ budgets: [
      { category: "Groceries", monthly_limit: 400 }, { category: "Groceries", monthly_limit: 350 }, { category: "Dining", monthly_limit: 200 },
    ] }).expect(200);
    assert.equal(res.body.accepted, 2);
    const rows = (await q("SELECT category, monthly_limit::float AS l FROM budgets ORDER BY category")).rows;
    assert.deepEqual(rows, [{ category: "Dining", l: 200 }, { category: "Groceries", l: 350 }]);
  });
});
