// ============================================================================
// Roadmap T3.3 K1 — investment transactions, realized gains, investment income.
//
//   - realizedGains (pure FIFO): partial lots, short / long / mixed terms, a
//     reinvested dividend lot, a sale beyond known lots (NULL basis, partial /
//     none coverage — never 0), an unknown-cost transfer-in lot, an in-kind
//     transfer out, cancel pairs, corporate-action flags, same-day ordering,
//     shorts left out, the year filter, the leap-day anniversary;
//   - investmentIncome / retirementDistributions + TAX_ADVANTAGED;
//   - getInvestmentTaxData over a fake pool (the year bound, retirement
//     accounts kept out of gains and income);
//   - syncAllPlaidInvestmentFlows storing every investment transaction with its
//     security from the same response, flows unchanged, a store failure
//     isolated (flows still written, one error entry, coverage still stamped);
//   - the migration + reset-fresh classification.
// The database-backed half is tests/contract/tax-investments.contract.test.js.
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";
const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const tax = require("../teller/services/tax-investments");

let seq = 0;
const tx = (o) => ({
  plaid_investment_transaction_id: o.id || "t" + (++seq),
  investment_account_id: o.acct || 1,
  txn_date: o.date,
  type: o.type,
  subtype: o.subtype || o.type,
  security_id: o.sec === undefined ? "AAA" : o.sec,
  ticker: o.ticker || "AAA",
  security_name: o.name || "Alpha Fund",
  quantity: o.qty,
  amount: o.amount,
  fees: o.fees || 0,
  cancel_transaction_id: o.cancels || null,
});
const buy = (date, qty, amount, extra = {}) => tx({ date, type: "buy", qty, amount, ...extra });
const sell = (date, qty, proceeds, extra = {}) => tx({ date, type: "sell", qty: -qty, amount: -proceeds, ...extra });

describe("realizedGains — FIFO over stored lots", () => {
  it("takes the oldest lots first, splitting a lot, with cost from the buy amount (fees in)", () => {
    const r = tax.realizedGains([
      buy("2024-01-10", 10, 1005),
      buy("2025-03-01", 10, 1500),
      sell("2026-02-01", 15, 2400),
    ], { year: 2026 });
    assert.equal(r.sales.length, 1);
    const s = r.sales[0];
    assert.equal(s.cost_basis, 1755); // 1005 + 5 × 150
    assert.equal(s.proceeds, 2400);
    assert.equal(s.gain, 645);
    assert.equal(s.basis_coverage, "full");
    assert.equal(s.term, "mixed", "10 long (2024 lot) + 5 short (2025 lot)");
    assert.equal(r.totals.long.cost_basis, 1005);
    assert.equal(r.totals.long.proceeds, 1600);
    assert.equal(r.totals.short.cost_basis, 750);
    assert.equal(r.totals.short.proceeds, 800);
    assert.equal(r.totals.long.gain + r.totals.short.gain, 645);
  });

  it("the remaining lot carries its reduced cost into the next sale", () => {
    const r = tax.realizedGains([
      buy("2026-01-02", 10, 1000),
      sell("2026-02-01", 4, 480),
      sell("2026-03-01", 6, 540),
    ], { year: 2026 });
    assert.deepEqual(r.sales.map((s) => [s.cost_basis, s.gain, s.term]), [[400, 80, "short"], [600, -60, "short"]]);
  });

  it("long term means MORE than a year; a Feb 29 lot's anniversary is Feb 28", () => {
    assert.equal(tax.isLongTerm("2025-03-01", "2026-03-01"), false);
    assert.equal(tax.isLongTerm("2025-03-01", "2026-03-02"), true);
    assert.equal(tax.isLongTerm("2024-02-29", "2025-02-28"), false);
    assert.equal(tax.isLongTerm("2024-02-29", "2025-03-01"), true);
    assert.equal(tax.isLongTerm(null, "2025-03-01"), null);
  });

  it("a reinvested dividend is a lot (a buy subtype)", () => {
    const r = tax.realizedGains([
      buy("2026-01-05", 1, 100),
      buy("2026-03-31", 0.5, 52, { subtype: "dividend reinvestment" }),
      sell("2026-06-01", 1.5, 165),
    ], { year: 2026 });
    assert.equal(r.sales[0].cost_basis, 152);
    assert.equal(r.sales[0].gain, 13);
  });

  it("shares sold beyond the known lots give a NULL basis and gain — never 0", () => {
    const r = tax.realizedGains([buy("2026-01-05", 5, 500), sell("2026-02-01", 8, 900)], { year: 2026 });
    const s = r.sales[0];
    assert.equal(s.cost_basis, null);
    assert.equal(s.gain, null);
    assert.equal(s.basis_coverage, "partial");
    assert.equal(s.term, "unknown");
    assert.deepEqual(r.totals.unknown, { proceeds: 900, count: 1 });
    assert.equal(r.totals.short.count, 0);
    const none = tax.realizedGains([sell("2026-02-01", 3, 300)], { year: 2026 }).sales[0];
    assert.equal(none.basis_coverage, "none");
    assert.equal(none.cost_basis, null);
  });

  it("a transfer in is a lot of unknown cost; a transfer out removes shares without a sale", () => {
    const r = tax.realizedGains([
      tx({ date: "2025-01-02", type: "transfer", subtype: "transfer", qty: 4, amount: 0 }),
      buy("2025-06-01", 4, 400),
      sell("2026-02-01", 2, 260),
    ], { year: 2026 });
    assert.equal(r.sales[0].basis_coverage, "none", "the unknown-cost lot is the oldest");
    const out = tax.realizedGains([
      buy("2025-01-02", 4, 400),
      buy("2025-06-01", 4, 480),
      tx({ date: "2025-09-01", type: "transfer", subtype: "send", qty: -4, amount: 0 }),
      sell("2026-02-01", 4, 600),
    ], { year: 2026 });
    assert.equal(out.sales.length, 1, "the transfer out isn't a sale");
    assert.equal(out.sales[0].cost_basis, 480, "the transfer took the 2025-01 lot");
  });

  it("drops a cancelled row and its cancel; flags a corporate action; leaves shorts out", () => {
    const r = tax.realizedGains([
      buy("2026-01-05", 10, 1000, { id: "b1" }),
      sell("2026-02-01", 10, 1500, { id: "s-bad" }),
      tx({ date: "2026-02-02", type: "cancel", subtype: "cancel", qty: 10, amount: 1500, cancels: "s-bad" }),
      sell("2026-03-01", 10, 1200),
    ], { year: 2026 });
    assert.equal(r.sales.length, 1);
    assert.equal(r.sales[0].gain, 200);
    const split = tax.realizedGains([
      buy("2026-01-05", 10, 1000),
      tx({ date: "2026-02-01", type: "transfer", subtype: "split", qty: 10, amount: 0 }),
      sell("2026-03-01", 10, 700),
    ], { year: 2026 });
    assert.equal(split.sales[0].corporate_action, true);
    assert.equal(split.corporate_action_securities, 1);
    assert.equal(split.sales[0].cost_basis, 1000, "lots aren't adjusted for the split");
    // A reverse split reported as shares out leaves the lots alone too (flagged, not a removal).
    const reverse = tax.realizedGains([
      buy("2026-01-05", 10, 1000),
      tx({ date: "2026-02-01", type: "transfer", subtype: "split", qty: -5, amount: 0 }),
      sell("2026-03-01", 10, 1500),
    ], { year: 2026 });
    assert.equal(reverse.sales[0].cost_basis, 1000);
    assert.equal(reverse.sales[0].basis_coverage, "full");
    assert.equal(reverse.sales[0].corporate_action, true);
    const short = tax.realizedGains([sell("2026-03-01", 5, 500, { subtype: "sell short" })], { year: 2026 });
    assert.equal(short.sales.length, 0);
  });

  it("buys before sells on the same day; lots are per account and security; the year filter", () => {
    const r = tax.realizedGains([
      sell("2026-04-01", 2, 220),
      buy("2026-04-01", 2, 200),
      buy("2025-01-02", 1, 50, { acct: 2 }),
      buy("2025-01-02", 1, 70, { sec: "BBB", ticker: "BBB" }),
      sell("2025-06-01", 1, 60, { acct: 2 }),
      sell("2026-05-01", 1, 90, { sec: "BBB", ticker: "BBB" }),
    ], { year: 2026 });
    assert.deepEqual(r.sales.map((s) => [s.date, s.ticker, s.cost_basis, s.gain]), [
      ["2026-04-01", "AAA", 200, 20],
      ["2026-05-01", "BBB", 70, 20],
    ], "the 2025 sale draws on its lots but isn't reported for 2026");
  });
});

describe("investment income, retirement distributions, tax-advantaged accounts", () => {
  const accounts = new Map([
    [1, { id: 1, name: "Brokerage", institution: "Schwab", account_type: "brokerage", tax_advantaged: false }],
    [2, { id: 2, name: "IRA", institution: "Schwab", account_type: "ira", tax_advantaged: true }],
  ]);
  const cash = (acct, subtype, amount, date = "2026-03-01") => tx({ acct, date, type: "cash", subtype, qty: 0, amount });

  it("sums income per taxable account, positive, with qualified dividends apart; reinvestment buys aren't income", () => {
    const r = tax.investmentIncome([
      cash(1, "qualified dividend", -40),
      cash(1, "dividend", -10),
      cash(1, "non-qualified dividend", -5),
      cash(1, "interest", -2.5),
      cash(1, "long-term capital gain", -12),
      cash(1, "short-term capital gain", -3),
      cash(1, "tax withheld", 1.2),
      buy("2026-03-01", 1, 40, { subtype: "dividend reinvestment" }),
      cash(2, "dividend", -99),
    ], accounts);
    assert.equal(r.accounts.length, 1, "the IRA's dividend isn't taxable income");
    assert.deepEqual(r.totals, {
      dividends: 55, qualified_dividends: 40, interest: 2.5,
      capital_gain_distributions_long: 12, capital_gain_distributions_short: 3, tax_withheld: 1.2,
    });
    assert.equal(r.accounts[0].institution, "Schwab");
  });

  it("lists withdrawals from tax-advantaged accounts only", () => {
    const r = tax.retirementDistributions([
      cash(2, "withdrawal", 500, "2026-07-01"),
      cash(2, "distribution", 250, "2026-08-01"),
      cash(2, "deposit", -1000),
      cash(1, "withdrawal", 300),
    ], accounts);
    assert.deepEqual(r.distributions.map((d) => [d.date, d.amount, d.account_name]), [["2026-07-01", 500, "IRA"], ["2026-08-01", 250, "IRA"]]);
    assert.equal(r.total, 750);
  });

  it("recognises Plaid's tax-advantaged subtypes and the app's underscored spellings", () => {
    for (const t of ["ira", "roth", "Roth 401k", "401k", "sep_ira", "roth_ira", "hsa", "529", "pension", "simple ira", "rrsp", "tfsa"]) {
      assert.equal(tax.accountTaxAdvantaged(t), true, t);
    }
    for (const t of ["brokerage", "", null, "cash management", "crypto exchange", "ugma"]) {
      assert.equal(tax.accountTaxAdvantaged(t), false, String(t));
    }
  });
});

describe("getInvestmentTaxData over a fake pool", () => {
  it("reads every row before the year ends and keeps the IRA out of gains + income", async () => {
    const calls = [];
    const pool = {
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (/FROM investment_accounts/.test(sql)) {
          return { rows: [
            { id: 1, name: "Brokerage", institution: "Schwab", account_type: "brokerage", is_active: true },
            { id: 2, name: "IRA", institution: "Schwab", account_type: "ira", is_active: true },
          ] };
        }
        return { rows: [
          buy("2025-01-02", 10, 1000),
          buy("2025-01-02", 10, 1000, { acct: 2 }),
          sell("2026-02-01", 10, 1300),
          sell("2026-02-01", 10, 1300, { acct: 2 }),
          tx({ acct: 1, date: "2026-03-01", type: "cash", subtype: "qualified dividend", qty: 0, amount: -20 }),
          tx({ acct: 2, date: "2026-03-01", type: "cash", subtype: "dividend", qty: 0, amount: -20 }),
          tx({ acct: 2, date: "2026-09-01", type: "cash", subtype: "distribution", qty: 0, amount: 400 }),
          tx({ acct: 1, date: "2025-03-01", type: "cash", subtype: "dividend", qty: 0, amount: -7 }),
        ] };
      },
    };
    const d = await tax.getInvestmentTaxData(pool, 2026);
    const txnCall = calls.find((c) => /FROM investment_transactions/.test(c.sql) && /txn_date < \$1::date/.test(c.sql));
    assert.deepEqual(txnCall.params, ["2027-01-01"]);
    assert.equal(d.realized_gains.sales.length, 1, "only the brokerage sale");
    assert.equal(d.realized_gains.sales[0].gain, 300);
    assert.equal(d.realized_gains.sales[0].term, "long");
    assert.equal(d.investment_income.totals.dividends, 20, "2026 brokerage dividends only");
    assert.equal(d.retirement.total, 400);
    assert.deepEqual(d.accounts.map((a) => [a.name, a.tax_advantaged]), [["Brokerage", false], ["IRA", true]]);
    assert.equal(d.earliest_transaction_date, "2025-01-02");
    await assert.rejects(tax.getInvestmentTaxData(pool, 2026.5));
  });
});

describe("syncAllPlaidInvestmentFlows stores every investment transaction", () => {
  const dbModule = require("../teller/services/database");
  const plaidClientModule = require("../teller/services/plaid-client");
  const origQuery = dbModule.pool.query;
  const origClient = plaidClientModule.getPlaidClient;
  let perf, plaid, log, failStore;

  before(() => {
    plaidClientModule.getPlaidClient = () => plaid;
    delete require.cache[require.resolve("../teller/routes/investment-performance")];
    perf = require("../teller/routes/investment-performance");
  });
  after(() => {
    plaidClientModule.getPlaidClient = origClient;
    dbModule.pool.query = origQuery;
    delete require.cache[require.resolve("../teller/routes/investment-performance")];
  });
  afterEach(() => { dbModule.pool.query = origQuery; });

  function setup() {
    log = [];
    const seen = new Set();
    dbModule.pool.query = async (sql, params) => {
      log.push({ sql, params });
      if (/SELECT DISTINCT ON \(item_id\)/.test(sql)) return { rows: [{ item_id: "it1", institution_name: "Broker", access_token: "tok" }] };
      if (/SELECT id, plaid_account_id FROM investment_accounts/.test(sql)) return { rows: [{ id: 7, plaid_account_id: "acc1" }] };
      if (/INSERT INTO investment_transactions/.test(sql)) {
        if (failStore) throw new Error("relation \"investment_transactions\" does not exist");
        const fresh = !seen.has(params[0]);
        seen.add(params[0]);
        return { rows: [{ inserted: fresh }] };
      }
      if (/INSERT INTO investment_flows/.test(sql)) return { rowCount: 1, rows: [] };
      return { rows: [], rowCount: 0 };
    };
    plaid = {
      investmentsTransactionsGet: async () => ({ data: {
        total_investment_transactions: 4,
        accounts: [{ account_id: "acc1" }],
        securities: [{ security_id: "sec1", ticker_symbol: "VTI", name: "Total Market ETF", type: "etf" }],
        investment_transactions: [
          { investment_transaction_id: "p1", account_id: "acc1", security_id: "sec1", date: "2026-01-05", name: "BUY VTI", quantity: 2, amount: 500.5, price: 250, fees: 0.5, type: "buy", subtype: "buy" },
          { investment_transaction_id: "p2", account_id: "acc1", security_id: "sec1", date: "2026-03-05", name: "SELL VTI", quantity: -1, amount: -260, price: 260, fees: 0, type: "sell", subtype: "sell" },
          { investment_transaction_id: "p3", account_id: "acc1", security_id: null, date: "2026-03-31", name: "DIV", quantity: 0, amount: -3.2, price: 0, fees: null, type: "cash", subtype: "Qualified Dividend" },
          { investment_transaction_id: "p4", account_id: "acc1", security_id: null, date: "2026-04-01", name: "DEPOSIT", quantity: 0, amount: -1000, price: 0, fees: null, type: "cash", subtype: "deposit" },
          { investment_transaction_id: "px", account_id: "untracked", security_id: null, date: "2026-04-01", name: "OTHER", quantity: 0, amount: -5, type: "cash", subtype: "interest" },
        ],
      } }),
    };
  }

  it("writes each row of a tracked account with its security, once; flows stay as before", async () => {
    failStore = false;
    setup();
    const r = await perf.syncAllPlaidInvestmentFlows();
    assert.equal(r.ok, true);
    assert.equal(r.transactions_stored, 4);
    assert.equal(r.flows_added, 1, "only the deposit is an external flow");
    assert.equal(r.errors, undefined);
    const stores = log.filter((c) => /INSERT INTO investment_transactions/.test(c.sql));
    assert.deepEqual(stores.map((c) => c.params[0]), ["p1", "p2", "p3", "p4"], "the untracked account's row is skipped");
    assert.match(stores[0].sql, /ON CONFLICT \(plaid_investment_transaction_id\) DO UPDATE SET/);
    assert.deepEqual(stores[0].params, ["p1", 7, "2026-01-05", "buy", "buy", "sec1", "VTI", "Total Market ETF", "etf", 2, 250, 500.5, 0.5, "BUY VTI", null]);
    assert.equal(stores[2].params[4], "qualified dividend", "subtype lower-cased");
    assert.equal(stores[2].params[6], null, "no security → no ticker");
    assert.equal(stores[2].params[12], null, "fees null stays null");
    const r2 = await perf.syncAllPlaidInvestmentFlows();
    assert.equal(r2.transactions_stored, 0, "a re-sync updates, it doesn't add");
  });

  it("a store failure keeps the flows, stamps coverage, and reports one error for the item", async () => {
    failStore = true;
    setup();
    const errs = [];
    const orig = console.error;
    console.error = (...a) => errs.push(a.join(" "));
    let r;
    try { r = await perf.syncAllPlaidInvestmentFlows(); } finally { console.error = orig; }
    assert.equal(r.ok, true);
    assert.equal(r.flows_added, 1);
    assert.equal(r.transactions_stored, 0);
    assert.deepEqual(r.errors, [{ institution: "Broker", error: "investment_transactions_not_stored" }]);
    assert.equal(errs.filter((e) => /Investment transaction store error/.test(e)).length, 1, "logged once per run");
    assert.ok(log.some((c) => /UPDATE investment_accounts SET flows_synced_at = now\(\)/.test(c.sql)));
  });
});

describe("migration + reset-fresh", () => {
  it("creates investment_transactions idempotently with a unique Plaid id", () => {
    const db = read("teller/services/database.js");
    assert.match(db, /CREATE TABLE IF NOT EXISTS investment_transactions \(/);
    assert.match(db, /plaid_investment_transaction_id TEXT NOT NULL UNIQUE/);
    assert.match(db, /CREATE INDEX IF NOT EXISTS idx_inv_txn_account_date/);
  });
  it("reset-fresh wipes it", () => {
    assert.ok(require("../scripts/reset-fresh").WIPE_TABLES.includes("investment_transactions"));
  });
});
