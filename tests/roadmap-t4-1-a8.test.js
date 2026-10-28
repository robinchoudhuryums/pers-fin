// Roadmap T4.1 A8 — statement-date utilization and loan extra payments
// (services/advice.js): the liabilities sync storing a card's last statement
// balance + issue date and the migration's columns; nextStatementDate (a month
// on from the last statement, its day clamped; stale / future / malformed →
// null); the carried-balance test reading the statement (a payment after it
// under 95% → carried, at or above → paid in full, a payment before it → the
// minimum rule); the utilization tip naming the day the next statement closes
// (else the due date); loanExtraPayments (an extra $100 a month — interest
// saved and months sooner from computeLoanPayoff, a low-APR loan's note, a loan
// the plan already funds left out, no APR / payment / a payment that never pays
// it off → none); the readers' SQL; the card, the prompt block, Ask and the
// audit's plan figures.
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
const { computeLoanPayoff } = require("../teller/services/projections");

const TODAY = "2026-10-28";
const MONTHS = ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"].map((m) => ({ month: m, income: 6000, spending: 2800 }));
const VISA = (over = {}) => ({
  id: 1, account_id: "c1", name: "Visa", type: "credit", current_balance: "3000", credit_limit: "5000", apr: "24.99", minimum_payment: "90",
  last_statement_balance: "2500", last_statement_issue_date: "2026-10-05", last_payment_amount: "500", last_payment_date: "2026-10-20", ...over,
});
const CAR = (over = {}) => ({ id: 2, account_id: "l1", name: "Car Loan", type: "loan", current_balance: "18000", apr: "6.5", monthly_payment: "400", ...over });

function inputs(over = {}) {
  return {
    today: TODAY, errors: [],
    months: MONTHS, streams: [],
    cash: { starting_balance: 15000, lowest: { date: "2026-11-20", balance: 14000 } },
    settings: { cash_alert_threshold: "500" },
    debts: [VISA(), CAR()], activity: [{ account_id: "c1", txns: 3, interest: false }],
    transfers: [], goals: [], deposits: [], categories: [],
    idle: { accounts: [], investments: [], snapshots: [] },
    allocation: { total_value: 0, has_targets: false, classes: [] },
    subscriptions: { subs: [], bills: [], activity: [] },
    contributions: { limits: {}, accounts: [], flows: [] },
    ...over,
  };
}
const plan = (over) => a.buildAdvicePlan(inputs(over));

// ---------------------------------------------------------------------------
describe("T4.1 A8 — the statement is stored", () => {
  const db = require("../teller/services/database");
  const orig = db.pool.query;
  afterEach(() => { db.pool.query = orig; });

  it("the liabilities sync writes a card's last statement balance and issue date ($0 kept)", async () => {
    const seen = [];
    db.pool.query = async (sql, params) => { seen.push({ sql: sql.replace(/\s+/g, " "), params }); return { rows: [], rowCount: 1 }; };
    const inv = require("../teller/routes/investments");
    const client = { liabilitiesGet: async () => ({ data: { accounts: [], liabilities: { credit: [
      { account_id: "c1", aprs: [{ apr_type: "purchase_apr", apr_percentage: 24.99 }], minimum_payment_amount: 90, last_statement_balance: 2500.5, last_statement_issue_date: "2026-10-05" },
      { account_id: "c2", aprs: [], last_statement_balance: 0, last_statement_issue_date: null },
    ] } } }) };
    const r = await inv.syncPlaidLiabilities(client, "tok", 7);
    assert.equal(r.updated, 2);
    const ups = seen.filter((q) => /UPDATE linked_accounts SET apr = COALESCE\(\$1, apr\)/.test(q.sql));
    assert.match(ups[0].sql, /last_statement_balance = \$8, last_statement_issue_date = \$9/);
    assert.deepEqual(ups[0].params.slice(5), ["c1", 7, 2500.5, "2026-10-05"]);
    assert.deepEqual(ups[1].params.slice(7), [0, null]);
  });

  it("the migration adds both columns", () => {
    const src = read("teller/services/database.js");
    assert.match(src, /ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS last_statement_balance NUMERIC\(12,2\) DEFAULT NULL/);
    assert.match(src, /ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS last_statement_issue_date DATE DEFAULT NULL/);
  });

  it("the plan's card read carries them as text dates", () => {
    const sql = a.DEBTS_SQL.replace(/\s+/g, " ");
    assert.match(sql, /la\.last_payment_date::text AS last_payment_date/);
    assert.match(sql, /la\.last_statement_balance, la\.last_statement_issue_date::text AS last_statement_issue_date/);
  });
});

// ---------------------------------------------------------------------------
describe("T4.1 A8 — the next statement and the carried test", () => {
  it("nextStatementDate: a month on, the day clamped; stale, future or malformed → null", () => {
    const n = (d, today = TODAY) => a.nextStatementDate({ last_statement_issue_date: d }, today);
    assert.equal(n("2026-10-05"), "2026-11-05");
    assert.equal(n("2026-09-30"), "2026-10-30", "a statement two cycles back still projects the next close");
    assert.equal(n("2027-01-31", "2027-02-10"), "2027-02-28");
    assert.equal(n("2027-01-31", "2027-03-01"), "2027-03-31", "stepped from the original day, not the clamped one");
    assert.equal(n("2026-10-28"), "2026-11-28", "a statement issued today: the next one");
    assert.equal(n("2026-08-01"), null, "older than 62 days");
    assert.equal(n("2026-11-01"), null);
    assert.equal(n("10/05/2026"), null);
    assert.equal(n(null), null);
  });

  it("a payment after the statement: under 95% carried, at or above paid in full (the statement wins over the minimum rule)", () => {
    const c = (over) => a.carryStatus({ current_balance: "3000", minimum_payment: "2400", last_statement_balance: "2500", last_statement_issue_date: "2026-10-05", last_payment_date: "2026-10-20", ...over }, { txns: 3 });
    assert.deepEqual(c({ last_payment_amount: "500", minimum_payment: "90" }), { carried: true, reason: "statement_not_paid" });
    assert.deepEqual(c({ last_payment_amount: "2500" }), { carried: false, reason: "statement_paid" });
    assert.deepEqual(c({ last_payment_amount: "2400" }), { carried: false, reason: "statement_paid" }, "within 5% of the statement");
    assert.deepEqual(c({ last_payment_amount: "2370" }), { carried: true, reason: "statement_not_paid" }, "just under 95% of the statement");
    // A payment before the statement paid the one before it: the minimum rule decides.
    assert.deepEqual(c({ last_payment_amount: "2500", last_payment_date: "2026-09-25" }), { carried: true, reason: "minimum_payments" });
    // A $0 statement or no statement: the old rules.
    assert.deepEqual(c({ last_payment_amount: "2500", last_statement_balance: "0" }), { carried: true, reason: "minimum_payments" });
    assert.deepEqual(c({ last_payment_amount: "2500", minimum_payment: "90", last_statement_balance: null }), { carried: false, reason: "paid_in_full" });
    // An interest charge still decides first.
    assert.deepEqual(a.carryStatus({ current_balance: "3000", last_statement_balance: "2500", last_statement_issue_date: "2026-10-05", last_payment_amount: "2500", last_payment_date: "2026-10-20" }, { interest: true }), { carried: true, reason: "interest_charged" });
  });

  it("the utilization tip names the day the next statement closes, else the due date", () => {
    const [d] = a.normalizeDebts([VISA()], [], TODAY);
    assert.deepEqual(d.statement, { last_date: "2026-10-05", last_balance: 2500, reported_pct: 50, next_date: "2026-11-05" });
    assert.deepEqual(d.utilization_tip, { pay: 1500, by: "2026-11-05", basis: "statement",
      text: "Paying $1,500.00 on Visa before Nov 5, when its next statement closes, keeps the balance it reports under 30% of its limit." });
    const [stale] = a.normalizeDebts([VISA({ last_statement_issue_date: "2026-07-01" })], [], TODAY);
    assert.equal(stale.statement.next_date, null);
    assert.equal(stale.utilization_tip.basis, "due_date");
    assert.equal(stale.utilization_tip.text, "Paying $1,500.00 on Visa before its due date brings it under 30% of its limit.");
    // A card paid in full still reports its balance: the tip stays.
    const [paid] = a.normalizeDebts([VISA({ last_payment_amount: "2500" })], [{ account_id: "c1", txns: 3 }], TODAY);
    assert.equal(paid.carried, false);
    assert.equal(paid.utilization_tip.basis, "statement");
    // A loan has no statement block.
    assert.equal("statement" in a.normalizeDebts([CAR()], [], TODAY)[0], false);
  });
});

// ---------------------------------------------------------------------------
describe("T4.1 A8 — loan extra payments", () => {
  it("an extra $100 a month: interest saved and months sooner, from computeLoanPayoff", () => {
    const p = plan();
    assert.equal(p.headline.step, "high_interest_debt");
    assert.equal(p.loan_extra.length, 1);
    const l = p.loan_extra[0];
    const now = computeLoanPayoff({ balance: 18000, aprPct: 6.5, monthlyPayment: 400, today: TODAY });
    const more = computeLoanPayoff({ balance: 18000, aprPct: 6.5, monthlyPayment: 500, today: TODAY });
    assert.equal(l.months_now, now.months_to_payoff);
    assert.equal(l.months_with_extra, more.months_to_payoff);
    assert.equal(l.months_sooner, now.months_to_payoff - more.months_to_payoff);
    assert.equal(l.interest_saved, Math.round((now.total_interest - more.total_interest) * 100) / 100);
    assert.equal(l.extra_monthly, a.LOAN_EXTRA_MONTHLY);
    assert.equal(l.text, `An extra $100.00 a month on Car Loan would save about $${l.interest_saved.toLocaleString("en-US", { minimumFractionDigits: 2 })} in interest and pay it off 11 months sooner (Mar 2030 instead of Feb 2031).`);
  });

  it("a low-APR loan says the plan keeps it on its minimum", () => {
    const [l] = plan({ debts: [VISA(), CAR({ apr: "3.0" })] }).loan_extra;
    assert.equal(l.tier, "low");
    assert.match(l.text, / At 3% APR it's low-interest debt, so your plan keeps it on its minimum\.$/);
  });

  it("left out: a loan the plan already funds, no APR / 0%, no payment, a payment that never pays it off, a card", () => {
    // Emergency fund reached, no high-interest debt → the medium step funds the car loan.
    const funded = plan({ debts: [CAR()], activity: [] });
    assert.equal(funded.headline.step, "medium_interest_debt");
    assert.deepEqual(funded.loan_extra, []);
    assert.deepEqual(plan({ debts: [VISA(), CAR({ apr: null })] }).loan_extra, []);
    assert.deepEqual(plan({ debts: [VISA(), CAR({ apr: "0" })] }).loan_extra, []);
    assert.deepEqual(plan({ debts: [VISA(), CAR({ monthly_payment: null })] }).loan_extra, []);
    assert.deepEqual(plan({ debts: [VISA(), CAR({ monthly_payment: "90" })] }).loan_extra, [], "$90 doesn't cover the interest");
    assert.deepEqual(plan({ debts: [VISA()] }).loan_extra, []);
  });
});

// ---------------------------------------------------------------------------
describe("T4.1 A8 — the surfaces", () => {
  it("the card: the loan line and the statement tip, escaped", () => {
    const dash = read("teller/views/dashboard.ejs");
    const i = dash.indexOf("    var ADVICE_DISCLAIMER"), j = dash.indexOf("    // Design D3: the Summary card + Needs attention");
    const ctx = {
      esc: (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
      fmt: (n) => "$" + Number(n).toFixed(2), emptyState: () => "EMPTY", Number, String, Date, JSON,
    };
    vm.runInNewContext(dash.slice(i, j), ctx);
    const html = ctx.renderAdvice(plan({ debts: [VISA(), CAR({ name: "Car <Loan>" })] }));
    assert.match(html, /<li>An extra \$100\.00 a month on Car &lt;Loan&gt; would save about/);
    assert.match(html, /<li>Paying \$1,500\.00 on Visa before Nov 5, when its next statement closes/);
  });

  it("the insight prompt block carries the loan lines and the statement tip", () => {
    const block = require("../teller/routes/insights").cashPlanPromptBlock(plan());
    assert.match(block, /\nLoan extra payments:\n- An extra \$100\.00 a month on Car Loan would save about .* 11 months sooner/);
    assert.match(block, /\nUtilization tips:\n- Paying \$1,500\.00 on Visa before Nov 5, when its next statement closes/);
  });

  it("Ask's get_cash_plan carries them", async () => {
    const real = a.getAdvicePlan;
    const p = plan();
    a.getAdvicePlan = async () => p;
    try {
      const ask = require("../teller/routes/ask");
      const out = await (ask._TOOL_EXECUTORS || ask.TOOL_EXECUTORS).get_cash_plan({});
      assert.deepEqual(out.loan_extra, p.loan_extra);
      const visa = out.debts.find((d) => d.name === "Visa");
      assert.equal(visa.next_statement_date, "2026-11-05");
      assert.equal(visa.last_statement_reported_pct, 50);
      assert.equal(out.debts.find((d) => d.name === "Car Loan").next_statement_date, null);
    } finally { a.getAdvicePlan = real; }
  });

  it("the audit counts a loan's extra $100 and its payment with it as the loan's monthly figures", () => {
    const audit = require("../teller/services/ai-audit");
    const f = audit.planFigures(plan());
    assert.ok(f.debts["car loan"].monthly.includes(100));
    assert.ok(f.debts["car loan"].monthly.includes(500));
    const check = (text) => { const c = audit.extractDollarClaims(text); const s = audit.claimSegments(text, c, 0); return audit.planClaimFinding(c[0], s.lead, s.trail, f); };
    assert.deepEqual(check("For Car Loan, put $100 a month extra toward it."), { matched: true, finding: null });
    assert.equal(check("For Car Loan, put $250 a month extra toward it.").finding.check, "cash_plan");
  });
});
