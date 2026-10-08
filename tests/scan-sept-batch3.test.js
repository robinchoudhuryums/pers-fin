// ============================================================================
// Broad-scan (Sept 2026) Batch 3 regression tests — income/spending
// classification (Perfin)
// ============================================================================
// FAN-2  INCOME_PREDICATE's brokerage double-count guard references the OUTER
//        row (incomePredicate(alias) qualifies every outer column)
// DD-2   keyword matching reads the raw description as well as the merchant
// DD-3   Plaid personal_finance_category: INCOME counts as income, TRANSFER_* /
//        LOAN_PAYMENTS are excluded from spending, and a free PFC→category map
// FAN-5  cash-flow starting balance = depository cash only
// DD-4   cash-flow: subscriptions out of the daily average; card autopays not
//        billed on top of the card spending they pay off
// FAN-6  spending-summary averages over whole, COMPLETED months
// DC-12  Teller map: accommodation → Travel, loan → Transfer
// DC-13  implicit "remember" rules default to exact match
// DC-14  CSV / manual categories passed as text[] parameters
// AIN-13 Ask's search total applies the dashboard spending filters
// (The SQL itself is also exercised against real Postgres — see the Batch 3
//  summary block; these tests pin the construction and route behavior.)
// ============================================================================

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
afterEach(() => { dbModule.pool.query = originalQuery; });

const fq = require("../teller/services/financial-queries");
const helpers = require("../teller/routes/categorize-helpers");

function mountApp(mod) {
  const app = express();
  app.use(express.json());
  app.use(require(mod));
  return app;
}

// ---------------------------------------------------------------------------
// FAN-2 / DD-2 / DD-3 — income predicate
// ---------------------------------------------------------------------------
describe("FAN-2 — the brokerage double-count guard references the OUTER row", () => {
  it("every outer reference inside the __t2 subquery carries the caller's alias", () => {
    const p = fq.incomePredicate("t");
    assert.match(p, /__t2\.account_id <> t\.account_id/);
    assert.match(p, /__t2\.amount = ABS\(t\.amount\)/);
    assert.match(p, /t\.date - INTERVAL '2 days' AND t\.date \+ INTERVAL '2 days'/);
    // The pre-fix form self-compared __t2 (bare account_id resolved to __t2).
    assert.doesNotMatch(p, /<> account_id/);
    assert.doesNotMatch(p, /ABS\(amount\)/);
  });

  it("INCOME_PREDICATE (unaliased callers) qualifies with the bare table name", () => {
    assert.match(fq.INCOME_PREDICATE, /__t2\.account_id <> transactions\.account_id/);
    assert.equal(fq.INCOME_PREDICATE, fq.incomePredicate("transactions"));
  });
});

describe("DD-2 — keyword matching reads the raw description too", () => {
  it("income matches user_merchant_name, merchant_name AND name together", () => {
    assert.match(fq.incomePredicate("t"), /CONCAT_WS\(' ', t\.user_merchant_name, t\.merchant_name, t\.name\) ~\*/);
  });
  it("NOT_TRANSFER reads merchant + raw description when the user hasn't renamed", () => {
    assert.match(fq.NOT_TRANSFER, /COALESCE\(t\.user_merchant_name, CONCAT_WS\(' ', t\.merchant_name, t\.name\)\) !~\*/);
  });
});

describe("DD-3 — Plaid personal_finance_category", () => {
  it("INCOME primary counts as income unless the user set a category; branch (c) is case-insensitive", () => {
    const p = fq.incomePredicate("t");
    assert.match(p, /t\.user_category IS NULL AND t\.personal_finance_category->>'primary' = 'INCOME'/);
    assert.match(p, /LOWER\(COALESCE\(t\.user_category, t\.category\[1\], ''\)\) = 'income'/);
  });
  it("TRANSFER_* / LOAN_PAYMENTS are excluded from spending unless re-categorized by the user", () => {
    assert.match(fq.NOT_TRANSFER, /IN \('TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS'\)/);
    assert.match(fq.NOT_TRANSFER, /COALESCE\(t\.user_category, 'Transfer'\) = 'Transfer'/);
  });
  it("NOT_TRANSFER stays a single parenthesized boolean (safe after AND, and for the t→t2 derivation)", () => {
    assert.ok(fq.NOT_TRANSFER.trim().startsWith("(") && fq.NOT_TRANSFER.trim().endsWith(")"));
    assert.doesNotMatch(fq.NOT_TRANSFER.replace(/\bt\./g, "t2."), /[^2]\bt\./);
  });

  it("mapCategoryFor: Teller category first, then PFC detailed over primary", () => {
    assert.equal(helpers.mapCategoryFor({ category: ["dining"] }), "Food & Drink");
    assert.equal(helpers.mapCategoryFor({ category: ["Food and Drink"], personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_GROCERIES" } }), "Groceries");
    assert.equal(helpers.mapCategoryFor({ personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_RESTAURANT" } }), "Food & Drink");
    assert.equal(helpers.mapCategoryFor({ personal_finance_category: '{"primary":"TRANSFER_OUT"}' }), "Transfer", "JSON-string PFC is parsed");
    assert.equal(helpers.mapCategoryFor({ personal_finance_category: { primary: "GENERAL_SERVICES", detailed: "GENERAL_SERVICES_OTHER_GENERAL_SERVICES" } }), null, "ambiguous primary left to rules/AI");
  });
  it("every PFC target is one of our categories", () => {
    for (const v of [...Object.values(helpers.PLAID_PFC_DETAILED_MAP), ...Object.values(helpers.PLAID_PFC_PRIMARY_MAP)]) {
      assert.ok(helpers.CATEGORIES.includes(v), v);
    }
  });

  it("runCategorize runs the PFC map and the credit→Income pass before any AI call", async () => {
    const sqls = [];
    dbModule.pool.query = async (sql) => {
      sqls.push(sql);
      if (/SELECT COUNT\(\*\) AS uncategorized/.test(sql)) return { rows: [{ uncategorized: 0 }] };
      if (/RETURNING transaction_id/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [] };
    };
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = savedKey || "test-key";
    try {
      delete require.cache[require.resolve("../teller/routes/categorize")];
      const { runCategorize } = require("../teller/routes/categorize");
      const out = await runCategorize();
      if (out.status === 501) return; // SDK not installed in this environment — nothing to assert
      assert.ok(sqls.some(s => /user_category_source = 'plaid_map'[\s\S]*personal_finance_category->>'detailed' = \$2/.test(s)), "detailed PFC pass");
      assert.ok(sqls.some(s => /user_category_source = 'plaid_map'[\s\S]*personal_finance_category->>'primary' = \$2/.test(s)), "primary PFC pass");
      const credit = sqls.find(s => /SET user_category = 'Income'/.test(s));
      assert.ok(credit, "credit→Income pass runs");
      assert.match(credit, /amount < 0/);
      assert.match(credit, /LOWER\(category\[1\]\) = 'income' OR personal_finance_category->>'primary' = 'INCOME'/);
    } finally {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });
});

// ---------------------------------------------------------------------------
// FAN-5 / DD-4 — cash-flow
// ---------------------------------------------------------------------------
describe("FAN-5 / DD-4 — cash-flow forecast", () => {
  function cashFlowPool(sqls) {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    return async (sql) => {
      sqls.push(sql);
      if (/FROM recurring_transfers/.test(sql)) {
        return { rows: [
          { display_name: "CHASE CREDIT CARD AUTOPAY", amount: "2000", cadence_days: 30, next_expected: tomorrow, transfer_type: "bill_payment", direction: "outgoing" },
          { display_name: "AUTO LOAN PAYMENT", amount: "300", cadence_days: 30, next_expected: tomorrow, transfer_type: "bill_payment", direction: "outgoing" },
        ] };
      }
      if (/AS cash/.test(sql)) return { rows: [{ cash: "5000", debt: "0" }] };
      return { rows: [] };
    };
  }

  it("card autopays are not billed on top of card spending; loan payments still are (DD-4)", async () => {
    const sqls = [];
    dbModule.pool.query = cashFlowPool(sqls);
    const res = await supertest(mountApp("../teller/routes/spending-analytics")).get("/api/cash-flow?days=30").expect(200);
    assert.equal(res.body.total_projected_bills, 300, "only the loan payment is billed (was 2300)");
  });

  it("the daily-average queries exclude active subscription merchants (DD-4)", async () => {
    const sqls = [];
    dbModule.pool.query = cashFlowPool(sqls);
    await supertest(mountApp("../teller/routes/spending-analytics")).get("/api/cash-flow?days=30").expect(200);
    const avgQueries = sqls.filter(s => /INTERVAL '60 days'/.test(s) && /daily_total/.test(s));
    assert.equal(avgQueries.length, 2);
    for (const q of avgQueries) assert.match(q, /NOT EXISTS \(\s*SELECT 1 FROM detected_subscriptions ds[\s\S]*ds\.merchant_key = COALESCE\(t\.user_merchant_name, t\.merchant_name, LOWER/);
  });

  it("starting balance counts depository, non-investment accounts only (FAN-5)", async () => {
    const sqls = [];
    dbModule.pool.query = cashFlowPool(sqls);
    await supertest(mountApp("../teller/routes/spending-analytics")).get("/api/cash-flow?days=30").expect(200);
    const bal = sqls.find(s => /AS cash/.test(s));
    assert.match(bal, /la\.type = 'depository' AND NOT \(\s*la\.type = 'investment'/);
    assert.doesNotMatch(bal, /type != 'credit'/, "loans were counted as cash");
  });
});

// ---------------------------------------------------------------------------
// FAN-6 — spending-summary averages
// ---------------------------------------------------------------------------
describe("FAN-6 — spending-summary averages over whole, completed months", () => {
  it("excludes the month-to-date current month and uses real month lengths", async () => {
    const cur = fq.currentMonth();
    let trendSql = null, trendParams = null;
    dbModule.pool.query = async (sql, params) => {
      if (/AS avg_transaction/.test(sql)) {
        trendSql = sql; trendParams = params;
        return { rows: [
          { month: cur, total_spend: "500.00", txn_count: 5, avg_transaction: "100" },
          { month: "2026-02", total_spend: "2800.00", txn_count: 20, avg_transaction: "140" },
          { month: "2026-01", total_spend: "3100.00", txn_count: 22, avg_transaction: "141" },
        ] };
      }
      return { rows: [] };
    };
    const res = await supertest(mountApp("../teller/routes/spending-analytics")).get("/api/spending-summary?months=6").expect(200);
    assert.match(trendSql, /date_trunc\('month', \$2::date\) - make_interval\(months => \$1 - 1\)/, "whole-month floor, not a rolling window");
    assert.deepEqual(trendParams, [6, cur + "-01"]);
    assert.equal(res.body.avg_months, 2, "current month excluded");
    assert.equal(res.body.avg_monthly_spend, 2950);
    assert.equal(res.body.avg_daily_spend, Math.round((5900 / (28 + 31)) * 100) / 100, "Feb 2026 has 28 days, Jan 31");
    assert.equal(res.body.monthly_trend.length, 3, "the table still shows the current month");
  });

  it("the dashboard reads the server averages instead of dividing by the bucket count", () => {
    const dash = read("teller", "views", "dashboard.ejs");
    assert.match(dash, /data\.avg_monthly_spend/);
    assert.doesNotMatch(dash, /data\.monthly_trend\.length \* 30/);
  });
});

// ---------------------------------------------------------------------------
// DC-12 / DC-13 / DC-14
// ---------------------------------------------------------------------------
describe("DC-12 — Teller map misroutes", () => {
  it("accommodation (lodging) → Travel, loan → Transfer", () => {
    assert.equal(helpers.TELLER_CATEGORY_MAP.accommodation, "Travel");
    assert.equal(helpers.TELLER_CATEGORY_MAP.loan, "Transfer");
  });
});

describe("DC-13 — implicit 'remember' rules default to exact match", () => {
  function rulePool(captured) {
    return async (sql, params) => {
      if (/INSERT INTO categorization_rules/.test(sql)) { captured.push(params); return { rows: [{ id: 1 }] }; }
      if (/UPDATE transactions SET user_category/.test(sql)) return { rows: [{ transaction_id: "tx1", merchant: "ARCO" }] };
      if (/SELECT COALESCE\(user_merchant_name, merchant_name, name\) AS merchant/.test(sql)) return { rows: [{ merchant: "ARCO" }] };
      return { rows: [] };
    };
  }
  it("POST /api/categorize/review with create_rule and no match_type → exact", async () => {
    const captured = [];
    dbModule.pool.query = rulePool(captured);
    await supertest(mountApp("../teller/routes/categorize")).post("/api/categorize/review")
      .send({ transaction_id: "tx1", category: "Gas & Fuel", create_rule: true }).expect(200);
    assert.equal(captured[0][2], "exact");
  });
  it("POST /api/categorization-rules/from-transaction without match_type → exact", async () => {
    const captured = [];
    dbModule.pool.query = rulePool(captured);
    await supertest(mountApp("../teller/routes/categorize")).post("/api/categorization-rules/from-transaction")
      .send({ transaction_id: "tx1", category: "Gas & Fuel" }).expect(200);
    assert.equal(captured[0][2], "exact");
  });
  it("an explicit match_type is still honored; the explicit rules API keeps its contains default", async () => {
    const captured = [];
    dbModule.pool.query = rulePool(captured);
    await supertest(mountApp("../teller/routes/categorize")).post("/api/categorize/review")
      .send({ transaction_id: "tx1", category: "Gas & Fuel", create_rule: true, match_type: "starts_with" }).expect(200);
    assert.equal(captured[0][2], "starts_with");
    assert.match(read("teller", "routes", "categorize.js"), /const type = validTypes\.includes\(match_type\) \? match_type : "contains";/);
  });
  it("the accuracy-review remember path and the dashboard widget use exact", () => {
    const src = read("teller", "routes", "categorize.js");
    assert.match(src, /VALUES \(\$1, \$2, 'exact'\)/);
    assert.doesNotMatch(src, /VALUES \(\$1, \$2, 'contains'\)/);
    assert.match(read("teller", "views", "dashboard.ejs"), /match_type: 'exact'/);
  });
});

describe("DC-14 — categories are text[] parameters, never concatenated literals", () => {
  it("manual cash entry passes a one-element array (commas/quotes survive)", async () => {
    let params = null;
    dbModule.pool.query = async (sql, p) => {
      if (/SELECT account_id, is_manual FROM linked_accounts/.test(sql)) return { rows: [{ account_id: "cash", is_manual: true }] };
      if (/INSERT INTO transactions/.test(sql)) { params = p; return { rows: [{}] }; }
      return { rows: [] };
    };
    await supertest(mountApp("../teller/routes/transactions")).post("/api/transactions/manual")
      .send({ account_id: "cash", amount: 5, date: "2026-06-01", category: 'Travel, "Air"' }).expect(200);
    assert.deepEqual(params[5], ['Travel, "Air"']);
  });
  it("the CSV import route passes [category] like the CLI", () => {
    const src = read("teller", "routes", "subscriptions.js");
    assert.match(src, /parsed\.category \? \[String\(parsed\.category\)\] : null/);
    assert.doesNotMatch(src, /`\{\$\{parsed\.category\}\}`/);
  });
});

// ---------------------------------------------------------------------------
// AIN-13 — Ask search total
// ---------------------------------------------------------------------------
describe("AIN-13 — Ask search_transactions total uses the dashboard spending filters", () => {
  it("the total excludes transfers + reimbursed; the count matches the listed rows; LIKE metacharacters are escaped", async () => {
    const sqls = []; let totalParams = null;
    dbModule.pool.query = async (sql, params) => {
      sqls.push(sql);
      if (/match_count/.test(sql)) { totalParams = params; return { rows: [{ match_count: "2", total_spent_adjusted: "10.00" }] }; }
      return { rows: [] };
    };
    const { TOOL_EXECUTORS } = require("../teller/routes/ask");
    const out = await TOOL_EXECUTORS.search_transactions({ merchant: "50%_off" });
    const totals = sqls.find(s => /match_count/.test(s));
    assert.match(totals, /CASE WHEN t\.amount > 0 AND COALESCE\(t\.is_reimbursed, false\) = false AND \(/);
    assert.match(totals, /payment thank/, "NOT_TRANSFER applied to the total");
    assert.doesNotMatch(totals, /WHERE [^\n]*AND COALESCE\(t\.is_reimbursed/, "count is over the same rows as the list");
    assert.match(totals, /ILIKE \$1 ESCAPE '\\'/);
    assert.equal(totalParams[0], "%50\\%\\_off%");
    assert.match(out.note, /transfers\/card payments/);
  });
});
