// ============================================================================
// AI Audit — tests for insight validation logic
// ============================================================================

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  extractDollarClaims,
  extractPercentClaims,
  extractMerchantNames,
  extractTrendClaims,
  findContradictions,
  CROSS_PERIOD_RE,
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

// AIA1: Tier-1 dollar-claim arithmetic only has this-month actuals, so a claim
// whose context is scoped to a non-current-month window must be SKIPPED (not
// compared) to avoid false-positive critical findings.
describe("CROSS_PERIOD_RE — skip non-current-month dollar claims (AIA1)", () => {
  const crosses = [
    "you spent $2,400 per year on groceries",
    "$2,400/yr on dining",
    "annual food & drink spend is $2,400",
    "annually you pay $1,200",
    "$3,600 over the past 6 months",
    "spent $3,600 in the last 3 months on shopping",
    "year-to-date you spent $1,500",
    "$1,500 YTD on healthcare",
    "your monthly average is $300",
    "projected $400 on travel",
    "on track to spend $5,000 this year",
  ];
  for (const t of crosses) {
    it(`flags cross-period: "${t}"`, () => {
      assert.ok(CROSS_PERIOD_RE.test(t.toLowerCase()), "should be treated as cross-period (skipped)");
    });
  }

  const currentOrUnqualified = [
    "you spent $234.56 on groceries",
    "$234.56 on dining this month",
    "Food & Drink: $234.56",
    "$50 per month on subscriptions",
  ];
  for (const t of currentOrUnqualified) {
    it(`does NOT flag current/unqualified: "${t}"`, () => {
      assert.ok(!CROSS_PERIOD_RE.test(t.toLowerCase()), "this-month/unqualified claims stay checked");
    });
  }
});
