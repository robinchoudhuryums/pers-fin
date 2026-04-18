// ============================================================================
// AI Audit — tests for insight validation logic
// ============================================================================

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  extractDollarClaims,
  extractPercentClaims,
  extractMerchantNames,
  extractTrendClaims,
  findContradictions,
} = require("../teller/services/ai-audit");

describe("extractDollarClaims", () => {
  it("extracts simple dollar amounts", () => {
    const claims = extractDollarClaims("You spent $1,234.56 on groceries");
    assert.equal(claims.length, 1);
    assert.equal(claims[0].value, 1234.56);
  });

  it("extracts multiple amounts", () => {
    const claims = extractDollarClaims("Netflix $15.99 and Spotify $9.99");
    assert.equal(claims.length, 2);
    assert.equal(claims[0].value, 15.99);
    assert.equal(claims[1].value, 9.99);
  });

  it("ignores zero amounts", () => {
    const claims = extractDollarClaims("Balance: $0.00");
    assert.equal(claims.length, 0);
  });

  it("handles amounts without decimals", () => {
    const claims = extractDollarClaims("Budget is $500");
    assert.equal(claims.length, 1);
    assert.equal(claims[0].value, 500);
  });
});

describe("extractPercentClaims", () => {
  it("extracts percentage values", () => {
    const claims = extractPercentClaims("Your savings rate is 18%");
    assert.equal(claims.length, 1);
    assert.equal(claims[0].value, 18);
  });

  it("extracts decimal percentages", () => {
    const claims = extractPercentClaims("Utilization at 32.5%");
    assert.equal(claims.length, 1);
    assert.equal(claims[0].value, 32.5);
  });

  it("ignores unreasonable values (>1000%)", () => {
    const claims = extractPercentClaims("Error code 5000%");
    assert.equal(claims.length, 0);
  });
});

describe("extractMerchantNames", () => {
  it("extracts merchants from bullet format", () => {
    const names = extractMerchantNames("- **Netflix**: $15.99/mo streaming\n- **Spotify**: $9.99/mo music");
    assert.ok(names.includes("Netflix"));
    assert.ok(names.includes("Spotify"));
  });

  it("extracts merchants from 'at Merchant' pattern", () => {
    const names = extractMerchantNames("You spent $50 at Costco last week");
    assert.ok(names.some(n => n.includes("Costco")));
  });

  it("ignores short strings", () => {
    const names = extractMerchantNames("at US on the 5th");
    assert.equal(names.filter(n => n.length < 3).length, 0);
  });
});

describe("extractTrendClaims", () => {
  it("detects 'up' direction", () => {
    const claims = extractTrendClaims("Food spending is up by $200");
    assert.ok(claims.length > 0);
    assert.equal(claims[0].direction, "up");
  });

  it("detects 'down' direction", () => {
    const claims = extractTrendClaims("Entertainment is down this month");
    assert.ok(claims.length > 0);
    assert.equal(claims[0].direction, "down");
  });

  it("detects 'increased' as up", () => {
    const claims = extractTrendClaims("spending on Dining increased by $150");
    assert.ok(claims.some(c => c.direction === "up"));
  });
});

describe("findContradictions", () => {
  it("flags same category claimed both up and down", () => {
    const text = "Food is up 15% this month. Later we see Food is down compared to last quarter.";
    const contradictions = findContradictions(text);
    assert.ok(contradictions.length > 0, "Should detect Food claimed both up and down");
  });

  it("no contradiction when categories differ", () => {
    const text = "Food is up 10%. Entertainment is down this month.";
    const contradictions = findContradictions(text);
    assert.equal(contradictions.length, 0);
  });
});
