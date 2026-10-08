// ============================================================================
// Broad-scan (Sept 2026) Batch 6 — APP_TIMEZONE anchors (FAN-13 / SXE-12)
// ============================================================================
// Runs with an APP_TIMEZONE whose calendar date DIFFERS from UTC's at the
// moment the test runs (UTC−12 before noon UTC, UTC+14 after), so any surface
// still reading the server's UTC date/month disagrees with todayStr() and fails.
// ============================================================================

const utcHour = new Date().getUTCHours();
process.env.APP_TIMEZONE = utcHour < 12 ? "Etc/GMT+12" : "Pacific/Kiritimati";
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supertest = require("supertest");

const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
afterEach(() => { dbModule.pool.query = originalQuery; });

const fq = require("../teller/services/financial-queries");

function mountApp(mod) {
  const app = express();
  app.use(express.json());
  app.use(require(mod));
  return app;
}

const today = fq.todayStr();
const [Y, M, D] = today.split("-").map(Number);

describe("fixture sanity", () => {
  it("the forced zone's date differs from the UTC date", () => {
    assert.notEqual(today, new Date().toISOString().slice(0, 10));
  });
});

describe("FAN-13 — budget alerts day math uses the tz date", () => {
  it("day_of_month / days_in_month / days_remaining follow todayStr()", async () => {
    dbModule.pool.query = async () => ({ rows: [] });
    const res = await supertest(mountApp("../teller/routes/budgets")).get("/api/budgets/alerts");
    assert.equal(res.status, 200);
    const dim = new Date(Date.UTC(Y, M, 0)).getUTCDate();
    assert.equal(res.body.day_of_month, D);
    assert.equal(res.body.days_in_month, dim);
    assert.equal(res.body.days_remaining, dim - D);
  });
});

describe("FAN-13 — YoY defaults come from the tz date", () => {
  it("default month/year/through-day = today in APP_TIMEZONE", async () => {
    let params;
    dbModule.pool.query = async (_sql, p) => { params = p; return { rows: [] }; };
    const res = await supertest(mountApp("../teller/routes/spending-analytics")).get("/api/spending-yoy");
    assert.equal(res.status, 200);
    assert.deepEqual(params, [M, Y, D]);
  });
});

describe("FAN-13 — income-summary window anchors on the tz month", () => {
  it("passes currentMonth()-01, not the UTC month", async () => {
    const seen = [];
    dbModule.pool.query = async (_sql, p) => { seen.push(p); return { rows: [] }; };
    await supertest(mountApp("../teller/routes/spending-analytics")).get("/api/income-summary?months=3");
    assert.equal(seen.length, 3);
    for (const p of seen) assert.deepEqual(p, [3, today.slice(0, 7) + "-01"]);
  });
});

describe("SXE-12 — ICS 'today' is the tz date", () => {
  it("a manual bill due today (tz) is in the feed", async () => {
    dbModule.pool.query = async (sql) => {
      if (/FROM manual_bills/.test(sql)) {
        // Created this month, due today → occurrence on `today`.
        return { rows: [{ id: 4, name: "Phone", amount: "60", due_day: D, cadence: "monthly", created_at: new Date(Date.UTC(Y, M - 1, 1, 12)) }] };
      }
      return { rows: [] };
    };
    const ics = await require("../teller/routes/subscriptions").buildBillCalendarIcs(30);
    assert.match(ics, new RegExp("UID:bill-4-" + today.replace(/-/g, "") + "@perfin"));
  });
});

describe("FAN-7 / FAN-13 — the scheduled snapshot keys on the tz month", () => {
  it("runBudgetSnapshot() defaults to todayStr()", async () => {
    const { runBudgetSnapshot } = require("../teller/routes/budgets");
    const db = { query: async () => ({ rows: [], rowCount: 0 }) };
    const r = await runBudgetSnapshot(db);
    assert.equal(r.month, fq.previousMonthKey(today.slice(0, 7)));
    assert.equal(r.mode, D <= 5 ? "refresh" : "catch_up");
  });
});
