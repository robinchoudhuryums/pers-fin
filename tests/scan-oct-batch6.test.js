// ============================================================================
// Broad-scan (Oct 2026, cycle 7) Batch 6 — delete integrity and feeds
// ============================================================================
// Real-Postgres behaviour (tombstoned re-syncs, CSV-overlap pairing, the ICS
// clamp + folding, Undismiss, the F57 400s and literal search) is pinned in
// tests/contract/delete-feeds.contract.test.js. This file covers the pure
// helpers and the source-level guarantees without a database:
// F20  both provider upserts skip deleted_transactions; the DELETE records it
// F21  merchantsSimilar / pairOverlaps
// F59  icsFold
// F57  isValidYmd + the route-level 400s on a mock pool
// F56  Undismiss re-activates
// F58  the dead artifacts are gone
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
const mount = (mod) => { const app = express(); app.use(express.json()); app.use(require(mod)); return app; };

describe("F20 — deleted transactions stay deleted", () => {
  it("the Teller and Plaid upserts skip a tombstoned id; the DELETE records one; reset wipes them", () => {
    for (const f of ["enrollments.js", "investments.js"]) {
      assert.match(read("teller", "routes", f),
        /INSERT INTO transactions[\s\S]{0,300}SELECT \$1::text, \$2::text, \$3::numeric[\s\S]{0,200}WHERE NOT EXISTS \(SELECT 1 FROM deleted_transactions dt WHERE dt\.transaction_id = \$2::text\)\s+ON CONFLICT \(transaction_id\)/, f);
    }
    assert.match(read("teller", "routes", "transactions.js"),
      /DELETE FROM transactions WHERE transaction_id = \$1 RETURNING transaction_id[\s\S]{0,400}INSERT INTO deleted_transactions \(transaction_id\) VALUES \(\$1\) ON CONFLICT DO NOTHING/);
    assert.match(read("teller", "services", "database.js"), /CREATE TABLE IF NOT EXISTS deleted_transactions \(\s+transaction_id TEXT PRIMARY KEY/);
    assert.ok(require("../scripts/reset-fresh").WIPE_TABLES.includes("deleted_transactions"));
  });
});

describe("F21 — CSV-overlap pairing", () => {
  const { merchantsSimilar, pairOverlaps } = require("../teller/routes/transactions");
  it("merchant similarity: shared token or a ≥4-letter prefix; noise words don't count", () => {
    assert.equal(merchantsSimilar("AMAZON MKTPLACE PMTS", "Amazon"), true);
    assert.equal(merchantsSimilar("SQ *BLUE BOTTLE", "Blue Bottle Coffee"), true);
    assert.equal(merchantsSimilar("STARBUCKS 123", "Blue Bottle"), false);
    assert.equal(merchantsSimilar("POS PURCHASE 4411", "PAYPAL PAYMENT"), false, "only noise words in common");
  });
  it("one-to-one per account pair, closest date first, dissimilar merchants never paired", () => {
    const c = (csv_txn, synced_txn, day_gap, csv_merchant = "Cafe", synced_merchant = "Cafe") =>
      ({ csv_id: 1, synced_id: 2, csv_txn, synced_txn, day_gap, csv_merchant, synced_merchant });
    const out = pairOverlaps([c("a", "x", 2), c("b", "x", 0), c("a", "y", 1), c("z", "w", 0, "Shell", "Starbucks")]);
    assert.deepEqual(out.map((p) => p.csv_txn + p.synced_txn).sort(), ["ay", "bx"]);
  });
});

describe("F59 — ICS line folding", () => {
  const { icsFold } = require("../teller/routes/subscriptions");
  it("≤75 octets per line, continuation lines start with a space, multi-byte chars intact", () => {
    const line = "SUMMARY:" + "é".repeat(50) + "☕".repeat(10);
    const folded = icsFold(line);
    for (const l of folded.split("\r\n")) assert.ok(Buffer.byteLength(l, "utf8") <= 75);
    assert.equal(folded.replace(/\r\n /g, ""), line);
    assert.equal(icsFold("SUMMARY:short"), "SUMMARY:short");
  });
});

describe("F57 — validation", () => {
  const { isValidYmd } = require("../teller/services/cadence");
  it("isValidYmd checks the calendar, not just the shape", () => {
    assert.equal(isValidYmd("2028-02-29"), true);
    assert.equal(isValidYmd("2026-02-29"), false);
    assert.equal(isValidYmd("2026-13-45"), false);
    assert.equal(isValidYmd("2026-1-5"), false);
  });
  it("bill-calendar / bill-payments 400 on an impossible month and never query", async () => {
    let queried = false;
    dbModule.pool.query = async () => { queried = true; return { rows: [] }; };
    const app = mount("../teller/routes/subscriptions");
    await supertest(app).get("/api/bill-calendar?month=13").expect(400);
    await supertest(app).get("/api/bill-payments?year=abc").expect(400);
    await supertest(app).post("/api/manual-bills").send({ name: "Gym", amount: 40, due_day: "abc" }).expect(400);
    assert.equal(queried, false);
  });
  it("search escapes LIKE metacharacters and 400s a bad date; manual txn 400s a fake date", async () => {
    let sql = "", params = null;
    dbModule.pool.query = async (s, p) => { sql = s; params = p; return { rows: [{ total: 0 }] }; };
    const app = mount("../teller/routes/transactions");
    await supertest(app).get("/api/transactions/search?q=" + encodeURIComponent("50%_off")).expect(200);
    assert.match(sql, /LIKE \$1 ESCAPE '\\'/);
    assert.equal(params[0], "%50\\%\\_off%");
    await supertest(app).get("/api/transactions/search?end_date=2026-04-31").expect(400);
    await supertest(app).post("/api/transactions/manual").send({ account_id: "a", amount: 5, date: "2026-13-45" }).expect(400);
  });
  it("defaults are the APP_TIMEZONE month / date, not UTC", () => {
    const src = read("teller", "routes", "subscriptions.js");
    assert.doesNotMatch(src, /new Date\(\)\.getMonth\(\) \+ 1/);
    assert.match(src, /const today = todayStr\(\); \/\/ APP_TIMEZONE date/);
  });
});

describe("F56 — Undismiss re-activates", () => {
  it("both undismiss routes set is_active", () => {
    const src = read("teller", "routes", "subscriptions.js");
    assert.match(src, /SET is_dismissed = false, is_active = \(cancelled_at IS NULL\)/);
    assert.match(src, /UPDATE recurring_transfers SET is_dismissed = false, is_active = true/);
  });
});

describe("F58 — dead artifacts removed", () => {
  it("firstOnOrAfter, the n8n header, the stale ICS header and the unused import are gone", () => {
    assert.equal(require("../teller/services/cadence").firstOnOrAfter, undefined);
    assert.doesNotMatch(read("scripts", "detect-subscriptions.js"), /n8n/);
    assert.doesNotMatch(read("teller", "routes", "subscriptions.js"), /since their anchor month is ambiguous/);
    assert.doesNotMatch(read("teller", "routes", "categorize.js"), /estimateCostGranular/);
  });
});
