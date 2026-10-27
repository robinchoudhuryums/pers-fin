// ============================================================================
// Roadmap T2.2 L3 — payday alerts
// ============================================================================
// services/payday-alerts.js over a fake pool: "Paycheck landed" (off, first
// switch-on initialising the watermark, only stream-matched deposits announced,
// the watermark advancing as text, a throwing send holding it back, the recent-
// date window), its place as the third post-sync step; "Payday missed?" (the
// overdue-payday rule, a deposit of any amount cancelling it, the connection-
// freshness gate, CSV / manual accounts never alerting, dedup, the memo,
// unlogged retry, the email), the shared tick isolating the two checks, PATCH
// /api/settings and the Settings toggle.
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

const pa = require("../teller/services/payday-alerts");
const jobHealth = require("../teller/services/job-health");

const TODAY = "2026-03-19";
// A biweekly ACME stream: last deposit 2026-03-01 → expected 03-15.
const PAY_ROWS = ["2026-01-04", "2026-01-18", "2026-02-01", "2026-02-15", "2026-03-01"]
  .map((date) => ({ source: "ACME PAYROLL", date, amount: "2100" }));

beforeEach(() => pa._reset());

// ---------------------------------------------------------------------------
describe("overduePayday (pure)", () => {
  const stream = { source: "ACME PAYROLL", amount: 2100, cadence: "biweekly", anchor: "2026-03-01", last: "2026-03-01" };
  it("is the expected payday once its 3-day grace has fully passed", () => {
    assert.equal(pa.overduePayday(stream, "2026-03-18"), null, "grace runs through 03-18");
    assert.equal(pa.overduePayday(stream, "2026-03-19"), "2026-03-15");
  });
  it("takes the latest overdue payday within 14 days", () => {
    assert.equal(pa.overduePayday(stream, "2026-04-01"), null, "03-29 is still in its grace; 03-15 is past the 14-day lookback");
    assert.equal(pa.overduePayday(stream, "2026-04-02"), "2026-03-29");
    assert.equal(pa.overduePayday(stream, "2026-04-20"), "2026-04-12", "the latest one (a stream quiet for weeks is dropped upstream by getLiveIncomeStreams)");
    assert.equal(pa.overduePayday({ ...stream, last: "2026-01-04", anchor: "2026-01-04" }, "2026-03-19"), "2026-03-15");
  });
  it("nothing when the stream just paid", () => {
    assert.equal(pa.overduePayday({ ...stream, last: "2026-03-15", anchor: "2026-03-15" }, "2026-03-19"), null);
  });
});

// ---------------------------------------------------------------------------
describe("runPaydayLanded", () => {
  function landedPool({ settings, candidates = [] }) {
    const calls = { updates: [], candidateParams: null, candidateSql: null };
    return {
      calls,
      query: async (sql, params) => {
        if (/SELECT payday_alerts_enabled, last_income_alert_at/.test(sql)) return { rows: [settings] };
        if (/UPDATE user_settings SET last_income_alert_at/.test(sql)) { calls.updates.push(params ? params[0] : "now()"); return { rows: [] }; }
        if (/created_at > \$1::timestamptz/.test(sql)) { calls.candidateSql = sql; calls.candidateParams = params; return { rows: candidates }; }
        if (/INTERVAL '4 months'/.test(sql)) return { rows: PAY_ROWS.concat([{ source: "ACME PAYROLL", date: "2026-03-15", amount: "2100" }]) };
        throw new Error("unexpected query: " + sql.slice(0, 60));
      },
    };
  }
  const cand = (id, source, amount, date, created) => ({ transaction_id: id, source, amount: String(amount), date, created_at: created });

  it("off: one settings read, nothing else", async () => {
    const pool = landedPool({ settings: { payday_alerts_enabled: false } });
    assert.equal((await pa.runPaydayLanded(pool, { today: TODAY })).status, "disabled");
    assert.equal(pool.calls.candidateSql, null);
  });

  it("first run after switching on sets the watermark and announces nothing older", async () => {
    const sent = [];
    const pool = landedPool({ settings: { payday_alerts_enabled: true, last_income_alert_at: null } });
    assert.equal((await pa.runPaydayLanded(pool, { today: TODAY, deps: { sendToAll: async (p) => sent.push(p) } })).status, "initialized");
    assert.deepEqual(pool.calls.updates, ["now()"]);
    assert.equal(sent.length, 0);
  });

  it("announces a deposit that matches a live stream, not a one-off; the watermark moves to the newest processed (as text)", async () => {
    const sent = [];
    const pool = landedPool({
      settings: { payday_alerts_enabled: true, last_income_alert_at: "2026-03-14 08:00:00.123456+00" },
      candidates: [
        cand("t1", "ACME PAYROLL", 2080, "2026-03-15", "2026-03-15 09:00:00.654321+00"),
        cand("t2", "IRS TREAS 310 TAX REF", 412, "2026-03-15", "2026-03-15 09:00:01.000001+00"),
        cand("t3", "ACME PAYROLL", 900, "2026-03-15", "2026-03-15 09:00:02.5+00"),
      ],
    });
    const r = await pa.runPaydayLanded(pool, { today: TODAY, deps: { sendToAll: async (p) => { sent.push(p); return { logged: true }; } } });
    assert.deepEqual([r.status, r.notified, r.considered], ["done", 1, 3]);
    assert.equal(sent[0].title, "Paycheck landed");
    assert.equal(sent[0].body, "$2,080.00 from ACME PAYROLL (biweekly) on Sun, Mar 15.");
    assert.match(sent[0].tag, /^payday-[0-9a-f]{12}$/);
    assert.deepEqual(pool.calls.updates, ["2026-03-15 09:00:02.5+00"], "the exact text, microseconds kept");
    assert.deepEqual(pool.calls.candidateParams, ["2026-03-14 08:00:00.123456+00", "2026-03-14"], "deposits dated within 5 days");
    assert.match(pool.calls.candidateSql, /amount < 0 AND pending = false/);
    assert.ok(pool.calls.candidateSql.includes(require("../teller/services/financial-queries").INCOME_PREDICATE));
  });

  it("a send that throws stops the run with the watermark just before that deposit", async () => {
    let n = 0;
    const pool = landedPool({
      settings: { payday_alerts_enabled: true, last_income_alert_at: "2026-03-01 00:00:00+00" },
      candidates: [
        cand("a", "IRS REFUND", 50, "2026-03-15", "2026-03-15 09:00:00+00"),
        cand("b", "ACME PAYROLL", 2100, "2026-03-15", "2026-03-15 09:00:01+00"),
        cand("c", "ACME PAYROLL", 2100, "2026-03-16", "2026-03-16 09:00:00+00"),
      ],
    });
    const quiet = console.error; console.error = () => {};
    let r;
    try { r = await pa.runPaydayLanded(pool, { today: TODAY, deps: { sendToAll: async () => { n++; throw new Error("push down"); } } }); }
    finally { console.error = quiet; }
    assert.equal(r.status, "held_back");
    assert.equal(n, 1);
    assert.deepEqual(pool.calls.updates, ["2026-03-15 09:00:00+00"], "only the unmatched row before the failure is past the watermark");
  });

  it("runs as the third post-sync step, after the anomaly check; its failure never rejects", async () => {
    const enr = require("../teller/routes/enrollments");
    const rename = require("../teller/routes/merchant-rename");
    const realApply = rename.applyRenameRules, realLanded = pa.runPaydayLanded;
    const order = [];
    rename.applyRenameRules = async () => { order.push("rename"); };
    dbModule.pool.query = async (sql) => {
      if (/last_anomaly_check_at FROM user_settings/.test(sql)) order.push("anomaly");
      return { rows: [] };
    };
    pa.runPaydayLanded = async () => { order.push("payday"); throw new Error("boom"); };
    const quiet = console.error; console.error = () => {};
    try { await enr.runPostSyncSteps(2); }
    finally { console.error = quiet; rename.applyRenameRules = realApply; pa.runPaydayLanded = realLanded; }
    assert.deepEqual(order, ["rename", "anomaly", "payday"]);
  });
});

// ---------------------------------------------------------------------------
describe("runPaydayMissed", () => {
  function missedPool({ enabled = true, syncAt = "2026-03-19T06:00:00Z", arrived = false, conn = { synced_at: new Date("2026-03-19T06:00:00Z") } } = {}) {
    const calls = { settings: 0, arrivedParams: [], connParams: [] };
    return {
      calls,
      query: async (sql, params) => {
        if (/SELECT payday_alerts_enabled,\s+GREATEST/.test(sql)) { calls.settings++; return { rows: [{ payday_alerts_enabled: enabled, sync_at: syncAt }] }; }
        if (/INTERVAL '4 months'/.test(sql)) return { rows: PAY_ROWS };
        if (/SELECT 1 FROM transactions/.test(sql)) { calls.arrivedParams.push(params); return { rows: arrived ? [{ "?column?": 1 }] : [] }; }
        if (/JOIN linked_accounts la/.test(sql)) { calls.connParams.push(params); return { rows: conn ? [conn] : [] }; }
        throw new Error("unexpected query: " + sql.slice(0, 60));
      },
    };
  }
  function deps({ logged = true, recent = false } = {}) {
    const sent = [], emails = [], tags = [];
    return {
      sent, emails, tags,
      sendToAll: async (p) => { sent.push(p); return { logged }; },
      sentRecently: async (t) => { tags.push(t); return recent; },
      sendEmail: async (t, b) => { emails.push({ t, b }); },
    };
  }
  const run = (pool, d, today = TODAY) => pa.runPaydayMissed(pool, { today, deps: d });

  it("an overdue payday on a connection that synced after the grace window → push + email", async () => {
    const d = deps();
    const pool = missedPool();
    const r = await run(pool, d);
    assert.deepEqual([r.status, r.notified, r.checked], ["done", 1, 1]);
    assert.equal(d.sent[0].title, "Payday missed?");
    assert.equal(d.sent[0].body, "Your biweekly pay from ACME PAYROLL (about $2,100.00) was expected on Sun, Mar 15 and hasn't arrived — your bank connection synced after that.");
    assert.match(d.sent[0].tag, /^payday-missed-[0-9a-f]{12}-2026-03-15$/);
    assert.deepEqual(d.sent[0].data, { url: "/transactions" });
    assert.deepEqual(d.emails, [{ t: "Payday missed?", b: d.sent[0].body }]);
    assert.deepEqual(pool.calls.arrivedParams, [["2026-03-12", "ACME PAYROLL"]], "any deposit since expected − 3 days");
    assert.deepEqual(pool.calls.connParams, [["2026-03-01", "ACME PAYROLL"]], "the account of the stream's last deposit");
  });

  it("a deposit from the source (any amount) since expected − 3 days → no alert", async () => {
    const d = deps();
    await run(missedPool({ arrived: true }), d);
    assert.equal(d.sent.length, 0);
  });

  it("no connection (CSV / manual) or no clean sync after the grace window → no alert", async () => {
    for (const conn of [null, { synced_at: null }, { synced_at: new Date("2026-03-18T23:00:00Z") }]) {
      pa._reset();
      const d = deps();
      await run(missedPool({ conn }), d);
      assert.equal(d.sent.length, 0, JSON.stringify(conn));
    }
  });

  it("deduped per (stream, expected date) through notification_log", async () => {
    const d = deps({ recent: true });
    await run(missedPool(), d);
    assert.equal(d.sent.length, 0);
    assert.equal(d.tags.length, 1);
  });

  it("evaluates once per local day + sync stamp; a new sync re-evaluates", async () => {
    const pool = missedPool();
    await run(pool, deps());
    assert.equal((await run(pool, deps())).status, "unchanged");
    const pool2 = missedPool({ syncAt: "2026-03-19T09:00:00Z" });
    assert.equal((await run(pool2, deps())).ran, true);
  });

  it("an unlogged push: no email, and the next tick retries", async () => {
    const d = deps({ logged: false });
    const pool = missedPool();
    assert.equal((await run(pool, d)).status, "unlogged");
    assert.equal(d.emails.length, 0);
    assert.equal((await run(pool, deps())).ran, true, "the memo wasn't set");
  });

  it("off: no further DB read that day until invalidate()", async () => {
    const pool = missedPool({ enabled: false });
    await run(pool, deps());
    await run(pool, deps());
    assert.equal(pool.calls.settings, 1);
    pa.invalidate();
    await run(pool, deps());
    assert.equal(pool.calls.settings, 2);
  });
});

// ---------------------------------------------------------------------------
describe("the shared cash-alerts tick", () => {
  const startup = require("../teller/startup");
  const ca = require("../teller/services/cash-alerts");
  const realCash = ca.runCashAlerts, realMissed = pa.runPaydayMissed;
  afterEach(() => { ca.runCashAlerts = realCash; pa.runPaydayMissed = realMissed; jobHealth._memoryResults.delete("cash-alerts"); });

  it("runs the payday check even when the cash alert throws, and records both outcomes", async () => {
    let missedRan = false;
    ca.runCashAlerts = async () => { throw new Error("db down"); };
    pa.runPaydayMissed = async () => { missedRan = true; return { status: "done", ran: true }; };
    const quiet = console.error; console.error = () => {};
    try { await startup._awayJobs.runCashAlertsTick(); } finally { console.error = quiet; }
    assert.equal(missedRan, true);
    assert.deepEqual(jobHealth._memoryResults.get("cash-alerts"), { status: "error", error: "cash alert: db down" });
  });

  it("ok when only the payday check evaluated; nothing when neither did", async () => {
    ca.runCashAlerts = async () => ({ status: "disabled", ran: false });
    pa.runPaydayMissed = async () => ({ status: "done", ran: true });
    await startup._awayJobs.runCashAlertsTick();
    assert.deepEqual(jobHealth._memoryResults.get("cash-alerts"), { status: "ok", error: null });
    jobHealth._memoryResults.delete("cash-alerts");
    pa.runPaydayMissed = async () => ({ status: "unchanged", ran: false });
    await startup._awayJobs.runCashAlertsTick();
    assert.equal(jobHealth._memoryResults.get("cash-alerts"), undefined);
    pa.runPaydayMissed = async () => ({ status: "unlogged", ran: true });
    await startup._awayJobs.runCashAlertsTick();
    assert.deepEqual(jobHealth._memoryResults.get("cash-alerts"), { status: "error", error: "payday alert: notification not logged" });
  });
});

// ---------------------------------------------------------------------------
describe("Settings — payday_alerts_enabled", () => {
  const app = () => { const a = express(); a.use(express.json()); a.use(require("../teller/routes/settings")); return a; };

  it("400 unless a boolean", async () => {
    dbModule.pool.query = async () => { throw new Error("must not write"); };
    for (const v of ["yes", 1, null]) await supertest(app()).patch("/api/settings").send({ payday_alerts_enabled: v }).expect(400);
  });

  it("switching on also moves the landed watermark to now (only when it was off); off leaves it", async () => {
    const sqls = [];
    dbModule.pool.query = async (s) => { if (/^UPDATE user_settings SET/.test(s)) sqls.push(s); return { rows: [{}] }; };
    await supertest(app()).patch("/api/settings").send({ payday_alerts_enabled: true }).expect(200);
    await supertest(app()).patch("/api/settings").send({ payday_alerts_enabled: false }).expect(200);
    assert.match(sqls[0], /payday_alerts_enabled = \$1, last_income_alert_at = CASE WHEN payday_alerts_enabled THEN last_income_alert_at ELSE now\(\) END/);
    assert.doesNotMatch(sqls[1], /last_income_alert_at/);
  });

  it("a change clears the missed check's off-for-today memo", async () => {
    let settings = 0;
    const pool = { query: async () => { settings++; return { rows: [{ payday_alerts_enabled: false }] }; } };
    const today = require("../teller/services/financial-queries").todayStr();
    await pa.runPaydayMissed(pool, { today });
    dbModule.pool.query = async () => ({ rows: [{}] });
    await supertest(app()).patch("/api/settings").send({ payday_alerts_enabled: true }).expect(200);
    await pa.runPaydayMissed(pool, { today });
    assert.equal(settings, 2);
  });

  it("GET defaults it off; the Settings page has the toggle", async () => {
    dbModule.pool.query = async () => ({ rows: [{ theme: "dark" }] });
    assert.equal((await supertest(app()).get("/api/settings").expect(200)).body.payday_alerts_enabled, false);
    const v = fs.readFileSync(path.join(__dirname, "../teller/views/settings.ejs"), "utf8");
    assert.match(v, /id="payday-alert-toggle" aria-label="Payday alerts"/);
    assert.match(v, /\['payday-alert-toggle', 'change', function\(\) \{ updateSetting\('payday_alerts_enabled', this\.checked\); \}\]/);
  });
});
