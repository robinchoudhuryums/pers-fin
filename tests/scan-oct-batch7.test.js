// ============================================================================
// Broad-scan (Oct 2026, cycle 7) Batch 7 — categorization rules + income cadence
// ============================================================================
// The rule ordering, superseded-rule deactivation, the mid-run user category
// and the unanswered-row back-off are pinned against real Postgres in
// tests/contract/categorize-rules.contract.test.js. This file covers what needs
// no database:
// F52   semimonthly pay on the 1st and 15th whose "1st" lands on the 29th–31st
// F46   RULE_ORDER_SQL + deactivateSupersededRules + times_applied not bumping
//       updated_at
// F48   rulePatternError + the POST route's 400
// F47   the AI write only fills a still-uncategorized row
// F54   the AI back-off column, select and stamp
// ============================================================================

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
afterEach(() => { dbModule.pool.query = originalQuery; });

// ---------------------------------------------------------------------------
describe("F52 — semimonthly pay across the month boundary", () => {
  const { classifyIncomeDates } = require("../teller/services/cadence");

  it("a '1st' that posts on the 29th–31st (weekend/holiday) is still semimonthly 1/15", () => {
    const r = classifyIncomeDates(["2026-05-01", "2026-05-15", "2026-05-29", "2026-06-15",
      "2026-07-01", "2026-07-15", "2026-07-31", "2026-08-14"]);
    assert.equal(r.cadence, "semimonthly");
    assert.deepEqual(r.days, [1, 15]);
  });

  it("a plain 1st/15th and a biweekly series keep their cadence", () => {
    assert.equal(classifyIncomeDates(["2026-05-01", "2026-05-15", "2026-06-01", "2026-06-15",
      "2026-07-01", "2026-07-15"]).cadence, "semimonthly");
    assert.equal(classifyIncomeDates(["2026-05-01", "2026-05-15", "2026-05-29", "2026-06-12",
      "2026-06-26", "2026-07-10"]).cadence, "biweekly");
  });
});

// ---------------------------------------------------------------------------
describe("F46 / F48 — categorization rules", () => {
  const helpers = require("../teller/routes/categorize-helpers");

  it("rules apply most specific first: exact, starts_with, contains; longer pattern, newer rule", () => {
    assert.match(helpers.RULE_ORDER_SQL,
      /CASE match_type WHEN 'exact' THEN 0 WHEN 'starts_with' THEN 1 ELSE 2 END, LENGTH\(merchant_pattern\) DESC, updated_at DESC/);
    const src = read("teller", "routes", "categorize.js");
    assert.equal((src.match(/WHERE is_active = true \$\{RULE_ORDER_SQL\}/g) || []).length, 2, "runCategorize + /apply");
    assert.doesNotMatch(src, /WHERE is_active = true ORDER BY times_applied DESC/, "applying rules never orders by use count");
    // A busy rule must not look "newer" just because it ran.
    assert.doesNotMatch(src, /times_applied = times_applied \+ \$1, updated_at/);
  });

  it("deactivateSupersededRules turns off the same merchant's rules for another category", async () => {
    const calls = [];
    const n = await helpers.deactivateSupersededRules({ query: async (sql, p) => { calls.push({ sql, p }); return { rowCount: 2 }; } }, " Costco ", "Shopping");
    assert.equal(n, 2);
    assert.match(calls[0].sql, /SET is_active = false[\s\S]*LOWER\(merchant_pattern\) = LOWER\(\$1\) AND category <> \$2 AND is_active = true/);
    assert.deepEqual(calls[0].p, ["Costco", "Shopping"]);
  });

  it("rulePatternError: blank always, < 3 characters unless exact", () => {
    assert.ok(helpers.rulePatternError("  ", "exact"));
    assert.ok(helpers.rulePatternError("a", "contains"));
    assert.ok(helpers.rulePatternError("ab", "starts_with"));
    assert.equal(helpers.rulePatternError("QT", "exact"), null);
    assert.equal(helpers.rulePatternError("Uber", "contains"), null);
  });

  it("POST /api/categorization-rules 400s a 1-character contains rule without touching the DB", async () => {
    let queried = false;
    dbModule.pool.query = async () => { queried = true; return { rows: [], rowCount: 0 }; };
    const app = express(); app.use(express.json()); app.use(require("../teller/routes/categorize"));
    const r = await supertest(app).post("/api/categorization-rules").send({ merchant_pattern: "e", category: "Shopping" }).expect(400);
    assert.match(r.body.error, /at least 3 characters/);
    assert.equal(queried, false);
  });
});

// ---------------------------------------------------------------------------
describe("F47 / F54 — the AI pass", () => {
  const src = read("teller", "routes", "categorize.js");

  it("the AI write only fills a row that is still uncategorized and counts only real writes", () => {
    assert.match(src, /WHERE transaction_id = \$2 AND user_category IS NULL`/);
  });

  it("rows the model left unanswered are stamped and held back for 30 days", () => {
    assert.match(src, /const AI_SKIP_RETRY_DAYS = 30;/);
    assert.match(src, /AND \(ai_skipped_at IS NULL OR ai_skipped_at < now\(\) - make_interval\(days => \$\{AI_SKIP_RETRY_DAYS\}\)\)/);
    assert.match(src, /UPDATE transactions SET ai_skipped_at = now\(\) WHERE transaction_id = ANY\(\$1::text\[\]\) AND user_category IS NULL/);
    assert.match(read("teller", "services", "database.js"), /ALTER TABLE transactions ADD COLUMN IF NOT EXISTS ai_skipped_at TIMESTAMPTZ/);
  });
});
