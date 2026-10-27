// ============================================================================
// Cycle-8 broad scan Batch 5 — linked tasks, Perfin's side
// ============================================================================
// F17: an unpaid manual-bill occurrence older than the 30-day window is
// RETAINED (its open task stays open) rather than dropped, and the runner
// hands the retained keys to Per-sistant; a paid one isn't retained.
// F21: the hourly tick (scheduled) runs once a local day — after a clean run
// it reads nothing until the next day, a kick / Run now / invalidate(); a
// partial run is retried. F22: the housing config PATCH, the manual-bill
// writes and the housing ledger tick (when it generated rows) kick a refresh.
// Per-sistant's half is apps/per-sistant/tests/broad-scan-c8-batch5.test.js;
// the database-backed half is tests/contract/c8-batch5.
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const lt = require("../teller/services/linked-tasks");
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

beforeEach(() => lt._reset());
afterEach(() => lt._reset());

// ---------------------------------------------------------------- F17
describe("F17 — an aged unpaid bill is retained, not dropped", () => {
  const TODAY = "2026-11-28";
  function billPool({ bills, paid = [] }) {
    const calls = [];
    return {
      calls,
      async query(sql, params) {
        calls.push({ sql, params });
        if (/FROM manual_bills/.test(sql)) return { rows: bills };
        if (/FROM bill_payments/.test(sql)) return { rows: paid };
        throw new Error("unexpected SQL: " + sql);
      },
    };
  }
  const cfg = { sources: { still_charging: false, housing: false, utility_amount: false, bills: true, tax_documents: false }, bill_lead_days: 3 };

  it("keeps every unpaid occurrence before the window as retain, from the bill's creation month", async () => {
    const pool = billPool({
      bills: [{ id: 7, name: "Gym", amount: "40", due_day: 15, cadence: "monthly", created_at: new Date(2026, 6, 3) }],
      paid: [{ bill_id: 7, paid_date: "2026-09-15" }],
    });
    const r = await lt.computeLinkedTasks(pool, cfg, TODAY);
    assert.deepEqual(r.ok_kinds, ["bill"]);
    // the window (Oct 29 … Dec 1) creates Nov 15
    assert.deepEqual(r.desired.map((d) => d.key), ["perfin:bill:7:2026-11-15"]);
    // Jul 15 / Aug 15 / Oct 15 unpaid before the window → retained; Sep 15 paid → not
    assert.deepEqual(r.retain, ["perfin:bill:7:2026-07-15", "perfin:bill:7:2026-08-15", "perfin:bill:7:2026-10-15"]);
    const paidQuery = pool.calls.find((c) => /FROM bill_payments/.test(c.sql));
    assert.deepEqual(paidQuery.params, ["2026-07-01", "2026-12-01"], "payments read from the earliest creation month");
  });

  it("a bill created inside the window retains nothing", async () => {
    const pool = billPool({ bills: [{ id: 8, name: "Pool", amount: "25", due_day: 20, cadence: "monthly", created_at: "2026-11-05" }] });
    const r = await lt.computeLinkedTasks(pool, cfg, TODAY);
    assert.deepEqual(r.retain, []);
    assert.deepEqual(r.desired.map((d) => d.key), ["perfin:bill:8:2026-11-20"]);
  });

  it("the runner hands the retained keys to Per-sistant", async () => {
    let args;
    const pool = { async query(sql) {
      if (/^SELECT linked_tasks_enabled/.test(sql)) return { rows: [{ linked_tasks_enabled: true }] };
      return { rows: [] };
    } };
    await lt.runLinkedTasks(pool, {}, { today: TODAY, deps: {
      compute: async () => ({ ok_kinds: ["bill"], desired: [], retain: ["perfin:bill:7:2026-08-15"], errors: [] }),
      sync: async (p, a) => { args = a; return {}; },
    } });
    assert.deepEqual(args.retain, ["perfin:bill:7:2026-08-15"]);
  });
});

// ---------------------------------------------------------------- F21
describe("F21 — the hourly tick runs once a local day", () => {
  const TODAY = "2026-11-28";
  function settingsPool() {
    const calls = { selects: 0 };
    return { calls, async query(sql) {
      if (/^SELECT linked_tasks_enabled/.test(sql)) { calls.selects++; return { rows: [{ linked_tasks_enabled: true }] }; }
      return { rows: [] };
    } };
  }
  const okDeps = (counter, errors = []) => ({
    compute: async () => { counter.n++; return { ok_kinds: ["housing"], desired: [], retain: [], errors }; },
    sync: async () => ({}),
  });

  it("after a clean run a scheduled tick reads nothing that day; the next day it runs", async () => {
    const pool = settingsPool(); const c = { n: 0 };
    assert.equal((await lt.runLinkedTasks(pool, {}, { today: TODAY, deps: okDeps(c), scheduled: true })).status, "ok");
    const r = await lt.runLinkedTasks(pool, {}, { today: TODAY, deps: okDeps(c), scheduled: true });
    assert.deepEqual(r, { status: "fresh", ran: false });
    assert.equal(pool.calls.selects, 1, "no settings read");
    assert.equal(c.n, 1, "no computation");
    assert.equal((await lt.runLinkedTasks(pool, {}, { today: "2026-11-29", deps: okDeps(c), scheduled: true })).status, "ok");
    assert.equal(c.n, 2);
  });

  it("a kick or Run now (unscheduled) always runs, and invalidate() lets the tick run again", async () => {
    const pool = settingsPool(); const c = { n: 0 };
    await lt.runLinkedTasks(pool, {}, { today: TODAY, deps: okDeps(c), scheduled: true });
    await lt.runLinkedTasks(pool, {}, { today: TODAY, deps: okDeps(c) });
    assert.equal(c.n, 2);
    lt.invalidate();
    assert.equal((await lt.runLinkedTasks(pool, {}, { today: TODAY, deps: okDeps(c), scheduled: true })).status, "ok");
    assert.equal(c.n, 3);
  });

  it("a partial run is retried by the next tick", async () => {
    const pool = settingsPool(); const c = { n: 0 };
    const bad = okDeps(c, [{ kind: "bill", error: "Could not read this source." }]);
    assert.equal((await lt.runLinkedTasks(pool, {}, { today: TODAY, deps: bad, scheduled: true })).status, "partial");
    assert.equal((await lt.runLinkedTasks(pool, {}, { today: TODAY, deps: okDeps(c), scheduled: true })).status, "ok");
    assert.equal(c.n, 2);
  });

  it("the startup tick passes scheduled: true", () => {
    assert.match(read("teller/startup.js"), /runLinkedTasks\(pool, undefined, \{ scheduled: true \}\)/);
  });
});

// ---------------------------------------------------------------- F22
describe("F22 — the remaining writes kick the refresh", () => {
  it("PATCH /api/housing/config kicks after COMMIT", () => {
    const src = read("teller/routes/housing.js");
    const at = src.indexOf('router.patch("/api/housing/config"');
    const body = src.slice(at, src.indexOf("router.get(", at));
    assert.ok(body.indexOf('linkedTasks.kick("housing-config")') > body.indexOf('client.query("COMMIT")'));
  });

  it("the manual-bill POST / PATCH / DELETE kick", () => {
    const src = read("teller/routes/subscriptions.js");
    for (const [route, reason] of [['router.post("/api/manual-bills"', "manual-bill-add"], ['router.patch("/api/manual-bills/:id"', "manual-bill-edit"], ['router.delete("/api/manual-bills/:id"', "manual-bill-delete"]]) {
      const at = src.indexOf(route);
      const body = src.slice(at, src.indexOf("\nrouter.", at + 10));
      assert.ok(body.includes(`linkedTasks.kick("${reason}")`), route);
    }
  });

  it("the housing ledger tick kicks only when it generated obligations", () => {
    const src = read("teller/startup.js");
    assert.match(src, /if \(gen && gen\.generated > 0\) require\("\.\/services\/linked-tasks"\)\.kick\("housing-generate"\)/);
  });
});
