// Real-Postgres contract test for the cycle-9 Batch 5 follow-on items, with
// both apps' real databases wired the way the shell wires them and web-push
// stubbed:
//  - FO-2: a retry that gives up is stored 'failed' (the migrated CHECK takes
//    it); a hold that gives up is still 'expired'
//  - FO-3: a PIN-lockout push that failed is pushed during quiet hours; a held
//    push still waits
//  - FO-4: a 403 from the push service is 'none', not a retry, and the
//    subscription is kept
//  - FO-5: a held push stores hold_until; quiet hours switched off since, it
//    is still pushed within 12 hours of that end
//  - FO-6: Per-sistant's PATCH /api/settings refuses "false", an hour of 24 and
//    a malformed layout without changing anything, and stores valid values
//  - FO-7: with two months owed, the rent push is covered and Per-sistant's
//    line hidden by the LATER month's showing task; a task for a month that
//    isn't owed does neither
const Module = require("module");
const pushed = [];
let pushStatus = null;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "web-push") {
    return {
      setVapidDetails() {},
      async sendNotification(_sub, payload) {
        if (pushStatus) { const e = new Error("push " + pushStatus); e.statusCode = pushStatus; throw e; }
        pushed.push(JSON.parse(payload));
      },
    };
  }
  return origLoad.apply(this, arguments);
};
process.env.VAPID_PUBLIC_KEY = "pub";
process.env.VAPID_PRIVATE_KEY = "priv";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, persistentDb, perfinApp, persistentApp } = require("./_setup");

describe("cycle-9 Batch 5 follow-ons across both apps on real Postgres", { skip: SKIP }, () => {
  let psPool, pfPool, psApp, pfApp, notifications, housing, today, month, prevMonth, nextMonth;
  const pf = (s, p) => pfPool.query(s, p);
  const ps = (s, p) => psPool.query(s, p);
  const log = async () => (await pf("SELECT type, title, push_state, item_key, is_read, data, hold_until FROM notification_log ORDER BY id")).rows;
  const quiet = async (fn) => {
    const e = console.error; console.error = () => {};
    try { return await fn(); } finally { console.error = e; }
  };
  const settings = (body) => supertest(pfApp).patch("/api/settings").send(body);
  // Every time is relative to the real clock (created_at is the database's now()).
  const H = new Date().getUTCHours();
  const hh = (k) => String(((H + k) % 24 + 24) % 24).padStart(2, "0") + ":00";
  const quietHours = async (q) => { await settings({ notify_quiet_hours: q }).expect(200); notifications.invalidateNotifyPrefs(); };
  const fresh = async () => { await pf("DELETE FROM notification_log"); pushed.length = 0; pushStatus = null; notifications._release.reset({ heldPending: false }); };
  const shift = (ym, k) => { const [y, m] = ym.split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 + k, 1)); return d.toISOString().slice(0, 7); };

  before(async () => {
    psPool = await persistentDb("c9_b5_followons");
    pfPool = await perfinDb("c9_b5_followons");
    psApp = persistentApp(psPool);
    psApp.set("perfinPool", pfPool);
    pfApp = perfinApp();
    pfApp.set("persistentPool", psPool);
    require("../../teller/routes/persistent").setEmbeddedPersistentPool(psPool);
    notifications = require("../../teller/routes/notifications");
    housing = require("../../teller/routes/housing");
    today = require("../../teller/services/financial-queries").todayStr();
    month = today.slice(0, 7);
    prevMonth = shift(month, -1);
    nextMonth = shift(month, 1);
    await pf("INSERT INTO push_subscriptions (endpoint, keys) VALUES ('https://push.example/1', $1)",
      [JSON.stringify({ endpoint: "https://push.example/1", keys: {} })]);
  });
  after(async () => {
    Module._load = origLoad;
    require("../../teller/routes/persistent").setEmbeddedPersistentPool(null);
    if (psPool) await psPool.end();
    if (pfPool) await pfPool.end();
  });

  // ---------------------------------------------------------------- FO-5
  it("FO-5: a held push stores when its quiet hours end, and that end still counts once they're switched off", async () => {
    await fresh();
    await quietHours({ enabled: true, start: hh(-1), end: hh(2) });
    const r = await notifications.sendToAll({ title: "Low cash ahead", body: "b", tag: "cash-low", data: { url: "/dashboard" } });
    assert.equal(r.push_state, "held");
    const held = (await pf(`SELECT hold_until > now() AS ahead, hold_until <= now() + interval '2 hours' AS near,
                                   abs(extract(epoch FROM hold_until - date_trunc('hour', hold_until + interval '30 minutes'))) < 60 AS on_the_hour
                              FROM notification_log`)).rows[0];
    // (Whole minutes from the send, so within a minute of the hour.)
    assert.deepEqual(held, { ahead: true, near: true, on_the_hour: true }, "hold_until is the end of the quiet hours it was held in");
    // As if it had been held 13 hours ago, in quiet hours that ended an hour ago…
    await pf("UPDATE notification_log SET created_at = now() - interval '13 hours', hold_until = now() - interval '1 hour'");
    // …which have since been switched off: by today's settings it was never
    // held, so it used to be "13 hours old" and expire.
    await quietHours({ enabled: false, start: "22:00", end: "07:00" });
    const rel = await notifications.releaseHeldNotifications({ now: new Date() });
    assert.deepEqual([rel.outcome, rel.released, rel.expired], ["released", 1, 0]);
    assert.deepEqual(pushed.map((p) => p.title), ["Low cash ahead"]);
  });

  // ---------------------------------------------------------------- FO-2
  it("FO-2: a retry past its 12 hours is stored 'failed'; a hold past them 'expired'; another value is refused", async () => {
    await fresh();
    await quietHours({ enabled: false, start: "22:00", end: "07:00" });
    await pf(`INSERT INTO notification_log (type, title, body, data, push_state, created_at) VALUES
                ('anomaly-acme', 'Failed yesterday', 'b', '{}', 'retry', now() - interval '13 hours'),
                ('cash-low', 'Held yesterday', 'b', '{}', 'held', now() - interval '13 hours')`);
    notifications._release.reset({ heldPending: true });
    const rel = await notifications.releaseHeldNotifications({ now: new Date() });
    assert.deepEqual([rel.ok, rel.outcome, rel.expired], [true, "expired", 2]);
    assert.deepEqual((await log()).map((l) => [l.title, l.push_state]), [["Failed yesterday", "failed"], ["Held yesterday", "expired"]]);
    assert.equal(pushed.length, 0);
    await assert.rejects(pf("INSERT INTO notification_log (type, title, body, data, push_state) VALUES ('t', 't', 'b', '{}', 'gave_up')"), /push_state/);
  });

  // ---------------------------------------------------------------- FO-4
  it("FO-4: a 403 from the push service is not retried and the subscription stays", async () => {
    await fresh();
    await quietHours({ enabled: false, start: "22:00", end: "07:00" });
    pushStatus = 403;
    const r = await quiet(() => notifications.sendToAll({ title: "Unusual charge", body: "b", tag: "anomaly-acme" }));
    assert.deepEqual(r, { sent: 0, failed: 1, logged: true, push_state: "none" });
    assert.deepEqual((await log()).map((l) => l.push_state), ["none"]);
    assert.equal(notifications.releaseDue(), false, "nothing is waiting — the release job isn't asked to run");
    assert.equal((await pf("SELECT count(*)::int AS n FROM push_subscriptions")).rows[0].n, 1);
    // A 503 is still kept for another try.
    pushStatus = 503;
    assert.equal((await quiet(() => notifications.sendToAll({ title: "Again", body: "b", tag: "anomaly-acme" }))).push_state, "retry");
  });

  // ---------------------------------------------------------------- FO-3
  it("FO-3: a failed PIN-lockout push goes out during quiet hours; a held push waits for their end", async () => {
    await fresh();
    await quietHours({ enabled: true, start: hh(-1), end: hh(2) });
    assert.equal((await notifications.sendToAll({ title: "Low cash ahead", body: "b", tag: "cash-low" })).push_state, "held");
    pushStatus = 503;
    assert.equal((await quiet(() => notifications.sendToAll({ title: "PIN login locked", body: "b", tag: "pin-lockout", data: { url: "/settings" } }))).push_state, "retry");
    assert.equal(notifications.releaseDue(), true, "it used to wait for the end of quiet hours");
    pushStatus = null;
    const rel = await notifications.releaseHeldNotifications({ now: new Date() });
    assert.deepEqual([rel.ok, rel.outcome, rel.released], [true, "released", 1]);
    assert.deepEqual(pushed, [{ title: "PIN login locked", body: "b", tag: "pin-lockout", data: { url: "/settings" } }]);
    assert.deepEqual((await log()).map((l) => [l.type, l.push_state]), [["cash-low", "held"], ["pin-lockout", "sent"]]);
    assert.equal(notifications.releaseDue(), false, "the held push waits");
    await quietHours({ enabled: false, start: "22:00", end: "07:00" });
    assert.equal((await notifications.releaseHeldNotifications({ now: new Date() })).released, 1);
  });

  // ---------------------------------------------------------------- FO-7
  describe("FO-7 — two months owed", () => {
    // "Today" for the reminder's own window is the 3rd of this month (the
    // function takes it); whether a task covers is asked about the real day.
    let third;
    const key = (ym) => `perfin:housing:${ym}`;
    const remind = async () => { await fresh(); notifications.invalidateNotifyPrefs(); return housing.runHousingReminders(pfPool, third); };
    const rentLine = async () => (await supertest(psApp).get("/api/notifications/check").expect(200)).body.notifications.find((n) => n.type === "housing_due");

    before(async () => {
      third = `${month}-03`;
      await pf("UPDATE user_settings SET housing_config = $1 WHERE id = 1", [JSON.stringify({
        enabled: true, payee_name: "Sam Lee", rent_amount: 1800, rent_due_day: 1, reminder_lead_days: 2, start_month: prevMonth, utilities: [],
      })]);
      await pf(`INSERT INTO payee_obligations (payee, period, category, label, amount, status, due_day)
                VALUES ('Sam Lee', $1, 'rent', 'Rent', 1800, 'unpaid', 1), ('Sam Lee', $2, 'rent', 'Rent', 1800, 'unpaid', 1)`, [prevMonth, month]);
      // Last month's task was ticked off by hand (the rent wasn't recorded as
      // paid); this month's is open and due today.
      await ps(`INSERT INTO todos (title, source_app, source_key, source_url, due_date)
                VALUES ('Pay rent', 'perfin', $1, '/housing', $3), ('Pay rent', 'perfin', $2, '/housing', $4)`,
        [key(prevMonth), key(month), `${prevMonth}-01`, today]);
      await ps("UPDATE todos SET completed = true, completed_at = now() WHERE source_key = $1", [key(prevMonth)]);
    });

    it("this month's showing task covers the push (logged under the oldest month) and hides Per-sistant's line", async () => {
      assert.equal((await remind()).sent, 1);
      const rows = await log();
      // It used to be pushed: only last month's (completed) task was asked about.
      assert.deepEqual(rows.map((l) => [l.push_state, l.item_key, l.is_read]), [["covered", `housing:${prevMonth}`, true]]);
      assert.deepEqual(rows[0].data.cover_items, [`housing:${month}`]);
      assert.equal(pushed.length, 0);
      assert.equal(await rentLine(), undefined);
    });

    it("that task completed too: the push goes out and the line shows — a task for a month that isn't owed changes nothing", async () => {
      await ps("UPDATE todos SET completed = true, completed_at = now() WHERE source_key = $1", [key(month)]);
      await ps(`INSERT INTO todos (title, source_app, source_key, source_url, due_date) VALUES ('Pay rent', 'perfin', $1, '/housing', $2)`, [key(nextMonth), today]);
      assert.equal((await remind()).sent, 1);
      assert.deepEqual((await log()).map((l) => [l.push_state, l.item_key]), [["sent", `housing:${prevMonth}`]]);
      assert.equal(pushed.length, 1);
      assert.equal(pushed[0].item, undefined);
      assert.deepEqual(pushed[0].data, { url: "/housing" }, "the cover items stay in the log row");
      const line = await rentLine();
      assert.deepEqual([line.item, line.status], [`housing:${prevMonth}`, "overdue"]);
    });
  });

  // ---------------------------------------------------------------- FO-6
  describe("FO-6 — Per-sistant's settings", () => {
    const patch = (body) => supertest(psApp).patch("/api/settings").send(body);
    const COLS = "vault_enabled, job_radar_enabled, keep_alive_enabled, keep_alive_start, keep_alive_end, keep_alive_timezone, session_timeout_minutes, default_horizon, dashboard_layout";
    const stored = async () => (await ps(`SELECT ${COLS} FROM user_settings WHERE id = 1`)).rows[0];

    it("\"false\" for a switch, an hour of 24, a bad zone, a timeout of 0 and a malformed layout are 400s that change nothing", async () => {
      const before = await stored();
      assert.equal(before.vault_enabled, false);
      for (const body of [
        { vault_enabled: "false" }, // it used to switch the vault ON
        { job_radar_enabled: 1 },
        { keep_alive_start: 24, default_horizon: "long" },
        { keep_alive_timezone: "Mars/Olympus" },
        { session_timeout_minutes: 0 },
        { default_horizon: "forever" },
        { dashboard_layout: ["tasks"] },
      ]) {
        await patch(body).expect(400);
        assert.deepEqual(await stored(), before, JSON.stringify(body));
      }
    });

    it("valid values are stored as given", async () => {
      await patch({ job_radar_enabled: true, keep_alive_enabled: true, keep_alive_start: "7", keep_alive_end: 22, keep_alive_timezone: "America/Chicago",
        session_timeout_minutes: 45, default_horizon: "long", dashboard_layout: { widgets: ["tasks", "cards"], hidden: ["cards"] } }).expect(200);
      assert.deepEqual(await stored(), {
        vault_enabled: false, job_radar_enabled: true, keep_alive_enabled: true, keep_alive_start: 7, keep_alive_end: 22, keep_alive_timezone: "America/Chicago",
        session_timeout_minutes: 45, default_horizon: "long", dashboard_layout: { widgets: ["tasks", "cards"], hidden: ["cards"] },
      });
      await patch({ job_radar_enabled: false, dashboard_layout: null }).expect(200);
      const s = await stored();
      assert.deepEqual([s.job_radar_enabled, s.dashboard_layout], [false, null]);
    });
  });
});
