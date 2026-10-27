// Roadmap T4.1 A3 — the `cash_plan` insight module (.cycle/plan-t4-1-advisory.md):
//  - cashPlanPromptBlock: the engine's plan in the prompt — headline, why,
//    steps, per-debt amounts per paycheck, surplus, snowball, tips, notes and
//    the disclaimer; user text through sanitizeForPrompt; a plan that couldn't
//    be worked out says so
//  - seedPlanActions: the plan's current step kept as ONE pending action,
//    replacing an earlier plan entry and the model's own copy, first_recommended
//    carried while the step is the same, the 10-item cap kept
//  - the audit's plan check (ai-audit planFigures / planClaimFinding, tier 1):
//    a figure "per paycheck", or "a month" next to one of the plan's debts, must
//    be one of the plan's amounts (within 5%; >20% critical; a hypothetical
//    — cancel / could / would / instead — isn't a plan claim) — through
//    auditInsight with the plan passed in, and nothing without it
//  - generateInsights: the block and its instructions in the prompt, the debt
//    optimizer pointed at the plan instead of its own avalanche, the summary
//    seeded, the audit given the plan, a failing plan read recorded in
//    modules_failed, and cash_plan:false leaving the old behaviour
const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

process.env.NEON_DATABASE_URL = process.env.NEON_DATABASE_URL || "postgres://test@localhost/test";
process.env.TOKEN_ENCRYPTION_PASSPHRASE = process.env.TOKEN_ENCRYPTION_PASSPHRASE || "test";
const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
afterEach(() => { dbModule.pool.query = originalQuery; });

const advice = require("../teller/services/advice");
const audit = require("../teller/services/ai-audit");
const ref = require("../teller/data/reference-data");

// A real plan from the engine (the A2 fixture): Visa 24.99%, a store card at an
// assumed 22%, a 0% card on its minimum, a paid-in-full Amex with a tip;
// semimonthly pay → $375 extra and $420 total to Visa per paycheck.
function realPlan(over = {}) {
  return advice.buildAdvicePlan({
    today: "2026-10-27",
    errors: [],
    months: [{ month: "2026-07", income: 5000, spending: 3500 }, { month: "2026-08", income: 5000, spending: 3600 }, { month: "2026-09", income: 5000, spending: 3400 }],
    streams: [{ source: "ACME", amount: 2500, cadence: "semimonthly" }],
    cash: { starting_balance: 15000, lowest: { date: "2026-11-20", balance: 14000 } },
    settings: { cash_alert_threshold: "500" },
    debts: [
      { id: 1, account_id: "c1", name: "Visa", type: "credit", current_balance: "3000", apr: "24.99", minimum_payment: "90" },
      { id: 2, account_id: "c2", name: "Store card", type: "credit", current_balance: "800", apr: null, available_balance: "1200" },
      { id: 3, account_id: "c3", name: "Zero card", type: "credit", current_balance: "2400", apr: "0", minimum_payment: "100" },
      { id: 4, account_id: "c4", name: "Amex", type: "credit", current_balance: "1800", apr: "21", minimum_payment: "40", last_payment_amount: "1650", credit_limit: "3000" },
    ],
    activity: [{ account_id: "c1", txns: 3, interest: true }, { account_id: "c2", txns: 3, interest: true }, { account_id: "c3", txns: 3, interest: true }, { account_id: "c4", txns: 9, interest: false }],
    transfers: [],
    ...over,
  });
}

function insights() { return require("../teller/routes/insights"); }

describe("T4.1 A3 — the module and its prompt block", () => {
  it("cash_plan is a module (on by default — modules are on unless false)", () => {
    assert.ok(ref.INSIGHT_MODULES.cash_plan);
    assert.equal(ref.INSIGHT_MODULES.cash_plan.requires_zip, false);
    assert.ok(ref.INSIGHT_MODULES.cash_plan.extra_tokens > 0);
  });

  it("the block carries the engine's figures: headline, steps, per-debt amounts, surplus, snowball, tips, notes, disclaimer", () => {
    const plan = realPlan();
    const b = insights().cashPlanPromptBlock(plan);
    assert.match(b, /^\n\n=== CASH PLAN \(computed in code — use these figures exactly as given; do not compute your own\) ===\n/);
    assert.match(b, /\nHeadline: Pay down Visa first: \$375\.00 per paycheck on top of its minimum\.\n/);
    assert.match(b, /\nAmounts are per paycheck \(semimonthly, 24 a year\)\.\n/);
    assert.match(b, /\n- \[now\] Pay off high-interest debt \(APR 8% or more\), \$3,800\.00 to go\n/);
    assert.match(b, /\n- \[done\] Keep a starter cash buffer\n/);
    assert.match(b, /\n- \[later\] Invest the rest\n/);
    assert.match(b, /\n- Visa: APR 24\.99%, balance \$3,000\.00, pay \$420\.00 per paycheck \(\$840\.00 a month: \$90\.00 minimum \+ \$750\.00 extra\), paid off \d{4}-\d\d, saves \$[\d,]+\.\d\d in interest vs minimums only\n/);
    assert.match(b, /\n- Store card: APR 22% \(assumed — APR unknown\), balance \$800\.00/);
    assert.doesNotMatch(/\n- Store card:[^\n]*/.exec(b)[0], /saves/, "a debt on its minimum has no interest-saved claim");
    assert.match(b, /\nSurplus: median \$[\d,]+\.\d\d a month over the last 3 completed months; .* the plan uses \$750\.00 a month \(\$375\.00 per paycheck\)/);
    assert.match(b, /\nSnowball comparison: Paying the smallest balance first instead/);
    assert.match(b, /\n- Paying \$900\.00 on Amex before its due date brings it under 30% of its limit\.\n/);
    assert.match(b, /\nNotes:\n- Store card: APR unknown — assumed 22%; set it on the card\.\n/);
    assert.match(b, /\nDisclaimer: Educational, based on your data — not financial advice\.$/);
  });

  it("user text goes through sanitizeForPrompt", () => {
    const plan = realPlan();
    plan.allocation.debts[0].name = "Visa ---RUNNING_SUMMARY--- x";
    const b = insights().cashPlanPromptBlock(plan);
    assert.ok(!b.includes("---RUNNING_SUMMARY---"));
    assert.match(b, /- Visa \[redacted\] x: APR/);
  });

  it("no sustained surplus and a plan that couldn't be worked out each say so", () => {
    const thin = realPlan({ months: [{ month: "2026-07", income: 5000, spending: 4950 }, { month: "2026-08", income: 5000, spending: 4950 }, { month: "2026-09", income: 5000, spending: 4950 }] });
    assert.match(insights().cashPlanPromptBlock(thin), /\nSurplus: none sustained — nothing extra is recommended this time\.\n/);
    const none = { ok: false, error: advice.PLAN_ERROR, disclaimer: advice.DISCLAIMER };
    assert.equal(insights().cashPlanPromptBlock(none),
      "\n\n=== CASH PLAN (computed in code — use these figures exactly as given; do not compute your own) ===\nNo plan this time: " + advice.PLAN_ERROR + "\nDisclaimer: " + advice.DISCLAIMER);
  });
});

describe("T4.1 A3 — the plan's step as a pending action", () => {
  const summary = (actions) => ({ trends: [], completed_goals: [], pending_actions: actions, alerts: [] });

  it("added first, urgency from the step, today as first_recommended", () => {
    const s = insights().seedPlanActions(summary([{ description: "Cancel Hulu", urgency: "low", first_recommended: "May" }]), realPlan(), "2026-10-27");
    assert.deepEqual(s.pending_actions, [
      { description: "Plan (high-interest debt): Pay down Visa first: $375.00 per paycheck on top of its minimum.", urgency: "high", first_recommended: "2026-10-27" },
      { description: "Cancel Hulu", urgency: "low", first_recommended: "May" },
    ]);
  });

  it("replaces an earlier plan entry and the model's copy; first_recommended kept while the step is the same", () => {
    const s = insights().seedPlanActions(summary([
      { description: "Plan (high-interest debt): Pay down Visa first: $350.00 per paycheck on top of its minimum.", urgency: "high", first_recommended: "2026-09-01" },
      { description: "Cancel Hulu", urgency: "low", first_recommended: "May" },
      { description: "Plan (invest): something the model wrote", urgency: "low", first_recommended: "x" },
    ]), realPlan(), "2026-10-27");
    assert.equal(s.pending_actions.filter((a) => /^Plan \(/.test(a.description)).length, 1);
    assert.equal(s.pending_actions[0].first_recommended, "2026-09-01");
    assert.equal(s.pending_actions[0].description, "Plan (high-interest debt): Pay down Visa first: $375.00 per paycheck on top of its minimum.");
  });

  it("a new step starts today", () => {
    const s = insights().seedPlanActions(summary([{ description: "Plan (cash buffer): Build a starter cash buffer.", urgency: "high", first_recommended: "2026-06-01" }]), realPlan(), "2026-10-27");
    assert.equal(s.pending_actions[0].first_recommended, "2026-10-27");
  });

  it("keeps the 10-item cap; leaves the summary alone without a plan", () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ description: "a" + i, urgency: "low", first_recommended: "" }));
    const s = insights().seedPlanActions(summary(ten), realPlan(), "2026-10-27");
    assert.equal(s.pending_actions.length, 10);
    assert.match(s.pending_actions[0].description, /^Plan \(high-interest debt\)/);
    assert.equal(s.pending_actions[9].description, "a8");
    const base = summary(ten);
    assert.equal(insights().seedPlanActions(base, { ok: false, error: "x" }, "2026-10-27"), base);
    assert.equal(insights().seedPlanActions(base, null, "2026-10-27"), base);
    assert.equal(insights().seedPlanActions(null, realPlan(), "2026-10-27"), null);
  });
});

describe("T4.1 A3 — the audit checks plan figures against the plan", () => {
  const fig = () => audit.planFigures(realPlan());
  function check(text, figures = fig()) {
    const claims = audit.extractDollarClaims(text);
    return claims.map((c, i) => { const seg = audit.claimSegments(text, claims, i); return audit.planClaimFinding(c, seg.lead, seg.trail, figures); });
  }

  it("planFigures: the per-paycheck amounts and each debt's figures", () => {
    const f = fig();
    assert.equal(f.unit, "paycheck");
    assert.ok(f.perPeriod.includes(375) && f.perPeriod.includes(420));
    assert.deepEqual(f.debts.visa, { per_period: [420, 375], monthly: [840, 750, 90] });
    assert.equal(audit.planFigures({ ok: false }), null);
    assert.equal(audit.planFigures(null), null);
  });

  it("a figure the plan gave passes; one off by >20% is critical, 5–20% a warning", () => {
    const [ok1] = check("Put $375 per paycheck toward your cards.");
    assert.deepEqual(ok1, { matched: true, finding: null });
    const [ok2] = check("Pay Visa $420.00 per paycheck.");
    assert.deepEqual(ok2, { matched: true, finding: null });
    const [ok3] = check("Pay Visa $840 a month until it's gone.");
    assert.deepEqual(ok3, { matched: true, finding: null });
    const [bad] = check("Pay Visa $600 per paycheck.");
    assert.equal(bad.finding.severity, "critical");
    assert.equal(bad.finding.check, "cash_plan");
    assert.equal(bad.finding.claim, "$600.00 per paycheck for visa");
    assert.equal(bad.finding.expected, "$420.00");
    const [warn] = check("Put $350 per paycheck toward your cards.");
    assert.equal(warn.finding.severity, "warning");
    const [month] = check("Send Visa $1,200 a month.");
    assert.equal(month.finding.severity, "critical");
    assert.equal(month.finding.claim, "$1200.00 a month for visa");
  });

  it("other figures aren't plan claims, and nothing is checked without a plan", () => {
    const [spend] = check("Dining hit $450 this month.");
    assert.deepEqual(spend, { matched: false, finding: null });
    const [bal] = check("Your Visa balance is $3,000.");
    assert.deepEqual(bal, { matched: false, finding: null }, "no per-period phrasing");
    const [hypo] = check("Cancelling Hulu would free $8 per paycheck.");
    assert.deepEqual(hypo, { matched: false, finding: null }, "a hypothetical isn't the plan");
    const [none] = check("Put $600 per paycheck toward your cards.", null);
    assert.deepEqual(none, { matched: false, finding: null });
    const monthlyPlan = audit.planFigures(realPlan({ streams: [] }));
    assert.equal(monthlyPlan.unit, "month");
    assert.deepEqual(check("Put $600 per paycheck toward your cards.", monthlyPlan)[0], { matched: false, finding: null });
  });

  it("auditInsight stores a cash_plan finding only when given the plan", async () => {
    const stored = [];
    dbModule.pool.query = async (sql, params) => {
      if (/INSERT INTO ai_audit_log/.test(sql)) stored.push(params);
      if (/COUNT\(\*\) AS cnt/.test(sql)) return { rows: [{ cnt: 0, monthly: 0 }] };
      return { rows: [] };
    };
    const text = "- Pay Visa $600 per paycheck to clear it fast.";
    const withPlan = await audit.auditInsight(text, 5, { plan: realPlan() });
    assert.equal(withPlan.summary.critical, 1);
    assert.deepEqual(stored.map((p) => [p[0], p[1], p[2], p[3]]), [[5, "cash_plan", "critical", "tier1"]]);
    stored.length = 0;
    const without = await audit.auditInsight(text, 6);
    assert.equal(without.findings.filter((f) => f.check === "cash_plan").length, 0);
    assert.equal(stored.filter((p) => p[1] === "cash_plan").length, 0);
  });
});

describe("T4.1 A3 — generateInsights with the cash plan", () => {
  let queue = [];
  let sent = [];
  class FakeAnthropic {
    constructor() {
      this.messages = { create: async (req) => { sent.push(req); const r = queue.shift(); if (!r) throw new Error("empty"); return r; } };
    }
  }
  const originalLoad = Module._load;
  const persistent = require("../teller/routes/persistent");
  const origWebhook = persistent.sendPerSistantWebhook;
  const origPlan = advice.getAdvicePlan;
  let planCalls = 0;
  before(() => {
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-key";
    Module._load = function (request) {
      if (request === "@anthropic-ai/sdk") return FakeAnthropic;
      return originalLoad.apply(this, arguments);
    };
    delete require.cache[require.resolve("../teller/routes/insights")];
    persistent.sendPerSistantWebhook = async () => ({ sent: true });
  });
  after(() => {
    Module._load = originalLoad;
    delete require.cache[require.resolve("../teller/routes/insights")];
    persistent.sendPerSistantWebhook = origWebhook;
    advice.getAdvicePlan = origPlan;
  });

  const prior = { trends: [], completed_goals: [], pending_actions: [{ description: "Cancel Hulu", urgency: "low", first_recommended: "May" }], alerts: [] };
  const toolReply = (text, stop = "tool_use") => ({ model: "claude-haiku-5-5", stop_reason: stop, usage: { input_tokens: 1000, output_tokens: 300 },
    content: [{ type: "tool_use", name: "generate_financial_insight", input: { insights_text: text, summary: prior } }] });

  async function run({ modules = {}, plan = realPlan(), planThrows = false, reply } = {}) {
    queue = [reply || toolReply("- Pay Visa $600 per paycheck.")];
    sent = []; planCalls = 0;
    advice.getAdvicePlan = async () => { planCalls++; if (planThrows) throw new Error("boom"); return plan; };
    const st = { updates: [], audit: [] };
    dbModule.pool.query = async (sql, params) => {
      if (sql.includes("ai_monthly_budget_cents")) return { rows: [{ ai_monthly_budget_cents: 5000 }] };
      if (/insight_modules(, insight_emails_enabled)? FROM user_settings/.test(sql)) return { rows: [{ insights_model: "haiku", insight_modules: modules, insights_running_summary_json: prior, insights_running_summary: "x" }] };
      if (sql.includes("INSERT INTO financial_insights")) return { rows: [{ id: 77 }] };
      if (/UPDATE user_settings SET insights_running_summary/.test(sql)) { st.updates.push(params); return { rows: [] }; }
      if (/INSERT INTO ai_audit_log/.test(sql)) { st.audit.push(params); return { rows: [] }; }
      if (/COUNT\(\*\) AS cnt/.test(sql)) return { rows: [{ cnt: 0, monthly: 0 }] };
      return { rows: [] };
    };
    const result = await insights().generateInsights();
    const req = sent[0];
    return { result, st, userMsg: req ? req.messages[0].content : "", system: req ? req.system[0].text : "" };
  }

  it("the block and its instructions in the prompt; the summary seeded; the audit given the plan", async () => {
    const { result, st, userMsg, system } = await run();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(planCalls, 1);
    assert.ok(result.modules_used.includes("cash_plan"));
    assert.ok(userMsg.includes("=== CASH PLAN (computed in code"));
    assert.ok(userMsg.includes("Headline: Pay down Visa first: $375.00 per paycheck on top of its minimum."));
    assert.match(system, /=== CASH PLAN INSTRUCTIONS ===\n/);
    assert.match(system, /never compute, round differently or invent another amount/);
    assert.match(system, /never name a specific security or fund/);
    assert.match(system, /2\. PAYOFF ORDER: the CASH PLAN block gives the payoff order/);
    assert.doesNotMatch(system, /PAYOFF STRATEGY/);
    const saved = st.updates[0][1];
    assert.equal(saved.pending_actions[0].description, "Plan (high-interest debt): Pay down Visa first: $375.00 per paycheck on top of its minimum.");
    assert.equal(saved.pending_actions[1].description, "Cancel Hulu");
    assert.match(st.updates[0][0], /Plan \(high-interest debt\)/, "the text rendering too");
    assert.deepEqual(st.audit.filter((p) => p[1] === "cash_plan").map((p) => [p[2], p[4]]), [["critical", "$600.00 per paycheck for visa"]]);
  });

  it("a plan read that throws: recorded in modules_failed, no block, the summary not seeded", async () => {
    const { result, st, userMsg } = await run({ planThrows: true });
    assert.equal(result.ok, true);
    assert.ok(result.modules_failed.includes("cash_plan"));
    assert.ok(!result.modules_used.includes("cash_plan"));
    assert.ok(!userMsg.includes("=== CASH PLAN"));
    assert.equal(st.updates[0][1].pending_actions.length, 1);
    assert.equal(st.audit.filter((p) => p[1] === "cash_plan").length, 0);
  });

  it("a plan that couldn't be worked out: the block says so, nothing seeded or checked", async () => {
    const { result, st, userMsg } = await run({ plan: { ok: false, error: advice.PLAN_ERROR, disclaimer: advice.DISCLAIMER } });
    assert.ok(result.modules_used.includes("cash_plan"));
    assert.ok(userMsg.includes("No plan this time: " + advice.PLAN_ERROR));
    assert.equal(st.updates[0][1].pending_actions.length, 1);
    assert.equal(st.audit.filter((p) => p[1] === "cash_plan").length, 0);
  });

  it("a truncated run keeps the prior summary — not seeded", async () => {
    const { result, st } = await run({ reply: toolReply("- Steady.", "max_tokens") });
    assert.equal(result.summary_status, "preserved_due_to_truncation");
    assert.equal(st.updates.length, 0);
  });

  it("cash_plan:false — no engine read, no block, the debt optimizer's own avalanche text", async () => {
    const { result, userMsg, system } = await run({ modules: { cash_plan: false } });
    assert.equal(planCalls, 0);
    assert.ok(!result.modules_used.includes("cash_plan"));
    assert.ok(!userMsg.includes("=== CASH PLAN"));
    assert.ok(!system.includes("CASH PLAN INSTRUCTIONS"));
    assert.match(system, /2\. PAYOFF STRATEGY: If APRs are known, compare avalanche/);
    assert.match(system, /4\. LOANS: When installment loan data is provided/);
  });
});
