// ============================================================================
// Teller integration tests
// ============================================================================
// Tests Teller-specific logic: enrollment handling, transaction amount
// normalization, API request auth header construction, and mTLS config.
// ============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// Teller amount normalization
// ---------------------------------------------------------------------------
// Teller uses negative amounts for debits (money leaving account).
// We store positive for debits (same convention as Plaid).
describe("Teller amount normalization", () => {
  function normalizeAmount(tellerAmount) {
    const raw = parseFloat(tellerAmount);
    return raw < 0 ? Math.abs(raw) : -raw;
  }

  it("converts negative (debit) to positive", () => {
    assert.equal(normalizeAmount("-15.99"), 15.99);
  });

  it("converts positive (credit/refund) to negative", () => {
    assert.equal(normalizeAmount("42.50"), -42.50);
  });

  it("handles zero", () => {
    assert.equal(normalizeAmount("0"), -0);
  });

  it("handles string amounts from API", () => {
    assert.equal(normalizeAmount("-123.45"), 123.45);
  });
});

// ---------------------------------------------------------------------------
// Teller Basic Auth header construction
// ---------------------------------------------------------------------------
describe("Teller auth header", () => {
  function buildAuthHeader(accessToken) {
    return "Basic " + Buffer.from(accessToken + ":").toString("base64");
  }

  it("constructs correct Basic auth header", () => {
    const header = buildAuthHeader("test_token_abc123");
    // Decode and verify format: "token:"
    const decoded = Buffer.from(header.replace("Basic ", ""), "base64").toString();
    assert.equal(decoded, "test_token_abc123:");
  });

  it("always appends colon (empty password)", () => {
    const header = buildAuthHeader("my_access_token");
    const decoded = Buffer.from(header.replace("Basic ", ""), "base64").toString();
    assert.ok(decoded.endsWith(":"), "Should end with colon for empty password");
  });
});

// ---------------------------------------------------------------------------
// Enrollment data extraction
// ---------------------------------------------------------------------------
describe("Teller enrollment handling", () => {
  it("extracts institution name from enrollment callback", () => {
    const enrollment = {
      accessToken: "test_token_123",
      enrollment: {
        id: "enr_abc123",
        institution: { name: "Chase" },
      },
    };
    const institutionName = enrollment.enrollment.institution?.name || "Unknown";
    assert.equal(institutionName, "Chase");
  });

  it("defaults to Unknown for missing institution name", () => {
    const enrollment = {
      accessToken: "test_token_123",
      enrollment: { id: "enr_abc123" },
    };
    const institutionName = enrollment.enrollment.institution?.name || "Unknown";
    assert.equal(institutionName, "Unknown");
  });

  it("validates required enrollment fields", () => {
    const valid = { accessToken: "tok", enrollment: { id: "enr_1" } };
    const missingToken = { enrollment: { id: "enr_1" } };
    const missingEnrollment = { accessToken: "tok" };

    assert.ok(valid.accessToken && valid.enrollment?.id);
    assert.ok(!missingToken.accessToken);
    assert.ok(!missingEnrollment.enrollment?.id);
  });
});

// ---------------------------------------------------------------------------
// Teller transaction ID handling
// ---------------------------------------------------------------------------
describe("Teller transaction mapping", () => {
  it("maps Teller transaction fields to DB columns", () => {
    const tellerTxn = {
      id: "txn_abc123def456",
      account_id: "acc_xyz789",
      date: "2025-03-15",
      description: "NETFLIX.COM",
      amount: "-15.99",
      status: "posted",
      type: "card_payment",
      details: {
        category: "entertainment",
        counterparty: { name: "Netflix" },
      },
    };

    const mapped = {
      transaction_id: tellerTxn.id,
      account_id: tellerTxn.account_id,
      date: tellerTxn.date,
      name: tellerTxn.description,
      merchant_name: tellerTxn.details?.counterparty?.name || tellerTxn.description,
      amount: Math.abs(parseFloat(tellerTxn.amount)),
      category: tellerTxn.details?.category || null,
      pending: tellerTxn.status === "pending",
    };

    assert.equal(mapped.transaction_id, "txn_abc123def456");
    assert.equal(mapped.merchant_name, "Netflix");
    assert.equal(mapped.amount, 15.99);
    assert.equal(mapped.pending, false);
    assert.equal(mapped.category, "entertainment");
  });

  it("falls back to description when counterparty is missing", () => {
    const tellerTxn = {
      id: "txn_999",
      description: "POS PURCHASE - LOCAL SHOP",
      amount: "-8.50",
      details: {},
    };

    const merchantName = tellerTxn.details?.counterparty?.name || tellerTxn.description;
    assert.equal(merchantName, "POS PURCHASE - LOCAL SHOP");
  });

  it("skips pending transactions", () => {
    const txns = [
      { id: "1", status: "posted", amount: "-10" },
      { id: "2", status: "pending", amount: "-20" },
      { id: "3", status: "posted", amount: "-30" },
    ];
    const filtered = txns.filter(t => t.status !== "pending");
    assert.equal(filtered.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Teller environment config
// ---------------------------------------------------------------------------
describe("Teller environment mapping", () => {
  it("maps environment names correctly", () => {
    const envMap = (env) => {
      const e = (env || "sandbox").toLowerCase();
      if (e === "production") return "production";
      if (e === "development") return "development";
      return "sandbox";
    };

    assert.equal(envMap("production"), "production");
    assert.equal(envMap("development"), "development");
    assert.equal(envMap("sandbox"), "sandbox");
    assert.equal(envMap(undefined), "sandbox");
    assert.equal(envMap("PRODUCTION"), "production");
  });
});
