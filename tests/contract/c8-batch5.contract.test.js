// Cycle-8 broad scan Batch 5 on real Postgres — linked tasks, with both apps'
// real databases wired the way the shell wires them:
//  - F16: a linked task deleted for good (permanent delete, Empty Trash) is
//    never recreated by a later sync; its key is in linked_task_tombstones
//  - F17: an unpaid manual-bill task older than the 30-day window stays open,
//    and closes once the bill is marked paid
//  - F18: a task the sync closed is not counted as done (/api/stats,
//    /api/analytics, /api/review), while one completed by hand is
//  - F20: a sync waits for another holder of the linked-tasks lock
//  - F22: switching a manual bill off through its route closes its task
//  - F23: the notification check's housing_due entry steps aside while a
//    housing linked task is open, and comes back once it is done
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, persistentDb, perfinApp, persistentApp } = require("./_setup");

describe("cycle-8 Batch 5 — linked tasks on real Postgres", { skip: SKIP }, () => {
  let psPool, pfPool, psApp, pfApp, lt, ps, today, month, add;
  const pf = (s, p) => pfPool.query(s, p);
  const task = async (key) => (await psPool.query("SELECT * FROM todos WHERE source_key = $1", [key])).rows[0];
  const run = (day = today) => lt.runLinkedTasks(pfPool, psPool, { today: day });
  async function until(fn, ms = 3000) {
    const end = Date.now() + ms;
    for (;;) {
      if (await fn()) return true;
      if (Date.now() > end) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const desiredOne = (key) => [{ key, title: "Pay rent", due_date: today, priority: "high", url: "/housing" }];

  before(async () => {
    psPool = await persistentDb("c8_batch5");
    pfPool = await perfinDb("c8_batch5");
    psApp = persistentApp(psPool);
    psApp.set("perfinPool", pfPool);
    pfApp = perfinApp();
    pfApp.set("persistentPool", psPool);
    require("../../teller/routes/persistent").setEmbeddedPersistentPool(psPool);
    lt = require("../../teller/services/linked-tasks");
    ps = require("../../apps/per-sistant/services/linked-tasks");
    today = require("../../teller/services/financial-queries").todayStr();
    month = today.slice(0, 7);
    add = (n) => require("../../teller/services/cadence").addDaysStr(today, n);
  });
  after(async () => {
    require("../../teller/routes/persistent").setEmbeddedPersistentPool(null);
    if (psPool) await psPool.end();
    if (pfPool) await pfPool.end();
  });

  // ---------------------------------------------------------------- F16
  it("F16: a task deleted for good isn't recreated — permanent delete and Empty Trash", async () => {
    for (const [key, how] of [["perfin:housing:2099-01", "delete"], ["perfin:housing:2099-02", "empty"]]) {
      await ps.syncLinkedTasks(psPool, { app: "perfin", kinds: ["housing"], desired: desiredOne(key) });
      const id = (await task(key)).id;
      await supertest(psApp).delete(`/api/todos/${id}`).expect(200);
      if (how === "delete") await supertest(psApp).delete(`/api/trash/todo/${id}`).expect(200);
      else await supertest(psApp).post("/api/trash/empty").expect(200);
      assert.equal(await task(key), undefined, `${how}: the row is gone`);
      const r = await ps.syncLinkedTasks(psPool, { app: "perfin", kinds: ["housing"], desired: desiredOne(key) });
      assert.equal(r.created, 0, `${how}: not recreated`);
      assert.equal(await task(key), undefined);
      assert.equal((await psPool.query("SELECT count(*)::int AS n FROM linked_task_tombstones WHERE source_key = $1", [key])).rows[0].n, 1);
    }
  });

  // ---------------------------------------------------------------- F20
  it("F20: a sync waits while another process holds the linked-tasks lock", async () => {
    const other = await psPool.connect();
    let done = false;
    try {
      await other.query("BEGIN");
      await other.query("SELECT pg_advisory_xact_lock($1)", [ps.LINKED_TASKS_LOCK_KEY]);
      const p = ps.syncLinkedTasks(psPool, { app: "perfin", kinds: ["housing"], desired: desiredOne("perfin:housing:2099-03") })
        .then((r) => { done = true; return r; });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(done, false, "blocked behind the lock");
      await other.query("COMMIT");
      assert.equal((await p).created, 1);
    } finally { other.release(); }
  });

  // ---------------------------------------------------------------- F18
  it("F18: a task the sync closed isn't counted as done; one completed by hand is", async () => {
    await psPool.query("DELETE FROM todos");
    const auto = "perfin:housing:2099-04", hand = "perfin:housing:2099-05";
    await ps.syncLinkedTasks(psPool, { app: "perfin", kinds: ["housing"], desired: [...desiredOne(auto), ...desiredOne(hand)] });
    await supertest(psApp).patch(`/api/todos/${(await task(hand)).id}`).send({ completed: true }).expect(200);
    await ps.syncLinkedTasks(psPool, { app: "perfin", kinds: ["housing"], desired: desiredOne(hand) });
    assert.equal((await task(auto)).auto_closed, true);

    assert.equal(Number((await supertest(psApp).get("/api/stats").expect(200)).body.todos.done), 1);
    const a = (await supertest(psApp).get("/api/analytics?period=week").expect(200)).body;
    assert.equal(a.total_completed, 1);
    assert.equal(a.total_created, 1, "the auto-closed task is on neither side of the rate");
    const rv = (await supertest(psApp).get("/api/review").expect(200)).body;
    assert.deepEqual(rv.tasks_completed.map((t) => t.source_key), [hand]);
  });

  // ---------------------------------------------------------------- F23
  it("F23: housing_due steps aside while a housing linked task is open", async () => {
    await psPool.query("DELETE FROM todos");
    await pf("UPDATE user_settings SET housing_config = $1 WHERE id = 1", [JSON.stringify({
      enabled: true, payee_name: "Sam Lee", rent_amount: 1800, rent_due_day: 1, reminder_lead_days: 5, start_month: month, utilities: [],
    })]);
    await pf("INSERT INTO payee_obligations (payee, period, category, label, amount, status, due_day) VALUES ('Sam Lee', $1, 'rent', 'Rent', 1800, 'unpaid', 1)", [month]);
    const types = async () => (await supertest(psApp).get("/api/notifications/check").expect(200)).body.notifications.map((n) => n.type);
    assert.ok((await types()).includes("housing_due"), "no task yet → the rent line is there");
    await ps.syncLinkedTasks(psPool, { app: "perfin", kinds: ["housing"], desired: desiredOne(`perfin:housing:${month}`) });
    assert.ok(!(await types()).includes("housing_due"), "the open task is the reminder");
    await supertest(psApp).patch(`/api/todos/${(await task(`perfin:housing:${month}`)).id}`).send({ completed: true }).expect(200);
    assert.ok((await types()).includes("housing_due"), "done by hand → the rent line is back");
  });

  // ---------------------------------------------------------------- F17 + F22
  it("F17: an unpaid bill older than the window keeps its task open until it is paid; F22: switching a bill off closes its task", async () => {
    await psPool.query("DELETE FROM todos");
    await pf("UPDATE user_settings SET housing_config = '{}'::jsonb, linked_tasks_enabled = true, linked_tasks_sources = $1 WHERE id = 1",
      [JSON.stringify({ still_charging: false, housing: false, utility_amount: false, bills: true, tax_documents: false })]);
    const due = add(-10);
    const bill = (await pf(
      "INSERT INTO manual_bills (name, amount, due_day, cadence, category, created_at) VALUES ('Gym', 40, $1, 'monthly', 'bill', $2::date) RETURNING id",
      [Number(due.slice(8, 10)), add(-120)])).rows[0].id;
    const key = `perfin:bill:${bill}:${due}`;

    assert.equal((await run()).status, "ok");
    assert.equal((await task(key)).completed, false, "inside the window → a task");
    await run(add(30)); // the occurrence is now 40 days old
    assert.equal((await task(key)).completed, false, "still unpaid → still open");

    await supertest(pfApp).post("/api/bill-payments").send({ bill_source: "manual", bill_id: bill, paid_date: due }).expect(200);
    await run(add(30));
    assert.ok(await until(async () => (await task(key)).completed), "paid → closed");
    assert.equal((await task(key)).auto_closed, true);

    // F22: a bill due today has its task; switching the bill off closes it
    // through the route's own refresh (no run of ours in between).
    const gym2 = (await pf(
      "INSERT INTO manual_bills (name, amount, due_day, cadence, category, created_at) VALUES ('Pool', 25, $1, 'monthly', 'bill', $2::date) RETURNING id",
      [Number(today.slice(8, 10)), add(-120)])).rows[0].id;
    const key2 = `perfin:bill:${gym2}:${today}`;
    await run();
    assert.equal((await task(key2)).completed, false, "due today → open");
    await supertest(pfApp).patch(`/api/manual-bills/${gym2}`).send({ is_active: false }).expect(200);
    assert.ok(await until(async () => (await task(key2)).completed), "the route's own refresh closed it");
  });
});
