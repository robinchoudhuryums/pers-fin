// Real-Postgres contract test for roadmap T2.2 L2 — the low projected cash
// alert through the real forecast, notification log and settings route:
//  - off by default; switched on through PATCH /api/settings (a bad value 400s)
//  - a projected dip below the floor notifies once (notification_log 'cash-low')
//    and records the alert; a second tick with no new data is "unchanged", one
//    after new data is "held" (no second notification), one 72 h after the
//    alert notifies again
//  - more cash → "clear" and the alert is dropped; balances older than 36 h →
//    "skipped" with no notification
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("Low projected cash alert (T2.2 L2) on real Postgres", { skip: SKIP }, () => {
  let pool, app, ca, today, add;
  const q = (s, p) => pool.query(s, p);
  const alerts = async () => (await q("SELECT count(*)::int AS n FROM notification_log WHERE type = 'cash-low'")).rows[0].n;
  const state = async () => (await q("SELECT cash_alert_state, cash_alerts_checked_at FROM user_settings WHERE id = 1")).rows[0];

  before(async () => {
    pool = await perfinDb("cash_alerts_l2");
    app = perfinApp();
    ca = require("../../teller/services/cash-alerts");
    today = require("../../teller/services/financial-queries").todayStr();
    add = (n) => require("../../teller/services/cadence").addDaysStr(today, n);
    await q("INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual, current_balance, balance_updated_at) VALUES ('chk','Checking','depository','checking',true,2000, now())");
    // A $1,500 bill in 3 days takes the projected balance to $500.
    await q(`INSERT INTO detected_subscriptions (merchant_key, display_name, amount, cadence_days, first_seen, last_charged, next_expected, is_active)
             VALUES ('landlord','Landlord',1500,30,$1,$2,$3,true)`, [add(-90), add(-27), add(3)]);
  });
  after(async () => { if (pool) await pool.end(); });

  it("is off by default; PATCH /api/settings switches it on and rejects bad values", async () => {
    ca._reset();
    assert.equal((await ca.runCashAlerts(pool)).status, "disabled");
    await supertest(app).patch("/api/settings").send({ cash_alert_threshold: "" }).expect(400);
    await supertest(app).patch("/api/settings").send({ cash_alert_horizon_days: 90 }).expect(400);
    const s = (await supertest(app).patch("/api/settings").send({ cash_alert_enabled: true, cash_alert_threshold: 1000, cash_alert_horizon_days: 14 }).expect(200)).body;
    assert.deepEqual([s.cash_alert_enabled, parseFloat(s.cash_alert_threshold), s.cash_alert_horizon_days], [true, 1000, 14]);
  });

  it("a dip below the floor notifies once; no new data → unchanged; new data → held", async () => {
    const r = await ca.runCashAlerts(pool);
    assert.equal(r.status, "notified");
    assert.deepEqual(r.breach, { date: add(3), balance: 500 });
    assert.equal(await alerts(), 1);
    const st = await state();
    assert.equal(st.cash_alert_state.alert.breach_date, add(3));
    assert.equal(st.cash_alert_state.last_check.outcome, "notified");
    const row = (await q("SELECT title, data FROM notification_log WHERE type = 'cash-low'")).rows[0];
    assert.equal(row.title, "Low cash ahead");
    assert.deepEqual(row.data, { url: "/dashboard" });

    assert.equal((await ca.runCashAlerts(pool)).status, "unchanged");
    await q("UPDATE linked_accounts SET balance_updated_at = now() + interval '1 second'");
    assert.equal((await ca.runCashAlerts(pool)).status, "held");
    assert.equal(await alerts(), 1);
  });

  it("72 h after the alert, a breach that persists notifies again", async () => {
    await q(`UPDATE user_settings SET cash_alert_state = jsonb_set(cash_alert_state, '{alert,notified_at}', to_jsonb((now() - interval '73 hours')::text)),
                                      cash_alerts_checked_at = now() - interval '2 days' WHERE id = 1`);
    assert.equal((await ca.runCashAlerts(pool)).status, "notified");
    assert.equal(await alerts(), 2);
  });

  it("more cash → clear (the alert dropped); a 40-hour-old balance → skipped", async () => {
    await q("UPDATE linked_accounts SET current_balance = 9000, balance_updated_at = now() + interval '2 seconds'");
    assert.equal((await ca.runCashAlerts(pool)).status, "clear");
    assert.equal((await state()).cash_alert_state.alert, null);

    await q("UPDATE linked_accounts SET current_balance = 100, balance_updated_at = now() - interval '40 hours'");
    await q("UPDATE user_settings SET cash_alerts_checked_at = now() - interval '2 days' WHERE id = 1");
    const r = await ca.runCashAlerts(pool);
    assert.deepEqual([r.status, r.reason], ["skipped", "stale_balances"]);
    assert.equal(await alerts(), 2, "no alert on stale data");
    assert.equal((await state()).cash_alert_state.last_check.reason, "stale_balances");
  });
});
