// ============================================================================
// Tests for the subscription detection algorithm
// ============================================================================
// Tests the core logic: findModeAmount, gap analysis, cadence detection.
// Uses node:test (built-in, no deps needed).
// ============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// Exercise the REAL module. This file used to carry inline copies of
// findModeAmount / addDays / the gap analysis, so it kept passing on the old
// detection rules no matter what scripts/detect-subscriptions.js did (Batch 4
// DC-2/DC-7/DC-8 changed them). analyzeGroup now runs the real
// detectSubscriptions() over a mock pool that serves the given charges.
// ---------------------------------------------------------------------------
const { detectSubscriptions, findModeAmount, addDays } = require("../scripts/detect-subscriptions");

// The fixtures below are dated in 2023–2025; DC-2 (correctly) ignores a series
// whose last charge is stale, so shift every fixture so its LATEST charge was
// 5 days ago — the gaps (what's under test) are unchanged.
async function analyzeGroup(merchantTxns) {
  const ts = (d) => Date.parse(String(d).slice(0, 10) + "T00:00:00Z");
  const latest = Math.max(...merchantTxns.map(t => ts(t.date)));
  const now = new Date();
  const target = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 5 * 86400000;
  const shift = target - latest;
  const rows = merchantTxns.map((t, i) => ({
    transaction_id: "t" + i,
    merchant_key: "fixture service",
    display_name: t.display_name || "Fixture Service",
    amount: t.amount,
    date: new Date(ts(t.date) + shift).toISOString().slice(0, 10),
  }));
  const pool = {
    query: async (sql) => (/FROM transactions/.test(sql) ? { rows } : { rows: [] }),
  };
  const detected = await detectSubscriptions(pool);
  return detected[0] || null;
}

// Helper to generate monthly transactions
function monthlyCharges(merchantName, amount, count, startDate) {
  const start = new Date(startDate || "2025-01-15");
  const txns = [];
  for (let i = 0; i < count; i++) {
    const date = addDays(start, i * 30);
    txns.push({
      merchant_key: merchantName,
      display_name: merchantName,
      amount: amount,
      date: date.toISOString().split("T")[0],
    });
  }
  return txns;
}

// ============================================================================
// findModeAmount tests
// ============================================================================
describe("findModeAmount", () => {
  it("returns null for empty array", () => {
    assert.equal(findModeAmount([], 0.1), null);
  });

  it("returns the single element for a 1-element array", () => {
    assert.equal(findModeAmount([9.99], 0.1), 9.99);
  });

  it("finds the most common amount", () => {
    const amounts = [9.99, 9.99, 9.99, 14.99, 14.99];
    assert.equal(findModeAmount(amounts, 0.1), 9.99);
  });

  it("treats similar amounts as the same (within tolerance)", () => {
    // 10.00, 10.05, 10.10 are all within 10% of each other
    const amounts = [10.00, 10.05, 10.10, 25.00];
    const mode = findModeAmount(amounts, 0.1);
    assert.ok(mode >= 10.00 && mode <= 10.10, `Expected ~10.00, got ${mode}`);
  });

  it("handles price creep within tolerance", () => {
    const amounts = [14.99, 15.49, 15.99, 30.00];
    const mode = findModeAmount(amounts, 0.1);
    // 14.99 and 15.49 are within 10% of each other, as are 15.49 and 15.99
    assert.ok(mode < 20, `Expected a ~15 amount, got ${mode}`);
  });
});

// ============================================================================
// analyzeGroup (core detection) tests
// ============================================================================
describe("analyzeGroup", () => {
  it("detects a monthly subscription (3 charges, ~30 days apart)", async () => {
    const txns = monthlyCharges("Netflix", 15.99, 4);
    const result = await analyzeGroup(txns);
    assert.ok(result, "Should detect a subscription");
    assert.equal(result.cadence_days, 30);
    assert.equal(result.amount, 15.99);
  });

  it("detects a quarterly subscription (~90 days apart)", async () => {
    const start = new Date("2025-01-01");
    const txns = [0, 90, 180, 270].map((offset) => ({
      merchant_key: "quarterly_svc",
      display_name: "Quarterly Service",
      amount: 49.99,
      date: addDays(start, offset).toISOString().split("T")[0],
    }));
    const result = await analyzeGroup(txns);
    assert.ok(result, "Should detect quarterly subscription");
    assert.equal(result.cadence_days, 90);
  });

  it("rejects random non-recurring charges", async () => {
    const start = new Date("2025-01-01");
    // Gaps: 3, 15, 7, 2, 40 days — truly no consistent pattern
    const txns = [0, 3, 18, 25, 27, 67].map((offset) => ({
      merchant_key: "random_store",
      display_name: "Random Store",
      amount: 25.00,
      date: addDays(start, offset).toISOString().split("T")[0],
    }));
    const result = await analyzeGroup(txns);
    assert.equal(result, null, "Should not detect non-recurring charges");
  });

  it("rejects groups with fewer than 3 charges", async () => {
    const txns = monthlyCharges("TwoTimer", 9.99, 2);
    const result = await analyzeGroup(txns);
    assert.equal(result, null, "Should require at least 3 charges");
  });

  it("tolerates ±25% timing variance", async () => {
    const start = new Date("2025-01-15");
    // Gaps: 27, 33, 28, 32 days — all within 25% of 30
    const txns = [0, 27, 60, 88, 120].map((offset) => ({
      merchant_key: "flex_timing",
      display_name: "Flex Timing Svc",
      amount: 12.99,
      date: addDays(start, offset).toISOString().split("T")[0],
    }));
    const result = await analyzeGroup(txns);
    assert.ok(result, "Should tolerate timing variance within 25%");
    assert.equal(result.cadence_days, 30);
  });

  it("tolerates ±10% amount variance", async () => {
    const start = new Date("2025-01-15");
    const txns = [
      { amount: 10.00, date: addDays(start, 0).toISOString().split("T")[0] },
      { amount: 10.50, date: addDays(start, 30).toISOString().split("T")[0] },
      { amount: 10.20, date: addDays(start, 60).toISOString().split("T")[0] },
      { amount: 10.80, date: addDays(start, 90).toISOString().split("T")[0] },
    ].map((t) => ({ ...t, merchant_key: "flex_amt", display_name: "Flex Amt" }));
    const result = await analyzeGroup(txns);
    assert.ok(result, "Should tolerate amount variance within 10%");
  });

  it("detects price changes", async () => {
    const start = new Date("2025-01-15");
    const txns = [
      { amount: 9.99, date: addDays(start, 0).toISOString().split("T")[0] },
      { amount: 9.99, date: addDays(start, 30).toISOString().split("T")[0] },
      { amount: 9.99, date: addDays(start, 60).toISOString().split("T")[0] },
      { amount: 10.99, date: addDays(start, 90).toISOString().split("T")[0] },
    ].map((t) => ({ ...t, merchant_key: "price_chg", display_name: "Price Changer" }));
    const result = await analyzeGroup(txns);
    assert.ok(result, "Should still detect with minor price change");
    assert.equal(result.amount_changed, true);
    assert.equal(result.amount, 10.99);
    assert.equal(result.prior_amount, 9.99);
  });

  it("prefers shorter cadence (30-day over 60-day)", async () => {
    // 6 monthly charges also have 3 bimonthly pairs — should pick monthly
    const txns = monthlyCharges("Monthly", 19.99, 6);
    const result = await analyzeGroup(txns);
    assert.ok(result);
    assert.equal(result.cadence_days, 30, "Should prefer monthly cadence");
  });

  it("handles unsorted input correctly", async () => {
    const txns = monthlyCharges("Unsorted", 7.99, 5);
    // Shuffle
    const shuffled = [txns[3], txns[0], txns[4], txns[1], txns[2]];
    const result = await analyzeGroup(shuffled);
    assert.ok(result, "Should handle unsorted transactions");
    assert.equal(result.cadence_days, 30);
  });

  it("detects a yearly subscription (2 charges ~365 days apart)", async () => {
    const start = new Date("2024-01-15");
    const txns = [0, 365].map((offset) => ({
      merchant_key: "yearly_svc",
      display_name: "Domain Renewal",
      amount: 12.99,
      date: addDays(start, offset).toISOString().split("T")[0],
    }));
    const result = await analyzeGroup(txns);
    assert.ok(result, "Should detect yearly subscription with 2 charges");
    assert.equal(result.cadence_days, 365);
    assert.equal(result.amount, 12.99);
  });

  it("detects a yearly subscription with 3 charges", async () => {
    const start = new Date("2023-03-01");
    const txns = [0, 365, 730].map((offset) => ({
      merchant_key: "yearly3",
      display_name: "Annual License",
      amount: 99.00,
      date: addDays(start, offset).toISOString().split("T")[0],
    }));
    const result = await analyzeGroup(txns);
    assert.ok(result, "Should detect yearly subscription with 3 charges");
    assert.equal(result.cadence_days, 365);
  });

  it("detects a quarterly subscription (2 charges ~90 days apart) — F2", async () => {
    const start = new Date("2025-01-15");
    const txns = [0, 90].map((offset) => ({
      merchant_key: "quarterly_svc",
      display_name: "Quarterly Membership",
      amount: 45.00,
      date: addDays(start, offset).toISOString().split("T")[0],
    }));
    const result = await analyzeGroup(txns);
    assert.ok(result, "Should detect quarterly subscription with 2 charges (F2)");
    assert.equal(result.cadence_days, 90);
    assert.equal(result.amount, 45.00);
  });

  it("detects a bi-monthly subscription (2 charges ~60 days apart) — F2", async () => {
    const start = new Date("2025-02-01");
    const txns = [0, 60].map((offset) => ({
      merchant_key: "bimonthly_svc",
      display_name: "Bi-monthly Box",
      amount: 30.00,
      date: addDays(start, offset).toISOString().split("T")[0],
    }));
    const result = await analyzeGroup(txns);
    assert.ok(result, "Should detect bi-monthly subscription with 2 charges (F2)");
    assert.equal(result.cadence_days, 60);
  });

  it("still requires 3 charges for a 30-day cadence (2 monthly charges → none)", async () => {
    const txns = monthlyCharges("TwoMonthly", 9.99, 2);
    const result = await analyzeGroup(txns);
    // 2 charges 30 days apart: 30-day cadence needs 3, and the single ~30-day
    // gap doesn't match 60/90/365 — so no detection.
    assert.equal(result, null, "30-day cadence still needs 3 charges");
  });

  it("does not detect yearly from 2 charges with wrong gap", async () => {
    const start = new Date("2024-01-15");
    // 200 days apart — not yearly
    const txns = [0, 200].map((offset) => ({
      merchant_key: "not_yearly",
      display_name: "Not Yearly",
      amount: 50.00,
      date: addDays(start, offset).toISOString().split("T")[0],
    }));
    const result = await analyzeGroup(txns);
    assert.equal(result, null, "Should not detect yearly with wrong gap");
  });
});

// ============================================================================
// addDays helper tests
// ============================================================================
describe("addDays", () => {
  it("adds days correctly", () => {
    const d = addDays(new Date("2025-03-01"), 30);
    assert.equal(d.toISOString().split("T")[0], "2025-03-31");
  });

  it("handles month boundaries", () => {
    const d = addDays(new Date("2025-01-31"), 30);
    assert.equal(d.toISOString().split("T")[0], "2025-03-02");
  });

  it("handles zero days", () => {
    const d = addDays(new Date("2025-06-15"), 0);
    assert.equal(d.toISOString().split("T")[0], "2025-06-15");
  });
});

// ============================================================================
// Merchant exclusion tests
// ============================================================================
const { isExcludedMerchant } = require("../scripts/detect-subscriptions");

describe("isExcludedMerchant", () => {
  it("excludes interest charges", () => {
    assert.ok(isExcludedMerchant("CHASE INTEREST CHARGE"));
    assert.ok(isExcludedMerchant("interest"));
    assert.ok(isExcludedMerchant("APR CHARGE ON PURCHASES"));
  });

  it("excludes fast food and retail", () => {
    assert.ok(isExcludedMerchant("WALGREENS #1234"));
    assert.ok(isExcludedMerchant("MCDONALDS F12345"));
    assert.ok(isExcludedMerchant("DUTCH BROS 567"));
    assert.ok(isExcludedMerchant("starbucks"));
  });

  it("excludes fees", () => {
    assert.ok(isExcludedMerchant("LATE FEE"));
    assert.ok(isExcludedMerchant("late charge"));
    assert.ok(isExcludedMerchant("OVERDRAFT FEE"));
  });

  it("excludes debt/loan payments", () => {
    assert.ok(isExcludedMerchant("DIRECTPAY MINIMUM PAYMENT"));
    assert.ok(isExcludedMerchant("AUTOPAY CREDIT CARD"));
    assert.ok(isExcludedMerchant("loan payment"));
  });

  it("excludes transfers", () => {
    assert.ok(isExcludedMerchant("AMERICAN AIRLINE FUNDS TRAN"));
    assert.ok(isExcludedMerchant("ACH TRANSFER"));
    assert.ok(isExcludedMerchant("TRANSFER TO SAVINGS"));
  });

  it("does NOT exclude real subscriptions", () => {
    assert.ok(!isExcludedMerchant("NETFLIX.COM"));
    assert.ok(!isExcludedMerchant("SPOTIFY USA"));
    assert.ok(!isExcludedMerchant("HULU"));
    assert.ok(!isExcludedMerchant("ADOBE CREATIVE CLOUD"));
    assert.ok(!isExcludedMerchant("CHATGPT SUBSCRIPTION"));
  });

  // Regression: "interest" exclusion keyword used to substring-match
  // "internet" and silently hide every ISP/internet bill from detection.
  // Word-boundary matching prevents the collision.
  it("does NOT exclude internet/ISP bills (interest vs internet)", () => {
    assert.ok(!isExcludedMerchant("COMCAST INTERNET"));
    assert.ok(!isExcludedMerchant("ATT INTERNET 1000"));
    assert.ok(!isExcludedMerchant("Spectrum Internet"));
    assert.ok(!isExcludedMerchant("xfinity internet svc"));
    // But genuine interest charges still excluded
    assert.ok(isExcludedMerchant("CHASE INTEREST CHARGE"));
  });

  it("handles null/empty input", () => {
    assert.ok(!isExcludedMerchant(null));
    assert.ok(!isExcludedMerchant(""));
  });
});
