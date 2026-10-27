// ============================================================================
// Roadmap T2.2 L2 — the low projected cash alert
// ============================================================================
// services/cash-alerts.js runCashAlerts over a fake pool + stubbed forecast /
// push / email: off (and then no DB read for the day, until Settings changes
// it), nothing new since the last check, stale or unknown balances, clear,
// notify, held, re-notify after 3 days earlier or 72 h, an unlogged
// notification retried, the email after a logged push only. The startup tick's
// outcome recording, the job-health interval, PATCH /api/settings validation +
// the memo reset, GET /api/settings defaults and the Settings form.
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
afterEach(() => { dbModule.pool.query = originalQuery; });

const ca = require("../teller/services/cash-alerts");
const fq = require("../teller/services/financial-queries");
const jobHealth = require("../teller/services/job-health");

const NOW = new Date("2026-03-10T15:00:00Z");
const TODAY = "2026-03-10";
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600e3);

// A fake pool: the settings/stamps row, the per-account floors (T2.2 L4 —
// none unless given), and every UPDATE recorded (with whether it stamped).
function fakePool(row, { floors = [] } = {}) {
  const calls = { selects: 0, updates: [], stamps: [] };
  return {
    calls,
    query: async (sql, params) => {
      if (/UPDATE user_settings SET cash_alert_state/.test(sql)) { calls.updates.push(JSON.parse(params[0])); calls.stamps.push(params[2]); return { rows: [] }; }
      if (/FROM user_settings s/.test(sql)) { calls.selects++; return { rows: row ? [row] : [] }; }
      if (/low_balance_floor IS NOT NULL/.test(sql)) return { rows: floors };
      throw new Error("unexpected query: " + sql.slice(0, 60));
    },
  };
}
const row = (over = {}) => ({
  cash_alert_enabled: true, cash_alert_threshold: "500.00", cash_alert_horizon_days: 14,
  cash_alert_state: null, cash_alerts_checked_at: null,
  balances_at: hoursAgo(2), data_at: hoursAgo(2), ...over,
});
// Projection: 900, 400 (breach) … lowest 100 on 03-14.
const BREACH_FORECAST = {
  projection: [
    { date: "2026-03-11", balance: 900 }, { date: "2026-03-12", balance: 400 },
    { date: "2026-03-13", balance: 250 }, { date: "2026-03-14", balance: 100 },
  ],
  lowest: { date: "2026-03-14", balance: 100 },
};
function deps({ forecast = BREACH_FORECAST, logged = true, emailThrows = false } = {}) {
  const sent = [], emails = [], days = [];
  return {
    sent, emails, days,
    forecast: async (d) => { days.push(d); return forecast; },
    sendToAll: async (p) => { sent.push(p); return { sent: 0, failed: 0, logged }; },
    sendEmail: async (t, b) => { if (emailThrows) throw new Error("smtp down"); emails.push({ t, b }); return { sent: true }; },
    sentRecently: async () => false,
  };
}
const run = (pool, d, opts = {}) => ca.runCashAlerts(pool, { now: NOW, today: TODAY, deps: d, ...opts });

beforeEach(() => ca._reset());

describe("runCashAlerts — gates", () => {
  it("off: no evaluation, and no further DB read that day until invalidate()", async () => {
    const pool = fakePool(row({ cash_alert_enabled: false }));
    assert.equal((await run(pool, deps())).status, "disabled");
    assert.equal((await run(pool, deps())).status, "disabled");
    assert.equal(pool.calls.selects, 1, "the second tick made no DB read");
    ca.invalidate();
    await run(pool, deps());
    assert.equal(pool.calls.selects, 2);
    assert.equal(pool.calls.updates.length, 0);
  });

  it("nothing new since a check earlier today → unchanged, no write, no forecast", async () => {
    const d = deps();
    const pool = fakePool(row({ cash_alerts_checked_at: hoursAgo(1), data_at: hoursAgo(3) }));
    const r = await run(pool, d);
    assert.deepEqual([r.status, r.ran], ["unchanged", false]);
    assert.equal(d.days.length, 0);
    assert.equal(pool.calls.updates.length, 0);
  });

  it("new data since the check → evaluates; a check on an earlier day → evaluates", async () => {
    const d1 = deps();
    await run(fakePool(row({ cash_alerts_checked_at: hoursAgo(2), data_at: hoursAgo(1) })), d1);
    assert.equal(d1.days.length, 1);
    const d2 = deps();
    await run(fakePool(row({ cash_alerts_checked_at: hoursAgo(30), data_at: hoursAgo(40), balances_at: hoursAgo(20) })), d2);
    assert.equal(d2.days.length, 1, "2026-03-09 was another local day");
  });

  it("balances older than 36 h → skipped (stamped, no forecast, no alert); none at all → no_balances", async () => {
    const d = deps();
    const pool = fakePool(row({ balances_at: hoursAgo(37), data_at: hoursAgo(37) }));
    const r = await run(pool, d);
    assert.deepEqual([r.status, r.reason], ["skipped", "stale_balances"]);
    assert.equal(d.days.length, 0);
    assert.equal(d.sent.length, 0);
    assert.deepEqual(pool.calls.updates[0].last_check, { at: NOW.toISOString(), outcome: "skipped", reason: "stale_balances", floors_below: 0 });
    const r2 = await run(fakePool(row({ balances_at: null, data_at: hoursAgo(1) })), deps());
    assert.equal(r2.reason, "no_balances");
    assert.equal(ca.STALE_BALANCE_HOURS, 36);
  });

  it("projects the configured horizon", async () => {
    const d = deps();
    await run(fakePool(row({ cash_alert_horizon_days: 30 })), d);
    assert.deepEqual(d.days, [30]);
  });
});

describe("runCashAlerts — alert and dedup", () => {
  it("a breach notifies: push (tag cash-low → /dashboard), then the opt-in email, then the state", async () => {
    const d = deps();
    const pool = fakePool(row());
    const r = await run(pool, d);
    assert.equal(r.status, "notified");
    assert.equal(d.sent.length, 1);
    assert.equal(d.sent[0].tag, "cash-low");
    assert.equal(d.sent[0].title, "Low cash ahead");
    assert.deepEqual(d.sent[0].data, { url: "/dashboard" });
    assert.equal(d.sent[0].body, "Your cash is projected to fall below $500.00 on Thu, Mar 12 — lowest $100.00 on Sat, Mar 14. The forecast counts your bills, paychecks and usual spending.");
    assert.deepEqual(d.emails, [{ t: "Low cash ahead", b: d.sent[0].body }]);
    assert.deepEqual(pool.calls.updates[0], {
      alert: { breach_date: "2026-03-12", low_date: "2026-03-14", low_balance: 100, notified_at: NOW.toISOString() },
      last_notified: { breach_date: "2026-03-12", notified_at: NOW.toISOString() },
      last_check: { at: NOW.toISOString(), outcome: "notified", breach_date: "2026-03-12", floors_below: 0 },
    });
  });

  it("the same breach within 72 h is held (state kept), even a day earlier or two", async () => {
    for (const notifiedBreach of ["2026-03-12", "2026-03-13", "2026-03-14"]) {
      const alert = { breach_date: notifiedBreach, notified_at: hoursAgo(10).toISOString() };
      const d = deps();
      const pool = fakePool(row({ cash_alert_state: { alert } }));
      const r = await run(pool, d);
      assert.equal(r.status, "held", notifiedBreach);
      assert.equal(d.sent.length, 0);
      assert.deepEqual(pool.calls.updates[0].alert, alert, "the notified breach stays the reference");
    }
  });

  it("re-notifies when the breach moves 3+ days earlier, or 72 h after the last alert", async () => {
    const earlier = deps();
    await run(fakePool(row({ cash_alert_state: { alert: { breach_date: "2026-03-15", notified_at: hoursAgo(10).toISOString() } } })), earlier);
    assert.equal(earlier.sent.length, 1, "03-12 is 3 days before 03-15");
    const later = deps();
    await run(fakePool(row({ cash_alert_state: { alert: { breach_date: "2026-03-12", notified_at: hoursAgo(72).toISOString() } } })), later);
    assert.equal(later.sent.length, 1);
    const notYet = deps();
    await run(fakePool(row({ cash_alert_state: { alert: { breach_date: "2026-03-12", notified_at: hoursAgo(71).toISOString() } } })), notYet);
    assert.equal(notYet.sent.length, 0);
  });

  it("no breach → clear: a recorded alert is dropped silently, its notification remembered (F11)", async () => {
    const d = deps({ forecast: { projection: [{ date: "2026-03-11", balance: 900 }], lowest: { date: "2026-03-11", balance: 900 } } });
    const notifiedAt = hoursAgo(5).toISOString();
    const pool = fakePool(row({ cash_alert_state: { alert: { breach_date: "2026-03-12", notified_at: notifiedAt } } }));
    assert.equal((await run(pool, d)).status, "clear");
    assert.equal(d.sent.length, 0);
    assert.deepEqual(pool.calls.updates[0], {
      alert: null,
      last_notified: { breach_date: "2026-03-12", notified_at: notifiedAt },
      last_check: { at: NOW.toISOString(), outcome: "clear", floors_below: 0 },
    });
  });

  it("a balance AT the floor is not below it", async () => {
    const d = deps({ forecast: { projection: [{ date: "2026-03-11", balance: 500 }], lowest: { date: "2026-03-11", balance: 500 } } });
    assert.equal((await run(fakePool(row()), d)).status, "clear");
  });

  it("an unlogged notification: no email, no state, the check left unstamped so the next tick retries", async () => {
    const d = deps({ logged: false });
    const pool = fakePool(row());
    assert.equal((await run(pool, d)).status, "unlogged");
    assert.equal(d.emails.length, 0);
    assert.equal(pool.calls.updates.length, 0);
  });

  it("a failing email never fails the alert", async () => {
    const pool = fakePool(row());
    assert.equal((await run(pool, deps({ emailThrows: true }))).status, "notified");
    assert.equal(pool.calls.updates.length, 1);
  });

  it("a negative low prints as -$X", () => {
    assert.match(ca.alertText(0, { date: "2026-03-12", balance: -5 }, { date: "2026-03-14", balance: -1234.5 }), /below \$0\.00 on Thu, Mar 12 — lowest -\$1,234\.50 on Sat, Mar 14/);
  });
});

describe("the cash-alerts job", () => {
  const startup = require("../teller/startup");
  const real = ca.runCashAlerts;
  // The same tick runs the payday check (T2.2 L3) — kept quiet here.
  const payday = require("../teller/services/payday-alerts");
  const realMissed = payday.runPaydayMissed;
  beforeEach(() => { payday.runPaydayMissed = async () => ({ status: "disabled", ran: false }); });
  afterEach(() => { ca.runCashAlerts = real; payday.runPaydayMissed = realMissed; jobHealth._memoryResults.delete("cash-alerts"); });

  it("ticks hourly, is watched, and isn't activity-gated", () => {
    assert.equal(jobHealth.JOB_INTERVALS_MS["cash-alerts"], 3600e3);
    const src = fs.readFileSync(path.join(__dirname, "../teller/startup.js"), "utf8");
    const body = src.slice(src.indexOf("async function runCashAlertsTick()"), src.indexOf("\n}\n", src.indexOf("async function runCashAlertsTick()")));
    assert.doesNotMatch(body, /isUserActive\(\)/);
    assert.match(src, /setInterval\(\(\) => runCashAlertsTick\(\), 60 \* 60 \* 1000\)/);
  });

  it("records an outcome only when it evaluated; a failure or an unlogged alert as an error", async () => {
    for (const [result, expect] of [
      [{ status: "unchanged", ran: false }, undefined],
      [{ status: "disabled", ran: false }, undefined],
      [{ status: "clear", ran: true }, { status: "ok", error: null }],
      [{ status: "unlogged", ran: true }, { status: "error", error: "cash alert: notification not logged" }],
    ]) {
      jobHealth._memoryResults.delete("cash-alerts");
      ca.runCashAlerts = async () => result;
      await startup._awayJobs.runCashAlertsTick();
      assert.deepEqual(jobHealth._memoryResults.get("cash-alerts"), expect, result.status);
    }
    ca.runCashAlerts = async () => { throw new Error("db down"); };
    await startup._awayJobs.runCashAlertsTick();
    assert.deepEqual(jobHealth._memoryResults.get("cash-alerts"), { status: "error", error: "cash alert: db down" });
  });
});

describe("Settings — cash alert fields", () => {
  const app = () => { const a = express(); a.use(express.json()); a.use(require("../teller/routes/settings")); return a; };

  it("PATCH rejects a non-boolean switch, a bad floor and an out-of-range horizon", async () => {
    let wrote = 0;
    dbModule.pool.query = async () => { wrote++; return { rows: [{}] }; };
    for (const body of [
      { cash_alert_enabled: "yes" }, { cash_alert_enabled: 1 },
      { cash_alert_threshold: "" }, { cash_alert_threshold: null }, { cash_alert_threshold: -1 },
      { cash_alert_threshold: "abc" }, { cash_alert_threshold: 1e8 },
      { cash_alert_horizon_days: 6 }, { cash_alert_horizon_days: 61 }, { cash_alert_horizon_days: "14x" }, { cash_alert_horizon_days: 14.5 },
    ]) {
      await supertest(app()).patch("/api/settings").send(body).expect(400);
    }
    assert.equal(wrote, 0);
  });

  it("PATCH stores valid values (floor rounded to cents) and clears the off-for-today memo", async () => {
    const pool = fakePool(row({ cash_alert_enabled: false }));
    await ca.runCashAlerts(pool, { now: NOW, today: fq.todayStr(), deps: deps() });
    let sql = null, values = null;
    dbModule.pool.query = async (s, v) => { if (/^UPDATE user_settings SET/.test(s)) { sql = s; values = v; } return { rows: [{}] }; };
    await supertest(app()).patch("/api/settings").send({ cash_alert_enabled: true, cash_alert_threshold: "750.555", cash_alert_horizon_days: "21" }).expect(200);
    assert.match(sql, /cash_alert_enabled = \$1, cash_alert_threshold = \$2, cash_alert_horizon_days = \$3/);
    assert.deepEqual(values, [true, 750.56, 21]);
    await ca.runCashAlerts(pool, { now: NOW, today: fq.todayStr(), deps: deps() });
    assert.equal(pool.calls.selects, 2, "the memo was cleared, so the tick read the settings again");
  });

  it("GET returns the defaults for a row without them", async () => {
    dbModule.pool.query = async () => ({ rows: [{ theme: "dark" }] });
    const s = (await supertest(app()).get("/api/settings").expect(200)).body;
    assert.deepEqual([s.cash_alert_enabled, s.cash_alert_threshold, s.cash_alert_horizon_days], [false, 500, 14]);
  });

  it("the Settings page has the Cash Alerts form wired to those fields", () => {
    const v = fs.readFileSync(path.join(__dirname, "../teller/views/settings.ejs"), "utf8");
    assert.match(v, /<div class="section" id="cash-alerts-section"><h2>Cash Alerts<\/h2>/);
    for (const id of ["cash-alert-toggle", "cash-alert-threshold", "cash-alert-horizon"]) {
      assert.match(v, new RegExp('id="' + id + '"[^>]*aria-label="'), id + " is labelled");
    }
    assert.match(v, /\['cash-alert-toggle', 'change', function\(\) \{ updateSetting\('cash_alert_enabled', this\.checked\); \}\]/);
    assert.match(v, /updateSetting\('cash_alert_horizon_days', parseInt\(this\.value, 10\)\)/);
    assert.match(v, /var n = parseAmountInput\(document\.getElementById\('cash-alert-threshold'\)\.value\);[\s\S]{0,140}updateSetting\('cash_alert_threshold', n\)/);
  });
});
