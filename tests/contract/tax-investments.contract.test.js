// Real-Postgres contract tests for roadmap T3.3 K1: every Plaid investment
// transaction stored once by the flow sync (investment_transactions), and
// getInvestmentTaxData's realized gains / investment income / retirement
// distributions over those real rows. Only a Plaid client object is stubbed.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { SKIP, perfinDb } = require("./_setup");

describe("investment transactions + tax data on real Postgres (T3.3 K1)", { skip: SKIP }, () => {
  let pool, perf, tax;
  const q = (s, p) => pool.query(s, p);
  const PASS = () => process.env.TOKEN_ENCRYPTION_PASSPHRASE;
  let plaid;

  const SECURITIES = [
    { security_id: "sec_vti", ticker_symbol: "VTI", name: "Vanguard Total Stock Market ETF", type: "etf" },
    { security_id: "sec_bnd", ticker_symbol: "BND", name: "Vanguard Total Bond Market ETF", type: "etf" },
  ];
  const TXNS = [
    // Taxable brokerage: two lots, one sale across both, a dividend and interest.
    { investment_transaction_id: "k1", account_id: "brk", security_id: "sec_vti", date: "2024-03-01", type: "buy", subtype: "buy", quantity: 10, price: 100, amount: 1000, fees: 0, name: "BUY VTI" },
    { investment_transaction_id: "k2", account_id: "brk", security_id: "sec_vti", date: "2025-09-01", type: "buy", subtype: "buy", quantity: 5, price: 150, amount: 750, fees: 0, name: "BUY VTI" },
    { investment_transaction_id: "k3", account_id: "brk", security_id: "sec_vti", date: "2025-12-01", type: "sell", subtype: "sell", quantity: -12, price: 200, amount: -2400, fees: 0, name: "SELL VTI" },
    { investment_transaction_id: "k4", account_id: "brk", security_id: "sec_vti", date: "2025-06-15", type: "cash", subtype: "Qualified Dividend", quantity: 0, price: 0, amount: -40, fees: 0, name: "DIV VTI" },
    { investment_transaction_id: "k5", account_id: "brk", security_id: null, date: "2025-07-01", type: "cash", subtype: "interest", quantity: 0, price: 0, amount: -2.5, fees: 0, name: "INTEREST" },
    // A deposit — a flow (TWR/XIRR), not income.
    { investment_transaction_id: "k6", account_id: "brk", security_id: null, date: "2025-01-10", type: "cash", subtype: "deposit", quantity: 0, price: 0, amount: -500, fees: 0, name: "DEPOSIT" },
    // 401(k): a sale and a dividend that stay out of gains / income, a withdrawal listed as a distribution.
    { investment_transaction_id: "r1", account_id: "k401", security_id: "sec_bnd", date: "2024-05-01", type: "buy", subtype: "buy", quantity: 10, price: 70, amount: 700, fees: 0, name: "BUY BND" },
    { investment_transaction_id: "r2", account_id: "k401", security_id: "sec_bnd", date: "2025-04-01", type: "sell", subtype: "sell", quantity: -10, price: 80, amount: -800, fees: 0, name: "SELL BND" },
    { investment_transaction_id: "r3", account_id: "k401", security_id: "sec_bnd", date: "2025-03-01", type: "cash", subtype: "dividend", quantity: 0, price: 0, amount: -15, fees: 0, name: "DIV BND" },
    { investment_transaction_id: "r4", account_id: "k401", security_id: null, date: "2025-08-01", type: "cash", subtype: "withdrawal", quantity: 0, price: 0, amount: 600, fees: 0, name: "DISTRIBUTION" },
  ];

  before(async () => {
    pool = await perfinDb("taxinv");
    require("../../teller/services/plaid-client").getPlaidClient = () => plaid;
    perf = require("../../teller/routes/investment-performance");
    tax = require("../../teller/services/tax-investments");
    await q("INSERT INTO plaid_investment_items (item_id, institution_name, access_token_enc) VALUES ('pi_tax','Taxbroker', pgp_sym_encrypt('ttok', $1))", [PASS()]);
    await q("INSERT INTO investment_accounts (name, institution, account_type, balance, plaid_account_id) VALUES ('Brokerage','Taxbroker','brokerage',5000,'brk'), ('Work 401k','Taxbroker','401k',9000,'k401')");
    plaid = {
      investmentsTransactionsGet: async () => ({ data: {
        total_investment_transactions: TXNS.length,
        accounts: [{ account_id: "brk" }, { account_id: "k401" }],
        securities: SECURITIES,
        investment_transactions: TXNS,
      } }),
    };
  });

  after(async () => { if (pool) await pool.end(); });

  it("the flow sync stores every investment transaction once, with its security; flows unchanged", async () => {
    const r1 = await perf.syncAllPlaidInvestmentFlows();
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.equal(r1.transactions_stored, TXNS.length);
    assert.ok(!r1.errors, JSON.stringify(r1.errors));
    const r2 = await perf.syncAllPlaidInvestmentFlows();
    assert.equal(r2.transactions_stored, 0, "a re-sync updates, never duplicates");
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM investment_transactions")).rows[0].n, TXNS.length);

    const k3 = (await q(`SELECT it.type, it.subtype, it.ticker, it.security_type, it.quantity::float AS qty,
        it.amount::float AS amount, it.txn_date::text AS d, ia.plaid_account_id
      FROM investment_transactions it JOIN investment_accounts ia ON ia.id = it.investment_account_id
      WHERE it.plaid_investment_transaction_id = 'k3'`)).rows[0];
    assert.deepEqual(k3, { type: "sell", subtype: "sell", ticker: "VTI", security_type: "etf", qty: -12, amount: -2400, d: "2025-12-01", plaid_account_id: "brk" });
    assert.equal((await q("SELECT subtype FROM investment_transactions WHERE plaid_investment_transaction_id='k4'")).rows[0].subtype, "qualified dividend");

    // Flows are unchanged: the deposit in, the 401(k) withdrawal out — dividends, interest, buys and sells are not flows.
    const flows = (await q("SELECT plaid_investment_transaction_id AS id, amount::float AS amount FROM investment_flows ORDER BY 1")).rows;
    assert.deepEqual(flows, [{ id: "k6", amount: 500 }, { id: "r4", amount: -600 }]);
  });

  it("getInvestmentTaxData computes FIFO gains, income and retirement distributions from the stored rows", async () => {
    const d = await tax.getInvestmentTaxData(pool, 2025);
    assert.equal(d.year, 2025);
    assert.equal(d.earliest_transaction_date, "2024-03-01");
    assert.deepEqual(d.accounts.map((a) => [a.name, a.tax_advantaged]).sort(), [["Brokerage", false], ["Work 401k", true]]);

    // The 12-share sale: 10 from the 2024 lot (long, basis 1000) + 2 from the 2025 lot (short, basis 300).
    assert.equal(d.realized_gains.sales.length, 1, "the 401(k) sale is not a taxable gain");
    const s = d.realized_gains.sales[0];
    assert.equal(s.ticker, "VTI");
    assert.equal(s.term, "mixed");
    assert.equal(s.proceeds, 2400);
    assert.equal(s.cost_basis, 1300);
    assert.equal(s.gain, 1100);
    assert.equal(s.basis_coverage, "full");
    assert.deepEqual(d.realized_gains.totals.long, { proceeds: 2000, cost_basis: 1000, gain: 1000, count: 1 });
    assert.deepEqual(d.realized_gains.totals.short, { proceeds: 400, cost_basis: 300, gain: 100, count: 1 });

    assert.equal(d.investment_income.totals.dividends, 40);
    assert.equal(d.investment_income.totals.qualified_dividends, 40);
    assert.equal(d.investment_income.totals.interest, 2.5);
    assert.equal(d.retirement.total, 600);
    assert.deepEqual(d.retirement.distributions.map((x) => [x.account_name, x.amount, x.date]), [["Work 401k", 600, "2025-08-01"]]);
  });

  it("a year before the sale has no realized gains; an invalid year throws", async () => {
    const d = await tax.getInvestmentTaxData(pool, 2024);
    assert.equal(d.realized_gains.sales.length, 0);
    assert.equal(d.investment_income.totals.dividends, 0);
    await assert.rejects(() => tax.getInvestmentTaxData(pool, "2025abc"));
  });
});
