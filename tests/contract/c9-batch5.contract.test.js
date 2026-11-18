// Real-Postgres contract test for the cycle-9 broad scan, Batch 5 —
// notifications and settings — with both apps' real databases wired the way the
// shell wires them and web-push stubbed:
//  - F44: a push held early in a 13-hour quiet window is pushed when the window
//    ends; one from the night before expires
//  - F46: a push that failed on every device is stored 'retry' (the CHECK takes
//    it) and pushed by the release job
//  - F34: last month's unpaid rent is pushed before this month's window opens,
//    under last month's item
//  - F45: a linked task due tomorrow doesn't cover the push or hide
//    Per-sistant's line; due today it does both; with no due date, neither
//  - F47: a toggle map is merged over the stored one (two at once both land);
//    "false" for a switch and 7.5 for the idle timeout are 400s that change
//    nothing
//  - F48: reopening an auto-closed linked task by hand clears auto_closed, so
//    completing it afterwards counts; the migration repairs rows left that way
const Module = require("module");
const pushed = [];
let pushFails = false;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "web-push") {
    return {
      setVapidDetails() {},
      async sendNotification(_sub, payload) {
        if (pushFails) { const e = new Error("push service unavailable"); e.statusCode = 503; throw e; }
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
const path = require("path");
const supertest = require("supertest");
const { SKIP, ROOT, perfinDb, persistentDb, perfinApp, persistentApp } = require("./_setup");

describe("cycle-9 Batch 5 across both apps on real Postgres", { skip: SKIP }, () => {
  let psPool, pfPool, psApp, pfApp, notifications, housing, linked, today, tomorrow, month, prevMonth;
  const pf = (s, p) => pfPool.query(s, p);
  const ps = (s, p) => psPool.query(s, p);
  const log = async () => (await pf("SELECT type, push_state, item_key, is_read FROM notification_log ORDER BY id")).rows;
  const quiet = async (fn) => {
    const e = console.error; console.error = () => {};
    try { return await fn(); } finally { console.error = e; }
  };
  const settings = (body) => supertest(pfApp).patch("/api/settings").send(body);
  const stored = async (cols) => (await pf(`SELECT ${cols} FROM user_settings WHERE id = 1`)).rows[0];
  // Every time is relative to the real clock (created_at is the database's now()).
  const H = new Date().getUTCHours();
  const hh = (k) => String(((H + k) % 24 + 24) % 24).padStart(2, "0") + ":00";

  before(async () => {
    psPool = await persistentDb("c9_batch5");
    pfPool = await perfinDb("c9_batch5");
    psApp = persistentApp(psPool);
    psApp.set("perfinPool", pfPool);
    pfApp = perfinApp();
    pfApp.set("persistentPool", psPool);
    require("../../teller/routes/persistent").setEmbeddedPersistentPool(psPool);
    notifications = require("../../teller/routes/notifications");
    notifications._release.reset({ heldPending: false });
    housing = require("../../teller/routes/housing");
    linked = require(path.join(ROOT, "apps/per-sistant/services/linked-tasks"));
    today = require("../../teller/services/financial-queries").todayStr();
    tomorrow = new Date(Date.parse(today + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
    month = today.slice(0, 7);
    const [y, m] = month.split("-").map(Number);
    prevMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
    await pf("INSERT INTO push_subscriptions (endpoint, keys) VALUES ('https://push.example/1', $1)",
      [JSON.stringify({ endpoint: "https://push.example/1", keys: {} })]);
  });
  after(async () => {
    Module._load = origLoad;
    require("../../teller/routes/persistent").setEmbeddedPersistentPool(null);
    if (psPool) await psPool.end();
    if (pfPool) await pfPool.end();
  });

  // ---------------------------------------------------------------- F44
  it("F44: held 30+ minutes into a 13-hour quiet window → pushed when it ends; last night's hold expires", async () => {
    // Quiet hours ran from 14 hours ago until the hour before this one (13 h).
    await settings({ notify_quiet_hours: { enabled: true, start: hh(-14), end: hh(-1) } }).expect(200);
    notifications.invalidateNotifyPrefs();
    await pf(`INSERT INTO notification_log (type, title, body, data, push_state, created_at) VALUES
                ('cash-low', 'Last night', 'b', '{}', 'held', now() - interval '37 hours'),
                ('cash-low', 'Low cash ahead', 'b', '{"url":"/dashboard"}', 'held', now() - interval '13 hours')`);
    pushed.length = 0;
    const r = await notifications.releaseHeldNotifications({ now: new Date() });
    assert.deepEqual([r.ok, r.outcome, r.released, r.expired], [true, "released", 1, 1]);
    assert.deepEqual((await log()).map((l) => l.push_state), ["expired", "sent"],
      "the 13-hour-old hold used to be expired too — nothing held early in a long window was ever pushed");
    assert.deepEqual(pushed.map((p) => p.title), ["Low cash ahead"]);
  });

  // ---------------------------------------------------------------- F46
  it("F46: a push that fails everywhere is stored 'retry' and pushed by the next release", async () => {
    await pf("DELETE FROM notification_log");
    await settings({ notify_quiet_hours: { enabled: false, start: "22:00", end: "07:00" } }).expect(200);
    notifications.invalidateNotifyPrefs();
    notifications._release.reset({ heldPending: false });
    pushed.length = 0;
    pushFails = true;
    const r = await quiet(() => notifications.sendToAll({ title: "Unusual charge", body: "b", tag: "anomaly-acme", data: { url: "/transactions" } }));
    assert.deepEqual(r, { sent: 0, failed: 1, logged: true, push_state: "retry" });
    assert.deepEqual((await log()).map((l) => l.push_state), ["retry"], "the migrated CHECK takes the new value");
    assert.equal(notifications.releaseDue(), true);
    // Still down: the row waits, the job reports the failure.
    const still = await quiet(() => notifications.releaseHeldNotifications({ now: new Date() }));
    assert.deepEqual([still.ok, still.outcome], [false, "failed"]);
    assert.deepEqual((await log()).map((l) => l.push_state), ["retry"]);
    pushFails = false;
    const rel = await notifications.releaseHeldNotifications({ now: new Date() });
    assert.deepEqual([rel.outcome, rel.released], ["released", 1]);
    assert.deepEqual(pushed, [{ title: "Unusual charge", body: "b", tag: "anomaly-acme", data: { url: "/transactions" } }]);
    assert.deepEqual((await log()).map((l) => l.push_state), ["sent"]);
    assert.equal(notifications.releaseDue(), false);
  });

  it("F46: a retry is not a push Per-sistant should stay quiet for; another value is still refused", async () => {
    await pf("INSERT INTO notification_log (type, title, body, data, push_state, item_key) VALUES ('t', 't', 'b', '{}', 'retry', 'housing:retrying')");
    const { perfinPushedItems } = require(path.join(ROOT, "apps/per-sistant/routes/notifications"));
    assert.equal((await perfinPushedItems(pfPool, ["housing:retrying"])).size, 0);
    await assert.rejects(pf("INSERT INTO notification_log (type, title, body, data, push_state) VALUES ('t', 't', 'b', '{}', 'later')"), /push_state/);
    await pf("DELETE FROM notification_log");
  });

  // ---------------------------------------------------------------- F34 + F45
  describe("the rent reminder", () => {
    // "Today" for the reminder's own window is the 3rd of this month (the
    // function takes it); whether a task covers the push is asked about the
    // real day, so the task's due date is set relative to that.
    let third;
    const remind = async () => {
      await pf("DELETE FROM notification_log"); // outside the 72 h dedup each round
      notifications.invalidateNotifyPrefs();
      pushed.length = 0;
      return housing.runHousingReminders(pfPool, third);
    };
    const check = async () => (await supertest(psApp).get("/api/notifications/check").expect(200)).body.notifications;
    const key = () => `perfin:housing:${prevMonth}`;

    before(async () => {
      third = `${month}-03`;
      await pf("UPDATE user_settings SET housing_config = $1 WHERE id = 1", [JSON.stringify({
        enabled: true, payee_name: "Sam Lee", rent_amount: 1800, rent_due_day: 20, reminder_lead_days: 5, start_month: prevMonth, utilities: [],
      })]);
      // Last month's rent is still owed; this month's is already paid.
      await pf(`INSERT INTO payee_obligations (payee, period, category, label, amount, status, due_day)
                VALUES ('Sam Lee', $1, 'rent', 'Rent', 1800, 'unpaid', 20), ('Sam Lee', $2, 'rent', 'Rent', 1800, 'paid', 20)`, [prevMonth, month]);
    });

    it("F34: on the 3rd, last month's unpaid rent is pushed — under last month's item", async () => {
      // This month's window (due the 20th, 5 days' notice) opens on the 15th; the
      // reminder used to test only that one and said nothing until then.
      assert.equal((await remind()).sent, 1);
      assert.deepEqual(await log(), [{ type: `housing-due-${prevMonth}`, push_state: "sent", item_key: `housing:${prevMonth}`, is_read: false }]);
      assert.deepEqual(pushed.map((p) => p.tag), [`housing-due-${prevMonth}`]);
      // The same month Per-sistant's own line names.
      const line = (await check()).find((n) => n.type === "housing_due");
      assert.equal(line.item, `housing:${prevMonth}`);
    });

    it("F45: a linked task due TOMORROW is open but silent — the push goes out and the line stays", async () => {
      await ps(`INSERT INTO todos (title, source_app, source_key, source_url, due_date)
                VALUES ('Pay rent', 'perfin', $1, '/housing', $2)`, [key(), tomorrow]);
      assert.equal((await remind()).sent, 1);
      assert.deepEqual((await log()).map((l) => [l.push_state, l.is_read]), [["sent", false]],
        "it used to be covered — with the task saying nothing until its due date, the reminder reached no one");
      assert.equal(pushed.length, 1);
      const list = await check();
      assert.ok(list.find((n) => n.type === "housing_due"), "Per-sistant's line isn't hidden by a task that isn't showing");
      assert.equal(list.find((n) => n.entity === "todo" && n.item === `housing:${prevMonth}`), undefined, "the task itself isn't listed yet");
    });

    it("F45: once the task is due it is the reminder — the push is covered (read) and the line steps aside", async () => {
      await ps("UPDATE todos SET due_date = $2 WHERE source_key = $1", [key(), today]);
      assert.equal((await remind()).sent, 1, "`logged` keeps its meaning");
      assert.deepEqual(await log(), [{ type: `housing-due-${prevMonth}`, push_state: "covered", item_key: `housing:${prevMonth}`, is_read: true }]);
      assert.equal(pushed.length, 0);
      const list = await check();
      assert.equal(list.find((n) => n.type === "housing_due"), undefined);
      const task = list.find((n) => n.item === `housing:${prevMonth}`);
      assert.equal(task.type, "due_today");
    });

    it("F45: a task with no due date never covers", async () => {
      await ps("UPDATE todos SET due_date = NULL WHERE source_key = $1", [key()]);
      await remind();
      assert.deepEqual((await log()).map((l) => l.push_state), ["sent"]);
      assert.ok((await check()).find((n) => n.type === "housing_due"));
      await ps("DELETE FROM todos WHERE source_key = $1", [key()]);
    });
  });

  // ---------------------------------------------------------------- F47
  describe("F47 — settings", () => {
    it("a toggle is merged into the stored map: the other keys stay", async () => {
      const before = (await stored("dashboard_widgets")).dashboard_widgets;
      assert.ok(Object.keys(before).length > 5 && before.charts === true && before.pyramid === true);
      await settings({ dashboard_widgets: { charts: false } }).expect(200);
      const after = (await stored("dashboard_widgets")).dashboard_widgets;
      assert.deepEqual(after, { ...before, charts: false }, "it used to become { charts: false } — every other widget reset");
      await settings({ dashboard_widgets: { charts: true } }).expect(200);
      assert.deepEqual((await stored("dashboard_widgets")).dashboard_widgets, before);
    });

    it("two toggles at once both land", async () => {
      const before = (await stored("insight_modules")).insight_modules;
      await Promise.all([
        settings({ insight_modules: { anomaly_detection: false } }).expect(200),
        settings({ insight_modules: { tax_deductions: false } }).expect(200),
      ]);
      const after = (await stored("insight_modules")).insight_modules;
      assert.deepEqual(after, { ...before, anomaly_detection: false, tax_deductions: false });
      const body = (await supertest(pfApp).get("/api/settings").expect(200)).body;
      assert.equal(body.insight_modules.anomaly_detection, false);
      assert.equal(body.insight_modules.goal_tracking, true);
    });

    it("\"false\" for a switch is a 400 and changes nothing (it used to switch it ON)", async () => {
      assert.equal((await stored("weekly_digest_enabled")).weekly_digest_enabled, false);
      const res = await settings({ weekly_digest_enabled: "false" }).expect(400);
      assert.equal(res.body.error, "weekly_digest_enabled must be true or false");
      assert.equal((await stored("weekly_digest_enabled")).weekly_digest_enabled, false);
      await settings({ weekly_digest_enabled: true }).expect(200);
      assert.equal((await stored("weekly_digest_enabled")).weekly_digest_enabled, true);
      await settings({ weekly_digest_enabled: false }).expect(200);
    });

    it("7.5 minutes for the idle timeout is a 400 (it was a 500) and the stored value stays", async () => {
      const was = (await stored("shell_idle_timeout_minutes")).shell_idle_timeout_minutes;
      await settings({ shell_idle_timeout_minutes: 7.5 }).expect(400);
      assert.equal((await stored("shell_idle_timeout_minutes")).shell_idle_timeout_minutes, was);
      await settings({ shell_idle_timeout_minutes: 45 }).expect(200);
      assert.equal((await stored("shell_idle_timeout_minutes")).shell_idle_timeout_minutes, 45);
    });
  });

  // ---------------------------------------------------------------- F48
  describe("F48 — auto_closed after a hand reopen", () => {
    const KEY = "perfin:housing:2031-04";
    const rent = { key: KEY, title: "Pay rent for 2031-04", url: "/housing", due_date: "2031-04-01", priority: "high" };
    const sync = (desired) => linked.syncLinkedTasks(psPool, { app: "perfin", kinds: ["housing"], desired });
    const row = async (k = KEY) => (await ps("SELECT id, completed, auto_closed, source_detached FROM todos WHERE source_key = $1", [k])).rows[0];
    const done = async () => Number((await supertest(psApp).get("/api/stats").expect(200)).body.todos.done);

    it("the sync's close is auto_closed; reopening it by hand clears that", async () => {
      await sync([rent]);
      await sync([]);
      const closed = await row();
      assert.deepEqual([closed.completed, closed.auto_closed, closed.source_detached], [true, true, false]);
      await supertest(psApp).patch(`/api/todos/${closed.id}`).send({ completed: false }).expect(200);
      const open = await row();
      assert.deepEqual([open.completed, open.auto_closed, open.source_detached], [false, false, true],
        "an OPEN task used to stay marked 'closed by the sync'");
    });

    it("completing it yourself afterwards counts as done", async () => {
      const before = await done();
      const t = await row();
      await supertest(psApp).patch(`/api/todos/${t.id}`).send({ completed: true }).expect(200);
      assert.deepEqual([(await row()).completed, (await row()).auto_closed], [true, false]);
      assert.equal(await done(), before + 1, "it was left out of every count");
      // …and the sync leaves a detached task alone when its key comes back.
      assert.equal((await sync([rent])).reopened, 0);
    });

    it("the migration repairs a row left open-but-auto_closed, and leaves a real auto-close alone", async () => {
      // As a pre-fix database holds them (an INSERT doesn't fire the UPDATE trigger).
      await ps(`INSERT INTO todos (title, source_app, source_key, completed, auto_closed, source_detached) VALUES
                  ('Reopened by hand before the fix', 'perfin', 'perfin:housing:2031-05', false, true, true),
                  ('Reopened, then completed by hand', 'perfin', 'perfin:housing:2031-06', true, true, true),
                  ('Closed by the sync', 'perfin', 'perfin:housing:2031-07', true, true, false)`);
      await require(path.join(ROOT, "apps/per-sistant/db")).runMigrations();
      assert.equal((await row("perfin:housing:2031-05")).auto_closed, false);
      assert.equal((await row("perfin:housing:2031-06")).auto_closed, false);
      assert.equal((await row("perfin:housing:2031-07")).auto_closed, true);
      // A second run changes nothing.
      await require(path.join(ROOT, "apps/per-sistant/db")).runMigrations();
      assert.equal((await row("perfin:housing:2031-07")).auto_closed, true);
    });
  });
});
