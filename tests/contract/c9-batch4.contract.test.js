// Real-Postgres contract test for the cycle-9 broad scan, Batch 4 — AI audit
// trust. The audit swallows a failing query by design (the tier is marked
// incomplete, or the subscription read falls back to zero), so only a real
// database shows that the new SQL runs:
//  - F39: the subscription total is read apart from utilities — the total the
//    prompt gives passes, the combined one passes, a wrong one is CRITICAL; a
//    monthly rate isn't compared with the month to date
//  - F42: an account, card or brokerage the user has is a known entity
//  - F43: an empty insight run charges the cap and leaves insights_last_run alone
// Only the Anthropic SDK is stubbed.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const { SKIP, perfinDb } = require("./_setup");

const anthropicQueue = [];
class FakeAnthropic {
  constructor() {
    this.messages = { create: async () => {
      const r = anthropicQueue.shift();
      if (!r) throw new Error("FakeAnthropic: response queue empty");
      return r;
    } };
  }
}

describe("cycle-9 Batch 4 on real Postgres", { skip: SKIP }, () => {
  let pool, audit, insights, originalLoad, today, add;
  const q = (s, p) => pool.query(s, p);
  const quiet = async (fn) => {
    const e = console.error, w = console.warn, l = console.log;
    console.error = () => {}; console.warn = () => {}; console.log = () => {};
    try { return await fn(); } finally { console.error = e; console.warn = w; console.log = l; }
  };
  const run = async (text) => {
    const r = await audit.auditInsight(text, null);
    return { incomplete: r.incomplete, findings: r.findings.map((f) => `${f.severity}:${f.check}:${f.claim}:${f.expected}`) };
  };

  before(async () => {
    process.env.ANTHROPIC_API_KEY = "contract-test-key";
    originalLoad = Module._load;
    Module._load = function (request) {
      if (request === "@anthropic-ai/sdk") return FakeAnthropic;
      return originalLoad.apply(this, arguments);
    };
    pool = await perfinDb("c9_batch4");
    const fq = require("../../teller/services/financial-queries");
    today = fq.todayStr();
    add = (n) => require("../../teller/services/cadence").addDaysStr(today, n);
    audit = require("../../teller/services/ai-audit");
    insights = require("../../teller/routes/insights");
    await q(`INSERT INTO linked_accounts (account_id, name, official_name, type, subtype, is_manual, current_balance)
             VALUES ('chk','Checking','Everyday Checking','depository','checking',true,4000),
                    ('visa','Chase Sapphire Preferred',NULL,'credit','credit card',true,900)`);
    await q("INSERT INTO investment_accounts (name, institution, account_type, balance) VALUES ('Schwab Brokerage','Schwab','brokerage',25000)");
    const sub = (key, amount, cadence, category) => q(
      `INSERT INTO detected_subscriptions (merchant_key, display_name, amount, cadence_days, first_seen, last_charged, next_expected, is_active, category)
       VALUES ($1,$1,$2,$3,$4,$5,$6,true,$7)`, [key, amount, cadence, add(-120), add(-5), add(25), category]);
    await sub("Netflix", 15.49, 30, "subscription");
    await sub("Spotify", 11.99, 30, "subscription");
    await sub("Quarterly Box", 30, 90, "subscription"); // $10 a month
    await sub("Pacific Gas and Electric", 120, 30, "utility");
    // A cancelled one never counts.
    await q(`INSERT INTO detected_subscriptions (merchant_key, display_name, amount, cadence_days, first_seen, last_charged, next_expected, is_active, cancelled_at)
             VALUES ('Old Gym','Old Gym',40,30,$1,$2,$3,false,now())`, [add(-200), add(-90), add(-60)]);
    // This month so far: $100 of Dining.
    await q(`INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending, user_category)
             VALUES ('visa','t_dining',100,$1,'Thai Place','THAI PLACE',false,'Dining')`, [today]);
  });
  after(async () => {
    if (originalLoad) Module._load = originalLoad;
    if (pool) await pool.end();
  });

  // ---------------------------------------------------------------- F39
  it("F39: the subscriptions-only total the prompt gives ($37.48) is not a finding", async () => {
    assert.deepEqual(await run("Your 3 subscriptions total $37.48 a month."), { incomplete: false, findings: [] });
  });

  it("F39: subscriptions plus utilities ($157.48), and the utility total where utilities are named", async () => {
    assert.deepEqual((await run("All your subscriptions combined come to $157.48 a month.")).findings, []);
    assert.deepEqual((await run("Your subscriptions total $37.48 and your utilities total $120.00.")).findings, []);
  });

  it("F39: a wrong total is CRITICAL against the nearest real one", async () => {
    assert.deepEqual((await quiet(() => run("Your 3 subscriptions total $90 a month."))).findings, ["critical:subscription_total:$90.00:$37.48"]);
    assert.deepEqual((await quiet(() => run("Your 4 subscriptions total $300 a month."))).findings, ["critical:subscription_total:$300.00:$157.48"]);
  });

  it("F39: a monthly rate isn't compared with the month to date; a plain total still is", async () => {
    assert.deepEqual((await run("You spend about $600/mo on Dining.")).findings, []);
    assert.deepEqual((await run("Dining spending hit $100.")).findings, []);
    assert.deepEqual((await quiet(() => run("Dining spending hit $600."))).findings, ["critical:arithmetic:$600.00 for dining:$100.00"]);
  });

  // ---------------------------------------------------------------- F42
  it("F42: the user's card, account and brokerage are known; an invented name is still a warning", async () => {
    assert.deepEqual(await run("Pay down the balance at Chase Sapphire first."), { incomplete: false, findings: [] });
    assert.deepEqual((await run("Move the idle cash to Schwab.")).findings, []);
    assert.deepEqual((await run("Move it from Everyday Checking this week.")).findings, []);
    const f = (await run("Cancel the plan at Zorblax Media.")).findings;
    assert.equal(f.length, 1);
    assert.match(f[0], /^warning:entity_existence:Zorblax Media:/);
  });

  // ---------------------------------------------------------------- F43
  it("F43: an empty insight run is charged and leaves insights_last_run alone", async () => {
    await q("UPDATE user_settings SET insights_last_run = NULL, insight_emails_enabled = false WHERE id = 1");
    // No text and no tool call, then the same again for the one re-ask.
    for (let i = 0; i < 2; i++) anthropicQueue.push({ content: [], stop_reason: "end_turn", model: "claude-sonnet-5-5", usage: { input_tokens: 800, output_tokens: 5 } });
    const r = await quiet(() => insights.generateInsights());
    assert.equal(r.ok, false);
    assert.equal(r.status, 502);
    const s = (await q("SELECT insights_last_run FROM user_settings WHERE id = 1")).rows[0];
    assert.equal(s.insights_last_run, null, "it used to be stamped — the next attempt then waited a whole cadence");
    const rows = (await q("SELECT entry_type, input_tokens FROM financial_insights")).rows;
    assert.deepEqual(rows.map((x) => x.entry_type), ["insight_empty"], "the tokens still count toward the cap");
    assert.ok(Number(rows[0].input_tokens) > 0);
  });

  it("F43: a real run still stamps it", async () => {
    anthropicQueue.push({
      content: [{ type: "tool_use", id: "tu", name: "generate_financial_insight", input: {
        insights_text: "## Overview\nSteady month.",
        summary: { trends: [], completed_goals: [], pending_actions: [], alerts: [] },
      } }],
      stop_reason: "tool_use", model: "claude-sonnet-5-5", usage: { input_tokens: 900, output_tokens: 100 },
    });
    const r = await quiet(() => insights.generateInsights());
    assert.equal(r.ok, true, r.error);
    assert.ok((await q("SELECT insights_last_run FROM user_settings WHERE id = 1")).rows[0].insights_last_run);
  });
});
