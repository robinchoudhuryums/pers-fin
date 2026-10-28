// ============================================================================
// Roadmap T4.1 A1 — the "where should my extra money go?" engine
// ============================================================================
// services/advice.js over canned inputs: each step as the headline, the
// per-card avalanche with overflow and rollover, an unknown APR assumed 22%, a
// 0% card left on minimums, the 3-month surplus bar, money already moved to
// savings, the cash-floor cap, per-paycheck rounding, carried-balance
// detection, and getAdviceInputs' fail-soft reads (a critical source missing
// is no plan, never an "invest" over unread debts). The real-Postgres half is
// tests/contract/advice-a1.contract.test.js.
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const a = require("../teller/services/advice");

const TODAY = "2026-10-27";
const month = (m, income, spending) => ({ month: m, income, spending });
const GOOD_MONTHS = [month("2026-07", 5000, 3500), month("2026-08", 5000, 3600), month("2026-09", 5000, 3400), month("2026-10", 800, 900)];
const card = (o) => ({ id: o.id || 1, account_id: o.account_id || "c" + (o.id || 1), name: o.name || "Visa", type: "credit", current_balance: String(o.balance), apr: o.apr == null ? null : String(o.apr), minimum_payment: o.min == null ? null : String(o.min), last_payment_amount: o.last == null ? null : String(o.last), credit_limit: o.limit == null ? null : String(o.limit), available_balance: o.available == null ? null : String(o.available) });
const loan = (o) => ({ id: o.id, account_id: "l" + o.id, name: o.name, type: "loan", current_balance: String(o.balance), apr: o.apr == null ? null : String(o.apr), monthly_payment: o.payment == null ? null : String(o.payment) });
const charged = (...ids) => ids.map((id) => ({ account_id: id, txns: 5, interest: true }));

function inputs(over = {}) {
  return {
    today: TODAY,
    errors: [],
    months: GOOD_MONTHS,
    streams: [{ source: "ACME PAYROLL", amount: 2500, cadence: "semimonthly" }],
    cash: { starting_balance: 15000, lowest: { date: "2026-11-20", balance: 14000 } },
    settings: { cash_alert_threshold: "500" },
    debts: [],
    activity: [],
    transfers: [],
    ...over,
  };
}
const plan = (over) => a.buildAdvicePlan(inputs(over));

describe("T4.1 A1 — the steps, each as the headline", () => {
  it("invest when nothing comes first: 60% of the median net, per paycheck, rounded down to $25", () => {
    const p = plan();
    assert.equal(p.ok, true);
    assert.equal(p.headline.step, "invest");
    // median net 1500 × 60% = 900 a month → 900 × 12 / 24 = 450 per paycheck.
    assert.equal(p.surplus.median_net, 1500);
    assert.equal(p.headline.amount_per_period, 450);
    assert.equal(p.headline.amount_monthly, 900);
    assert.equal(p.allocation.invest_monthly, 900);
    assert.equal(p.headline.text, "Invest $450.00 per paycheck more.");
    assert.equal(p.surplus.slack_monthly, 600);
    assert.equal(p.disclaimer, "Educational, based on your data — not financial advice.");
    assert.deepEqual(p.steps.map((s) => [s.key, s.status]), [
      ["minimums", "done"], ["starter_buffer", "done"], ["high_interest_debt", "done"],
      ["emergency_fund", "done"], ["medium_interest_debt", "done"], ["invest", "current"],
    ]);
  });

  it("the starter buffer comes first, ahead of a 24% card, and isn't capped by the cash floor", () => {
    const p = plan({
      cash: { starting_balance: 2000, lowest: { date: "2026-11-05", balance: 600 } },
      debts: [card({ balance: 3000, apr: 24.99, min: 90 })], activity: charged("c1"),
    });
    assert.equal(p.headline.step, "starter_buffer");
    assert.equal(p.cash.starter_target, 4000); // floor 500 + 3500 of spending
    assert.equal(p.allocation.buffer_monthly, p.headline.amount_monthly);
    assert.ok(p.headline.amount_monthly > 0, "money kept in cash isn't held back by the floor");
    assert.equal(p.surplus.cash_cap_monthly, null);
    assert.equal(p.steps[1].remaining, 2000);
    assert.equal(p.steps[1].months_to_finish, Math.ceil(2000 / p.headline.amount_monthly));
    assert.match(p.headline.text, /^Build a starter cash buffer: keep \$4,000\.00 in spendable cash \(you have \$2,000\.00\): put \$\d+\.00 per paycheck toward it\.$/);
    assert.deepEqual(p.allocation.debts.map((d) => [d.name, d.extra_monthly]), [["Visa", 0]], "the card gets its minimum");
  });

  it("high-interest debt: the whole recommendation to the highest APR, the minimum on top", () => {
    const p = plan({ debts: [card({ balance: 3000, apr: 24.99, min: 90 })], activity: charged("c1") });
    assert.equal(p.headline.step, "high_interest_debt");
    // net 1500 − minimum 90 = 1410 × 60% = 846 → 423 per paycheck → 400.
    assert.equal(p.surplus.required_minimums_monthly, 90);
    assert.equal(p.headline.amount_per_period, 400);
    assert.equal(p.headline.text, "Pay down Visa first: $400.00 per paycheck on top of its minimum.");
    const [visa] = p.allocation.debts;
    assert.equal(visa.minimum_monthly, 90);
    assert.equal(visa.extra_monthly, 800);
    assert.equal(visa.payment_monthly, 890);
    assert.equal(visa.per_period, 445);
    assert.ok(visa.months_to_payoff >= 3 && visa.months_to_payoff <= 4);
    assert.equal(visa.payoff_month, require("../teller/services/projections").addMonthsYm(TODAY, visa.months_to_payoff));
    assert.ok(visa.interest_saved > 1000, "against minimums only");
  });

  it("the emergency fund to 3 months of spending once the buffer and high debt are done", () => {
    const p = plan({ cash: { starting_balance: 6000, lowest: { date: "2026-11-05", balance: 5500 } } });
    assert.equal(p.headline.step, "emergency_fund");
    assert.equal(p.cash.emergency_target, 10500);
    assert.equal(p.allocation.emergency_monthly, 900);
    assert.equal(p.headline.text, "Grow your emergency fund to $10,500.00 — 3 months of spending (you have $6,000.00): put $450.00 per paycheck toward it.");
    assert.equal(p.steps[3].months_to_finish, 5);
  });

  it("medium-interest debt splits the recommendation 50/50 with investing", () => {
    const p = plan({ debts: [loan({ id: 7, name: "Auto loan", balance: 12000, apr: 5.5, payment: 350 })] });
    assert.equal(p.headline.step, "medium_interest_debt");
    // 1500 − 350 = 1150 × 60% = 690 → 345 per paycheck → 325 → 650 a month.
    assert.equal(p.headline.amount_monthly, 650);
    assert.equal(p.allocation.debt_extra_monthly, 325);
    assert.equal(p.allocation.invest_monthly, 325);
    assert.equal(p.headline.text, "Split your extra: $162.50 per paycheck to Auto loan, $162.50 per paycheck to investing.");
    assert.equal(p.allocation.debts[0].extra_monthly, 325);
  });

  it("minimums not covered → that is the headline", () => {
    const p = plan({
      months: [month("2026-07", 3000, 2900), month("2026-08", 3000, 2900), month("2026-09", 3000, 2900)],
      debts: [loan({ id: 7, name: "Auto loan", balance: 12000, apr: 9, payment: 350 })],
    });
    assert.equal(p.headline.step, "minimums");
    assert.equal(p.headline.text, "Your recent months don't cover your $350.00 of monthly minimum payments.");
    assert.equal(p.headline.amount_monthly, 0);
    assert.ok(p.why);
  });
});

describe("T4.1 A1 — the avalanche", () => {
  const debts = [
    card({ id: 1, name: "Visa", balance: 5000, apr: 18, min: 100 }),
    card({ id: 2, name: "Store card", balance: 4000, apr: 29.99, min: 120 }),
  ];

  it("the highest APR takes the extra; a tie goes to the smaller balance", () => {
    const p = plan({ debts, activity: charged("c1", "c2") });
    assert.deepEqual(p.allocation.debts.map((d) => d.name), ["Store card", "Visa"]);
    assert.ok(p.allocation.debts[0].extra_monthly > 0);
    assert.equal(p.allocation.debts[1].extra_monthly, 0);
    const tie = a.allocateDebts([
      { id: 1, name: "Big", balance: 2000, apr: 20, minimum: 50 },
      { id: 2, name: "Small", balance: 500, apr: 20, minimum: 25 },
    ], 100, TODAY, 12);
    assert.deepEqual(tie.rows.map((r) => r.name), ["Small", "Big"]);
  });

  it("overflow: more extra than the top balance spills to the next debt in the same month", () => {
    const { rows } = a.allocateDebts([
      { id: 1, name: "A", balance: 200, apr: 25, minimum: 25 },
      { id: 2, name: "B", balance: 2000, apr: 15, minimum: 50 },
    ], 1000, TODAY, 12);
    const [A, B] = rows;
    assert.equal(A.months_to_payoff, 1);
    // A: 200 + 4.17 interest, all paid; the rest of the 1000 goes to B.
    assert.equal(A.payment_monthly, 204.17);
    assert.equal(B.payment_monthly, 50 + 1000 - (204.17 - 25));
  });

  it("rollover: a paid-off debt's minimum moves to the next one", () => {
    const sim = a.simulatePayoff([
      { id: 1, balance: 100, apr: 0, minimum: 50 },
      { id: 2, balance: 1000, apr: 0, minimum: 50 },
    ], 0, (x, y) => x.id - y.id);
    assert.equal(sim[0].months, 2);
    // B: 50 + 50 (months 1–2), then 100 a month: 1000 − 100 = 900 → 9 more months.
    assert.equal(sim[1].months, 11);
  });

  it("a snowball line with its extra cost", () => {
    const p = plan({ debts: [
      card({ id: 1, name: "Small low", balance: 500, apr: 12, min: 25 }),
      card({ id: 2, name: "Big high", balance: 4000, apr: 28, min: 100 }),
    ], activity: charged("c1", "c2") });
    assert.equal(p.allocation.debts[0].name, "Big high");
    assert.ok(p.allocation.snowball.extra_cost > 0);
    assert.match(p.allocation.snowball.text, /^Paying the smallest balance first instead \(the "snowball" order\) would cost about \$[\d,]+\.\d\d more in interest\.$/);
  });

  it("a minimum that never pays a debt off is said so (no interest saved figure)", () => {
    const { rows } = a.allocateDebts([{ id: 1, name: "X", balance: 10000, apr: 30, minimum: 200 }], 0, TODAY, 12);
    assert.equal(rows[0].minimum_never_pays_off, true);
    assert.equal(rows[0].interest_saved, null);
    assert.equal(rows[0].months_to_payoff, null);
  });
});

describe("T4.1 A1 — APRs, minimums and carried balances", () => {
  it("a carried card with no APR is assumed 22% and said so", () => {
    const p = plan({ debts: [card({ balance: 800, available: 1200 })], activity: charged("c1") });
    const [d] = p.debts;
    assert.equal(d.apr, 22);
    assert.equal(d.apr_assumed, true);
    assert.equal(d.tier, "high");
    assert.equal(d.minimum, 25, "max($25, 1% + a month's interest)");
    assert.equal(d.minimum_estimated, true);
    assert.ok(p.notes.includes("Visa: APR unknown — assumed 22%; set it on the card."));
    assert.equal(p.headline.step, "high_interest_debt");
  });

  it("an estimated minimum above $25: 1% of the balance plus a month's interest", () => {
    const [d] = a.normalizeDebts([card({ balance: 6000, apr: 24 })], charged("c1"));
    assert.equal(d.minimum, 60 + 120);
  });

  it("a 0% card stays on its minimum; the plan goes on to investing", () => {
    const p = plan({ debts: [card({ balance: 2400, apr: 0, min: 100 })], activity: charged("c1") });
    assert.equal(p.debts[0].tier, "low");
    assert.equal(p.headline.step, "invest");
    assert.equal(p.surplus.required_minimums_monthly, 100);
    assert.deepEqual(p.allocation.debts.map((d) => [d.name, d.extra_monthly, d.minimum_monthly]), [["Visa", 0, 100]]);
  });

  it("carried: an interest charge, or a minimum-sized last payment; else paid in full or unknown", () => {
    assert.deepEqual(a.carryStatus({ current_balance: "500" }, { txns: 3, interest: true }), { carried: true, reason: "interest_charged" });
    assert.deepEqual(a.carryStatus({ current_balance: "3000", minimum_payment: "90", last_payment_amount: "95" }, { txns: 3 }), { carried: true, reason: "minimum_payments" });
    assert.deepEqual(a.carryStatus({ current_balance: "3000", minimum_payment: "90", last_payment_amount: "1500" }, { txns: 3 }), { carried: false, reason: "paid_in_full" });
    assert.deepEqual(a.carryStatus({ current_balance: "800" }, { txns: 9, interest: false }), { carried: false, reason: "paid_in_full" });
    assert.deepEqual(a.carryStatus({ current_balance: "800" }, undefined), { carried: false, reason: "unknown" });
  });

  it("a card paid in full isn't debt: no minimum required, but its utilization tip stays", () => {
    const p = plan({ debts: [card({ balance: 1800, apr: 24, min: 40, last: 1650, limit: 3000 })], activity: [{ account_id: "c1", txns: 20, interest: false }] });
    const [d] = p.debts;
    assert.equal(d.carried, false);
    assert.equal(d.tier, "paid_in_full");
    assert.equal(p.surplus.required_minimums_monthly, 0);
    assert.equal(p.headline.step, "invest");
    assert.equal(d.utilization_pct, 60);
    assert.deepEqual(d.utilization_tip, { pay: 900, by: null, basis: "due_date", text: "Paying $900.00 on Visa before its due date brings it under 30% of its limit." });
  });

  it("a card with no activity and no payment data is said to be treated as paid in full", () => {
    const p = plan({ debts: [card({ balance: 700 })] });
    assert.equal(p.debts[0].carry_reason, "unknown");
    assert.ok(p.notes.includes("Visa: no recent activity, so it's treated as paid in full each month."));
  });

  it("a loan with no APR or payment isn't planned and says what to set", () => {
    const p = plan({ debts: [loan({ id: 9, name: "Personal loan", balance: 5000 })] });
    assert.equal(p.debts[0].tier, "unknown");
    assert.equal(p.surplus.required_minimums_monthly, 0);
    assert.ok(p.notes.includes("Personal loan: APR unknown — set it on the loan card to include it in the plan."));
    assert.ok(p.notes.includes("Personal loan: monthly payment unknown — set it on the loan card."));
  });

  it("a loan at 8% or more joins the high-interest step", () => {
    const p = plan({ debts: [loan({ id: 9, name: "Personal loan", balance: 5000, apr: 11, payment: 150 })] });
    assert.equal(p.headline.step, "high_interest_debt");
    assert.equal(p.headline.text.startsWith("Pay down Personal loan first:"), true);
  });
});

describe("T4.1 A1 — the surplus", () => {
  it("each of the last 3 COMPLETED months must clear max($200, 10% of income); the month to date never counts", () => {
    const rows = a.surplusMonths(GOOD_MONTHS, TODAY);
    assert.deepEqual(rows.map((r) => [r.month, r.net, r.bar, r.ok]), [["2026-07", 1500, 500, true], ["2026-08", 1400, 500, true], ["2026-09", 1600, 500, true]]);
    const low = a.surplusMonths([month("2026-07", 1500, 1350), month("2026-08", 1500, 1290), month("2026-09", 1500, 1200)], TODAY);
    assert.deepEqual(low.map((r) => [r.bar, r.ok]), [[200, false], [200, true], [200, true]]);
  });

  it("one month under the bar → no recommendation, and the reason says so", () => {
    const p = plan({ months: [month("2026-07", 5000, 4900), month("2026-08", 5000, 3600), month("2026-09", 5000, 4950)] });
    assert.equal(p.headline.step, "invest");
    assert.equal(p.headline.amount_monthly, 0);
    assert.equal(p.surplus.sustained, false);
    assert.equal(p.why, "2 of the last 3 months left less than $200.00 (or 10% of that month's income) after spending.");
    assert.equal(p.headline.text, "Invest the rest once there's a surplus.");
  });

  it("a short history says how many months it has", () => {
    const p = plan({ months: [month("2026-09", 5000, 3000), month("2026-10", 100, 50)] });
    assert.equal(p.surplus.sustained, false);
    assert.equal(p.why, "Your plan needs 3 complete months of history (1 so far).");
  });

  it("money already moved to savings / investments every month is taken off first", () => {
    const p = plan({ transfers: [
      { display_name: "TO SAVINGS", amount: "400", cadence_days: 30, transfer_type: "savings" },
      { display_name: "BROKERAGE", amount: "300", cadence_days: 14, transfer_type: "investment" },
    ] });
    // 400 + 300 × 30 / 14 = 1042.86
    assert.equal(p.surplus.existing_transfers_monthly, 1042.86);
    assert.equal(p.surplus.after_commitments_monthly, 457.14);
    // 457.14 × 60% = 274.28 → 137.14 per paycheck → 125.
    assert.equal(p.headline.amount_per_period, 125);
  });

  it("nothing left after the commitments → no recommendation", () => {
    const p = plan({ transfers: [{ display_name: "TO SAVINGS", amount: "1500", cadence_days: 30, transfer_type: "savings" }] });
    assert.equal(p.headline.amount_monthly, 0);
    assert.match(p.why, /^After minimum payments \(\$0\.00 a month\) and the \$1,500\.00 a month you already move to savings, nothing is left over\.$/);
  });

  it("money leaving cash keeps the lowest projected day at or above the floor", () => {
    // lowest 1100 in ~24 days, floor 500 → at most 600 a month leaves cash.
    let p = plan({ cash: { starting_balance: 15000, lowest: { date: "2026-11-20", balance: 1100 } } });
    assert.equal(p.surplus.cash_cap_monthly, 600);
    // 600 × 60% = 360 → 180 per paycheck → 175.
    assert.equal(p.headline.amount_per_period, 175);
    // ~54 days away → two months share the headroom.
    p = plan({ cash: { starting_balance: 15000, lowest: { date: "2026-12-20", balance: 1100 } } });
    assert.equal(p.surplus.cash_cap_monthly, 300);
    // below the floor → nothing goes out.
    p = plan({ cash: { starting_balance: 15000, lowest: { date: "2026-11-20", balance: 450 } } });
    assert.equal(p.surplus.cash_cap_monthly, 0);
    assert.equal(p.headline.amount_monthly, 0);
    assert.equal(p.why, "Your cash is projected to dip to $450.00 on 2026-11-20, near your $500.00 floor, so nothing more goes out for now.");
  });

  it("a floor the user never set is the $500 default", () => {
    assert.equal(plan({ settings: {} }).cash.floor, 500);
    assert.equal(plan({ settings: null }).cash.floor, 500);
  });
});

describe("T4.1 A1 — per paycheck", () => {
  it("the largest pay stream by yearly amount sets the period", () => {
    assert.deepEqual(a.payPeriod([
      { source: "Side gig", amount: 900, cadence: "monthly" },
      { source: "ACME", amount: 1800, cadence: "biweekly" },
    ]), { unit: "paycheck", paychecks_per_year: 26, cadence: "biweekly", source: "ACME" });
    assert.deepEqual(a.payPeriod([]), { unit: "month", paychecks_per_year: 12, cadence: null, source: null });
  });

  it("rounds DOWN to $25 a paycheck; biweekly converts with 26 a year", () => {
    const p = plan({ streams: [{ source: "ACME", amount: 2300, cadence: "biweekly" }] });
    // 900 a month → 900 × 12 / 26 = 415.38 → 400 per paycheck → 400 × 26 / 12 = 866.67 a month.
    assert.equal(p.headline.amount_per_period, 400);
    assert.equal(p.headline.amount_monthly, 866.67);
  });

  it("no pay stream → per month, with a note", () => {
    let p = plan({ streams: [] });
    assert.equal(p.period.unit, "month");
    assert.equal(p.headline.amount_per_period, 900);
    assert.equal(p.headline.text, "Invest $900.00 per month more.");
    assert.ok(p.notes.includes("No regular paycheck was found, so amounts are shown per month."));
    p = plan({ streams: null });
    assert.ok(p.notes.includes("Your pay schedule couldn't be read, so amounts are shown per month."));
  });

  it("completed months step back across January", () => {
    assert.deepEqual(a.completedMonthKeys("2027-01-03"), ["2026-10", "2026-11", "2026-12"]);
  });
});

describe("T4.1 A1 — reads are fail-soft; a missing critical source is no plan", () => {
  const ok = {
    months: async () => GOOD_MONTHS,
    streams: async () => [],
    cash: async () => ({ starting_balance: 15000, lowest: null }),
    settings: async () => ({ cash_alert_threshold: "500" }),
    debts: async () => [],
    activity: async () => [],
    transfers: async () => [],
    goals: async () => [],
    deposits: async () => [],
    categories: async () => [],
    idle: async () => ({ accounts: [], investments: [], snapshots: [] }),
    allocation: async () => ({ total_value: 0, has_targets: false, classes: [] }),
  };
  const quietly = async (fn) => {
    const err = console.error; console.error = () => {};
    try { return await fn(); } finally { console.error = err; }
  };

  it("each source read once; a failing one is null with its fixed sentence", async () => {
    const calls = {};
    const deps = Object.fromEntries(Object.entries(ok).map(([k, f]) => [k, (...x) => { calls[k] = (calls[k] || 0) + 1; return f(...x); }]));
    deps.streams = () => { calls.streams = (calls.streams || 0) + 1; throw new Error("boom: secret detail"); };
    const inp = await quietly(() => a.getAdviceInputs({}, { today: TODAY, deps }));
    assert.deepEqual(Object.keys(calls).sort(), Object.keys(a.SOURCE_ERRORS).sort());
    assert.ok(Object.values(calls).every((n) => n === 1));
    assert.equal(inp.streams, null);
    assert.deepEqual(inp.errors, [{ source: "streams", error: "Your pay schedule couldn't be read." }]);
    const p = a.buildAdvicePlan(inp);
    assert.equal(p.ok, true, "the pay schedule isn't critical");
    assert.equal(JSON.stringify(p).includes("secret detail"), false);
  });

  for (const key of a.CRITICAL_SOURCES) {
    it(`no ${key} → no plan, a fixed sentence`, async () => {
      const deps = { ...ok, [key]: async () => { throw new Error("down"); } };
      const p = a.buildAdvicePlan(await quietly(() => a.getAdviceInputs({}, { today: TODAY, deps })));
      assert.equal(p.ok, false);
      assert.equal(p.error, "Your plan couldn't be worked out — part of your data couldn't be read.");
      assert.deepEqual(p.errors, [{ source: key, error: a.SOURCE_ERRORS[key] }]);
      assert.equal(p.headline, undefined);
      assert.equal(p.disclaimer, a.DISCLAIMER);
    });
  }

  it("the real readers' SQL: debts > 0, credit activity over 60 days with the interest test, savings + investment transfers", async () => {
    const seen = [];
    const pool = { query: async (sql, params) => { seen.push({ sql: sql.replace(/\s+/g, " "), params }); return { rows: [] }; } };
    const deps = { months: ok.months, streams: ok.streams, cash: ok.cash };
    await a.getAdviceInputs(pool, { today: TODAY, deps });
    const find = (re) => seen.find((q) => re.test(q.sql));
    assert.match(find(/FROM linked_accounts la WHERE la.type IN/).sql, /la\.type IN \('credit', 'loan'\) AND la\.current_balance > 0/);
    const act = find(/bool_or/);
    assert.deepEqual(act.params, [TODAY]);
    assert.match(act.sql, /la\.type = 'credit' AND t\.date >= \$1::date - 60/);
    assert.match(act.sql, /BANK_FEES_INTEREST_CHARGE/);
    assert.match(act.sql, /~\* '\\y\(interest charge\|interest charged\|purchase interest\|cash advance interest\|finance charge\)\\y'/);
    assert.match(find(/recurring_transfers/).sql, /direction = 'outgoing' AND transfer_type IN \('savings', 'investment'\)/);
    assert.match(find(/cash_alert_threshold/).sql, /FROM user_settings WHERE id = 1/);
  });
});

describe("T4.1 A1 — the plan never names a security or a fund", () => {
  it("no ticker-like or fund wording in any text it writes", () => {
    const p = plan({ debts: [loan({ id: 7, name: "Auto loan", balance: 12000, apr: 5.5, payment: 350 })] });
    const text = [p.headline.text, p.why, ...p.notes, ...p.steps.map((s) => s.title)].filter(Boolean).join(" ");
    assert.doesNotMatch(text, /\b(index fund|ETF|S&P|stock|bond|VTSAX|VOO|mutual fund)\b/i);
  });
});
