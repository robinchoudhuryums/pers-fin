// ============================================================================
// Financial Queries — tests for INCOME_PREDICATE, spending splits, reimbursed
// ============================================================================
// Tests the SQL fragments and helper functions in services/financial-queries.js.
// Uses a mock pool to capture SQL and verify the right clauses are used.
// Also tests the INCOME_PREDICATE regex patterns directly against PostgreSQL
// regex syntax (via a JS approximation of \y word-boundary).
// ============================================================================

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

const {
  INCOME_PREDICATE,
  SPLIT_AMOUNT,
  NOT_REIMBURSED,
  NOT_REIMBURSED_UNALIASED,
  NOT_TRANSFER,
  getMonthlySpending,
  getMonthlyIncome,
  getMonthlyIncomeAndSpending,
  getCategorySpendingThisMonth,
  currentMonth,
  todayStr,
} = require("../teller/services/financial-queries");

// ---------------------------------------------------------------------------
// Timezone helpers (F11) — APP_TIMEZONE-aware "today"/"current month"
// ---------------------------------------------------------------------------
describe("currentMonth / todayStr (tz-aware)", () => {
  it("returns YYYY-MM-DD / YYYY-MM in shape", () => {
    assert.match(todayStr(), /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
    assert.match(currentMonth(), /^\d{4}-(0[1-9]|1[0-2])$/);
    assert.equal(currentMonth(), todayStr().slice(0, 7));
  });
  it("resolves the boundary in the given zone (UTC-evening rolls forward of US-East)", () => {
    // An explicit IANA zone shifts the resolved day vs UTC. We don't pin an
    // absolute value (depends on run time), but the two zones must agree with
    // their own slice and be valid — and an invalid zone falls back to UTC.
    assert.match(todayStr("America/New_York"), /^\d{4}-\d{2}-\d{2}$/);
    assert.match(todayStr("not/a/zone"), /^\d{4}-\d{2}-\d{2}$/); // fallback, no throw
  });
});

// ---------------------------------------------------------------------------
// INCOME_PREDICATE pattern tests
// ---------------------------------------------------------------------------
// PostgreSQL \y is a word-boundary anchor equivalent to \b in PCRE.
// We approximate it in JS to test the inclusion/exclusion keywords.
function pgRegexMatch(text, pattern) {
  // Convert PG \y to JS \b for testing
  const jsPattern = pattern.replace(/\\y/g, "\\b");
  return new RegExp(jsPattern, "i").test(text);
}

// Extract the inclusion and exclusion patterns from INCOME_PREDICATE
const inclMatch = INCOME_PREDICATE.match(/~\*\s*'([^']+)'/);
const exclMatch = INCOME_PREDICATE.match(/!~\*\s*'([^']+)'/);
const INCL_PATTERN = inclMatch ? inclMatch[1] : "";
const EXCL_PATTERN = exclMatch ? exclMatch[1] : "";

describe("INCOME_PREDICATE — inclusion keywords", () => {
  it("matches 'payroll' as a whole word", () => {
    assert.ok(pgRegexMatch("ADP PAYROLL", INCL_PATTERN));
    assert.ok(pgRegexMatch("payroll deposit", INCL_PATTERN));
  });

  it("matches 'direct dep' as a phrase", () => {
    assert.ok(pgRegexMatch("DIRECT DEP EMPLOYER INC", INCL_PATTERN));
    assert.ok(pgRegexMatch("direct dep", INCL_PATTERN));
  });

  it("matches 'salary' as a whole word", () => {
    assert.ok(pgRegexMatch("Monthly Salary", INCL_PATTERN));
  });

  it("matches 'employer' as a whole word", () => {
    assert.ok(pgRegexMatch("EMPLOYER DEPOSIT", INCL_PATTERN));
  });

  it("does NOT substring-match 'payroll' inside other words", () => {
    // \y should prevent matching inside longer words
    assert.ok(!pgRegexMatch("nonpayrollservice", INCL_PATTERN));
  });

  it("does NOT match random merchant names", () => {
    assert.ok(!pgRegexMatch("Amazon.com", INCL_PATTERN));
    assert.ok(!pgRegexMatch("Netflix", INCL_PATTERN));
    assert.ok(!pgRegexMatch("Costco Wholesale", INCL_PATTERN));
  });
});

describe("INCOME_PREDICATE — exclusion keywords", () => {
  it("excludes 'payment' as a whole word", () => {
    assert.ok(pgRegexMatch("CREDIT CARD PAYMENT", EXCL_PATTERN));
    assert.ok(pgRegexMatch("Loan Payment", EXCL_PATTERN));
  });

  it("excludes 'transfer' as a whole word", () => {
    assert.ok(pgRegexMatch("FUNDS TRANSFER", EXCL_PATTERN));
  });

  it("excludes 'zelle' and 'venmo'", () => {
    assert.ok(pgRegexMatch("Zelle payment from John", EXCL_PATTERN));
    assert.ok(pgRegexMatch("Venmo Credit", EXCL_PATTERN));
  });

  it("excludes 'refund' and 'reversal'", () => {
    assert.ok(pgRegexMatch("Refund - Amazon", EXCL_PATTERN));
    assert.ok(pgRegexMatch("REVERSAL FEE", EXCL_PATTERN));
  });

  it("does NOT exclude legitimate merchants with embedded exclusion words", () => {
    // \y word boundary should prevent "credit" from matching "discredit"
    assert.ok(!pgRegexMatch("Discredit", EXCL_PATTERN));
  });
});

describe("INCOME_PREDICATE — combined logic", () => {
  // A merchant that matches inclusion AND exclusion should be excluded.
  // Example: "Employer Payment" matches 'employer' (income) but also 'payment' (exclusion)
  it("Employer Payment should match inclusion AND exclusion (net: excluded)", () => {
    assert.ok(pgRegexMatch("Employer Payment", INCL_PATTERN), "should match income keyword");
    assert.ok(pgRegexMatch("Employer Payment", EXCL_PATTERN), "should match exclusion keyword");
    // In SQL: matches income predicate but then fails the NOT exclusion → not income
  });

  it("ADP Payroll should match inclusion and NOT exclusion (net: income)", () => {
    assert.ok(pgRegexMatch("ADP Payroll", INCL_PATTERN));
    assert.ok(!pgRegexMatch("ADP Payroll", EXCL_PATTERN));
  });
});

describe("INCOME_PREDICATE — expanded keywords", () => {
  it("matches 'deposit' as a whole word", () => {
    assert.ok(pgRegexMatch("ACH DEPOSIT", INCL_PATTERN));
    assert.ok(pgRegexMatch("DEPOSIT FROM EMPLOYER", INCL_PATTERN));
  });

  it("matches 'direct deposit' (two-word phrase)", () => {
    assert.ok(pgRegexMatch("DIRECT DEPOSIT EMPLOYER INC", INCL_PATTERN));
  });

  it("matches 'ach credit'", () => {
    assert.ok(pgRegexMatch("ACH CREDIT FROM EMPLOYER", INCL_PATTERN));
  });

  it("does NOT match ATM deposits (excluded by 'atm')", () => {
    assert.ok(pgRegexMatch("ATM DEPOSIT", EXCL_PATTERN), "ATM should trigger exclusion");
  });
});

// Extract NOT_TRANSFER pattern for testing
const transferMatch = NOT_TRANSFER.match(/!~\*\s*'([^']+)'/);
const TRANSFER_PATTERN = transferMatch ? transferMatch[1] : "";

describe("NOT_TRANSFER — credit card payment exclusion", () => {
  it("excludes 'Chase' standalone (not just 'Chase Bank')", () => {
    assert.ok(pgRegexMatch("Chase", TRANSFER_PATTERN));
    assert.ok(pgRegexMatch("CHASE PAYMENT", TRANSFER_PATTERN));
  });

  it("excludes 'Discover'", () => {
    assert.ok(pgRegexMatch("Discover", TRANSFER_PATTERN));
    assert.ok(pgRegexMatch("DISCOVER CARD PAYMENT", TRANSFER_PATTERN));
  });

  it("excludes 'Capital One'", () => {
    assert.ok(pgRegexMatch("CAPITAL ONE MOBILE PAYMENT", TRANSFER_PATTERN));
    assert.ok(pgRegexMatch("Capital One", TRANSFER_PATTERN));
  });

  it("excludes 'American Express' and 'Amex'", () => {
    assert.ok(pgRegexMatch("AMERICAN EXPRESS PAYMENT", TRANSFER_PATTERN));
    assert.ok(pgRegexMatch("AMEX PAYMENT", TRANSFER_PATTERN));
  });

  it("excludes 'Wells Fargo'", () => {
    assert.ok(pgRegexMatch("WELLS FARGO", TRANSFER_PATTERN));
  });

  it("excludes Zelle, Venmo, PayPal", () => {
    assert.ok(pgRegexMatch("ZELLE TRANSFER", TRANSFER_PATTERN));
    assert.ok(pgRegexMatch("Venmo Payment", TRANSFER_PATTERN));
    assert.ok(pgRegexMatch("PayPal Transfer", TRANSFER_PATTERN));
  });

  it("does NOT exclude legitimate merchants", () => {
    assert.ok(!pgRegexMatch("Amazon.com", TRANSFER_PATTERN));
    assert.ok(!pgRegexMatch("Costco Wholesale", TRANSFER_PATTERN));
    assert.ok(!pgRegexMatch("Netflix", TRANSFER_PATTERN));
    assert.ok(!pgRegexMatch("Starbucks", TRANSFER_PATTERN));
  });
});

describe("getMonthlySpending applies NOT_TRANSFER", () => {
  it("SQL includes the transfer exclusion", async () => {
    let capturedSql = "";
    const mockPool = {
      query: async (sql) => { capturedSql = sql; return { rows: [] }; },
    };
    await getMonthlySpending(mockPool, 3);
    assert.ok(capturedSql.includes("!~*"), "spending query should use regex exclusion");
    assert.ok(capturedSql.includes("chase"), "spending query should exclude Chase");
    assert.ok(capturedSql.includes("discover"), "spending query should exclude Discover");
  });
});

// ---------------------------------------------------------------------------
// SQL fragment tests — verify the fragments contain expected patterns
// ---------------------------------------------------------------------------
describe("SQL fragments", () => {
  it("INCOME_PREDICATE uses \\y word boundaries (not LIKE)", () => {
    assert.ok(INCOME_PREDICATE.includes("~*"), "should use ~* regex operator");
    assert.ok(INCOME_PREDICATE.includes("\\y"), "should use \\y word boundary");
    assert.ok(!INCOME_PREDICATE.includes("LIKE"), "should NOT use LIKE");
    assert.ok(!INCOME_PREDICATE.includes("SIMILAR TO"), "should NOT use SIMILAR TO");
  });

  it("SPLIT_AMOUNT applies spending_split_pct", () => {
    assert.ok(SPLIT_AMOUNT.includes("spending_split_pct"));
    assert.ok(SPLIT_AMOUNT.includes("COALESCE"));
    assert.ok(SPLIT_AMOUNT.includes("100"));
  });

  it("NOT_REIMBURSED excludes reimbursed transactions", () => {
    assert.ok(NOT_REIMBURSED.includes("is_reimbursed"));
    assert.ok(NOT_REIMBURSED.includes("false"));
  });

  it("NOT_REIMBURSED_UNALIASED has no table alias prefix", () => {
    assert.ok(!NOT_REIMBURSED_UNALIASED.includes("t."));
  });
});

// ---------------------------------------------------------------------------
// Mock pool query capture tests — verify SQL construction
// ---------------------------------------------------------------------------
describe("getMonthlySpending", () => {
  it("queries with spending_split_pct, reimbursed filter, and months param", async () => {
    let capturedSql = "", capturedParams = [];
    const mockPool = {
      query: async (sql, params) => {
        capturedSql = sql;
        capturedParams = params;
        return { rows: [{ month: "2026-03", total_spend: "1500.00", txn_count: 42 }] };
      },
    };
    const result = await getMonthlySpending(mockPool, 3);
    assert.ok(capturedSql.includes("spending_split_pct"), "SQL should apply spending split");
    assert.ok(capturedSql.includes("is_reimbursed"), "SQL should exclude reimbursed");
    assert.ok(capturedSql.includes("make_interval"), "SQL should use make_interval for months");
    // F11: anchor is now the tz-aware current month passed as $2 (was UTC CURRENT_DATE).
    assert.equal(capturedParams[0], 3);
    assert.match(capturedParams[1], /^\d{4}-(0[1-9]|1[0-2])-01$/);
    assert.equal(result[0].month, "2026-03");
  });
});

describe("getMonthlyIncome", () => {
  it("queries with INCOME_PREDICATE and months param", async () => {
    let capturedSql = "";
    const mockPool = {
      query: async (sql, params) => {
        capturedSql = sql;
        return { rows: [{ month: "2026-03", total_income: "5000.00" }] };
      },
    };
    const result = await getMonthlyIncome(mockPool, 6);
    assert.ok(capturedSql.includes("~*"), "SQL should use regex income predicate");
    assert.ok(capturedSql.includes("payroll"), "SQL should match payroll keyword");
    assert.ok(capturedSql.includes("amount < 0"), "Income transactions have negative amounts");
    assert.equal(result[0].total_income, "5000.00");
  });
});

describe("getMonthlyIncomeAndSpending", () => {
  it("merges income and spending by month", async () => {
    let callCount = 0;
    const mockPool = {
      query: async (sql) => {
        callCount++;
        if (sql.includes("amount < 0")) {
          // Income query
          return { rows: [
            { month: "2026-01", total_income: "5000" },
            { month: "2026-02", total_income: "5200" },
          ] };
        }
        // Spending query
        return { rows: [
          { month: "2026-01", total_spend: "3000", txn_count: 50 },
          { month: "2026-02", total_spend: "3500", txn_count: 60 },
          { month: "2026-03", total_spend: "2000", txn_count: 30 },
        ] };
      },
    };
    const result = await getMonthlyIncomeAndSpending(mockPool, 3);
    assert.equal(callCount, 2, "should make 2 queries (income + spending)");
    assert.equal(result.length, 3, "should have 3 months (union of both sets)");
    // 2026-01: both
    assert.equal(result[0].income, 5000);
    assert.equal(result[0].spending, 3000);
    // 2026-03: spending only
    assert.equal(result[2].income, 0, "missing income month should default to 0");
    assert.equal(result[2].spending, 2000);
  });
});

describe("getCategorySpendingThisMonth", () => {
  it("uses parent_no_splits and from_splits CTEs", async () => {
    let capturedSql = "";
    const mockPool = {
      query: async (sql) => {
        capturedSql = sql;
        return { rows: [
          { category: "Food & Drink", spent: "250.00" },
          { category: "Shopping", spent: "100.00" },
        ] };
      },
    };
    const result = await getCategorySpendingThisMonth(mockPool);
    assert.ok(capturedSql.includes("parent_no_splits"), "should have parent_no_splits CTE");
    assert.ok(capturedSql.includes("from_splits"), "should have from_splits CTE");
    assert.ok(capturedSql.includes("transaction_splits"), "should join transaction_splits");
    assert.ok(capturedSql.includes("spending_split_pct"), "should apply spending split");
    assert.ok(capturedSql.includes("is_reimbursed"), "should exclude reimbursed");
    assert.equal(result.length, 2);
    assert.equal(result[0].category, "Food & Drink");
  });
});
