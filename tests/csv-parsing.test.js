// ============================================================================
// Tests for CSV format detection and parsing
// ============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// Recreate CSV parsing logic from server.js for unit testing
// ---------------------------------------------------------------------------

const CSV_FORMATS = {
  chase: {
    detect: (headers) => headers.includes("Transaction Date") && headers.includes("Post Date") && headers.includes("Description"),
    parse: (row) => ({
      date: row["Transaction Date"],
      merchant_name: row["Description"],
      amount: -parseFloat(row["Amount"]),
      category: row["Category"] || null,
    }),
  },
  capitalone: {
    detect: (headers) => headers.includes("Transaction Date") && headers.includes("Posted Date") && (headers.includes("Debit") || headers.includes("Credit")),
    parse: (row) => ({
      date: row["Transaction Date"],
      merchant_name: row["Description"],
      amount: parseFloat(row["Debit"] || "0") || -(parseFloat(row["Credit"] || "0")),
      category: row["Category"] || null,
    }),
  },
  generic: {
    detect: () => true,
    parse: (row) => {
      const date = row["Date"] || row["Transaction Date"] || row["date"] || Object.values(row)[0];
      const desc = row["Description"] || row["Merchant"] || row["Name"] || row["description"] || Object.values(row).find(v => typeof v === "string" && v.length > 3 && isNaN(v));
      const amtStr = row["Amount"] || row["Debit"] || row["amount"] || Object.values(row).find(v => !isNaN(parseFloat(v)));
      return {
        date,
        merchant_name: desc || null,
        amount: Math.abs(parseFloat(amtStr) || 0),
        category: row["Category"] || row["category"] || null,
      };
    },
  },
};

function detectCsvFormat(headers) {
  for (const [name, fmt] of Object.entries(CSV_FORMATS)) {
    if (name !== "generic" && fmt.detect(headers)) return name;
  }
  return "generic";
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  const cleaned = dateStr.trim();
  const slashMatch = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) return `${slashMatch[3]}-${slashMatch[1].padStart(2, "0")}-${slashMatch[2].padStart(2, "0")}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return cleaned;
  const d = new Date(cleaned);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

// ============================================================================
// Format detection tests
// ============================================================================
describe("detectCsvFormat", () => {
  it("detects Chase format", () => {
    const headers = ["Transaction Date", "Post Date", "Description", "Category", "Type", "Amount", "Memo"];
    assert.equal(detectCsvFormat(headers), "chase");
  });

  it("detects Capital One format", () => {
    const headers = ["Transaction Date", "Posted Date", "Card No.", "Description", "Category", "Debit", "Credit"];
    assert.equal(detectCsvFormat(headers), "capitalone");
  });

  it("falls back to generic for unknown formats", () => {
    const headers = ["Date", "Description", "Amount"];
    assert.equal(detectCsvFormat(headers), "generic");
  });
});

// ============================================================================
// Chase parsing tests
// ============================================================================
describe("Chase CSV parsing", () => {
  it("parses a Chase debit transaction", () => {
    const row = {
      "Transaction Date": "01/15/2025",
      "Post Date": "01/16/2025",
      "Description": "NETFLIX.COM",
      "Category": "Entertainment",
      "Type": "Sale",
      "Amount": "-15.99",
      "Memo": "",
    };
    const result = CSV_FORMATS.chase.parse(row);
    assert.equal(result.merchant_name, "NETFLIX.COM");
    assert.equal(result.amount, 15.99); // negated
    assert.equal(result.date, "01/15/2025");
    assert.equal(result.category, "Entertainment");
  });

  it("parses a Chase credit/refund", () => {
    const row = {
      "Transaction Date": "02/01/2025",
      "Post Date": "02/02/2025",
      "Description": "REFUND FROM STORE",
      "Category": "Shopping",
      "Type": "Return",
      "Amount": "25.00",
      "Memo": "",
    };
    const result = CSV_FORMATS.chase.parse(row);
    assert.equal(result.amount, -25.00); // credits become negative
  });
});

// ============================================================================
// Capital One parsing tests
// ============================================================================
describe("Capital One CSV parsing", () => {
  it("parses a Capital One debit", () => {
    const row = {
      "Transaction Date": "2025-01-15",
      "Posted Date": "2025-01-16",
      "Card No.": "1234",
      "Description": "SPOTIFY USA",
      "Category": "Entertainment",
      "Debit": "10.99",
      "Credit": "",
    };
    const result = CSV_FORMATS.capitalone.parse(row);
    assert.equal(result.merchant_name, "SPOTIFY USA");
    assert.equal(result.amount, 10.99);
  });

  it("parses a Capital One credit", () => {
    const row = {
      "Transaction Date": "2025-02-01",
      "Posted Date": "2025-02-02",
      "Card No.": "1234",
      "Description": "PAYMENT RECEIVED",
      "Category": "Payment",
      "Debit": "",
      "Credit": "500.00",
    };
    const result = CSV_FORMATS.capitalone.parse(row);
    assert.equal(result.amount, -500.00); // credit is negative
  });
});

// ============================================================================
// Generic format parsing tests
// ============================================================================
describe("Generic CSV parsing", () => {
  it("parses common column names", () => {
    const row = { "Date": "2025-03-01", "Description": "Amazon Prime", "Amount": "14.99", "Category": "Shopping" };
    const result = CSV_FORMATS.generic.parse(row);
    assert.equal(result.merchant_name, "Amazon Prime");
    assert.equal(result.amount, 14.99);
    assert.equal(result.category, "Shopping");
  });

  it("handles alternative column names", () => {
    const row = { "date": "2025-03-15", "description": "HULU", "amount": "7.99" };
    const result = CSV_FORMATS.generic.parse(row);
    assert.equal(result.merchant_name, "HULU");
    assert.equal(result.amount, 7.99);
  });
});

// ============================================================================
// Date parsing tests
// ============================================================================
describe("parseDate", () => {
  it("parses MM/DD/YYYY format", () => {
    assert.equal(parseDate("01/15/2025"), "2025-01-15");
  });

  it("parses M/D/YYYY format", () => {
    assert.equal(parseDate("3/5/2025"), "2025-03-05");
  });

  it("passes through ISO YYYY-MM-DD format", () => {
    assert.equal(parseDate("2025-12-31"), "2025-12-31");
  });

  it("returns null for empty/null input", () => {
    assert.equal(parseDate(null), null);
    assert.equal(parseDate(""), null);
  });

  it("trims whitespace", () => {
    assert.equal(parseDate("  01/01/2025  "), "2025-01-01");
  });
});
