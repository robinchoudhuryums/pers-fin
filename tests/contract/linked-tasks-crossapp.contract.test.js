// Real-Postgres contract test for roadmap T2.4 X2b — linked tasks end to end,
// with both apps' real databases wired the way the shell wires them (Perfin's
// embedded Per-sistant pool set, Per-sistant's routes on its own database):
//  - switched off (the default) → a run writes nothing
//  - rent due → one Per-sistant task; a payment recorded through Perfin's
//    route closes it (the route's own fire-and-forget refresh); undoing the
//    payment reopens it; a task completed by hand stays done across a payment
//    and its undo
//  - a utility amount entered (PATCH) closes its task
//  - a manual bill marked paid (POST /api/bill-payments) closes its task
//  - a still-charging alert creates one task across two watchdog runs
//  - the run's record lands in user_settings.linked_tasks_state
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, persistentDb, perfinApp, persistentApp } = require("./_setup");

describe("Linked tasks across both apps (T2.4 X2b) on real Postgres", { skip: SKIP }, () => {
  let psPool, pfPool, psApp, pfApp, lt, subs, today, month;
  const pf = (s, p) => pfPool.query(s, p);
  const task = async (key) => (await psPool.query("SELECT * FROM todos WHERE source_key = $1", [key])).rows[0];
  const run = () => lt.runLinkedTasks(pfPool, psPool);
  async function until(fn, ms = 3000) {
    const end = Date.now() + ms;
    for (;;) {
      if (await fn()) return true;
      if (Date.now() > end) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  before(async () => {
    psPool = await persistentDb("linked_crossapp");
    pfPool = await perfinDb("linked_crossapp");
    psApp = persistentApp(psPool);
    pfApp = perfinApp();
    pfApp.set("persistentPool", psPool);
    require("../../teller/routes/persistent").setEmbeddedPersistentPool(psPool);
    lt = require("../../teller/services/linked-tasks");
    subs = require("../../teller/routes/subscriptions");
    today = require("../../teller/services/financial-queries").todayStr();
    month = today.slice(0, 7);
    await pf("UPDATE user_settings SET housing_config = $1 WHERE id = 1", [JSON.stringify({
      enabled: true, payee_name: "Sam Lee", rent_amount: 1800, rent_due_day: 1, reminder_lead_days: 5, start_month: month, utilities: [],
    })]);
  });
  after(async () => {
    require("../../teller/routes/persistent").setEmbeddedPersistentPool(null);
    if (psPool) await psPool.end();
    if (pfPool) await pfPool.end();
  });

  it("switched off (the default), a run writes nothing", async () => {
    await pf("INSERT INTO payee_obligations (payee, period, category, label, amount, status, due_day) VALUES ('Sam Lee', $1, 'rent', 'Rent', 1800, 'unpaid', 1)", [month]);
    assert.equal((await run()).status, "disabled");
    assert.equal((await psPool.query("SELECT count(*)::int AS n FROM todos")).rows[0].n, 0);
    await supertest(pfApp).patch("/api/settings").send({ linked_tasks_enabled: true, linked_tasks_sources: { bills: true } }).expect(200);
  });

  it("rent due → one task; a payment through Perfin's route closes it; undo reopens it", async () => {
    const r = await run();
    assert.equal(r.status, "ok");
    const key = `perfin:housing:${month}`;
    let t = await task(key);
    assert.ok(t, "the rent task was created");
    const overdue = today > `${month}-01`; // rent is due the 1st
    assert.deepEqual([t.category, t.priority, t.source_app, t.source_url, t.completed], ["finance", overdue ? "urgent" : "high", "perfin", "/housing", false]);
    const rent = (await pf("SELECT id FROM payee_obligations WHERE period = $1 AND category = 'rent'", [month])).rows[0].id;
    const pay = (await supertest(pfApp).post("/api/housing/payments").send({ obligation_ids: [rent] }).expect(200)).body;
    assert.ok(await until(async () => (await task(key)).completed), "the route's own refresh closed it");
    t = await task(key);
    assert.deepEqual([t.auto_closed, t.source_detached], [true, false]);
    await supertest(pfApp).delete(`/api/housing/payments/${pay.payment.id}`).expect(200);
    assert.ok(await until(async () => !(await task(key)).completed), "undo reopened it");
    const st = (await pf("SELECT linked_tasks_state FROM user_settings WHERE id = 1")).rows[0].linked_tasks_state;
    assert.ok(st && st.at && Array.isArray(st.errors), "the run's record is stored");
  });

  it("a task completed by hand stays done across a payment and its undo", async () => {
    const key = `perfin:housing:${month}`;
    const t = await task(key);
    await supertest(psApp).patch(`/api/todos/${t.id}`).send({ completed: true }).expect(200);
    const rent = (await pf("SELECT id FROM payee_obligations WHERE period = $1 AND category = 'rent'", [month])).rows[0].id;
    const pay = (await supertest(pfApp).post("/api/housing/payments").send({ obligation_ids: [rent] }).expect(200)).body;
    await run();
    await supertest(pfApp).delete(`/api/housing/payments/${pay.payment.id}`).expect(200);
    await run();
    const after2 = await task(key);
    assert.deepEqual([after2.completed, after2.source_detached], [true, true]);
  });

  it("a utility amount entered closes its task", async () => {
    const id = (await pf("INSERT INTO payee_obligations (payee, period, category, label, amount, status, due_day) VALUES ('Sam Lee', $1, 'utility', 'Electricity', NULL, 'pending_amount', 1) RETURNING id", [month])).rows[0].id;
    await run();
    const key = `perfin:utility-amount:${id}`;
    assert.equal((await task(key)).completed, false);
    await supertest(pfApp).patch(`/api/housing/obligations/${id}`).send({ amount: 95.5 }).expect(200);
    assert.ok(await until(async () => (await task(key)).completed), "closed by the route's refresh");
  });

  it("a manual bill marked paid closes its task", async () => {
    const bill = (await supertest(pfApp).post("/api/manual-bills").send({ name: "Insurance", amount: 120, due_day: parseInt(today.slice(8, 10), 10), cadence: "monthly", category: "insurance" }).expect(200)).body;
    const id = bill.id || (bill.bill && bill.bill.id);
    await run();
    const key = `perfin:bill:${id}:${today}`;
    const t = await task(key);
    assert.ok(t, "the bill due today has a task");
    assert.equal(t.priority, "medium");
    await supertest(pfApp).post("/api/bill-payments").send({ bill_source: "manual", bill_id: id, paid_date: today }).expect(200);
    assert.ok(await until(async () => (await task(key)).completed));
  });

  it("a still-charging alert creates one task across two watchdog runs", async () => {
    const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    await pf("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status) VALUES ('i1','Bank','x','GOOD')");
    const item = (await pf("SELECT id FROM plaid_items")).rows[0].id;
    await pf("INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype, current_balance) VALUES ($1,'card','card','credit','credit card',0)", [item]);
    const sub = (await pf(`INSERT INTO detected_subscriptions (merchant_key, display_name, amount, prior_amount, cadence_days, first_seen, last_charged, next_expected, is_active, amount_changed, cancelled_at)
      VALUES ('Netflix', 'Netflix', 15.49, 15.49, 30, $1, $2, $3, false, false, $4) RETURNING id`, [daysAgo(200), daysAgo(5), daysAgo(-25), daysAgo(20)])).rows[0].id;
    await pf("INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending) VALUES ('card', 'nf1', 15.49, $1, 'Netflix', 'Netflix', false)", [daysAgo(5)]);
    assert.equal((await subs.runSubscriptionWatchdog(pfPool)).still_charging, 1);
    await pf("UPDATE detected_subscriptions SET still_charging_txn = NULL WHERE id = $1", [sub]); // force a second alert for the same charge
    assert.equal((await subs.runSubscriptionWatchdog(pfPool)).still_charging, 1);
    const rows = (await psPool.query("SELECT source_key, priority, source_url FROM todos WHERE source_key LIKE 'perfin:still-charging:%'")).rows;
    assert.deepEqual(rows, [{ source_key: `perfin:still-charging:${sub}:nf1`, priority: "high", source_url: "/subscriptions" }]);
    // a sync never closes it
    await run();
    assert.equal((await task(`perfin:still-charging:${sub}:nf1`)).completed, false);
  });
});
