// ============================================================================
// Cycle-8 broad scan, Batch 2 — money accuracy: forecast, alerts, tax
// ============================================================================
//   F7   a transfer between two of your own spendable accounts isn't billed
//   F8   only CARD autopays are skipped; a utility "AUTOPAY" is billed
//   F9   `fee` rows with an income subtype aren't netted against income
//   F10  "Paycheck landed" holds its watermark when the notification isn't logged
//   F11  the low-cash alert remembers its last notification across a "clear"
//   F12  a cash-alert setting / floor change makes the next tick evaluate
//   F13  documents.csv lists the dismissed DAY in APP_TIMEZONE
//   F14  a tax document id beyond int4 is a 400, not a 500
//   F15  "buy to cover" isn't a FIFO lot
// The SQL half of F7 / F8 runs on real Postgres in
// tests/contract/c8-batch2.contract.test.js.
// ============================================================================
process.env.APP_TIMEZONE = "America/Los_Angeles";
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supertest = require("supertest");

const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
afterEach(() => { dbModule.pool.query = originalQuery; });

const cf = require("../teller/services/cash-flow");
const ca = require("../teller/services/cash-alerts");
const pa = require("../teller/services/payday-alerts");
const tax = require("../teller/services/tax-investments");
const pkg = require("../teller/services/tax-package");

// ---------------------------------------------------------------------------
describe("F8 — only card autopays are left out of the forecast's bills", () => {
  const bp = (display_name, extra = {}) => ({ transfer_type: "bill_payment", display_name, ...extra });
  it("a utility / insurance autopay from checking is billed", () => {
    for (const n of ["PG&E", "PGANDE WEB ONLINE AUTOPAY", "STATE FARM AUTOPAY", "Comcast autopay"]) {
      assert.equal(cf.isCardAutopay(bp(n)), false, n);
    }
  });
  it("a card payment — by its name, an issuer, or a credit on a linked card — is skipped", () => {
    for (const n of ["CHASE CREDIT CARD AUTOPAY", "AMEX EPAYMENT", "CAPITAL ONE AUTOPAY", "DISCOVER E-PAYMENT", "CITI CARD ONLINE PAYMENT", "CARDMEMBER SERV"]) {
      assert.equal(cf.isCardAutopay(bp(n)), true, n);
    }
    assert.equal(cf.isCardAutopay(bp("ONLINE PMT 12345", { paid_linked_card: true })), true);
  });
  it("a loan or mortgage payment is always billed, even to a card issuer", () => {
    assert.equal(cf.isCardAutopay(bp("CHASE AUTO LOAN PAYMENT", { paid_linked_card: true })), false);
    assert.equal(cf.isCardAutopay(bp("Mortgage payment")), false);
    assert.equal(cf.isCardAutopay({ transfer_type: "peer_transfer", display_name: "Zelle" }), false);
  });
});

describe("F7 — a transfer between your own spendable accounts isn't billed", () => {
  function pool(rows, sqls = []) {
    return {
      query: async (sql) => {
        sqls.push(sql);
        if (/FROM recurring_transfers rt/.test(sql)) return { rows };
        if (/AS cash/.test(sql)) return { rows: [{ cash: "5000", debt: "0" }] };
        return { rows: [] };
      },
    };
  }
  const xfer = (display_name, transfer_type, flags = {}) => ({
    display_name, amount: "1000", cadence_days: 30, next_expected: "2030-07-01", last_date: "2030-06-01",
    transfer_type, direction: "outgoing", moved_between_cash_accounts: false, paid_linked_card: false, ...flags,
  });

  it("a transfer whose debit landed on another depository account is left out; others stay", async () => {
    const inputs = await cf.getCashFlowInputs(pool([
      xfer("Online Transfer to Savings", "internal", { moved_between_cash_accounts: true }),
      xfer("Ally Savings", "savings", { moved_between_cash_accounts: true }),
      xfer("Online Transfer to J Smith", "internal"),
      xfer("Vanguard", "investment"),
      xfer("PG&E AUTOPAY", "bill_payment"),
      xfer("ONLINE PMT", "bill_payment", { paid_linked_card: true }),
    ]), { today: "2030-06-30" });
    assert.deepEqual(inputs.bills.map((b) => b.display_name).sort(),
      ["Online Transfer to J Smith", "PG&E AUTOPAY", "Vanguard"]);
  });

  it("the transfers query computes both flags from the transfer's latest debit and a same-amount credit within 5 days", async () => {
    const sqls = [];
    await cf.getCashFlowInputs(pool([], sqls), { today: "2030-06-30" });
    const sql = sqls.find((s) => /FROM recurring_transfers rt/.test(s));
    assert.match(sql, /AS moved_between_cash_accounts/);
    assert.match(sql, /AS paid_linked_card/);
    assert.match(sql, /t2\.amount = -t\.amount AND t2\.date BETWEEN t\.date - 5 AND t\.date \+ 5/);
    assert.match(sql, /t\.date = rt\.last_transferred/);
    assert.match(sql, /la2\.type = 'depository' AND NOT \(\s*la2\.type = 'investment'/, "an investment destination is never 'between cash accounts'");
    assert.match(sql, /la2\.type = 'credit'/);
  });
});

// ---------------------------------------------------------------------------
describe("F9 / F15 — investment tax figures", () => {
  let seq = 0;
  const tx = (o) => ({
    plaid_investment_transaction_id: "t" + (++seq), investment_account_id: 1, txn_date: o.date,
    type: o.type, subtype: o.subtype || o.type, security_id: "AAA", ticker: "AAA", security_name: "Alpha",
    quantity: o.qty, amount: o.amount, fees: 0, cancel_transaction_id: null,
  });
  const accounts = new Map([[1, { id: 1, name: "Brokerage", institution: "Schwab", account_type: "brokerage", tax_advantaged: false }]]);

  it("F9: margin interest charged and a dividend paid on a short are not netted against income", () => {
    const r = tax.investmentIncome([
      tx({ date: "2026-03-01", type: "cash", subtype: "interest", qty: 0, amount: -12 }),
      tx({ date: "2026-03-02", type: "fee", subtype: "interest", qty: 0, amount: 40 }),
      tx({ date: "2026-03-03", type: "cash", subtype: "qualified dividend", qty: 0, amount: -50 }),
      tx({ date: "2026-03-04", type: "fee", subtype: "qualified dividend", qty: 0, amount: 5 }),
      tx({ date: "2026-03-05", type: "fee", subtype: "tax withheld", qty: 0, amount: 1.5 }),
    ], accounts);
    assert.equal(r.totals.interest, 12);
    assert.equal(r.totals.dividends, 50);
    assert.equal(r.totals.qualified_dividends, 50);
    assert.equal(r.totals.tax_withheld, 1.5, "tax withheld counts whatever the row's type");
  });

  it("F9: a dividend REVERSAL on a cash row still reduces income", () => {
    const r = tax.investmentIncome([
      tx({ date: "2026-03-03", type: "cash", subtype: "dividend", qty: 0, amount: -50 }),
      tx({ date: "2026-03-10", type: "cash", subtype: "dividend", qty: 0, amount: 20 }),
    ], accounts);
    assert.equal(r.totals.dividends, 30);
  });

  it("F15: a buy to cover isn't a lot — a later long sale isn't matched against it", () => {
    const r = tax.realizedGains([
      tx({ date: "2025-01-10", type: "sell", subtype: "sell short", qty: -10, amount: -1000 }),
      tx({ date: "2025-02-10", type: "buy", subtype: "buy to cover", qty: 10, amount: 900 }),
      tx({ date: "2025-06-01", type: "buy", subtype: "buy", qty: 5, amount: 600 }),
      tx({ date: "2026-03-01", type: "sell", subtype: "sell", qty: -10, amount: -1500 }),
    ], { year: 2026 });
    const s = r.sales[0];
    assert.equal(s.basis_coverage, "partial", "only the 5 long shares are known lots");
    assert.equal(s.cost_basis, null);
  });
});

// ---------------------------------------------------------------------------
describe("F10 — a Paycheck landed alert that wasn't logged is retried", () => {
  beforeEach(() => pa._reset());
  const PAY = ["2026-01-04", "2026-01-18", "2026-02-01", "2026-02-15", "2026-03-01", "2026-03-15"]
    .map((date) => ({ source: "ACME PAYROLL", date, amount: "2100" }));
  function landedPool(candidates) {
    const calls = { updates: [] };
    return {
      calls,
      query: async (sql, params) => {
        if (/SELECT payday_alerts_enabled, last_income_alert_txn_id/.test(sql)) return { rows: [{ payday_alerts_enabled: true, last_income_alert_txn_id: "400", last_income_alert_at: "2026-03-01 00:00:00+00" }] };
        if (/AS mark_id/.test(sql)) return { rows: [{ mark_id: "500", mark_at: "2026-03-19 10:00:00+00" }] };
        if (/UPDATE user_settings SET last_income_alert_txn_id/.test(sql)) { calls.updates.push(params); return { rows: [] }; }
        if (/AS in_overlap/.test(sql)) return { rows: candidates };
        if (/INTERVAL '4 months'/.test(sql)) return { rows: PAY };
        throw new Error("unexpected query: " + sql.slice(0, 60));
      },
    };
  }
  const cand = (id, source, amount, date, rowId) => ({ id: String(rowId), transaction_id: id, source, amount: String(amount), date, in_overlap: false });

  it("{ logged: false } holds the watermark just before that deposit", async () => {
    const pool = landedPool([
      cand("a", "IRS REFUND", 50, "2026-03-15", 410),
      cand("b", "ACME PAYROLL", 2100, "2026-03-15", 420),
      cand("c", "ACME PAYROLL", 2100, "2026-03-16", 430),
    ]);
    const quiet = console.error; console.error = () => {};
    let r, n = 0;
    try { r = await pa.runPaydayLanded(pool, { today: "2026-03-19", deps: { sendToAll: async () => { n++; return { sent: 0, failed: 0, logged: false }; } } }); }
    finally { console.error = quiet; }
    assert.equal(r.status, "held_back");
    assert.equal(r.notified, 0, "an unlogged alert isn't counted as sent");
    assert.equal(n, 1, "the run stops at the first unlogged alert");
    assert.deepEqual(pool.calls.updates, [["419", "2026-03-01 00:00:00+00"]]);
  });
});

// ---------------------------------------------------------------------------
describe("F11 / F12 — the low-cash alert", () => {
  const NOW = new Date("2026-03-10T15:00:00Z");
  const TODAY = "2026-03-10";
  const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600e3);
  function fakePool(row) {
    const calls = { selects: 0, updates: [] };
    return {
      calls,
      query: async (sql, params) => {
        if (/UPDATE user_settings SET cash_alert_state/.test(sql)) { calls.updates.push(JSON.parse(params[0])); return { rows: [] }; }
        if (/FROM user_settings s/.test(sql)) { calls.selects++; return { rows: [row] }; }
        if (/low_balance_floor IS NOT NULL/.test(sql)) return { rows: [] };
        throw new Error("unexpected query: " + sql.slice(0, 60));
      },
    };
  }
  const row = (over = {}) => ({
    cash_alert_enabled: true, cash_alert_threshold: "500.00", cash_alert_horizon_days: 14,
    cash_alert_state: null, cash_alerts_checked_at: null, balances_at: hoursAgo(2), data_at: hoursAgo(2), ...over,
  });
  const breachOn = (date) => ({ projection: [{ date: "2026-03-11", balance: 900 }, { date, balance: 497 }], lowest: { date, balance: 497 } });
  const clearForecast = { projection: [{ date: "2026-03-11", balance: 503 }], lowest: { date: "2026-03-11", balance: 503 } };
  function deps(forecast) {
    const sent = [];
    return { sent, forecast: async () => forecast, sendToAll: async (p) => { sent.push(p); return { logged: true }; }, sendEmail: async () => ({}), sentRecently: async () => false };
  }
  const run = (pool, d) => ca.runCashAlerts(pool, { now: NOW, today: TODAY, deps: d });

  it("F11: notify → clear → the dip comes back 5 hours later: held, not a second alert", async () => {
    const first = deps(breachOn("2026-03-14"));
    const p1 = fakePool(row());
    assert.equal((await run(p1, first)).status, "notified");
    const afterNotify = p1.calls.updates[0];

    const p2 = fakePool(row({ cash_alert_state: afterNotify }));
    assert.equal((await run(p2, deps(clearForecast))).status, "clear");
    const afterClear = p2.calls.updates[0];
    assert.equal(afterClear.alert, null);
    assert.deepEqual(afterClear.last_notified, { breach_date: "2026-03-14", notified_at: NOW.toISOString() });

    const again = deps(breachOn("2026-03-14"));
    const p3 = fakePool(row({ cash_alert_state: { ...afterClear, last_notified: { ...afterClear.last_notified, notified_at: hoursAgo(5).toISOString() } } }));
    assert.equal((await run(p3, again)).status, "held");
    assert.equal(again.sent.length, 0);
    assert.ok(p3.calls.updates[0].last_notified, "the memory survives a held check");
  });

  it("F11: after a clear, a dip 72 h later — or 3+ days earlier — notifies", async () => {
    const lateState = { alert: null, last_notified: { breach_date: "2026-03-14", notified_at: hoursAgo(73).toISOString() } };
    const late = deps(breachOn("2026-03-14"));
    assert.equal((await run(fakePool(row({ cash_alert_state: lateState })), late)).status, "notified");
    const earlierState = { alert: null, last_notified: { breach_date: "2026-03-15", notified_at: hoursAgo(5).toISOString() } };
    const earlier = deps(breachOn("2026-03-12"));
    assert.equal((await run(fakePool(row({ cash_alert_state: earlierState })), earlier)).status, "notified");
  });

  it("F12: after invalidate() a check earlier today with nothing new still evaluates — once", async () => {
    const r0 = row({ cash_alerts_checked_at: hoursAgo(1), data_at: hoursAgo(3) });
    assert.equal((await run(fakePool(r0), deps(clearForecast))).status, "unchanged");
    ca.invalidate();
    assert.equal((await run(fakePool(r0), deps(clearForecast))).status, "clear", "the setting changed → evaluated");
    assert.equal((await run(fakePool(r0), deps(clearForecast))).status, "unchanged", "the force is used up");
  });

  it("F12: a forced evaluation that throws keeps the force for the next tick", async () => {
    const r0 = row({ cash_alerts_checked_at: hoursAgo(1), data_at: hoursAgo(3) });
    ca.invalidate();
    const boom = { ...deps(clearForecast), forecast: async () => { throw new Error("db down"); } };
    await assert.rejects(run(fakePool(r0), boom));
    assert.equal((await run(fakePool(r0), deps(clearForecast))).status, "clear");
  });
});

// ---------------------------------------------------------------------------
describe("F13 — documents.csv: the dismissed day in APP_TIMEZONE", () => {
  it("a form dismissed at 8pm Pacific on Mar 14 (03:00 UTC Mar 15) is listed as dismissed 2026-03-14", () => {
    const csv = pkg.documentsCsv({ ok: true, documents: [
      { form: "1099-INT", issuer: "Ally", expected_by: "2026-01-31", received_at: null, dismissed_at: new Date("2026-03-15T03:00:00Z"), state: "dismissed", origin: "suggested", notes: null },
    ] });
    const line = csv.split(/\r?\n/)[1];
    assert.match(line, /,2026-03-14,"dismissed",/);
  });
});

describe("F14 — a tax document id beyond int4 is refused before any query", () => {
  it("PATCH / DELETE with id 2147483648 → 400 and no database call", async () => {
    let calls = 0;
    dbModule.pool.query = async () => { calls++; return { rows: [] }; };
    const app = express(); app.use(express.json()); app.use(require("../teller/routes/tax"));
    await supertest(app).patch("/api/tax/documents/2147483648").send({ received: true }).expect(400);
    await supertest(app).delete("/api/tax/documents/9999999999").expect(400);
    assert.equal(calls, 0);
    dbModule.pool.query = async () => ({ rows: [], rowCount: 0 });
    await supertest(app).patch("/api/tax/documents/2147483647").send({ received: true }).expect(404);
  });
});
