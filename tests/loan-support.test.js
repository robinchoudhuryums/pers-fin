// ============================================================================
// Auto-loan support — loan accounts as first-class debt
// ============================================================================
// A Plaid-linked credit-union auto loan lands in linked_accounts with
// type='loan'. These tests pin: the payoff math (computeLoanPayoff), the
// manual APR/monthly_payment fields (Plaid Liabilities does NOT cover auto
// loans, so both are operator-entered), the dashboard's debt rendering +
// Loans group, and the debt-optimizer's loan block.

const { describe, it, before, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const { computeLoanPayoff } = require("../teller/services/projections");

// ---------------------------------------------------------------------------
// computeLoanPayoff (pure)
// ---------------------------------------------------------------------------
describe("computeLoanPayoff", () => {
  it("zero-APR loan pays off in balance/payment months with zero interest", () => {
    const p = computeLoanPayoff({ balance: 12000, aprPct: 0, monthlyPayment: 500 });
    assert.equal(p.months_to_payoff, 24);
    assert.equal(p.total_interest, 0);
    assert.match(p.payoff_date, /^\d{4}-\d{2}$/);
  });

  it("partial final payment counts as a month (1000 at 600/mo = 2 months)", () => {
    const p = computeLoanPayoff({ balance: 1000, aprPct: 0, monthlyPayment: 600 });
    assert.equal(p.months_to_payoff, 2);
  });

  it("amortizes a realistic auto loan (20k @ 6% APR, $500/mo ≈ 44 months)", () => {
    const p = computeLoanPayoff({ balance: 20000, aprPct: 6, monthlyPayment: 500 });
    assert.ok(p.months_to_payoff >= 43 && p.months_to_payoff <= 45, String(p.months_to_payoff));
    assert.ok(p.total_interest > 2000 && p.total_interest < 2600, String(p.total_interest));
    assert.equal(p.insufficient_payment, false);
  });

  it("flags a payment below the monthly interest instead of a bogus horizon", () => {
    // 20k at 12% APR = $200/mo interest; a $150 payment never touches principal.
    const p = computeLoanPayoff({ balance: 20000, aprPct: 12, monthlyPayment: 150 });
    assert.equal(p.insufficient_payment, true);
    assert.equal(p.months_to_payoff, null);
  });

  it("higher APR strictly increases months and interest", () => {
    const lo = computeLoanPayoff({ balance: 15000, aprPct: 3, monthlyPayment: 400 });
    const hi = computeLoanPayoff({ balance: 15000, aprPct: 9, monthlyPayment: 400 });
    assert.ok(hi.months_to_payoff > lo.months_to_payoff);
    assert.ok(hi.total_interest > lo.total_interest);
  });

  it("degenerate inputs return the empty shape", () => {
    assert.equal(computeLoanPayoff({ balance: 0, aprPct: 5, monthlyPayment: 100 }).months_to_payoff, null);
    assert.equal(computeLoanPayoff({ balance: 1000, aprPct: 5, monthlyPayment: 0 }).months_to_payoff, null);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/accounts/:id — monthly_payment field (behavioral)
// ---------------------------------------------------------------------------
describe("PATCH /api/accounts/:id monthly_payment", () => {
  const supertest = require("supertest");
  const express = require("express");
  let dbModule, originalPoolQuery, app;

  before(() => {
    dbModule = require("../teller/services/database");
    originalPoolQuery = dbModule.pool.query;
    app = express();
    app.use(express.json());
    app.use(require("../teller/routes/enrollments"));
  });
  afterEach(() => { dbModule.pool.query = originalPoolQuery; });

  it("rejects non-positive and non-numeric payments", async () => {
    dbModule.pool.query = async () => { throw new Error("should not reach the DB"); };
    await supertest(app).patch("/api/accounts/1").send({ monthly_payment: -50 }).expect(400);
    await supertest(app).patch("/api/accounts/1").send({ monthly_payment: 0 }).expect(400);
    await supertest(app).patch("/api/accounts/1").send({ monthly_payment: "junk" }).expect(400);
  });

  it("accepts a valid payment and null-to-clear", async () => {
    const captured = [];
    dbModule.pool.query = async (sql, params) => { captured.push(params); return { rows: [{ id: 1 }] }; };
    await supertest(app).patch("/api/accounts/1").send({ monthly_payment: 487.5 }).expect(200);
    assert.equal(captured[0][0], 487.5);
    await supertest(app).patch("/api/accounts/1").send({ monthly_payment: null }).expect(200);
    assert.equal(captured[1][0], null);
  });

  it("apr and monthly_payment can be set together", async () => {
    let sql;
    dbModule.pool.query = async (s, params) => { sql = s; return { rows: [{ id: 1 }] }; };
    await supertest(app).patch("/api/accounts/1").send({ apr: 5.99, monthly_payment: 480 }).expect(200);
    assert.match(sql, /apr = \$1/);
    assert.match(sql, /monthly_payment = \$2/);
  });
});

// ---------------------------------------------------------------------------
// POST /api/accounts/manual — loan type (behavioral)
// ---------------------------------------------------------------------------
describe("manual loan accounts", () => {
  const supertest = require("supertest");
  const express = require("express");
  let dbModule, originalPoolQuery, app;

  before(() => {
    dbModule = require("../teller/services/database");
    originalPoolQuery = dbModule.pool.query;
    app = express();
    app.use(express.json());
    app.use(require("../teller/routes/enrollments"));
  });
  afterEach(() => { dbModule.pool.query = originalPoolQuery; });

  it("accepts type=loan with an auto subtype default", async () => {
    let captured;
    dbModule.pool.query = async (sql, params) => { captured = params; return { rows: [{ id: 9 }] }; };
    await supertest(app).post("/api/accounts/manual")
      .send({ name: "AACU Auto Loan", type: "loan", current_balance: 18500 })
      .expect(200);
    assert.equal(captured[2], "loan");
    assert.equal(captured[3], "auto", "loan subtype defaults to auto");
  });

  it("still rejects unknown types", async () => {
    dbModule.pool.query = async () => { throw new Error("should not reach the DB"); };
    await supertest(app).post("/api/accounts/manual").send({ name: "X", type: "mortgage" }).expect(400);
  });
});

// ---------------------------------------------------------------------------
// Integration pins (source-read)
// ---------------------------------------------------------------------------
describe("loan support integration pins", () => {
  it("migration adds monthly_payment idempotently", () => {
    assert.match(read("teller", "services", "database.js"),
      /ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS monthly_payment NUMERIC\(12,2\)/);
  });

  it("GET /api/accounts returns monthly_payment", () => {
    assert.match(read("teller", "routes", "enrollments.js"), /la\.monthly_payment,/);
  });

  it("dashboard treats loans as debt (negative balance, own Loans group)", () => {
    const src = read("teller", "views", "dashboard.ejs");
    assert.match(src, /const isLoan = a\.type === 'loan';/);
    assert.match(src, /const isDebt = isCredit \|\| isLoan;/);
    assert.match(src, /const displayBal = isDebt \? -bal : bal;/,
      "an $18k auto loan must not render as +$18k green");
    assert.match(src, /groupHeader\('Loans', loanAccts\.length\)/);
    assert.match(src, /a\.type !== 'credit' && a\.type !== 'loan'/, "Other group excludes loans");
    assert.match(src, /data-payment-account/);
  });

  it("client loanPayoff mirrors the canonical iteration (parity smoke)", () => {
    const client = read("teller", "views", "dashboard.ejs");
    const server = read("teller", "services", "projections.js");
    for (const [src, expr] of [[client, "b = b + i - payment"], [server, "b = b + i - monthlyPayment"]]) {
      assert.ok(src.includes(expr), expr);
      assert.ok(src.includes("1200"), "same 100-year cap");
    }
    assert.match(client, /payment <= balance \* r/, "same insufficient-payment guard");
    assert.match(server, /monthlyPayment <= balance \* r/);
  });

  it("debt optimizer feeds loan accounts (with payoff figures) to Claude", () => {
    const src = read("teller", "routes", "insights.js");
    assert.match(src, /WHERE type = 'loan' AND current_balance IS NOT NULL/);
    assert.match(src, /Loan Accounts \(auto\/personal/);
    assert.match(src, /computeLoanPayoff/);
    assert.match(src, /Installment utilization barely affects credit scores/);
  });
});
