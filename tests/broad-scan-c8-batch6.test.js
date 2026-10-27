// ============================================================================
// Cycle-8 broad scan Batch 6 — AI trust, Perfin's side
// ============================================================================
// F42: the audit treats year / week / quarter periods and a prior-year month
// ("last November", "November 2025", "In 2025") as cross-period, so a claim
// about them isn't compared with this month's actuals (the real audit on real
// spending is tests/contract/c8-batch6). F50: the insights prompt's credit-score
// deltas compare the same score type. F53: the weekly digest waits for 07:00
// local, like the daily digest, with no DB read before then. F44 (Ask's
// success-path charge) is in tests/ai-cap-charge.test.js; Per-sistant's half
// is apps/per-sistant/tests/broad-scan-c8-batch6.test.js.
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const audit = require("../teller/services/ai-audit");
const fq = require("../teller/services/financial-queries");

// ---------------------------------------------------------------- F42
describe("F42 — year, week and quarter claims are cross-period", () => {
  const cross = (t) => audit.CROSS_PERIOD_RE.test(t.toLowerCase());

  it("the regex covers last / previous / prior year, week and quarter and per-week rates", () => {
    for (const t of [
      "Last year Shopping hit $800", "$800 the previous year", "prior year dining was $2,400", "two years ago you spent $900",
      "same month last year Shopping was $700", "last winter heating cost $300",
      "$90 last week on coffee", "$120 this week on dining", "about $100 a week on groceries", "$40/week on lunch", "weekly coffee runs $35",
      "$1,200 last quarter on travel", "$600 this quarter", "quarterly insurance of $450",
    ]) assert.ok(cross(t), t);
  });

  it("this-month and unqualified claims stay checked", () => {
    for (const t of ["Dining $450 this month", "you spent $234.56 on groceries", "$50 per month on subscriptions",
      "a quarter of your spending ($450) went to dining", "you may want to keep dining near $450"]) {
      assert.ok(!cross(t), t);
    }
  });

  it("this month's name in another year is another month", () => {
    const n = audit.namesOtherMonth;
    assert.equal(n("Last November Shopping hit $800", "2026-11"), true);
    assert.equal(n("previous November Shopping hit $800", "2026-11"), true);
    assert.equal(n("In November 2025, Shopping hit $800", "2026-11"), true);
    assert.equal(n("In November, 2025 Shopping hit $800", "2026-11"), true);
    assert.equal(n("In 2025, Shopping hit $800", "2026-11"), true);
    // still this month
    assert.equal(n("In November 2026, Shopping hit $800", "2026-11"), false);
    assert.equal(n("In November, Shopping hit $800", "2026-11"), false);
    assert.equal(n("For 2026-11 Dining hit $450", "2026-11"), false);
    assert.equal(n("Shopping hit $2025 so far", "2026-11"), false, "an amount isn't a year");
    assert.equal(n("In 2026, Shopping hit $800", "2026-11"), false);
  });

  it("an attached prior-year month after the figure counts too", () => {
    const at = (t) => audit.claimNamesOtherMonth(t, { index: t.indexOf("$800"), raw: "$800" }, "2026-11");
    assert.equal(at("Shopping hit $800 last November."), true);
    assert.equal(at("Shopping hit $800 in November 2025."), true);
    assert.equal(at("Shopping hit $800 in 2025."), true);
    assert.equal(at("Shopping hit $800 in November."), false);
  });
});

// ---------------------------------------------------------------- F50
describe("F50 — the prompt's credit-score deltas compare the same score type", () => {
  const { creditScoreSummary } = require("../teller/routes/insights");
  const row = (score, score_type, checked_at) => ({ score, score_type, checked_at });

  it("an interleaved VantageScore entry isn't diffed against FICO", () => {
    const s = creditScoreSummary([
      row(742, "fico", "2026-10-20"), row(701, "vantagescore", "2026-10-10"),
      row(735, "fico", "2026-09-20"), row(698, "vantagescore", "2026-09-10"), row(720, "fico", "2026-08-20"),
    ]);
    assert.match(s, /^Latest: 742 \(fico, 2026-10-20\)/);
    assert.match(s, /Prior fico: 735 \(delta \+7\)/);
    assert.match(s, /3-entry fico range: 720 → 742 \(\+22 over 61 days\)/);
    assert.match(s, /Latest vantagescore: 701 \(2026-10-10\)/);
    assert.doesNotMatch(s, /delta \+41/, "never 742 − 701");
  });

  it("one entry, a negative delta, and nothing at all", () => {
    assert.equal(creditScoreSummary([row(700, "fico", "2026-10-01")]), "Latest: 700 (fico, 2026-10-01)");
    assert.match(creditScoreSummary([row(690, null, "2026-10-01"), row(700, null, "2026-09-01")]), /Prior unknown: 700 \(delta -10\)/);
    assert.equal(creditScoreSummary([]), "");
  });

  it("generateInsights builds the section through it", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "teller", "routes", "insights.js"), "utf8");
    assert.match(src, /const summary = creditScoreSummary\(csResult\.rows\);/);
  });
});

// ---------------------------------------------------------------- F53
describe("F53 — the weekly digest waits for 07:00 local", () => {
  const startup = require("../teller/startup");
  const insights = require("../teller/routes/insights");
  const dbModule = require("../teller/services/database");
  const origQuery = dbModule.pool.query;
  const origHour = insights.DAILY_DIGEST_HOUR;
  const origWeekly = insights.runWeeklyDigest;
  afterEach(() => {
    dbModule.pool.query = origQuery;
    insights.DAILY_DIGEST_HOUR = origHour;
    insights.runWeeklyDigest = origWeekly;
    startup._awayJobs.reset();
  });
  const weekday = new Date(fq.todayStr() + "T00:00:00Z").getUTCDay();

  it("before the hour: no DB read, nothing sent, not settled for the day", async () => {
    let queries = 0, runs = 0;
    dbModule.pool.query = async () => { queries++; return { rows: [{ weekly_digest_enabled: true, weekly_digest_day: weekday }] }; };
    insights.runWeeklyDigest = async () => { runs++; return { sent: true }; };
    insights.DAILY_DIGEST_HOUR = 25; // always too early
    await startup._awayJobs.runWeeklyDigestTick();
    assert.equal(queries, 0);
    assert.equal(runs, 0);
    insights.DAILY_DIGEST_HOUR = 0; // the hour arrives the same day
    await startup._awayJobs.runWeeklyDigestTick();
    assert.equal(runs, 1, "the earlier tick didn't settle the day");
  });
});
