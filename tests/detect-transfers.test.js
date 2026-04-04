// ============================================================================
// Tests for the recurring transfer detection algorithm
// ============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { classifyTransfer, isTransferMerchant, TRANSFER_PATTERNS } = require("../scripts/detect-transfers");
const { findModeAmount, addDays } = require("../scripts/detect-subscriptions");

// ---------------------------------------------------------------------------
// classifyTransfer
// ---------------------------------------------------------------------------
describe("classifyTransfer", () => {
  it("classifies Zelle as peer_transfer", () => {
    assert.equal(classifyTransfer("ZELLE PAYMENT TO JOHN"), "peer_transfer");
  });

  it("classifies Venmo as peer_transfer", () => {
    assert.equal(classifyTransfer("Venmo Payment"), "peer_transfer");
  });

  it("classifies Cash App as peer_transfer", () => {
    assert.equal(classifyTransfer("cash app *john"), "peer_transfer");
  });

  it("classifies autopay as bill_payment", () => {
    assert.equal(classifyTransfer("CHASE AUTOPAY PAYMENT"), "bill_payment");
  });

  it("classifies loan payment as bill_payment", () => {
    assert.equal(classifyTransfer("STUDENT LOAN PAYMENT"), "bill_payment");
  });

  it("classifies Vanguard as investment", () => {
    assert.equal(classifyTransfer("VANGUARD CONTRIBUTION"), "investment");
  });

  it("classifies Fidelity as investment", () => {
    assert.equal(classifyTransfer("FIDELITY INVESTMENTS"), "investment");
  });

  it("classifies ACH transfer as internal", () => {
    assert.equal(classifyTransfer("ACH TRANSFER 12345"), "internal");
  });

  it("classifies wire transfer as internal", () => {
    assert.equal(classifyTransfer("WIRE TRANSFER"), "internal");
  });

  it("classifies savings as savings", () => {
    assert.equal(classifyTransfer("TRANSFER TO SAVINGS ACCOUNT"), "savings");
  });

  it("returns null for non-transfer merchants", () => {
    assert.equal(classifyTransfer("NETFLIX"), null);
    assert.equal(classifyTransfer("SPOTIFY"), null);
    assert.equal(classifyTransfer("STARBUCKS"), null);
  });

  it("returns null for null/empty input", () => {
    assert.equal(classifyTransfer(null), null);
    assert.equal(classifyTransfer(""), null);
  });
});

// ---------------------------------------------------------------------------
// isTransferMerchant
// ---------------------------------------------------------------------------
describe("isTransferMerchant", () => {
  it("returns true for transfer keywords", () => {
    assert.equal(isTransferMerchant("ZELLE TO FRIEND"), true);
    assert.equal(isTransferMerchant("ACH TRANSFER"), true);
    assert.equal(isTransferMerchant("AUTOPAY PAYMENT"), true);
  });

  it("returns false for non-transfer merchants", () => {
    assert.equal(isTransferMerchant("AMAZON PRIME"), false);
    assert.equal(isTransferMerchant("UBER EATS"), false);
  });
});

// ---------------------------------------------------------------------------
// Transfer detection logic (unit test without DB)
// ---------------------------------------------------------------------------
describe("Transfer gap analysis", () => {
  // Reuse the analyzeGroup logic from subscription tests but with transfer parameters
  function analyzeTransferGroup(txns) {
    const CADENCES = [7, 14, 30, 60, 90, 365];
    const TOLERANCE = 0.25;
    const AMOUNT_TOLERANCE = 0.15;
    const MIN_OCCURRENCES = 3;
    const MIN_OCCURRENCES_LONG = 2;

    if (txns.length < MIN_OCCURRENCES_LONG) return null;
    txns.sort((a, b) => new Date(a.date) - new Date(b.date));

    for (const targetCadence of CADENCES) {
      const minOcc = targetCadence >= 90 ? MIN_OCCURRENCES_LONG : MIN_OCCURRENCES;
      const minGap = targetCadence * (1 - TOLERANCE);
      const maxGap = targetCadence * (1 + TOLERANCE);

      const amounts = txns.map(t => Math.abs(parseFloat(t.amount)));
      const modeAmount = findModeAmount(amounts, AMOUNT_TOLERANCE);
      if (modeAmount === null) continue;

      const filtered = txns.filter(t =>
        Math.abs(Math.abs(parseFloat(t.amount)) - modeAmount) / modeAmount <= AMOUNT_TOLERANCE
      );
      if (filtered.length < minOcc) continue;

      const gaps = [];
      for (let i = 1; i < filtered.length; i++) {
        gaps.push((new Date(filtered[i].date) - new Date(filtered[i - 1].date)) / 86400000);
      }

      const matchingGaps = gaps.filter(g => g >= minGap && g <= maxGap);
      const minMatchingGaps = targetCadence >= 90 ? 1 : 2;

      if (matchingGaps.length >= Math.floor(gaps.length * 0.5) && matchingGaps.length >= minMatchingGaps) {
        return { cadence_days: targetCadence, amount: modeAmount, count: filtered.length };
      }
    }
    return null;
  }

  it("detects weekly transfers (7-day cadence)", () => {
    const txns = [];
    for (let i = 0; i < 6; i++) {
      const d = new Date("2024-01-01");
      d.setDate(d.getDate() + i * 7);
      txns.push({ date: d.toISOString().split("T")[0], amount: "50.00" });
    }
    const result = analyzeTransferGroup(txns);
    assert.ok(result, "Should detect weekly pattern");
    assert.equal(result.cadence_days, 7);
    assert.equal(result.amount, 50);
  });

  it("detects biweekly transfers (14-day cadence)", () => {
    const txns = [];
    for (let i = 0; i < 5; i++) {
      const d = new Date("2024-01-01");
      d.setDate(d.getDate() + i * 14);
      txns.push({ date: d.toISOString().split("T")[0], amount: "500.00" });
    }
    const result = analyzeTransferGroup(txns);
    assert.ok(result, "Should detect biweekly pattern");
    assert.equal(result.cadence_days, 14);
  });

  it("detects monthly transfers (30-day cadence)", () => {
    const txns = [];
    for (let i = 0; i < 4; i++) {
      const d = new Date("2024-01-15");
      d.setDate(d.getDate() + i * 30);
      txns.push({ date: d.toISOString().split("T")[0], amount: "200.00" });
    }
    const result = analyzeTransferGroup(txns);
    assert.ok(result, "Should detect monthly pattern");
    assert.equal(result.cadence_days, 30);
  });

  it("handles amount variance within 15% tolerance", () => {
    const txns = [
      { date: "2024-01-01", amount: "100.00" },
      { date: "2024-01-31", amount: "105.00" },
      { date: "2024-03-01", amount: "95.00" },
      { date: "2024-03-31", amount: "110.00" },
    ];
    const result = analyzeTransferGroup(txns);
    assert.ok(result, "Should detect with amount variance");
    assert.equal(result.cadence_days, 30);
  });

  it("rejects non-recurring transactions", () => {
    const txns = [
      { date: "2024-01-01", amount: "50.00" },
      { date: "2024-02-15", amount: "75.00" },
      { date: "2024-05-20", amount: "30.00" },
    ];
    const result = analyzeTransferGroup(txns);
    assert.equal(result, null, "Should not detect irregular pattern");
  });

  it("rejects groups with too few transactions", () => {
    const txns = [
      { date: "2024-01-01", amount: "100.00" },
    ];
    const result = analyzeTransferGroup(txns);
    assert.equal(result, null, "Single transaction should not match");
  });
});

// ---------------------------------------------------------------------------
// TRANSFER_PATTERNS coverage
// ---------------------------------------------------------------------------
describe("TRANSFER_PATTERNS", () => {
  it("has all expected transfer type categories", () => {
    assert.ok(TRANSFER_PATTERNS.peer_transfer);
    assert.ok(TRANSFER_PATTERNS.bill_payment);
    assert.ok(TRANSFER_PATTERNS.savings);
    assert.ok(TRANSFER_PATTERNS.investment);
    assert.ok(TRANSFER_PATTERNS.internal);
  });

  it("peer_transfer includes common P2P services", () => {
    const p = TRANSFER_PATTERNS.peer_transfer;
    assert.ok(p.includes("zelle"));
    assert.ok(p.includes("venmo"));
    assert.ok(p.includes("cash app"));
    assert.ok(p.includes("paypal"));
  });

  it("investment includes major brokerages", () => {
    const inv = TRANSFER_PATTERNS.investment;
    assert.ok(inv.includes("vanguard"));
    assert.ok(inv.includes("fidelity"));
    assert.ok(inv.includes("schwab"));
    assert.ok(inv.includes("robinhood"));
  });
});
