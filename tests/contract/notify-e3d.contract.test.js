// Real-Postgres contract test for cycle-8 E3d (ST2) — one real-world item, one
// alert, with both apps' real databases wired the way the shell wires them and
// web-push stubbed:
//  - linked tasks off: the rent reminder is pushed (push_state sent, item_key
//    housing:<month>)
//  - linked tasks on: one Per-sistant task for the month's rent, and the rent
//    reminder is logged covered and read — not pushed; a utility amount to
//    enter likewise (utility-amount:<id>)
//  - the task completed by hand (detached): the next reminder is pushed again
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

describe("one item, one alert (cycle-8 E3d) across both apps on real Postgres", { skip: SKIP }, () => {
  let psPool, pfPool, psApp, pfApp, lt, housing, notifications, today, month, nextMonth, utilId;
  const pf = (s, p) => pfPool.query(s, p);
  const log = async () => (await pf("SELECT type, push_state, item_key, is_read FROM notification_log ORDER BY id")).rows;
  const remind = async () => {
    await pf("DELETE FROM notification_log"); // each round starts outside the 72 h dedup
    notifications.invalidateNotifyPrefs();
    pushed.length = 0;
    return housing.runHousingReminders(pfPool, today);
  };

  before(async () => {
    psPool = await persistentDb("notify_e3d");
    pfPool = await perfinDb("notify_e3d");
    psApp = persistentApp(psPool);
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
    // This month's rent unpaid (due the 1st — always open); next month's
    // already paid, so the reminder is about this month whatever today is.
    await pf(`INSERT INTO payee_obligations (payee, period, category, label, amount, status, due_day)
              VALUES ('Sam Lee', $1, 'rent', 'Rent', 1800, 'unpaid', 1), ('Sam Lee', $2, 'rent', 'Rent', 1800, 'paid', 1)`, [month, nextMonth]);
    utilId = (await pf(`INSERT INTO payee_obligations (payee, period, category, label, amount, status, due_day)
              VALUES ('Sam Lee', $1, 'utility', 'Electricity', NULL, 'pending_amount', 1) RETURNING id`, [month])).rows[0].id;
  });
  after(async () => {
    Module._load = origLoad;
    require("../../teller/routes/persistent").setEmbeddedPersistentPool(null);
    if (psPool) await psPool.end();
    if (pfPool) await pfPool.end();
  });

  it("linked tasks off: both reminders are pushed with their items", async () => {
    assert.equal((await remind()).sent, 2);
    assert.deepEqual(await log(), [
      { type: `housing-due-${month}`, push_state: "sent", item_key: `housing:${month}`, is_read: false },
      { type: `housing-util-${utilId}`, push_state: "sent", item_key: `utility-amount:${utilId}`, is_read: false },
    ]);
    assert.deepEqual(pushed.map((p) => p.tag), [`housing-due-${month}`, `housing-util-${utilId}`]);
  });

  it("linked tasks on: one task per item, and the reminders are covered — logged read, not pushed", async () => {
    await supertest(pfApp).patch("/api/settings").send({ linked_tasks_enabled: true }).expect(200);
    assert.equal((await lt.runLinkedTasks(pfPool, psPool)).status, "ok");
    const keys = (await psPool.query("SELECT source_key FROM todos WHERE NOT completed AND source_key IN ($1, $2) ORDER BY source_key",
      [`perfin:housing:${month}`, `perfin:utility-amount:${utilId}`])).rows.map((r) => r.source_key);
    assert.deepEqual(keys, [`perfin:housing:${month}`, `perfin:utility-amount:${utilId}`]);
    assert.equal((await remind()).sent, 2, "`logged` keeps its meaning — both count as sent reminders");
    assert.deepEqual(await log(), [
      { type: `housing-due-${month}`, push_state: "covered", item_key: `housing:${month}`, is_read: true },
      { type: `housing-util-${utilId}`, push_state: "covered", item_key: `utility-amount:${utilId}`, is_read: true },
    ]);
    assert.deepEqual(pushed, []);
    const unread = (await supertest(pfApp).get("/api/notifications").expect(200)).body.unread_count;
    assert.equal(unread, 0, "the bell doesn't count a covered row");
  });

  it("the rent task completed by hand: the next rent reminder is pushed again", async () => {
    const t = (await psPool.query("SELECT id FROM todos WHERE source_key = $1", [`perfin:housing:${month}`])).rows[0];
    await supertest(psApp).patch(`/api/todos/${t.id}`).send({ completed: true }).expect(200);
    await remind();
    assert.deepEqual((await log()).map((r) => [r.type, r.push_state]), [
      [`housing-due-${month}`, "sent"],
      [`housing-util-${utilId}`, "covered"],
    ]);
    assert.deepEqual(pushed.map((p) => p.tag), [`housing-due-${month}`]);
  });
});
