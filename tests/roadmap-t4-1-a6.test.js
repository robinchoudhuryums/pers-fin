// Roadmap T4.1 A6 — raises, bonuses and spending creep (services/advice.js):
// detectRaises over canned deposits (a biweekly step-up with its cadence from the
// stream or the gaps, noisy pay, a too-small / too-old / single raised deposit, a
// bonus inside the run), detectBonuses (1.5× and $500, a one-off at $1,000, a
// level of two big deposits, the 45-day window), splitWindfall in the plan's
// order (buffer → high debt by APR → emergency → medium 50/50 → invest, the
// state carried to a second lump), spendingCreep (faster than income by 15
// points and $50, the base, Uncategorized, a missing month, the top 3), the plan
// fields and texts (toward the current step, the bonus measured without itself,
// a failing read null with its sentence), the readers' SQL, the surfaces (the
// card in a vm, the prompt block, the audit's plan figures, Ask) and the
// plan-change push for a new raise or bonus.
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://localhost/test";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const a = require("../teller/services/advice");
const aa = require("../teller/services/advice-alerts");

const TODAY = "2026-10-28";
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
// Biweekly deposits from `start` through TODAY; `amountOf(date)` sets each one.
function biweekly(source, start, amountOf) {
  const out = [];
  for (let d = start; d <= TODAY; d = addDays(d, 14)) out.push({ date: d, source, amount: amountOf(d) });
  return out;
}
const STREAM = [{ source: "ACME PAYROLL", cadence: "biweekly", amount: 2200 }];
const RAISED = biweekly("ACME PAYROLL", "2026-03-06", (d) => (d >= "2026-09-11" ? 2200 : 2000));
const MONTHS = ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]
  .map((m) => ({ month: m, income: 4333, spending: 2800 }));
const VISA = { id: 1, account_id: "c1", name: "Visa", type: "credit", current_balance: "3000", apr: "24.99", minimum_payment: "90" };
const CAR = { id: 2, account_id: "l1", name: "Car loan", type: "loan", current_balance: "6000", apr: "6", monthly_payment: "250" };

function inputs(over = {}) {
  return {
    today: TODAY, errors: [],
    months: MONTHS,
    streams: STREAM,
    cash: { starting_balance: 15000, lowest: { date: "2026-11-20", balance: 14000 } },
    settings: { cash_alert_threshold: "500" },
    debts: [VISA],
    activity: [{ account_id: "c1", txns: 3, interest: true }],
    transfers: [], goals: [], deposits: [], categories: [],
    ...over,
  };
}
const plan = (over) => a.buildAdvicePlan(inputs(over));
const cats = (rows) => rows.flatMap(([category, prior, recent]) => [
  ...["2026-04", "2026-05", "2026-06"].map((month) => ({ month, category, spent: prior })),
  ...["2026-07", "2026-08", "2026-09"].map((month) => ({ month, category, spent: recent })),
]);

// ---------------------------------------------------------------------------
describe("T4.1 A6 — detectRaises", () => {
  it("a biweekly step-up from $2,000 to $2,200: the levels, the month, the cadence from the stream", () => {
    const [r] = a.detectRaises(RAISED, TODAY, STREAM);
    assert.deepEqual(r, { source: "ACME PAYROLL", from: 2000, to: 2200, raise_per_deposit: 200, deposits_per_year: 26, raise_monthly: 433.33, since: "2026-09-18" });
  });

  it("without a live stream the cadence comes from the gaps between deposits", () => {
    const [r] = a.detectRaises(RAISED, TODAY, []);
    assert.equal(r.deposits_per_year, 26);
    const monthly = RAISED.filter((_, i) => i % 2 === 0).map((d) => ({ ...d, date: d.date.slice(0, 8) + "01" }));
    const [m] = a.detectRaises(monthly, TODAY, []);
    assert.equal(m.deposits_per_year, 12);
  });

  it("pay that wanders within ±10% is not a raise", () => {
    const noisy = biweekly("HOURLY CO", "2026-03-06", (d) => [1900, 2050, 1980, 2100, 1950, 2080][Number(d.slice(8, 10)) % 6]);
    assert.deepEqual(a.detectRaises(noisy, TODAY, []), []);
  });

  it("too small, too old, or only one deposit at the new level: nothing", () => {
    const tiny = biweekly("ACME PAYROLL", "2026-03-06", (d) => (d >= "2026-09-11" ? 2040 : 2000)); // 2% — under 3%
    assert.deepEqual(a.detectRaises(tiny, TODAY, STREAM), []);
    const small = biweekly("SIDE GIG", "2026-03-06", (d) => (d >= "2026-09-11" ? 220 : 200)); // 10% but $43 a month
    assert.deepEqual(a.detectRaises(small, TODAY, []), []);
    const old = biweekly("ACME PAYROLL", "2026-03-06", (d) => (d >= "2026-06-19" ? 2200 : 2000)); // 131 days ago
    assert.deepEqual(a.detectRaises(old, TODAY, STREAM), []);
    const one = biweekly("ACME PAYROLL", "2026-03-06", (d) => (d >= "2026-10-23" ? 2200 : 2000));
    assert.deepEqual(a.detectRaises(one, TODAY, STREAM), []);
  });

  it("a bonus between paychecks doesn't hide the raise", () => {
    const [r] = a.detectRaises([...RAISED, { date: "2026-10-15", source: "acme payroll", amount: 5000 }], TODAY, STREAM);
    assert.equal(r.to, 2200);
    assert.equal(r.from, 2000);
  });
});

describe("T4.1 A6 — detectBonuses", () => {
  const base = biweekly("ACME PAYROLL", "2026-05-01", () => 2000);

  it("a deposit 1.5× the payer's usual and at least $500, within 45 days", () => {
    assert.deepEqual(a.detectBonuses([...base, { date: "2026-10-15", source: "ACME PAYROLL", amount: 5000 }], TODAY),
      [{ date: "2026-10-15", source: "ACME PAYROLL", amount: 5000, typical: 2000, one_off: false }]);
    assert.deepEqual(a.detectBonuses([...base, { date: "2026-10-15", source: "ACME PAYROLL", amount: 2900 }], TODAY), []);
    assert.deepEqual(a.detectBonuses([...base, { date: "2026-09-01", source: "ACME PAYROLL", amount: 5000 }], TODAY), [], "57 days ago");
    const gig = [300, 300, 300].map((amount, i) => ({ date: `2026-0${6 + i}-10`, source: "Gig", amount }));
    assert.equal(a.detectBonuses([...gig, { date: "2026-10-20", source: "Gig", amount: 600 }], TODAY).length, 1);
    assert.equal(a.detectBonuses([...gig, { date: "2026-10-20", source: "Gig", amount: 450 }], TODAY).length, 0, "under $500");
  });

  it("a payer seen once: a one-off at $1,000 or more", () => {
    assert.deepEqual(a.detectBonuses([{ date: "2026-10-20", source: "Estate", amount: 1500 }], TODAY),
      [{ date: "2026-10-20", source: "Estate", amount: 1500, typical: null, one_off: true }]);
    assert.deepEqual(a.detectBonuses([{ date: "2026-10-20", source: "Estate", amount: 900 }], TODAY), []);
  });

  it("two big deposits of the same size are a level, not a bonus", () => {
    const level = [...base, { date: "2026-10-09", source: "ACME PAYROLL", amount: 5000 }, { date: "2026-10-23", source: "ACME PAYROLL", amount: 5100 }];
    assert.deepEqual(a.detectBonuses(level, TODAY), []);
  });
});

describe("T4.1 A6 — splitWindfall in the plan's order", () => {
  const state = () => ({
    buffer_gap: 1000, emergency_gap: 2000,
    high: [{ name: "Visa", balance: 1500 }, { name: "Store card", balance: 800 }],
    medium: [{ name: "Car loan", balance: 3000 }],
  });

  it("buffer, high-interest debt by APR, emergency, then medium 50/50 with investing", () => {
    const s = state();
    assert.deepEqual(a.splitWindfall(7300, s), [
      { key: "buffer", name: "your starter cash buffer", amount: 1000 },
      { key: "debt", name: "Visa", amount: 1500 },
      { key: "debt", name: "Store card", amount: 800 },
      { key: "emergency", name: "your emergency fund", amount: 2000 },
      { key: "debt", name: "Car loan", amount: 1000 },
      { key: "invest", name: "investing", amount: 1000 },
    ]);
    assert.equal(s.medium[0].balance, 2000);
    assert.equal(s.buffer_gap, 0);
  });

  it("a small lump stops at the first gap; a second lump fills what's left", () => {
    const s = state();
    assert.deepEqual(a.splitWindfall(600, s), [{ key: "buffer", name: "your starter cash buffer", amount: 600 }]);
    assert.deepEqual(a.splitWindfall(1000, s), [
      { key: "buffer", name: "your starter cash buffer", amount: 400 },
      { key: "debt", name: "Visa", amount: 600 },
    ]);
  });

  it("with nothing owed and no gaps it all goes to investing", () => {
    assert.deepEqual(a.splitWindfall(2500, { buffer_gap: 0, emergency_gap: 0, high: [], medium: [] }), [{ key: "invest", name: "investing", amount: 2500 }]);
  });
});

describe("T4.1 A6 — spendingCreep", () => {
  const months = (prior, recent) => ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]
    .map((m, i) => ({ month: m, income: i < 3 ? prior : recent, spending: 2000 }));

  it("a category growing 15 points faster than income and $50 a month", () => {
    const out = a.spendingCreep(cats([["Dining", 300, 450], ["Groceries", 400, 410]]), months(4000, 4000), TODAY);
    assert.deepEqual(out, [{ category: "Dining", prior_monthly: 300, recent_monthly: 450, increase_monthly: 150, growth_pct: 50, income_growth_pct: 0 }]);
  });

  it("income growing too keeps it off; so do a small base, a small rise and Uncategorized", () => {
    assert.deepEqual(a.spendingCreep(cats([["Dining", 300, 450]]), months(4000, 5600), TODAY), [], "income +40%");
    assert.equal(a.spendingCreep(cats([["Dining", 300, 450]]), months(4000, 5000), TODAY).length, 1, "income +25%: 25 points behind");
    assert.deepEqual(a.spendingCreep(cats([["Coffee", 40, 120]]), months(4000, 4000), TODAY), [], "under $50 before");
    assert.deepEqual(a.spendingCreep(cats([["Gas", 200, 245]]), months(4000, 4000), TODAY), [], "under $50 more");
    assert.deepEqual(a.spendingCreep(cats([["Uncategorized", 300, 900]]), months(4000, 4000), TODAY), []);
  });

  it("needs all six completed months; lists the three biggest rises", () => {
    assert.deepEqual(a.spendingCreep(cats([["Dining", 300, 450]]), months(4000, 4000).slice(1), TODAY), []);
    const many = cats([["A", 100, 200], ["B", 100, 400], ["C", 100, 300], ["D", 100, 250]]);
    assert.deepEqual(a.spendingCreep(many, months(4000, 4000), TODAY).map((c) => c.category), ["B", "C", "D"]);
  });
});

// ---------------------------------------------------------------------------
describe("T4.1 A6 — in the plan", () => {
  it("a raise is pointed at the current step, half of it rounded down to $25 per paycheck", () => {
    const p = plan({ deposits: RAISED });
    assert.equal(p.headline.step, "high_interest_debt");
    const [r] = p.raises;
    assert.equal(r.toward, "high_interest_debt");
    assert.equal(r.suggest_per_period, 100); // $200 × 26 a year × 0.5 ÷ 26 paychecks
    assert.equal(r.suggest_monthly, 216.67);
    assert.equal(r.text, "Your pay from ACME PAYROLL went up from $2,000.00 to $2,200.00 a deposit in Sep 2026 (about $433.33 a month more). Put $100.00 per paycheck of it toward Visa.");
    const ef = plan({ deposits: RAISED, debts: [], activity: [], cash: { starting_balance: 4000, lowest: null } });
    assert.match(ef.raises[0].text, /toward your emergency fund\.$/);
  });

  it("a bonus is split with the gaps measured as if it hadn't landed", () => {
    // $12,000 spendable includes the $5,000 bonus. Without it ($7,000) the
    // buffer ($3,300) is met and the emergency fund ($8,400) is $1,400 short:
    // Visa first, then that gap, then investing.
    const p = plan({ cash: { starting_balance: 12000, lowest: null }, deposits: [...RAISED, { date: "2026-10-15", source: "ACME PAYROLL", amount: 5000 }] });
    assert.equal(p.steps.find((s) => s.key === "emergency_fund").status, "done", "the plan itself counts the bonus");
    const [b] = p.bonuses;
    assert.deepEqual(b.split, [
      { key: "debt", name: "Visa", amount: 3000 },
      { key: "emergency", name: "your emergency fund", amount: 1400 },
      { key: "invest", name: "investing", amount: 600 },
    ]);
    assert.equal(b.text, "$5,000.00 from ACME PAYROLL on 2026-10-15 looks like a bonus (your usual deposit from them is $2,000.00). Your plan would split it: $3,000.00 to Visa, $1,400.00 to your emergency fund, $600.00 to investing.");
  });

  it("spending creep carries what trimming it frees per paycheck", () => {
    const [c] = plan({ categories: cats([["Dining", 300, 450]]) }).spending_creep;
    assert.equal(c.increase_per_period, 69.23);
    assert.equal(c.text, "Dining spending rose from $300.00 to $450.00 a month (+50%) over the last 3 months, while your income stayed flat. Bringing it back would free $69.23 per paycheck.");
  });

  it("a failing read is not critical: still a plan, those fields null, a fixed sentence", async () => {
    const quietly = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
    const deps = Object.fromEntries(Object.entries(inputs()).filter(([k]) => a.SOURCE_ERRORS[k]).map(([k, v]) => [k, async () => v]));
    deps.deposits = async () => { throw new Error("x"); };
    deps.categories = async () => { throw new Error("y"); };
    const p = a.buildAdvicePlan(await quietly(() => a.getAdviceInputs({}, { today: TODAY, deps })));
    assert.equal(p.ok, true);
    assert.equal(p.raises, null);
    assert.equal(p.bonuses, null);
    assert.equal(p.spending_creep, null);
    assert.deepEqual(p.errors, [
      { source: "categories", error: "Spending by category couldn't be read." },
      { source: "deposits", error: "Recent paychecks couldn't be read." },
    ]);
  });

  it("the readers: income deposits at your share over 240 days, net category months, 7 months of totals", async () => {
    const seen = [];
    const pool = { query: async (sql, params) => { seen.push({ sql: sql.replace(/\s+/g, " "), params }); return { rows: [] }; } };
    let monthsArg = null;
    const fq = require("../teller/services/financial-queries");
    const real = fq.getMonthlyIncomeAndSpending;
    fq.getMonthlyIncomeAndSpending = async (_p, n) => { monthsArg = n; return []; };
    try {
      await a.getAdviceInputs(pool, { today: TODAY, deps: { streams: async () => [], cash: async () => ({ starting_balance: 0 }) } });
    } finally { fq.getMonthlyIncomeAndSpending = real; }
    assert.equal(monthsArg, 7);
    const dep = seen.find((q) => /ROUND\(\(-\( CASE/.test(q.sql));
    assert.deepEqual(dep.params, [TODAY]);
    assert.match(dep.sql, /t\.amount < 0 AND t\.pending = false AND t\.date >= \$1::date - 240 AND t\.date <= \$1::date/);
    assert.ok(dep.sql.includes(fq.incomePredicate("t").replace(/\s+/g, " ").trim()));
    const cat = seen.find((q) => /net_category_months/.test(q.sql));
    assert.deepEqual(cat.params, ["2026-04-01", "2026-10-01"]);
    assert.match(cat.sql, /spend_lines AS/);
  });
});

// ---------------------------------------------------------------------------
describe("T4.1 A6 — the surfaces", () => {
  const full = () => plan({
    deposits: [...RAISED, { date: "2026-10-15", source: "ACME <PAYROLL>", amount: 5000 }],
    categories: cats([["Dining <x>", 300, 450]]),
  });

  it("the card lists each line, escaped", () => {
    const dash = read("teller/views/dashboard.ejs");
    const i = dash.indexOf("    var ADVICE_DISCLAIMER"), j = dash.indexOf("    // Design D3: the Summary card + Needs attention");
    const ctx = {
      esc: (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
      fmt: (n) => (Number(n) < 0 ? "-$" : "$") + Math.abs(Number(n)).toFixed(2),
      emptyState: () => "EMPTY", Number, String, Date, JSON,
    };
    vm.runInNewContext(dash.slice(i, j), ctx);
    const html = ctx.renderAdvice(full());
    assert.match(html, /<li>Your pay from ACME PAYROLL went up from \$2,000\.00 to \$2,200\.00/);
    assert.match(html, /<li>\$5,000\.00 from ACME &lt;PAYROLL&gt; on 2026-10-15 looks like a one-off deposit\./);
    assert.match(html, /<li>Dining &lt;x&gt; spending rose from \$300\.00 to \$450\.00 a month/);
  });

  it("the insight prompt block carries all three", () => {
    const block = require("../teller/routes/insights").cashPlanPromptBlock(full());
    assert.match(block, /\nRaises:\n- Your pay from ACME PAYROLL went up .* Put \$100\.00 per paycheck of it toward Visa\.\n/);
    assert.match(block, /\nBonuses \/ one-off deposits:\n- \$5,000\.00 from ACME <PAYROLL> on 2026-10-15/);
    assert.match(block, /\nSpending growing faster than income:\n- Dining <x> spending rose/);
  });

  it("the audit counts a raise's share, the raise and the freed amount as plan figures", () => {
    const audit = require("../teller/services/ai-audit");
    const f = audit.planFigures(full());
    for (const v of [100, 200, 69.23]) assert.ok(f.perPeriod.includes(v), String(v));
    const check = (text) => { const c = audit.extractDollarClaims(text); const s = audit.claimSegments(text, c, 0); return audit.planClaimFinding(c[0], s.lead, s.trail, f); };
    assert.deepEqual(check("Put $100 per paycheck of your raise toward Visa."), { matched: true, finding: null });
    assert.equal(check("Put $160 per paycheck of your raise toward savings.").finding.check, "cash_plan");
  });

  it("Ask's get_cash_plan carries them", async () => {
    const real = a.getAdvicePlan;
    const p = full();
    a.getAdvicePlan = async () => p;
    try {
      const ask = require("../teller/routes/ask");
      const out = await (ask._TOOL_EXECUTORS || ask.TOOL_EXECUTORS).get_cash_plan({});
      assert.deepEqual(out.raises, p.raises);
      assert.deepEqual(out.bonuses, p.bonuses);
      assert.deepEqual(out.spending_creep, p.spending_creep);
    } finally { a.getAdvicePlan = real; }
  });
});

// ---------------------------------------------------------------------------
describe("T4.1 A6 — the plan-change push names a new raise or bonus once", () => {
  beforeEach(() => aa._reset());
  const NOW = new Date("2026-10-28T15:00:00Z");
  function fakePool(state) {
    const calls = { writes: [] };
    return {
      calls,
      async query(sql, params) {
        if (/^SELECT advice_alerts_enabled/.test(sql)) return { rows: [{ advice_alerts_enabled: true, advice_state: state() }] };
        if (/^UPDATE user_settings SET advice_state/.test(sql)) { calls.writes.push(JSON.parse(params[0])); return { rows: [] }; }
        throw new Error("unexpected SQL: " + sql);
      },
    };
  }
  const withBonus = () => plan({ deposits: [...RAISED, { date: "2026-10-15", source: "ACME PAYROLL", amount: 5000 }] });
  const run = (pool, getPlan, sendToAll, today = TODAY) => aa.runAdviceAlerts(pool, { now: NOW, today, deps: { getPlan, sendToAll } });

  it("windfallsOf keys a bonus by payer, day and amount and a raise by payer and level", () => {
    assert.deepEqual(aa.windfallsOf(withBonus()).map((w) => w.key), ["bonus:acme payroll:2026-10-15:5000", "raise:acme payroll:2200"]);
  });

  it("the baseline records them without a push", async () => {
    const pool = fakePool(() => null);
    let sent = 0;
    await run(pool, async () => withBonus(), async () => { sent++; return { logged: true }; });
    assert.equal(sent, 0);
    assert.deepEqual(pool.calls.writes[0].windfalls_seen, ["bonus:acme payroll:2026-10-15:5000", "raise:acme payroll:2200"]);
  });

  it("a new one with the plan unchanged: one push, the signature kept, not again the next day", async () => {
    let state = { signature: aa.signatureOf(plan(), "x"), checked_on: "2026-10-27" };
    const pool = fakePool(() => state);
    const pushes = [];
    const send = async (p) => { pushes.push(p); return { logged: true }; };
    const r = await run(pool, async () => withBonus(), send);
    assert.equal(r.status, "notified");
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].title, "New money for your plan");
    assert.equal(pushes[0].tag, "advice-plan");
    assert.match(pushes[0].body, /^\$5,000\.00 from ACME PAYROLL on 2026-10-15 looks like a bonus .* Your pay from ACME PAYROLL went up/);
    state = pool.calls.writes[0];
    assert.deepEqual(state.signature, aa.signatureOf(plan(), "x"));
    assert.equal(state.last_check.kind, "windfall");
    aa._reset();
    const again = await run(pool, async () => withBonus(), send, "2026-10-29");
    assert.equal(again.status, "unchanged");
    assert.equal(pushes.length, 1);
  });

  it("with a plan change: one push carrying both; an unlogged push writes nothing", async () => {
    const prev = { ...aa.signatureOf(plan(), "x"), step: "emergency_fund", target: null };
    const pool = fakePool(() => ({ signature: prev, checked_on: "2026-10-27" }));
    const pushes = [];
    let r;
    const err = console.error; console.error = () => {};
    try { r = await run(pool, async () => withBonus(), async () => ({ logged: false })); } finally { console.error = err; }
    assert.equal(r.status, "unlogged");
    assert.equal(pool.calls.writes.length, 0);
    await run(pool, async () => withBonus(), async (p) => { pushes.push(p); return { logged: true }; });
    assert.equal(pushes[0].title, "Your plan changed");
    assert.match(pushes[0].body, /^Your plan changed — it now puts .* toward Visa\. \$5,000\.00 from ACME PAYROLL/);
    assert.equal(pool.calls.writes[0].signature.step, "high_interest_debt");
    assert.equal(pool.calls.writes[0].windfalls_seen.length, 2);
  });
});
