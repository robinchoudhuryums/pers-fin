// Roadmap T4.1 A4 — "Tell me when my plan changes" (services/advice-alerts.js):
// the pure change test (step, target debt, amount ≥ 20% and ≥ $50, a unit
// change compared monthly), the notification text over REAL plans from the
// engine ("Visa is paid off — …"), runAdviceAlerts over a fake pool (off → one
// settings read a day until invalidate(); at most one evaluation a local day;
// the first run a silent baseline; a change pushed once with tag advice-plan
// and never emailed; an unlogged push leaving the day unchecked and the
// signature unmoved; a plan that can't be worked out changing nothing), the
// hourly away job's wiring and outcome, PATCH /api/settings (400s, the
// baseline reset on switch-on), GET's default, the migration and the
// Settings checkbox.
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://localhost/test";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
afterEach(() => { dbModule.pool.query = originalQuery; });

const advice = require("../teller/services/advice");
const aa = require("../teller/services/advice-alerts");
const jobHealth = require("../teller/services/job-health");
const scheduled = (name) => {
  const st = require("../teller/startup");
  st.startBackgroundJobs();
  const job = st._scheduler.runner().list().find((j) => j.name === name);
  st.stopBackgroundJobs();
  return job;
};
beforeEach(() => aa._reset());

const TODAY = "2026-10-27";
const VISA = { id: 1, account_id: "c1", name: "Visa", type: "credit", current_balance: "3000", apr: "24.99", minimum_payment: "90" };
const STORE = { id: 2, account_id: "c2", name: "Store card", type: "credit", current_balance: "800", apr: null, available_balance: "1200" };
function plan(over = {}) {
  return advice.buildAdvicePlan({
    today: TODAY, errors: [],
    months: [{ month: "2026-07", income: 5000, spending: 3500 }, { month: "2026-08", income: 5000, spending: 3600 }, { month: "2026-09", income: 5000, spending: 3400 }],
    streams: [{ source: "ACME", amount: 2500, cadence: "semimonthly" }],
    cash: { starting_balance: 15000, lowest: { date: "2026-11-20", balance: 14000 } },
    settings: { cash_alert_threshold: "500" },
    debts: [VISA, STORE],
    activity: [{ account_id: "c1", txns: 3, interest: true }, { account_id: "c2", txns: 3, interest: true }],
    transfers: [],
    ...over,
  });
}
// Visa paid off and cash low → the emergency fund step.
const paidOff = () => plan({
  debts: [{ ...VISA, current_balance: "0" }], activity: [{ account_id: "c1", txns: 3, interest: false }],
  cash: { starting_balance: 4000, lowest: { date: "2026-11-20", balance: 3500 } },
});

function sig(over = {}) {
  return { step: "emergency_fund", target: null, unit: "paycheck", amount: 400, amount_monthly: 800, at: "x", ...over };
}

// ---------------------------------------------------------------------------
describe("T4.1 A4 — planChange (pure)", () => {
  it("nothing without a previous signature, or when nothing moved", () => {
    assert.equal(aa.planChange(null, sig()), null);
    assert.equal(aa.planChange(sig(), sig()), null);
  });

  it("a new headline step is a change", () => {
    assert.deepEqual(aa.planChange(sig({ step: "high_interest_debt", target: "Visa" }), sig()), { kind: "step" });
  });

  it("a debt step's new target debt is a change; the same target isn't", () => {
    const debt = (target) => sig({ step: "high_interest_debt", target });
    assert.deepEqual(aa.planChange(debt("Visa"), debt("Store card")), { kind: "target" });
    assert.equal(aa.planChange(debt("Visa"), debt("Visa")), null);
  });

  it("the amount needs both 20% and $50", () => {
    assert.deepEqual(aa.planChange(sig({ amount: 400 }), sig({ amount: 320 })), { kind: "amount" }); // -80, 20%
    assert.equal(aa.planChange(sig({ amount: 400 }), sig({ amount: 330 })), null); // 17.5%
    assert.equal(aa.planChange(sig({ amount: 200 }), sig({ amount: 160 })), null); // 20% but $40
    assert.deepEqual(aa.planChange(sig({ amount: 200 }), sig({ amount: 250 })), { kind: "amount" }); // 25%, $50
    assert.deepEqual(aa.planChange(sig({ amount: 0, amount_monthly: 0 }), sig({ amount: 50, amount_monthly: 100 })), { kind: "amount" });
  });

  it("a unit change (a paycheck found) is compared monthly", () => {
    // $800 a month → $400 per paycheck twice a month: the same money.
    assert.equal(aa.planChange(sig({ unit: "month", amount: 800, amount_monthly: 800 }), sig()), null);
    assert.deepEqual(aa.planChange(sig({ unit: "month", amount: 500, amount_monthly: 500 }), sig()), { kind: "amount" });
  });
});

// ---------------------------------------------------------------------------
describe("T4.1 A4 — signature and text over real plans", () => {
  it("signatureOf reads the step, the target debt, the unit and both amounts", () => {
    const s = aa.signatureOf(plan(), "at");
    assert.deepEqual(s, { step: "high_interest_debt", target: "Visa", unit: "paycheck", amount: 400, amount_monthly: 800, at: "at" });
    assert.equal(aa.signatureOf(paidOff(), "at").target, null);
  });

  it("a paid-off target leads the text (step change)", () => {
    const prev = aa.signatureOf(plan(), "a"), next = paidOff(), s = aa.signatureOf(next, "b");
    const change = aa.planChange(prev, s);
    assert.deepEqual(change, { kind: "step" });
    assert.equal(aa.changeText(prev, s, next, change), "Visa is paid off — your plan now puts $450 per paycheck toward the emergency fund.");
  });

  it("a paid-off target leads the text when the next debt takes over", () => {
    const prev = aa.signatureOf(plan(), "a");
    const next = plan({ debts: [STORE], activity: [{ account_id: "c2", txns: 3, interest: true }] });
    const s = aa.signatureOf(next, "b");
    assert.equal(aa.changeText(prev, s, next, aa.planChange(prev, s)), "Visa is paid off — your plan now puts $425 per paycheck toward Store card.");
  });

  it("a still-owed target says the plan changed; an amount move says what it was", () => {
    const next = paidOff(), s = aa.signatureOf(next, "b");
    // Visa still carried in the new plan → not "paid off".
    const owed = { ...next, debts: [{ name: "Visa", balance: 2000, carried: true }] };
    const prev = sig({ step: "high_interest_debt", target: "Visa" });
    assert.equal(aa.changeText(prev, s, owed, { kind: "step" }), "Your plan changed — it now puts $450 per paycheck toward the emergency fund.");
    // Still a balance, but paid in full each month now → not debt → paid off.
    const inFull = { ...next, debts: [{ name: "Visa", balance: 300, carried: false }] };
    assert.equal(aa.changeText(prev, s, inFull, { kind: "step" }), "Visa is paid off — your plan now puts $450 per paycheck toward the emergency fund.");
    assert.equal(aa.changeText(sig({ amount: 600 }), s, next, { kind: "amount" }), "Your plan now puts $450 per paycheck toward the emergency fund (was $600 per paycheck).");
    assert.equal(aa.changeText(sig({ unit: "month", amount: 1300, amount_monthly: 1300 }), s, next, { kind: "amount" }), "Your plan now puts $450 per paycheck toward the emergency fund (was $1,300 a month).");
  });

  it("a $0 amount or the minimums step uses the plan's own headline", () => {
    const next = paidOff();
    const zero = { ...aa.signatureOf(next, "b"), amount: 0 };
    assert.equal(aa.changeText(sig(), zero, next, { kind: "amount" }), next.headline.text);
    const short = { ...next, headline: { ...next.headline, step: "minimums", text: "Your recent months don't cover your minimums." } };
    assert.equal(aa.changeText(sig(), aa.signatureOf(short, "c"), short, { kind: "step" }), "Your recent months don't cover your minimums.");
  });
});

// ---------------------------------------------------------------------------
// A fake pool: the settings row and every advice_state write.
function fakePool(row) {
  const calls = { reads: 0, writes: [] };
  return {
    calls,
    async query(sql, params) {
      if (/^SELECT advice_alerts_enabled, advice_state FROM user_settings/.test(sql)) { calls.reads++; return { rows: [row()] }; }
      if (/^UPDATE user_settings SET advice_state = \$1::jsonb WHERE id = 1$/.test(sql)) { calls.writes.push(JSON.parse(params[0])); return { rows: [] }; }
      throw new Error("unexpected SQL: " + sql);
    },
  };
}

describe("T4.1 A4 — runAdviceAlerts", () => {
  const NOW = new Date("2026-10-27T15:00:00Z");
  function run(pool, { getPlan = async () => plan(), sendToAll = async () => ({ logged: true }), today = TODAY } = {}) {
    return aa.runAdviceAlerts(pool, { now: NOW, today, deps: { getPlan, sendToAll } });
  }

  it("off: one settings read, then none for the rest of the day until invalidate()", async () => {
    const pool = fakePool(() => ({ advice_alerts_enabled: false }));
    let planned = 0;
    const getPlan = async () => { planned++; return plan(); };
    assert.equal((await run(pool, { getPlan })).status, "disabled");
    await run(pool, { getPlan });
    assert.equal(pool.calls.reads, 1);
    aa.invalidate();
    await run(pool, { getPlan });
    assert.equal(pool.calls.reads, 2);
    await run(pool, { getPlan, today: "2026-10-28" });
    assert.equal(pool.calls.reads, 3);
    assert.equal(planned, 0);
  });

  it("the first run records a baseline without notifying", async () => {
    let state = null;
    const pool = fakePool(() => ({ advice_alerts_enabled: true, advice_state: state }));
    let sent = 0;
    const r = await run(pool, { sendToAll: async () => { sent++; return { logged: true }; } });
    assert.equal(r.status, "baseline");
    assert.equal(sent, 0);
    const w = pool.calls.writes[0];
    assert.equal(w.checked_on, TODAY);
    assert.equal(w.signature.step, "high_interest_debt");
    assert.equal(w.signature.target, "Visa");
    assert.equal(w.last_check.outcome, "baseline");
  });

  it("at most one evaluation a local day — the stored day and the memo", async () => {
    const state = { signature: aa.signatureOf(plan(), "x"), checked_on: TODAY };
    const pool = fakePool(() => ({ advice_alerts_enabled: true, advice_state: state }));
    let planned = 0;
    const getPlan = async () => { planned++; return plan(); };
    assert.equal((await run(pool, { getPlan })).status, "checked");
    await run(pool, { getPlan });
    assert.equal(pool.calls.reads, 1); // the memo skips the read
    assert.equal(planned, 0);
    assert.equal(pool.calls.writes.length, 0);
  });

  it("unchanged: stamps the day, keeps the signature, no push", async () => {
    const prev = aa.signatureOf(plan(), "x");
    const pool = fakePool(() => ({ advice_alerts_enabled: true, advice_state: { signature: prev, checked_on: "2026-10-26" } }));
    let sent = 0;
    const r = await run(pool, { sendToAll: async () => { sent++; return { logged: true }; } });
    assert.equal(r.status, "unchanged");
    assert.equal(sent, 0);
    assert.deepEqual(pool.calls.writes[0].signature, prev);
    assert.equal(pool.calls.writes[0].checked_on, TODAY);
    // Evaluated → the rest of the day costs nothing.
    await run(pool);
    assert.equal(pool.calls.reads, 1);
  });

  it("a change: one push (tag advice-plan, /dashboard, never email), the signature advanced", async () => {
    const prev = aa.signatureOf(plan(), "x");
    const pool = fakePool(() => ({ advice_alerts_enabled: true, advice_state: { signature: prev, checked_on: "2026-10-26" } }));
    const pushes = [];
    const r = await run(pool, { getPlan: async () => paidOff(), sendToAll: async (p) => { pushes.push(p); return { logged: true }; } });
    assert.equal(r.status, "notified");
    assert.deepEqual(pushes, [{ title: "Your plan changed", body: "Visa is paid off — your plan now puts $450 per paycheck toward the emergency fund.", tag: "advice-plan", data: { url: "/dashboard" } }]);
    const w = pool.calls.writes[0];
    assert.equal(w.signature.step, "emergency_fund");
    assert.equal(w.notified_at, NOW.toISOString());
    assert.deepEqual(w.last_check, { at: NOW.toISOString(), outcome: "notified", kind: "step" });
    // The module never reaches for email.
    assert.doesNotMatch(read("teller/services/advice-alerts.js"), /sendCriticalAlertEmail|sendEmail/);
  });

  it("an unlogged push leaves the day unchecked and the signature unmoved, so the next tick retries", async () => {
    const prev = aa.signatureOf(plan(), "x");
    const pool = fakePool(() => ({ advice_alerts_enabled: true, advice_state: { signature: prev, checked_on: "2026-10-26" } }));
    const quiet = console.error; console.error = () => {};
    let r;
    try { r = await run(pool, { getPlan: async () => paidOff(), sendToAll: async () => ({ logged: false }) }); }
    finally { console.error = quiet; }
    assert.equal(r.status, "unlogged");
    assert.equal(pool.calls.writes.length, 0);
    let sent = 0;
    const again = await run(pool, { getPlan: async () => paidOff(), sendToAll: async () => { sent++; return { logged: true }; } });
    assert.equal(again.status, "notified");
    assert.equal(sent, 1);
  });

  it("a plan that can't be worked out changes nothing but the day", async () => {
    const prev = aa.signatureOf(plan(), "x");
    const pool = fakePool(() => ({ advice_alerts_enabled: true, advice_state: { signature: prev, checked_on: "2026-10-26" } }));
    let sent = 0;
    const r = await run(pool, { getPlan: async () => ({ ok: false, error: "Not enough history." }), sendToAll: async () => { sent++; return { logged: true }; } });
    assert.equal(r.status, "no_plan");
    assert.equal(sent, 0);
    assert.deepEqual(pool.calls.writes[0].signature, prev);
    assert.equal(pool.calls.writes[0].last_check.outcome, "no_plan");
  });

  it("a slow drift is compared with the last notified plan, not yesterday's", async () => {
    const base = sig({ amount: 400, amount_monthly: 800 });
    let state = { signature: base, checked_on: "2026-10-20" };
    const pool = fakePool(() => ({ advice_alerts_enabled: true, advice_state: state }));
    const fake = (amount) => async () => ({ ok: true, period: { unit: "paycheck" }, headline: { step: "emergency_fund", text: "t", amount_monthly: amount * 2, amount_per_period: amount }, debts: [], allocation: { debts: [] } });
    // Day 1: $360 (-10%) — unchanged. Day 2: $320 (-20% vs $400) — notified.
    let r = await aa.runAdviceAlerts(pool, { now: NOW, today: "2026-10-21", deps: { getPlan: fake(360), sendToAll: async () => ({ logged: true }) } });
    assert.equal(r.status, "unchanged");
    state = pool.calls.writes.at(-1);
    r = await aa.runAdviceAlerts(pool, { now: NOW, today: "2026-10-22", deps: { getPlan: fake(320), sendToAll: async () => ({ logged: true }) } });
    assert.equal(r.status, "notified");
    assert.equal(r.body, "Your plan now puts $320 per paycheck toward the emergency fund (was $400 per paycheck).");
  });
});

// ---------------------------------------------------------------------------
describe("T4.1 A4 — the advice-plan away job", () => {
  const startup = require("../teller/startup");
  const real = aa.runAdviceAlerts;
  afterEach(() => { aa.runAdviceAlerts = real; jobHealth._memoryResults.delete("advice-plan"); });

  it("records ok only when it evaluated, an error on a throw or an unlogged push", async () => {
    aa.runAdviceAlerts = async () => ({ status: "checked", ran: false });
    await startup._awayJobs.runAdvicePlanTick();
    assert.equal(jobHealth._memoryResults.get("advice-plan"), undefined);
    aa.runAdviceAlerts = async () => ({ status: "unchanged", ran: true });
    await startup._awayJobs.runAdvicePlanTick();
    assert.deepEqual(jobHealth._memoryResults.get("advice-plan"), { status: "ok", error: null });
    aa.runAdviceAlerts = async () => ({ status: "unlogged", ran: true });
    await startup._awayJobs.runAdvicePlanTick();
    assert.deepEqual(jobHealth._memoryResults.get("advice-plan"), { status: "error", error: "notification not logged" });
    aa.runAdviceAlerts = async () => { throw new Error("db down"); };
    const quiet = console.error; console.error = () => {};
    try { await startup._awayJobs.runAdvicePlanTick(); } finally { console.error = quiet; }
    assert.deepEqual(jobHealth._memoryResults.get("advice-plan"), { status: "error", error: "db down" });
  });

  it("is hourly, watched, boot-run and not activity-gated", () => {
    assert.equal(jobHealth.JOB_INTERVALS_MS["advice-plan"], 60 * 60 * 1000);
    const src = read("teller/startup.js");
    // Cycle-8 E2b: scheduled by the job runner, hourly, with no activity gate.
    assert.deepEqual(scheduled("advice-plan"), { name: "advice-plan", everyMs: 60 * 60 * 1000, gated: false });
    assert.match(src, /\["advice-plan", runAdvicePlanTick\],/);
    const body = src.slice(src.indexOf("async function runAdvicePlanTick"), src.indexOf("async function runLinkedTasksTick"));
    assert.doesNotMatch(body, /isUserActive/);
    assert.match(body, /^async function runAdvicePlanTick\(\) \{\n  jobHealth\.tick\("advice-plan"\);/);
  });
});

// ---------------------------------------------------------------------------
describe("T4.1 A4 — Settings", () => {
  const app = () => { const a = express(); a.use(express.json()); a.use(require("../teller/routes/settings")); return a; };

  it("400 unless a boolean", async () => {
    dbModule.pool.query = async () => { throw new Error("must not write"); };
    for (const v of ["yes", 1, null]) await supertest(app()).patch("/api/settings").send({ advice_alerts_enabled: v }).expect(400);
  });

  it("switching on drops the stored signature (only when it was off); off leaves it", async () => {
    const sqls = [];
    dbModule.pool.query = async (s) => { if (/^UPDATE user_settings SET/.test(s)) sqls.push(s); return { rows: [{}] }; };
    await supertest(app()).patch("/api/settings").send({ advice_alerts_enabled: true }).expect(200);
    await supertest(app()).patch("/api/settings").send({ advice_alerts_enabled: false }).expect(200);
    assert.match(sqls[0], /advice_alerts_enabled = \$1, advice_state = CASE WHEN advice_alerts_enabled THEN advice_state ELSE NULL END/);
    assert.doesNotMatch(sqls[1], /advice_state/);
  });

  it("a change clears the job's memo", async () => {
    const pool = fakePool(() => ({ advice_alerts_enabled: false }));
    await aa.runAdviceAlerts(pool, { today: TODAY });
    await aa.runAdviceAlerts(pool, { today: TODAY });
    assert.equal(pool.calls.reads, 1);
    dbModule.pool.query = async () => ({ rows: [{}] });
    await supertest(app()).patch("/api/settings").send({ advice_alerts_enabled: true }).expect(200);
    await aa.runAdviceAlerts(pool, { today: TODAY });
    assert.equal(pool.calls.reads, 2);
  });

  it("GET defaults it off; the migration adds both columns; the Cash Alerts section has the labelled checkbox", async () => {
    dbModule.pool.query = async () => ({ rows: [{ theme: "dark" }] });
    const body = (await supertest(app()).get("/api/settings").expect(200)).body;
    assert.equal(body.advice_alerts_enabled, false);
    assert.equal(body.advice_state, null);
    const db = read("teller/services/database.js");
    assert.match(db, /ADD COLUMN IF NOT EXISTS advice_alerts_enabled BOOLEAN NOT NULL DEFAULT false/);
    assert.match(db, /ADD COLUMN IF NOT EXISTS advice_state JSONB/);
    const v = read("teller/views/settings.ejs");
    const section = v.slice(v.indexOf('id="cash-alerts-section"'), v.indexOf('id="linked-tasks-section"'));
    assert.match(section, /id="advice-alert-toggle" aria-label="Tell me when my plan changes"/);
    assert.match(section, /Push only, never email/);
    assert.match(v, /\['advice-alert-toggle', 'change', function\(\) \{ saveToggle\(this, 'advice_alerts_enabled'\); \}\]/);
    assert.match(v, /getElementById\('advice-alert-toggle'\)\.checked = !!s\.advice_alerts_enabled/);
  });
});
