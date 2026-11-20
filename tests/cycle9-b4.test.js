// ============================================================================
// Cycle 9 Batch 4 — AI audit trust
// ============================================================================
// F39  no false CRITICAL on correct text: the subscription total the prompt
//      gave (without utilities) is accepted; a percentage is the savings rate
//      only when the phrase reaches it in its own clause (not the "recommended
//      20%", a neighbouring figure or a change); a monthly rate isn't compared
//      with the month to date
// F40  the cash-plan check: a period phrase that trails the PREVIOUS figure
//      doesn't apply to the next one; contribution-room amounts are plan
//      figures; a per-paycheck amount with nothing in the plan to match is flagged
// F41  Ask's tool results are shortened by key and stay valid JSON; the
//      what-if comparison comes first
// F42  account, card, loan and institution names are known entities
// F43  an empty insight run doesn't stamp insights_last_run; the plan action's
//      first_recommended comes from the stored summary; the tax prompt doesn't
//      present the 2024 thresholds as current
// ============================================================================
process.env.NEON_DATABASE_URL = process.env.NEON_DATABASE_URL || "postgres://test@localhost/test";
process.env.TOKEN_ENCRYPTION_PASSPHRASE = process.env.TOKEN_ENCRYPTION_PASSPHRASE || "test";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
afterEach(() => { dbModule.pool.query = originalQuery; });

const fq = require("../teller/services/financial-queries");
const advice = require("../teller/services/advice");
const audit = require("../teller/services/ai-audit");
const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const insights = () => require("../teller/routes/insights");

const cm = fq.currentMonth();
const pm = fq.previousMonthKey(cm);
const ppm = fq.previousMonthKey(pm);

// Ground truth. This month so far: Food and Drink $450, Shopping $330.
// Recurring: 7 rows — subscriptions $150/mo, utilities $80/mo ($230 together).
// Complete months: savings 24% and 18% (21% overall); the partial month 90%.
function mockAudit({ accounts = [], subs = { cnt: 7, monthly: 230, subs_monthly: 150, util_monthly: 80 } } = {}) {
  const seen = [];
  dbModule.pool.query = async (sql) => {
    seen.push(sql);
    if (/UPDATE financial_insights|INSERT INTO ai_audit_log/.test(sql)) return { rows: [] };
    if (/COUNT\(\*\) AS cnt/.test(sql)) return { rows: [subs] };
    if (/FROM linked_accounts/.test(sql) && /FROM teller_enrollments/.test(sql)) return { rows: accounts.map((n) => ({ n: n.toLowerCase() })) };
    if (/display_name FROM detected_subscriptions/.test(sql)) return { rows: [{ display_name: "Hulu" }] };
    if (/AS c FROM transactions/.test(sql)) return { rows: [{ c: "food and drink" }, { c: "shopping" }] };
    if (/AS m FROM transactions/.test(sql)) return { rows: [{ m: "costco" }, { m: "netflix" }] };
    if (/financial_goals/.test(sql)) return { rows: [] };
    if (/total_income/.test(sql)) return { rows: [{ month: ppm, total_income: 5000 }, { month: pm, total_income: 5000 }, { month: cm, total_income: 5000 }] };
    if (/total_spend/.test(sql)) return { rows: [{ month: ppm, total_spend: 3800 }, { month: pm, total_spend: 4100 }, { month: cm, total_spend: 500 }] };
    if (/category/.test(sql)) return { rows: [{ category: "Food and Drink", spent: 450 }, { category: "Shopping", spent: 330 }] };
    return { rows: [] };
  };
  return seen;
}
async function findingsFor(text, opts = {}, auditOpts = {}) {
  mockAudit(opts);
  return (await audit.auditInsight(text, null, auditOpts)).findings.map((f) => `${f.severity}:${f.check}:${f.claim}`);
}

// The A3 fixture: Visa 24.99%, a store card at an assumed 22%, a 0% card on its
// minimum, a paid-in-full Amex; semimonthly pay → $375 extra / $420 total to
// Visa per paycheck ($840 a month: $90 minimum + $750 extra).
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

// ---------------------------------------------------------------------------
describe("F39 — the subscription total the prompt gave is not a CRITICAL", () => {
  it("the audit reads subscriptions and utilities apart", async () => {
    const seen = mockAudit();
    await audit.auditInsight("Nothing to check.", null);
    const q = seen.find((s) => /COUNT\(\*\) AS cnt/.test(s));
    assert.match(q, /FILTER \(WHERE category IS DISTINCT FROM 'utility'\) AS subs_monthly/);
    assert.match(q, /FILTER \(WHERE category = 'utility'\) AS util_monthly/);
  });

  it("the subscriptions-only total ($150 — what the prompt says) passes; it used to be compared with $230", async () => {
    assert.deepEqual(await findingsFor("Your 5 subscriptions total $150/mo."), []);
    assert.deepEqual(await findingsFor("All your subscriptions combined cost $150 a month."), []);
  });

  it("subscriptions plus utilities ($230 — the Subscriptions page's total) passes too", async () => {
    assert.deepEqual(await findingsFor("Your 7 subscriptions total $230/mo."), []);
  });

  it("a clause that names utilities may state the utility total", async () => {
    assert.deepEqual(await findingsFor("Your subscriptions total $150 and utilities total $80."), []);
  });

  it("a wrong total is still CRITICAL, against the nearest real one", async () => {
    assert.deepEqual(await findingsFor("Your 7 subscriptions total $400 per month."), ["critical:subscription_total:$400.00"]);
    mockAudit();
    const f = (await audit.auditInsight("Your 7 subscriptions total $400 per month.", null)).findings[0];
    assert.equal(f.expected, "$230.00");
    assert.deepEqual(await findingsFor("Your 5 subscriptions total $165 a month."), ["warning:subscription_total:$165.00"]);
  });

  it("an older reader of the query (no split columns) still gets one total", async () => {
    assert.deepEqual(await findingsFor("Your 7 subscriptions total $150/mo.", { subs: { cnt: 7, monthly: 150 } }), []);
    assert.deepEqual(await findingsFor("Your 7 subscriptions total $400/mo.", { subs: { cnt: 7, monthly: 150 } }), ["critical:subscription_total:$400.00"]);
  });
});

// ---------------------------------------------------------------------------
describe("F39 — a percentage is the savings rate only in its own clause", () => {
  const correct = [
    // the prompt supplies "recommended 20%" — repeating it is not a wrong rate
    "Your savings rate is 18%, below the recommended 20%.",
    "The recommended savings rate is 20%+ (50/30/20 rule); you are close.",
    "Aim for a savings rate of 20% or more.",
    "A 20% savings rate is the usual target.",
    "Your savings rate is 18%, above the 5% national figure.",
    // a neighbouring figure in the next sentence / clause
    "Your savings rate is 18%. Dining was up 55% on last month.",
    "Your savings rate is healthy, while card utilization sits at 45%.",
    "Savings rate: 18%; utilization: 62%.",
    // a change, not the rate
    "Your savings rate improved by 6% since the spring.",
    "Your savings rate is 18%, a 6 point improvement.",
    "Your savings rate rose 6 percentage points.",
    // still the rate, still right
    "You have an 18% savings rate.",
    "Your savings rate is 18%.",
    "Your savings rate averaged 21% over the last six months.",
    "Your savings rate rose to 18% last month.",
  ];
  for (const t of correct) {
    it(`no finding: ${JSON.stringify(t)}`, async () => {
      assert.deepEqual(await findingsFor(t), []);
    });
  }

  it("a wrong rate is still caught, in either phrasing", async () => {
    assert.deepEqual(await findingsFor("- **Savings rate**: 50%"), ["critical:savings_rate:50%"]);
    assert.deepEqual(await findingsFor("Your savings rate is 50%."), ["critical:savings_rate:50%"]);
    assert.deepEqual(await findingsFor("You have a 50% savings rate."), ["critical:savings_rate:50%"]);
    assert.deepEqual(await findingsFor("Your savings rate is 50%, well above the recommended 20%."), ["critical:savings_rate:50%"]);
    assert.deepEqual(await findingsFor("Your savings rate is 26%."), ["warning:savings_rate:26%"]);
  });

  it("\"this month\" anywhere in the sentence still selects the partial month", async () => {
    assert.deepEqual(await findingsFor("Your savings rate is 90% this month."), []);
    assert.deepEqual(await findingsFor("This month your savings rate is 90%."), []);
    assert.deepEqual(await findingsFor("Your savings rate is 20% this month."), ["critical:savings_rate:20%"]);
  });

  it("savingsRateClaim: the phrase must reach the figure unbroken", () => {
    const is = (text) => {
      const claims = audit.extractPercentClaims(text);
      return claims.map((_, i) => !!audit.savingsRateClaim(text, claims, i));
    };
    assert.deepEqual(is("Your savings rate is 18%, below the recommended 20%."), [true, false]);
    assert.deepEqual(is("Savings ratio: 18%"), [true], "a heading-style colon still reaches");
    assert.deepEqual(is("- **Savings rate**: 18%; utilization: 62%"), [true, false]);
    assert.deepEqual(is("Your save rate this year is 18%"), [true]);
    assert.deepEqual(is("Your savings rate and your utilization of 45%"), [false]);
    assert.deepEqual(is("An 18% saving rate"), [true]);
    assert.deepEqual(is("Dining is up 25%."), [false]);
  });
});

// ---------------------------------------------------------------------------
describe("F39 — a monthly rate is not this month's total", () => {
  const rates = [
    "You spend about $600/mo on Food and Drink.",
    "Food and Drink: $600/month.",
    "Food and Drink runs $600 a month.",
    "Shopping costs you $500 per month.",
    "Food and Drink averages $600.",
    "Shopping averages about $500.",
  ];
  for (const t of rates) {
    it(`no finding: ${JSON.stringify(t)}`, async () => {
      assert.deepEqual(await findingsFor(t), []);
    });
  }

  it("the same figure tagged \"this month\" is still checked", async () => {
    assert.deepEqual(await findingsFor("Food and Drink is at $600/mo this month."), ["critical:arithmetic:$600.00 for food and drink"]);
  });

  it("a plain total is still checked, right and wrong", async () => {
    assert.deepEqual(await findingsFor("Food and Drink spending hit $450."), []);
    assert.deepEqual(await findingsFor("Food and Drink spending hit $900."), ["critical:arithmetic:$900.00 for food and drink"]);
    assert.deepEqual(await findingsFor("You spent $800 on shopping."), ["critical:arithmetic:$800.00 for shopping"]);
  });
});

// ---------------------------------------------------------------------------
describe("F40 — the cash-plan check", () => {
  const fig = (plan = realPlan()) => audit.planFigures(plan);
  function check(text, figures = fig()) {
    const claims = audit.extractDollarClaims(text);
    return claims.map((c, i) => {
      const seg = audit.claimSegments(text, claims, i);
      return audit.planClaimFinding(c, seg.lead, seg.trail, figures, { afterFigure: seg.afterFigure });
    });
  }
  const findingsOf = (text, figures) => check(text, figures).filter((r) => r.finding).map((r) => `${r.finding.severity}:${r.finding.claim}`);

  it("claimSegments marks a figure that follows another in the same sentence", () => {
    const text = "Pay Visa $420.00 per paycheck ($840.00 a month). Then $50 more.";
    const claims = audit.extractDollarClaims(text);
    assert.deepEqual(claims.map((_, i) => audit.claimSegments(text, claims, i).afterFigure), [false, true, false]);
  });

  it("\"per paycheck\" after one figure doesn't make the next figure a per-paycheck claim", () => {
    // $840 is the monthly figure; it used to be judged per paycheck (nearest $420 → 100% off, CRITICAL).
    assert.deepEqual(findingsOf("Pay Visa $420.00 per paycheck ($840.00 a month: $90.00 minimum + $750.00 extra)."), []);
    assert.deepEqual(findingsOf("Put $375 per paycheck toward your cards, about $9,000 over the year."), []);
  });

  it("the prompt block's own lines pass the check they are checked by", () => {
    const block = insights().cashPlanPromptBlock(realPlan());
    assert.match(block, /pay \$420\.00 per paycheck \(\$840\.00 a month: \$90\.00 minimum \+ \$750\.00 extra\)/);
    assert.deepEqual(findingsOf(block), [], "a model that repeats the block verbatim raises nothing");
  });

  it("a period phrase BEFORE the figure still counts when no figure precedes it", () => {
    assert.deepEqual(findingsOf("Each paycheck, put $375 toward your cards."), []);
    assert.deepEqual(findingsOf("Each paycheck, put $600 toward your cards."), ["critical:$600.00 per paycheck"]);
  });

  it("a wrong plan figure is still caught, whichever side its period is on", () => {
    assert.deepEqual(findingsOf("Pay Visa $600 per paycheck."), ["critical:$600.00 per paycheck for visa"]);
    assert.deepEqual(findingsOf("Pay Visa $420 per paycheck ($1,200 a month)."), [], "the monthly figure in a parenthetical isn't attributed to Visa — unchecked, not mis-flagged");
    assert.deepEqual(findingsOf("Send Visa $1,200 a month."), ["critical:$1200.00 a month for visa"]);
  });

  it("contribution-room amounts are plan figures", () => {
    const plan = realPlan();
    plan.contribution_room = { accounts: [{ name: "Roth IRA", per_period: 292, text: "Roth IRA: $292.00 per paycheck would fill it by Dec 31." }] };
    const f = audit.planFigures(plan);
    assert.ok(f.perPeriod.includes(292));
    assert.deepEqual(findingsOf("Put $292 per paycheck into your Roth IRA to fill it by Dec 31.", f), []);
    // Without it in the set the nearest plan amount was $375 — a 22% miss, CRITICAL.
    assert.deepEqual(findingsOf("Put $292 per paycheck into your Roth IRA to fill it by Dec 31."), ["critical:$292.00 per paycheck"]);
  });

  it("an invented per-paycheck amount is flagged when the plan recommends nothing", () => {
    const thin = realPlan({ debts: [], activity: [], months: [{ month: "2026-07", income: 5000, spending: 4950 }, { month: "2026-08", income: 5000, spending: 4950 }, { month: "2026-09", income: 5000, spending: 4950 }] });
    const f = audit.planFigures(thin);
    assert.equal(f.unit, "paycheck");
    assert.deepEqual(f.perPeriod, [], "nothing is recommended");
    const [r] = check("Put $500 per paycheck into savings.", f);
    assert.equal(r.matched, true);
    assert.deepEqual({ severity: r.finding.severity, check: r.finding.check, claim: r.finding.claim, expected: r.finding.expected },
      { severity: "warning", check: "cash_plan", claim: "$500.00 per paycheck", expected: "no such amount in the plan" });
  });

  it("…but a sentence about pay, a hypothetical and a non-plan figure aren't", () => {
    const f = audit.planFigures(realPlan({ debts: [], activity: [], months: [{ month: "2026-07", income: 5000, spending: 4950 }, { month: "2026-08", income: 5000, spending: 4950 }, { month: "2026-09", income: 5000, spending: 4950 }] }));
    assert.deepEqual(check("You bring home $2,500 per paycheck.", f), [{ matched: false, finding: null }]);
    assert.deepEqual(check("Your income is $2,500 per paycheck.", f), [{ matched: false, finding: null }]);
    assert.deepEqual(check("Cancelling Hulu would free $8 per paycheck.", f), [{ matched: false, finding: null }]);
    assert.deepEqual(check("Dining hit $450 this month.", f), [{ matched: false, finding: null }]);
  });

  it("end to end: the audit runs the plan check with afterFigure", async () => {
    const plan = realPlan();
    assert.deepEqual(await findingsFor("Pay Visa $420.00 per paycheck ($840.00 a month: $90.00 minimum + $750.00 extra).", {}, { plan }), []);
    assert.deepEqual(await findingsFor("Pay Visa $600 per paycheck.", {}, { plan }), ["critical:cash_plan:$600.00 per paycheck for visa"]);
  });
});

// ---------------------------------------------------------------------------
describe("F41 — Ask's tool results are shortened by key and stay valid JSON", () => {
  const ask = () => require("../teller/routes/ask");

  it("a result within the limit is sent whole", () => {
    const { toolResultContent } = ask();
    assert.equal(toolResultContent({ a: 1, b: [1, 2] }), '{"a":1,"b":[1,2]}');
    assert.equal(ask().TOOL_RESULT_LIMIT, 12000);
  });

  it("a long plan loses its supporting sections, least needed first — never the what-if", () => {
    const { toolResultContent, TOOL_RESULT_LIMIT } = ask();
    const big = {
      ok: true, disclaimer: "Educational only.",
      what_if: { text: "Paying $200 more a month clears Visa 7 months sooner.", before: { step: "high_interest_debt" }, after: { step: "emergency_fund" } },
      period: { unit: "paycheck" }, headline: { text: "Put $375 per paycheck toward Visa." },
      debts: Array.from({ length: 12 }, (_, i) => ({ name: "Card " + i, balance: 1000 + i, utilization_tip: "x".repeat(200) })),
      allocation: { debts: Array.from({ length: 12 }, (_, i) => ({ name: "Card " + i, per_period: 100 })) },
      subscription_review: { overlaps: Array.from({ length: 30 }, () => ({ text: "y".repeat(180) })) },
      sinking_funds: { bills: Array.from({ length: 8 }, () => ({ text: "z".repeat(200) })) },
      notes: Array.from({ length: 40 }, () => "n".repeat(120)),
    };
    assert.ok(JSON.stringify(big).length > TOOL_RESULT_LIMIT, "the fixture is over the limit");
    const out = toolResultContent(big);
    assert.ok(out.length <= TOOL_RESULT_LIMIT);
    const parsed = JSON.parse(out); // valid JSON — the old slice(0, 12000) wasn't
    assert.deepEqual(parsed.what_if, big.what_if);
    assert.deepEqual(parsed.headline, big.headline);
    // Dropped in the documented order, only as far as needed.
    assert.equal(parsed.omitted_for_length[0], "notes");
    const order = ["notes", "subscription_review", "sinking_funds"];
    assert.deepEqual(parsed.omitted_for_length, order.slice(0, parsed.omitted_for_length.length));
    assert.deepEqual(parsed.debts, big.debts, "what fits is sent whole");
    assert.equal("notes" in parsed, false);
  });

  it("the old cut dropped the comparison and left broken JSON", () => {
    const big = { ok: true, notes: Array.from({ length: 200 }, () => "n".repeat(100)), what_if: { text: "the answer" } };
    const old = JSON.stringify(big).slice(0, 12000);
    assert.throws(() => JSON.parse(old));
    assert.ok(!old.includes("the answer"));
    assert.equal(JSON.parse(ask().toolResultContent(big)).what_if.text, "the answer");
  });

  it("a long list is halved until it fits, and says so", () => {
    const { toolResultContent, TOOL_RESULT_LIMIT } = ask();
    const rows = Array.from({ length: 400 }, (_, i) => ({ date: "2026-10-01", merchant: "Merchant number " + i, amount: 12.5 }));
    const out = toolResultContent({ adjusted_total: 5000, match_count: 400, transactions: rows });
    assert.ok(out.length <= TOOL_RESULT_LIMIT);
    const parsed = JSON.parse(out);
    assert.equal(parsed.adjusted_total, 5000);
    assert.equal(parsed.transactions.length, parsed.shortened_for_length.transactions.kept);
    assert.equal(parsed.shortened_for_length.transactions.of, 400);
    assert.deepEqual(parsed.transactions[0], rows[0], "the first rows are kept");
  });

  it("something that can't be shortened is a short error, still JSON", () => {
    const { toolResultContent } = ask();
    assert.deepEqual(JSON.parse(toolResultContent("x".repeat(20000))), { error: "This result was too large to return — ask a narrower question.", truncated: true });
    assert.deepEqual(JSON.parse(toolResultContent({ blob: "x".repeat(20000) })).truncated, true);
    assert.equal(toolResultContent(undefined), "null");
  });

  it("get_cash_plan puts what_if right after ok and the disclaimer, and the loop uses the helper", async () => {
    const real = advice.getAdviceInputs, realWhat = advice.whatIfPlan;
    advice.getAdviceInputs = async () => ({});
    advice.whatIfPlan = () => ({ ok: true, plan: realPlan(), changes: ["x"], before: {}, after: {}, debts: [], text: "T" });
    try {
      const out = await ask().TOOL_EXECUTORS.get_cash_plan({ income_change_monthly: 200 });
      assert.deepEqual(Object.keys(out).slice(0, 3), ["ok", "disclaimer", "what_if"]);
      assert.equal(out.what_if.text, "T");
      assert.ok(out.headline && out.debts, "the plan itself follows");
    } finally { advice.getAdviceInputs = real; advice.whatIfPlan = realWhat; }
    const code = read("teller", "routes", "ask.js").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    assert.match(code, /content: toolResultContent\(result\),/);
    assert.doesNotMatch(code, /JSON\.stringify\(result\)\.slice\(0, 12000\)/);
  });
});

// ---------------------------------------------------------------------------
describe("F42 — account, card and loan names are known entities", () => {
  it("the audit reads every account and institution name", async () => {
    const seen = mockAudit();
    await audit.auditInsight("Pay down the balance at Chase Sapphire.", null);
    assert.ok(seen.includes(audit.ACCOUNT_NAMES_SQL));
    for (const part of ["name AS n FROM linked_accounts", "official_name FROM linked_accounts", "institution_name_manual FROM linked_accounts",
      "name FROM investment_accounts", "institution FROM investment_accounts", "institution_name FROM plaid_items", "institution_name FROM teller_enrollments"]) {
      assert.ok(audit.ACCOUNT_NAMES_SQL.includes(part), part);
    }
  });

  it("naming a card or a loan the user has is not a warning — it used to be", async () => {
    const accounts = ["Chase Sapphire Preferred", "Auto Loan", "Schwab", "Capital One"];
    assert.deepEqual(await findingsFor("Pay down the balance at Chase Sapphire first.", { accounts }), []);
    assert.deepEqual(await findingsFor("Send the extra to Auto Loan each month.", { accounts }), []);
    assert.deepEqual(await findingsFor("Move the idle cash to Schwab.", { accounts }), []);
    assert.deepEqual(await findingsFor("Pay down the balance at Chase Sapphire first."), ["warning:entity_existence:Chase Sapphire"]);
  });

  it("an entity that is nowhere in the data is still flagged", async () => {
    assert.deepEqual(await findingsFor("Cancel the plan at Zorblax Media.", { accounts: ["Chase Sapphire Preferred"] }), ["warning:entity_existence:Zorblax Media"]);
  });
});

// ---------------------------------------------------------------------------
describe("F43 — empty runs, the plan action's date, the tax prompt", () => {
  it("an empty insight run charges the cap but doesn't stamp insights_last_run", () => {
    const src = read("teller", "routes", "insights.js");
    const empty = src.slice(src.indexOf("if (!insightText) {"), src.indexOf("summary_status: summaryStatus === \"updated\" ? \"preserved_no_tool_block\""));
    assert.match(empty, /'insight_empty'/);
    assert.doesNotMatch(empty, /UPDATE user_settings SET insights_last_run/);
    assert.match(empty, /status: 502/);
    // The two real-run paths still stamp it.
    assert.equal((src.match(/insights_last_run = now\(\)/g) || []).length, 2);
  });

  it("with insights_last_run left alone, the auto-trigger's 24-hour retry applies", () => {
    const src = read("teller", "startup.js");
    assert.match(src, /if \(lastAttempt && \(!lastRun \|\| lastAttempt > lastRun\) && \(now - lastAttempt\) < INSIGHTS_RETRY_MS\)/);
    assert.match(src, /const INSIGHTS_RETRY_MS = 24 \* 60 \* 60 \* 1000;/);
  });

  const summary = (pending) => ({ trends: [], completed_goals: [], pending_actions: pending, alerts: [] });
  const planAction = (s) => s.pending_actions.find((a) => /^Plan \(/.test(a.description));

  it("first_recommended comes from the stored summary when the model didn't copy the entry forward", () => {
    const stored = summary([{ description: "Plan (high-interest debt): Put $375 per paycheck toward Visa.", urgency: "high", first_recommended: "2026-06-01" }]);
    const fresh = summary([{ description: "Cancel Hulu", urgency: "low", first_recommended: "2026-10-01" }]);
    const s = insights().seedPlanActions(fresh, realPlan(), "2026-10-27", stored);
    assert.equal(planAction(s).first_recommended, "2026-06-01", "it used to reset to today");
    assert.equal(s.pending_actions.length, 2);
  });

  it("the stored entry wins over a date the model rewrote; a new step starts today", () => {
    const stored = summary([{ description: "Plan (high-interest debt): old text", urgency: "high", first_recommended: "2026-06-01" }]);
    const rewritten = summary([{ description: "Plan (high-interest debt): Put $375 per paycheck toward Visa.", urgency: "high", first_recommended: "2026-10-27" }]);
    assert.equal(planAction(insights().seedPlanActions(rewritten, realPlan(), "2026-10-27", stored)).first_recommended, "2026-06-01");
    const otherStep = summary([{ description: "Plan (cash buffer): Build a starter cash buffer.", urgency: "high", first_recommended: "2026-06-01" }]);
    assert.equal(planAction(insights().seedPlanActions(summary([]), realPlan(), "2026-10-27", otherStep)).first_recommended, "2026-10-27");
  });

  it("without a stored summary it behaves as before", () => {
    const carried = summary([{ description: "Plan (high-interest debt): x", urgency: "high", first_recommended: "2026-06-01" }]);
    assert.equal(planAction(insights().seedPlanActions(carried, realPlan(), "2026-10-27")).first_recommended, "2026-06-01");
    assert.equal(planAction(insights().seedPlanActions(summary([]), realPlan(), "2026-10-27", null)).first_recommended, "2026-10-27");
    assert.equal(planAction(insights().seedPlanActions(summary([]), realPlan(), "2026-10-27", { pending_actions: "bad" })).first_recommended, "2026-10-27");
    assert.match(read("teller", "routes", "insights.js"), /seedPlanActions\(newSummaryJson, cashPlan, todayStr\(\), runningSummaryJson\)/);
  });

  it("the tax prompt no longer presents the 2024 thresholds as the current ones", () => {
    const src = read("teller", "routes", "insights.js");
    assert.doesNotMatch(src, /Note standard deduction thresholds \(\$14,600 single \/ \$29,200 married 2024\)/);
    assert.match(src, /it was \$14,600 single \/ \$29,200 married filing jointly for 2024 and rises each year/);
    assert.match(src, /don't state a later year's amount unless you are sure of it/);
  });
});
