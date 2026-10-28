// Roadmap T4.1 A5 — the emergency-fund tracker and the goal catch-up amount
// (services/advice.js): monthsUntil / requiredMonthly (the Goals page's monthly
// compounding), goalCatchUps over canned goals (behind → "add $X per paycheck",
// rounded UP; within $5 → on track; interest lowering the need; due / overdue;
// reached; no date), the tracker inside buildAdvicePlan for each step (the
// emergency step's and the starter buffer's pace, after the high-interest debt,
// reached, nothing going toward it), the goals source (its SQL, deriveGoalProgress
// on a funding-linked goal, a failing read → still a plan, goals null), and the
// three surfaces: the "Your plan" card run in a vm (a labelled progress bar, the
// pace, behind / overdue goals only, escaped), the insight prompt block, the
// audit treating a goal's catch-up amount as a plan figure, and Ask's
// get_cash_plan carrying both.
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://localhost/test";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const a = require("../teller/services/advice");

const TODAY = "2026-10-27";
const VISA = { id: 1, account_id: "c1", name: "Visa", type: "credit", current_balance: "3000", apr: "24.99", minimum_payment: "90" };
function plan(over = {}) {
  return a.buildAdvicePlan({
    today: TODAY, errors: [],
    months: [{ month: "2026-07", income: 5000, spending: 3500 }, { month: "2026-08", income: 5000, spending: 3600 }, { month: "2026-09", income: 5000, spending: 3400 }],
    streams: [{ source: "ACME", amount: 2500, cadence: "semimonthly" }],
    cash: { starting_balance: 15000, lowest: { date: "2026-11-20", balance: 14000 } },
    settings: { cash_alert_threshold: "500" },
    debts: [VISA],
    activity: [{ account_id: "c1", txns: 3, interest: true }],
    transfers: [],
    goals: [],
    ...over,
  });
}
const lowCash = (bal) => ({ starting_balance: bal, lowest: { date: "2026-11-20", balance: bal - 500 } });
const goal = (over = {}) => ({ id: 1, name: "House", target: 12000, current: 2000, monthly_contribution: 0, target_date: "2027-10-15", interest_rate: 0, ...over });
const SEMI = { unit: "paycheck", perPeriod: (m) => Math.round((m * 12 / 24) * 100) / 100 };

// ---------------------------------------------------------------------------
describe("T4.1 A5 — monthsUntil / requiredMonthly", () => {
  it("counts calendar months to the target's month", () => {
    assert.equal(a.monthsUntil(TODAY, "2027-10-15"), 12);
    assert.equal(a.monthsUntil(TODAY, "2026-11-01"), 1);
    assert.equal(a.monthsUntil(TODAY, "2026-10-31"), 0);
    assert.equal(a.monthsUntil(TODAY, "2026-08-01"), -2);
  });

  it("is the even split without interest and the annuity payment with it", () => {
    assert.equal(a.requiredMonthly(12000, 2000, 10, 0), 1000);
    // FV of 2000 at 0.5%/month for 12 months + 12 deposits of P = 12000.
    const p = a.requiredMonthly(12000, 2000, 12, 6);
    const r = 0.005, g = Math.pow(1 + r, 12);
    assert.ok(Math.abs(2000 * g + p * (g - 1) / r - 12000) < 1e-6);
    assert.equal(a.requiredMonthly(1000, 1500, 6, 0), 0);
    assert.equal(a.requiredMonthly(1000, 400, 0, 0), 600);
  });
});

// ---------------------------------------------------------------------------
describe("T4.1 A5 — goalCatchUps", () => {
  it("behind: the shortfall per paycheck, rounded up, with the text", () => {
    const [g] = a.goalCatchUps([goal({ monthly_contribution: 500 })], TODAY, SEMI);
    assert.equal(g.status, "behind");
    assert.equal(g.months_left, 12);
    assert.equal(g.required_monthly, 833.33);
    assert.equal(g.add_monthly, 333.33);
    assert.equal(g.add_per_period, 167); // 166.67 rounded up
    assert.equal(g.text, "Add $167.00 per paycheck to House to finish by Oct 2027.");
  });

  it("on track within $5 a month; interest lowers what's needed", () => {
    assert.equal(a.goalCatchUps([goal({ monthly_contribution: 830 })], TODAY, SEMI)[0].status, "on_track");
    assert.equal(a.goalCatchUps([goal({ monthly_contribution: 828 })], TODAY, SEMI)[0].status, "behind");
    const withRate = a.goalCatchUps([goal({ monthly_contribution: 805, interest_rate: 6 })], TODAY, SEMI)[0];
    assert.equal(withRate.status, "on_track");
    assert.equal(withRate.required_monthly, 800.66);
  });

  it("due this month, overdue, reached, no date, no target", () => {
    const [due, over, done, nodate, notarget] = a.goalCatchUps([
      goal({ id: 2, target_date: "2026-10-31" }),
      goal({ id: 3, name: "Trip", target_date: "2026-06-01" }),
      goal({ id: 4, current: 12000 }),
      goal({ id: 5, target_date: null }),
      goal({ id: 6, target: 0 }),
    ], TODAY, SEMI);
    assert.equal(due.status, "due");
    assert.equal(due.text, "House is due this month with $10,000.00 to go.");
    assert.equal(over.status, "overdue");
    assert.equal(over.text, "Trip is past its target date with $10,000.00 to go.");
    assert.equal(over.add_per_period, null);
    assert.equal(done.status, "reached");
    assert.equal(nodate.status, "no_date");
    assert.equal(notarget.status, "reached");
  });

  it("per month when there's no paycheck", () => {
    const [g] = a.goalCatchUps([goal()], TODAY, { unit: "month", perPeriod: (m) => m });
    assert.equal(g.add_per_period, 834);
    assert.equal(g.text, "Add $834.00 per month to House to finish by Oct 2027.");
  });
});

// ---------------------------------------------------------------------------
describe("T4.1 A5 — the emergency-fund tracker", () => {
  it("the emergency step: months covered (floored to a tenth), progress and the date at this pace", () => {
    const p = plan({ debts: [], activity: [], cash: lowCash(4000) });
    assert.equal(p.headline.step, "emergency_fund");
    assert.deepEqual(p.emergency, {
      months_covered: 1.1, target_months: 3, target: 10500, have: 4000, remaining: 6500, pct: 38,
      reached: false, projection: { months: 8, month: "2027-06" }, note: null,
    });
  });

  it("the starter buffer step counts toward it too", () => {
    const p = plan({ debts: [], activity: [], cash: lowCash(1000) });
    assert.equal(p.headline.step, "starter_buffer");
    assert.deepEqual(p.emergency.projection, { months: 11, month: "2027-09" });
  });

  it("after high-interest debt: the payoff months first, then the fund, with a note", () => {
    const p = plan({ cash: lowCash(4000) });
    assert.equal(p.headline.step, "high_interest_debt");
    const payoff = p.allocation.debts[0].months_to_payoff;
    assert.equal(p.emergency.projection.months, payoff + Math.ceil(6500 / p.headline.amount_monthly));
    assert.equal(p.emergency.note, "It comes after your high-interest debt is paid off.");
  });

  it("reached; and nothing going toward it", () => {
    const done = plan();
    assert.equal(done.emergency.reached, true);
    assert.equal(done.emergency.pct, 100);
    assert.equal(done.emergency.projection, null);
    const thin = plan({ debts: [], activity: [], cash: lowCash(4000), months: [{ month: "2026-07", income: 3600, spending: 3500 }, { month: "2026-08", income: 3600, spending: 3600 }, { month: "2026-09", income: 3600, spending: 3400 }] });
    assert.equal(thin.emergency.projection, null);
    assert.equal(thin.emergency.note, "Nothing is going toward it right now.");
  });
});

// ---------------------------------------------------------------------------
describe("T4.1 A5 — the goals source", () => {
  const quietly = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
  const ok = {
    months: async () => [{ month: "2026-07", income: 5000, spending: 3500 }, { month: "2026-08", income: 5000, spending: 3600 }, { month: "2026-09", income: 5000, spending: 3400 }],
    streams: async () => [], cash: async () => lowCash(4000), settings: async () => ({ cash_alert_threshold: "500" }),
    debts: async () => [], activity: async () => [], transfers: async () => [],
    deposits: async () => [], categories: async () => [],
    idle: async () => ({ accounts: [], investments: [], snapshots: [] }), allocation: async () => ({ total_value: 0, has_targets: false, classes: [] }),
    subscriptions: async () => ({ subs: [], bills: [], activity: [] }),
  };

  it("reads active goals and measures a funding-linked one as balance − baseline (deriveGoalProgress)", async () => {
    const seen = [];
    const pool = { query: async (sql) => {
      seen.push(sql.replace(/\s+/g, " "));
      return { rows: [
        { id: 1, name: "House", target_amount: "12000", current_amount: "50", monthly_contribution: "300", target_date: "2027-10-15", interest_rate: "0",
          funding_account_id: 9, funding_account_balance: "5000", goal_baseline_amount: "1000" },
        { id: 2, name: "Trip", target_amount: "2000", current_amount: "400", monthly_contribution: null, target_date: null, interest_rate: null },
      ] };
    } };
    const inp = await a.getAdviceInputs(pool, { today: TODAY, deps: ok });
    assert.match(seen[0], /FROM financial_goals g LEFT JOIN linked_accounts la ON la\.id = g\.funding_account_id LEFT JOIN investment_accounts ia ON ia\.id = g\.funding_investment_id WHERE g\.is_active = true/);
    assert.deepEqual(inp.goals, [
      { id: 1, name: "House", target: 12000, current: 4000, monthly_contribution: 300, target_date: "2027-10-15", interest_rate: 0 },
      { id: 2, name: "Trip", target: 2000, current: 400, monthly_contribution: 0, target_date: null, interest_rate: 0 },
    ]);
    const p = a.buildAdvicePlan(inp);
    assert.equal(p.goals[0].status, "behind");
    assert.equal(p.goals[1].status, "no_date");
  });

  it("a failing goals read is not critical: still a plan, goals null, its sentence", async () => {
    const inp = await quietly(() => a.getAdviceInputs({}, { today: TODAY, deps: { ...ok, goals: async () => { throw new Error("x"); } } }));
    const p = a.buildAdvicePlan(inp);
    assert.equal(p.ok, true);
    assert.equal(p.goals, null);
    assert.deepEqual(p.errors, [{ source: "goals", error: "Your goals couldn't be read." }]);
  });
});

// ---------------------------------------------------------------------------
describe("T4.1 A5 — the surfaces", () => {
  const dash = read("teller/views/dashboard.ejs");
  function card() {
    const i = dash.indexOf("    var ADVICE_DISCLAIMER"), j = dash.indexOf("    // Design D3: the Summary card + Needs attention");
    const ctx = {
      esc: (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
      fmt: (n) => (Number(n) < 0 ? "-$" : "$") + Math.abs(Number(n)).toFixed(2),
      emptyState: () => "EMPTY", Number, String, Date, JSON,
    };
    vm.runInNewContext(dash.slice(i, j), ctx);
    return ctx;
  }
  const withGoals = () => plan({ debts: [], activity: [], cash: lowCash(4000), goals: [
    goal({ name: "House <b>", monthly_contribution: 500 }),
    goal({ id: 2, name: "Car", monthly_contribution: 900 }),
    goal({ id: 3, name: "Trip", target_date: "2026-06-01" }),
  ] });

  it("the card: a labelled progress bar, the pace, and only behind / overdue goals, escaped", () => {
    const html = card().renderAdvice(withGoals());
    assert.match(html, /Emergency fund: 1\.1 of 3 months of spending \(\$4000\.00 of \$10500\.00\)/);
    assert.match(html, /<progress max="100" value="38" aria-label="Emergency fund: 38% of the target"><\/progress>/);
    assert.match(html, /At this pace, reached around Jun 2027\./);
    assert.match(html, /<li>Add \$167\.00 per paycheck to House &lt;b&gt; to finish by Oct 2027\.<\/li>/);
    assert.match(html, /<li>Trip is past its target date with \$10,000\.00 to go\.<\/li>/);
    assert.doesNotMatch(html, /Car/);
  });

  it("the card: reached, and the high-debt note", () => {
    assert.match(card().renderAdvice(plan()), /<div class="advice-ef-sub">Reached\.<\/div>/);
    const html = card().renderAdvice(plan({ cash: lowCash(4000) }));
    assert.match(html, /At this pace, reached around /);
  });

  it("the insight prompt block carries both", () => {
    const block = require("../teller/routes/insights").cashPlanPromptBlock(withGoals());
    assert.match(block, /\nEmergency fund: 1\.1 of 3 months of spending covered \(\$4,000\.00 of \$10,500\.00, 38%\), reaches it around 2027-06 at this pace\.\n/);
    assert.match(block, /\nGoals behind their target dates:\n- Add \$167\.00 per paycheck to House <b> to finish by Oct 2027\.\n- Trip is past its target date/);
    assert.doesNotMatch(block, /Car/);
    const debt = require("../teller/routes/insights").cashPlanPromptBlock(plan({ cash: lowCash(4000) }));
    assert.match(debt, /, reaches it around \d{4}-\d{2} at this pace — it comes after your high-interest debt is paid off\.\n/);
  });

  it("the audit treats a goal's catch-up amount as a plan figure", () => {
    const audit = require("../teller/services/ai-audit");
    const f = audit.planFigures(withGoals());
    assert.ok(f.perPeriod.includes(167));
    const check = (text) => { const c = audit.extractDollarClaims(text); return c.map((x, i) => { const s = audit.claimSegments(text, c, i); return audit.planClaimFinding(x, s.lead, s.trail, f); }); };
    assert.deepEqual(check("Add $167 per paycheck to House to finish by Oct 2027."), [{ matched: true, finding: null }]);
    // Without the goal in the plan figures the same sentence is a wrong plan amount.
    const bare = { ...f, perPeriod: f.perPeriod.filter((v) => v !== 167) };
    const c = audit.extractDollarClaims("Add $167 per paycheck to House.");
    const s = audit.claimSegments("Add $167 per paycheck to House.", c, 0);
    assert.equal(audit.planClaimFinding(c[0], s.lead, s.trail, bare).finding.check, "cash_plan");
  });

  it("Ask's get_cash_plan carries the tracker and the goals", async () => {
    const real = a.getAdvicePlan;
    const p = withGoals();
    a.getAdvicePlan = async () => p;
    try {
      const ask = require("../teller/routes/ask");
      const exec = ask._TOOL_EXECUTORS || ask.TOOL_EXECUTORS;
      const out = await exec.get_cash_plan({});
      assert.deepEqual(out.emergency, p.emergency);
      assert.deepEqual(out.goals, p.goals);
    } finally { a.getAdvicePlan = real; }
  });
});
