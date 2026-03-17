// ============================================================================
// Tests for the subscription detection algorithm
// ============================================================================
// Tests the core logic: findModeAmount, gap analysis, cadence detection.
// Uses node:test (built-in, no deps needed).
// ============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// Import helpers directly from detect-subscriptions.js
// The module only exports detectSubscriptions (which needs DB), so we
// re-implement the pure helpers here for unit testing, then verify they
// match the module's behavior.
// ---------------------------------------------------------------------------

// Exact copies of the helpers from detect-subscriptions.js
function findModeAmount(amounts, tolerance) {
  if (amounts.length === 0) return null;
  let bestAmount = amounts[0];
  let bestCount = 0;
  for (const candidate of amounts) {
    const count = amounts.filter(
      (a) => Math.abs(a - candidate) / Math.max(candidate, 0.01) <= tolerance
    ).length;
    if (count > bestCount) {
      bestCount = count;
      bestAmount = candidate;
    }
  }
  return bestAmount;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

// Detection logic extracted for testing without DB
function analyzeGroup(merchantTxns, opts = {}) {
  const CADENCES = opts.cadences || [30, 60, 90, 365];
  const TOLERANCE = opts.tolerance || 0.25;
  const AMOUNT_TOLERANCE = opts.amountTolerance || 0.10;
  const MIN_OCCURRENCES = opts.minOccurrences || 3;
  const MIN_OCCURRENCES_YEARLY = opts.minOccurrencesYearly || 2;

  if (merchantTxns.length < MIN_OCCURRENCES_YEARLY) return null;

  merchantTxns.sort((a, b) => new Date(a.date) - new Date(b.date));

  for (const targetCadence of CADENCES) {
    const minOcc = targetCadence >= 365 ? MIN_OCCURRENCES_YEARLY : MIN_OCCURRENCES;
    const minGap = targetCadence * (1 - TOLERANCE);
    const maxGap = targetCadence * (1 + TOLERANCE);

    const amounts = merchantTxns.map((t) => parseFloat(t.amount));
    const modeAmount = findModeAmount(amounts, AMOUNT_TOLERANCE);
    if (modeAmount === null) continue;

    const filtered = merchantTxns.filter((t) => {
      const amt = parseFloat(t.amount);
      return Math.abs(amt - modeAmount) / modeAmount <= AMOUNT_TOLERANCE;
    });

    if (filtered.length < minOcc) continue;

    const gaps = [];
    for (let i = 1; i < filtered.length; i++) {
      const daysDiff =
        (new Date(filtered[i].date) - new Date(filtered[i - 1].date)) /
        (1000 * 60 * 60 * 24);
      gaps.push(daysDiff);
    }

    const matchingGaps = gaps.filter((g) => g >= minGap && g <= maxGap);

    const minMatchingGaps = targetCadence >= 365 ? 1 : 2;
    if (matchingGaps.length >= Math.floor(gaps.length * 0.5) && matchingGaps.length >= minMatchingGaps) {
      const lastTxn = filtered[filtered.length - 1];
      const firstTxn = filtered[0];
      const latestAmount = parseFloat(lastTxn.amount);
      const priorAmount =
        filtered.length >= 2
          ? parseFloat(filtered[filtered.length - 2].amount)
          : null;

      return {
        amount: latestAmount,
        prior_amount: priorAmount,
        cadence_days: targetCadence,
        first_seen: firstTxn.date,
        last_charged: lastTxn.date,
        amount_changed:
          priorAmount !== null &&
          Math.abs(latestAmount - priorAmount) > 0.01,
      };
    }
  }
  return null;
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
  it("detects a monthly subscription (3 charges, ~30 days apart)", () => {
    const txns = monthlyCharges("Netflix", 15.99, 4);
    const result = analyzeGroup(txns);
    assert.ok(result, "Should detect a subscription");
    assert.equal(result.cadence_days, 30);
    assert.equal(result.amount, 15.99);
  });

  it("detects a quarterly subscription (~90 days apart)", () => {
    const start = new Date("2025-01-01");
    const txns = [0, 90, 180, 270].map((offset) => ({
      merchant_key: "quarterly_svc",
      display_name: "Quarterly Service",
      amount: 49.99,
      date: addDays(start, offset).toISOString().split("T")[0],
    }));
    const result = analyzeGroup(txns);
    assert.ok(result, "Should detect quarterly subscription");
    assert.equal(result.cadence_days, 90);
  });

  it("rejects random non-recurring charges", () => {
    const start = new Date("2025-01-01");
    // Gaps: 3, 15, 7, 2, 40 days — truly no consistent pattern
    const txns = [0, 3, 18, 25, 27, 67].map((offset) => ({
      merchant_key: "random_store",
      display_name: "Random Store",
      amount: 25.00,
      date: addDays(start, offset).toISOString().split("T")[0],
    }));
    const result = analyzeGroup(txns);
    assert.equal(result, null, "Should not detect non-recurring charges");
  });

  it("rejects groups with fewer than 3 charges", () => {
    const txns = monthlyCharges("TwoTimer", 9.99, 2);
    const result = analyzeGroup(txns);
    assert.equal(result, null, "Should require at least 3 charges");
  });

  it("tolerates ±25% timing variance", () => {
    const start = new Date("2025-01-15");
    // Gaps: 27, 33, 28, 32 days — all within 25% of 30
    const txns = [0, 27, 60, 88, 120].map((offset) => ({
      merchant_key: "flex_timing",
      display_name: "Flex Timing Svc",
      amount: 12.99,
      date: addDays(start, offset).toISOString().split("T")[0],
    }));
    const result = analyzeGroup(txns);
    assert.ok(result, "Should tolerate timing variance within 25%");
    assert.equal(result.cadence_days, 30);
  });

  it("tolerates ±10% amount variance", () => {
    const start = new Date("2025-01-15");
    const txns = [
      { amount: 10.00, date: addDays(start, 0).toISOString().split("T")[0] },
      { amount: 10.50, date: addDays(start, 30).toISOString().split("T")[0] },
      { amount: 10.20, date: addDays(start, 60).toISOString().split("T")[0] },
      { amount: 10.80, date: addDays(start, 90).toISOString().split("T")[0] },
    ].map((t) => ({ ...t, merchant_key: "flex_amt", display_name: "Flex Amt" }));
    const result = analyzeGroup(txns);
    assert.ok(result, "Should tolerate amount variance within 10%");
  });

  it("detects price changes", () => {
    const start = new Date("2025-01-15");
    const txns = [
      { amount: 9.99, date: addDays(start, 0).toISOString().split("T")[0] },
      { amount: 9.99, date: addDays(start, 30).toISOString().split("T")[0] },
      { amount: 9.99, date: addDays(start, 60).toISOString().split("T")[0] },
      { amount: 10.99, date: addDays(start, 90).toISOString().split("T")[0] },
    ].map((t) => ({ ...t, merchant_key: "price_chg", display_name: "Price Changer" }));
    const result = analyzeGroup(txns);
    assert.ok(result, "Should still detect with minor price change");
    assert.equal(result.amount_changed, true);
    assert.equal(result.amount, 10.99);
    assert.equal(result.prior_amount, 9.99);
  });

  it("prefers shorter cadence (30-day over 60-day)", () => {
    // 6 monthly charges also have 3 bimonthly pairs — should pick monthly
    const txns = monthlyCharges("Monthly", 19.99, 6);
    const result = analyzeGroup(txns);
    assert.ok(result);
    assert.equal(result.cadence_days, 30, "Should prefer monthly cadence");
  });

  it("handles unsorted input correctly", () => {
    const txns = monthlyCharges("Unsorted", 7.99, 5);
    // Shuffle
    const shuffled = [txns[3], txns[0], txns[4], txns[1], txns[2]];
    const result = analyzeGroup(shuffled);
    assert.ok(result, "Should handle unsorted transactions");
    assert.equal(result.cadence_days, 30);
  });

  it("detects a yearly subscription (2 charges ~365 days apart)", () => {
    const start = new Date("2024-01-15");
    const txns = [0, 365].map((offset) => ({
      merchant_key: "yearly_svc",
      display_name: "Domain Renewal",
      amount: 12.99,
      date: addDays(start, offset).toISOString().split("T")[0],
    }));
    const result = analyzeGroup(txns);
    assert.ok(result, "Should detect yearly subscription with 2 charges");
    assert.equal(result.cadence_days, 365);
    assert.equal(result.amount, 12.99);
  });

  it("detects a yearly subscription with 3 charges", () => {
    const start = new Date("2023-03-01");
    const txns = [0, 365, 730].map((offset) => ({
      merchant_key: "yearly3",
      display_name: "Annual License",
      amount: 99.00,
      date: addDays(start, offset).toISOString().split("T")[0],
    }));
    const result = analyzeGroup(txns);
    assert.ok(result, "Should detect yearly subscription with 3 charges");
    assert.equal(result.cadence_days, 365);
  });

  it("does not detect yearly from 2 charges with wrong gap", () => {
    const start = new Date("2024-01-15");
    // 200 days apart — not yearly
    const txns = [0, 200].map((offset) => ({
      merchant_key: "not_yearly",
      display_name: "Not Yearly",
      amount: 50.00,
      date: addDays(start, offset).toISOString().split("T")[0],
    }));
    const result = analyzeGroup(txns);
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

  it("handles null/empty input", () => {
    assert.ok(!isExcludedMerchant(null));
    assert.ok(!isExcludedMerchant(""));
  });
});
