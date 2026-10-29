// Real-Postgres contract test for cycle-8 E3e (ST2) — one rent, one alert, with
// both apps' real databases wired the way the shell wires them (Perfin's
// embedded Per-sistant pool, Per-sistant's perfinPool) and web-push stubbed:
//  - linked tasks off: Perfin pushes the rent reminder, and Per-sistant's
//    notification check lists housing_due with its item and notify:false (the
//    push already interrupted)
//  - linked tasks on: one Per-sistant task; Perfin's rent push is covered (not
//    pushed); the check leaves housing_due out and the task's own entry carries
//    the item and notifies
const Module = require("module");
const pushed = [];
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "web-push") {
    return { setVapidDetails() {}, async sendNotification(_sub, payload) { pushed.push(JSON.parse(payload)); } };
  }
  return origLoad.apply(this, arguments);
};
process.env.VAPID_PUBLIC_KEY = "pub";
process.env.VAPID_PRIVATE_KEY = "priv";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, persistentDb, perfinApp, persistentApp } = require("./_setup");

describe("one rent, one alert (cycle-8 E3e) across both apps on real Postgres", { skip: SKIP }, () => {
  let psPool, pfPool, psApp, pfApp, lt, housing, notifications, today, month, nextMonth;
  const pf = (s, p) => pfPool.query(s, p);
  const remind = async () => {
    await pf("DELETE FROM notification_log");
    notifications.invalidateNotifyPrefs();
    pushed.length = 0;
    return housing.runHousingReminders(pfPool, today);
  };
  const check = async () => (await supertest(psApp).get("/api/notifications/check").expect(200)).body.notifications;

  before(async () => {
    psPool = await persistentDb("notify_e3e");
    pfPool = await perfinDb("notify_e3e");
    psApp = persistentApp(psPool);
    psApp.set("perfinPool", pfPool);
    pfApp = perfinApp();
    pfApp.set("persistentPool", psPool);
    require("../../teller/routes/persistent").setEmbeddedPersistentPool(psPool);
    lt = require("../../teller/services/linked-tasks");
    housing = require("../../teller/routes/housing");
    notifications = require("../../teller/routes/notifications");
    notifications._release.reset({ heldPending: false });
    today = require("../../teller/services/financial-queries").todayStr();
    month = today.slice(0, 7);
    const [y, m] = month.split("-").map(Number);
    nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
    await pf("INSERT INTO push_subscriptions (endpoint, keys) VALUES ('https://push.example/1', $1)",
      [JSON.stringify({ endpoint: "https://push.example/1", keys: {} })]);
    await pf("UPDATE user_settings SET housing_config = $1 WHERE id = 1", [JSON.stringify({
      enabled: true, payee_name: "Sam Lee", rent_amount: 1800, rent_due_day: 1, reminder_lead_days: 5, start_month: month, utilities: [],
    })]);
    // This month's rent unpaid (due the 1st — open whatever today is); next month's paid.
    await pf(`INSERT INTO payee_obligations (payee, period, category, label, amount, status, due_day)
              VALUES ('Sam Lee', $1, 'rent', 'Rent', 1800, 'unpaid', 1), ('Sam Lee', $2, 'rent', 'Rent', 1800, 'paid', 1)`, [month, nextMonth]);
  });
  after(async () => {
    Module._load = origLoad;
    require("../../teller/routes/persistent").setEmbeddedPersistentPool(null);
    if (psPool) await psPool.end();
    if (pfPool) await pfPool.end();
  });

  it("tasks off: Perfin pushes; the check lists housing_due with its item, notify:false", async () => {
    await remind();
    assert.deepEqual(pushed.map((p) => p.tag), [`housing-due-${month}`]);
    const h = (await check()).find((n) => n.type === "housing_due");
    assert.ok(h, "housing_due is listed");
    assert.deepEqual([h.item, h.kind, h.notify], [`housing:${month}`, "bills", false]);
  });

  it("an older push (over 12 hours) no longer silences it", async () => {
    await pf("UPDATE notification_log SET created_at = now() - interval '13 hours'");
    const h = (await check()).find((n) => n.type === "housing_due");
    assert.equal(h.notify, true);
  });

  it("tasks on: Perfin's push is covered; the check's surface is the task's own entry", async () => {
    await supertest(pfApp).patch("/api/settings").send({ linked_tasks_enabled: true }).expect(200);
    assert.equal((await lt.runLinkedTasks(pfPool, psPool)).status, "ok");
    await remind();
    assert.deepEqual(pushed, [], "covered — not pushed");
    assert.equal((await pf("SELECT push_state FROM notification_log")).rows[0].push_state, "covered");
    const list = await check();
    assert.equal(list.find((n) => n.type === "housing_due"), undefined, "housing_due steps aside");
    const task = list.find((n) => n.item === `housing:${month}`);
    assert.ok(task, "the task's entry carries the item");
    assert.equal(task.type, today === `${month}-01` ? "due_today" : "overdue");
    assert.equal(task.notify, true, "the one interruption");
  });
});
