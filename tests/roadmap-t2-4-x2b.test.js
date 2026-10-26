// ============================================================================
// Roadmap T2.4 X2b — linked tasks: the runner, the job and the hooks
// ============================================================================
// runLinkedTasks over a fake Perfin pool with the computation and Per-sistant's
// sync injected: nothing without a Per-sistant pool, off → no further read that
// day until invalidate(), the sync given only ok_kinds + desired, the state
// record (counts, a failed source / sync as a fixed sentence, "partial"), one
// run at a time (a call during a run makes it go round once more and shares
// its promise). The hourly job's outcome. ensureStillChargingTask (gating,
// key, task shape). Every route hook calling the refresher and a throwing
// refresher leaving the route's 200; the watchdog creating the task after the
// alert is marked, a failure never un-marking it. The cross-database half is
// tests/contract/linked-tasks-crossapp.
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supertest = require("supertest");

const dbModule = require("../teller/services/database");
const lt = require("../teller/services/linked-tasks");
const jobHealth = require("../teller/services/job-health");

const saved = { query: dbModule.pool.query, connect: dbModule.pool.connect, refreshSoon: lt.refreshSoon, run: lt.runLinkedTasks, ensure: lt.ensureStillChargingTask };
beforeEach(() => lt._reset());
afterEach(() => {
  dbModule.pool.query = saved.query; dbModule.pool.connect = saved.connect;
  lt.refreshSoon = saved.refreshSoon; lt.runLinkedTasks = saved.run; lt.ensureStillChargingTask = saved.ensure;
  lt._reset();
});

const TODAY = "2026-11-28";
function settingsPool(row = { linked_tasks_enabled: true, linked_tasks_sources: { bills: true }, linked_tasks_bill_lead_days: 5 }) {
  const calls = { selects: 0, states: [] };
  return {
    calls,
    async query(sql, params) {
      if (/^SELECT linked_tasks_enabled/.test(sql)) { calls.selects++; return { rows: [row] }; }
      if (/^UPDATE user_settings SET linked_tasks_state/.test(sql)) { calls.states.push(JSON.parse(params[0])); return { rows: [] }; }
      throw new Error("unexpected SQL: " + sql);
    },
  };
}
const PS_POOL = { query: async () => { throw new Error("the injected sync owns Per-sistant"); } };

describe("runLinkedTasks", () => {
  it("does nothing without a Per-sistant pool (a standalone Perfin)", async () => {
    const pool = settingsPool();
    assert.deepEqual(await lt.runLinkedTasks(pool, null, { today: TODAY }), { status: "no_persistent", ran: false });
    assert.equal(pool.calls.selects, 0);
  });

  it("off → disabled, and no further settings read that day until invalidate()", async () => {
    const pool = settingsPool({ linked_tasks_enabled: false });
    let synced = 0;
    const deps = { compute: async () => ({ ok_kinds: [], desired: [], errors: [] }), sync: async () => { synced++; return {}; } };
    assert.equal((await lt.runLinkedTasks(pool, PS_POOL, { today: TODAY, deps })).status, "disabled");
    assert.equal((await lt.runLinkedTasks(pool, PS_POOL, { today: TODAY, deps })).status, "disabled");
    assert.equal(pool.calls.selects, 1);
    lt.invalidate();
    await lt.runLinkedTasks(pool, PS_POOL, { today: TODAY, deps });
    assert.equal(pool.calls.selects, 2);
    assert.equal(synced, 0);
  });

  it("computes with the stored settings and hands Per-sistant only the kinds read, then records the run", async () => {
    const pool = settingsPool();
    let computeArgs, syncArgs, syncPool;
    const desired = [{ key: "perfin:housing:2026-11", title: "Pay" }];
    const deps = {
      compute: async (p, cfg, today) => { computeArgs = { cfg, today }; return { ok_kinds: ["housing", "utility-amount"], desired, errors: [{ kind: "bill", error: "Could not read this source." }] }; },
      sync: async (p, args) => { syncPool = p; syncArgs = args; return { created: 1, updated: 0, closed: 2, reopened: 0, skipped: 0 }; },
    };
    const r = await lt.runLinkedTasks(pool, PS_POOL, { today: TODAY, deps });
    assert.deepEqual(computeArgs.cfg.sources, { still_charging: true, housing: true, utility_amount: true, bills: true, tax_documents: true });
    assert.equal(computeArgs.cfg.bill_lead_days, 5);
    assert.equal(computeArgs.today, TODAY);
    assert.equal(syncPool, PS_POOL);
    assert.deepEqual(syncArgs, { app: "perfin", kinds: ["housing", "utility-amount"], desired });
    assert.equal(r.status, "partial");
    const st = pool.calls.states[0];
    assert.deepEqual({ ...st, at: "x" }, { at: "x", desired: 1, created: 1, updated: 0, closed: 2, reopened: 0, skipped: 0, errors: [{ kind: "bill", error: "Could not read this source." }] });
  });

  it("a failed Per-sistant sync is recorded as a fixed sentence (never the exception text)", async () => {
    const pool = settingsPool();
    const r = await lt.runLinkedTasks(pool, PS_POOL, { today: TODAY, deps: {
      compute: async () => ({ ok_kinds: ["housing"], desired: [], errors: [] }),
      sync: async () => { throw new Error("relation todos has secret detail"); },
    } });
    assert.equal(r.status, "partial");
    assert.deepEqual(pool.calls.states[0].errors, [{ kind: null, error: "Could not update the tasks in Per-sistant." }]);
    assert.ok(!JSON.stringify(pool.calls.states[0]).includes("secret detail"));
  });

  it("one run at a time: a call during a run shares its promise and makes it go round once more", async () => {
    const pool = settingsPool();
    let rounds = 0, release;
    const gate = new Promise((r) => { release = r; });
    const deps = {
      compute: async () => { rounds++; if (rounds === 1) await gate; return { ok_kinds: [], desired: [], errors: [] }; },
      sync: async () => ({}),
    };
    const a = lt.runLinkedTasks(pool, PS_POOL, { today: TODAY, deps });
    await new Promise((r) => setImmediate(r));
    const b = lt.runLinkedTasks(pool, PS_POOL, { today: TODAY, deps });
    const c = lt.runLinkedTasks(pool, PS_POOL, { today: TODAY, deps });
    assert.equal(a, b); assert.equal(b, c);
    release();
    await a;
    assert.equal(rounds, 2, "the calls during the run collapse into one more round");
    await lt.runLinkedTasks(pool, PS_POOL, { today: TODAY, deps });
    assert.equal(rounds, 3, "a later call starts a fresh run");
  });
});

describe("the hourly job", () => {
  const startup = require("../teller/startup");
  it("is watched hourly and records an outcome only when it ran", async () => {
    assert.equal(jobHealth.JOB_INTERVALS_MS["linked-tasks"], 3600e3);
    const recorded = [];
    const origResult = jobHealth.result;
    jobHealth.result = (n, o) => recorded.push([n, o]);
    try {
      lt.runLinkedTasks = async () => ({ status: "disabled", ran: false });
      await startup._awayJobs.runLinkedTasksTick();
      assert.deepEqual(recorded, []);
      lt.runLinkedTasks = async () => ({ status: "ok", ran: true });
      await startup._awayJobs.runLinkedTasksTick();
      lt.runLinkedTasks = async () => ({ status: "partial", ran: true, errors: [{ kind: "bill", error: "Could not read this source." }] });
      await startup._awayJobs.runLinkedTasksTick();
      lt.runLinkedTasks = async () => { throw new Error("db down"); };
      await startup._awayJobs.runLinkedTasksTick();
    } finally { jobHealth.result = origResult; }
    assert.deepEqual(recorded, [
      ["linked-tasks", { ok: true }],
      ["linked-tasks", { ok: false, error: "bill: Could not read this source." }],
      ["linked-tasks", { ok: false, error: "db down" }],
    ]);
  });

  it("the settings PATCH invalidates the off-for-today memo", async () => {
    const pool = settingsPool({ linked_tasks_enabled: false });
    await lt.runLinkedTasks(pool, PS_POOL, { today: TODAY });
    dbModule.pool.query = async () => ({ rows: [{}] });
    const app = express(); app.use(express.json()); app.use(require("../teller/routes/settings"));
    await supertest(app).patch("/api/settings").send({ linked_tasks_enabled: true }).expect(200);
    await lt.runLinkedTasks(pool, PS_POOL, { today: TODAY });
    assert.equal(pool.calls.selects, 2);
  });
});

describe("ensureStillChargingTask", () => {
  const sub = { id: 12, display_name: "Netflix", charged: "15.49", charged_on: "2026-11-20", transaction_id: "txn_ab/cd 9" };
  it("creates one high-priority task keyed by the subscription and the charge", async () => {
    let args;
    const r = await lt.ensureStillChargingTask(settingsPool(), sub, { persistentPool: PS_POOL, deps: { ensure: async (p, a) => { args = a; return { created: true, id: 4 }; } } });
    assert.deepEqual(r, { status: "ok", created: true, id: 4 });
    assert.equal(args.app, "perfin");
    assert.equal(args.task.key, "perfin:still-charging:12:txn_ab-cd-9");
    assert.equal(args.task.title, "Check Netflix — charged $15.49 after you cancelled");
    assert.deepEqual([args.task.url, args.task.priority, args.task.due_date], ["/subscriptions", "high", null]);
    const ps = require("../apps/per-sistant/services/linked-tasks");
    assert.equal(ps.checkTask("perfin", ["still-charging"], args.task).error, undefined);
  });

  it("nothing while the switch or the source is off, or without Per-sistant", async () => {
    let called = 0;
    const deps = { ensure: async () => { called++; return { created: true }; } };
    assert.equal((await lt.ensureStillChargingTask(settingsPool({ linked_tasks_enabled: false }), sub, { persistentPool: PS_POOL, deps })).status, "disabled");
    assert.equal((await lt.ensureStillChargingTask(settingsPool({ linked_tasks_enabled: true, linked_tasks_sources: { still_charging: false } }), sub, { persistentPool: PS_POOL, deps })).status, "disabled");
    const pool = settingsPool();
    assert.equal((await lt.ensureStillChargingTask(pool, sub, { persistentPool: null, deps })).status, "no_persistent");
    assert.equal(pool.calls.selects, 0);
    assert.equal(called, 0);
  });
});

describe("the hooks", () => {
  // A permissive fake for the hooked routes: canned rows for the statements
  // they need, a client for the transactional ones.
  function routePool() {
    const query = async (sql) => {
      if (/SELECT housing_config/.test(sql)) return { rows: [{ housing_config: {} }] };
      if (/FROM payee_obligations WHERE id = ANY/.test(sql)) return { rows: [{ id: 1, payee: "P", label: "Rent", period: "2026-11", amount: "100", status: "unpaid" }] };
      if (/DELETE FROM payee_obligations/.test(sql)) return { rows: [{ period: "2026-11", category: "rent", label: "Rent", auto_generated: false }] };
      return { rows: [{ id: 1, amount: "10" }], rowCount: 1 };
    };
    dbModule.pool.query = query;
    dbModule.pool.connect = async () => ({ query, release() {} });
  }
  const CALLS = [
    ["post", "/api/housing/generate", {}, "housing-generate"],
    ["post", "/api/housing/obligations", { label: "Gas", period: "2026-11", amount: 40 }, "housing-obligation-add"],
    ["patch", "/api/housing/obligations/1", { amount: 40 }, "housing-obligation-edit"],
    ["delete", "/api/housing/obligations/1", {}, "housing-obligation-delete"],
    ["post", "/api/housing/payments", { obligation_ids: [1] }, "housing-payment"],
    ["delete", "/api/housing/payments/1", {}, "housing-payment-undo"],
    ["post", "/api/bill-payments", { bill_source: "manual", bill_id: 3, paid_date: "2026-11-30" }, "bill-payment"],
    ["delete", "/api/bill-payments/1", {}, "bill-payment-undo"],
  ];
  const app = () => {
    const a = express(); a.use(express.json());
    a.use(require("../teller/routes/housing")); a.use(require("../teller/routes/subscriptions"));
    return a;
  };

  it("every write that can resolve or reopen a task kicks a refresh", async () => {
    routePool();
    const kicked = [];
    lt.refreshSoon = (reason) => kicked.push(reason);
    for (const [m, url, body] of CALLS) await supertest(app())[m](url).send(body).expect(200);
    assert.deepEqual(kicked, CALLS.map((c) => c[3]));
  });

  it("a throwing refresher never fails the route", async () => {
    routePool();
    lt.refreshSoon = () => { throw new Error("refresher exploded"); };
    for (const [m, url, body] of CALLS) await supertest(app())[m](url).send(body).expect(200);
  });

  it("refreshSoon never rejects — a failing run is logged", async () => {
    lt.runLinkedTasks = async () => { throw new Error("boom"); };
    const logged = [];
    const orig = console.error;
    console.error = (...a) => logged.push(a.join(" "));
    try {
      lt.refreshSoon("test");
      await new Promise((r) => setTimeout(r, 10));
    } finally { console.error = orig; }
    assert.ok(logged.some((l) => /linked tasks refresh \(test\) failed: boom/.test(l)));
  });

  it("the watchdog creates the still-charging task after marking the alert; a failure never un-marks it", async () => {
    const subs = require("../teller/routes/subscriptions");
    const notifications = require("../teller/routes/notifications");
    const persistent = require("../teller/routes/persistent");
    const orig = { send: notifications.sendToAll, email: persistent.sendCriticalAlertEmail };
    notifications.sendToAll = async () => ({ logged: true });
    persistent.sendCriticalAlertEmail = async () => ({ sent: false });
    const order = [];
    const db = { query: async (sql) => {
      if (/FROM detected_subscriptions ds/.test(sql)) return { rows: [{ id: 12, display_name: "Netflix", amount: "15.49", charged: "15.49", charged_on: "2026-11-20", transaction_id: "txn_1" }] };
      if (/UPDATE detected_subscriptions SET still_charging_txn/.test(sql)) { order.push("marked"); return { rows: [] }; }
      return { rows: [] };
    } };
    try {
      lt.ensureStillChargingTask = async (p, sub) => { order.push("task:" + sub.id + ":" + sub.transaction_id); return { created: true }; };
      assert.equal((await subs.runSubscriptionWatchdog(db)).still_charging, 1);
      assert.deepEqual(order, ["marked", "task:12:txn_1"]);
      order.length = 0;
      lt.ensureStillChargingTask = async () => { throw new Error("per-sistant down"); };
      assert.equal((await subs.runSubscriptionWatchdog(db)).still_charging, 1, "the alert still counts");
      assert.deepEqual(order, ["marked"]);
    } finally { notifications.sendToAll = orig.send; persistent.sendCriticalAlertEmail = orig.email; }
  });
});
