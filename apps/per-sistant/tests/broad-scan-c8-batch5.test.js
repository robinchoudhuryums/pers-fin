// ============================================================================
// Cycle-8 broad scan Batch 5 — linked tasks, Per-sistant's side
// ============================================================================
// F16: a key in linked_task_tombstones (db/031's trigger on a hard delete) is
// never inserted again. F17: `retain` keeps an open task open, never creates,
// and ignores an unlisted kind. F18: an auto-close announces nothing, and the
// completion counts (analytics, the weekly review, Ask, /api/stats) leave
// auto-closed tasks out. F19: a linked task's webhook / Slack payload carries
// a kind label, never its title, description or snapshot. F20: the sync runs
// in one transaction under the advisory lock and announces only after COMMIT;
// a failure rolls back and announces nothing. F23: housingDueUnlessTask hides
// the rent line while a housing task is open, fail-soft. The database-backed
// half is the root tests/contract/c8-batch5.
// ============================================================================
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const helpers = require("../helpers");
const linked = require("../services/linked-tasks");
const { fakePool } = require("./_linked-tasks-fake");
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

let announced;
const savedAnnounce = helpers.announceTodoEvent;
beforeEach(() => { announced = []; helpers.announceTodoEvent = (ev, row) => announced.push([ev, row.source_key]); });
afterEach(() => { helpers.announceTodoEvent = savedAnnounce; });

const rent = (period) => ({ key: `perfin:housing:${period}`, title: `Pay Sam $1,800 for ${period}`, url: "/housing", due_date: `${period}-01`, priority: "high" });
const bill = (date) => ({ key: `perfin:bill:4:${date}`, title: "Pay Gym", url: "/calendar", due_date: date });
const sync = (pool, args) => linked.syncLinkedTasks(pool, { app: "perfin", kinds: ["housing", "bill"], ...args });

// ---------------------------------------------------------------- F16
describe("F16 — a task deleted for good stays deleted", () => {
  it("a tombstoned key is never inserted again", async () => {
    const pool = fakePool();
    await sync(pool, { desired: [rent("2026-11")] });
    pool.hardDelete("perfin:housing:2026-11");
    const r = await sync(pool, { desired: [rent("2026-11")] });
    assert.equal(r.created, 0);
    assert.equal(pool.rows.length, 0);
    assert.deepEqual(announced, [["todo_created", "perfin:housing:2026-11"]], "announced once, at the first create");
  });

  it("the insert checks the tombstones, and db/031 keeps the key on every hard delete (idempotent)", () => {
    const src = read("services/linked-tasks.js");
    assert.match(src, /WHERE NOT EXISTS \(SELECT 1 FROM linked_task_tombstones WHERE source_key = \$6\)/);
    const sql = read("db/031_linked_task_tombstones.sql");
    assert.match(sql, /CREATE TABLE IF NOT EXISTS linked_task_tombstones/);
    assert.match(sql, /DROP TRIGGER IF EXISTS trg_todos_tombstone_linked ON todos;\s*CREATE TRIGGER trg_todos_tombstone_linked\s*BEFORE DELETE ON todos/);
    assert.match(sql, /WHEN \(OLD\.source_key IS NOT NULL\)/);
  });
});

// ---------------------------------------------------------------- F17
describe("F17 — retain keeps an aged, still-unpaid task open", () => {
  it("a retained key isn't closed, created or refreshed; dropping it closes the task", async () => {
    const pool = fakePool();
    await sync(pool, { desired: [bill("2026-10-15")] });
    let r = await sync(pool, { desired: [], retain: ["perfin:bill:4:2026-10-15", "perfin:bill:4:2026-09-15"] });
    assert.equal(r.closed, 0);
    assert.equal(r.created, 0, "retain never creates");
    assert.equal(pool.rows.length, 1);
    assert.equal(pool.rows[0].completed, false);
    r = await sync(pool, { desired: [], retain: [] });
    assert.equal(r.closed, 1, "paid → no longer retained → closed");
  });

  it("a retained key of a kind not listed this run is ignored", async () => {
    const pool = fakePool();
    await sync(pool, { desired: [bill("2026-10-15")] });
    const r = await linked.syncLinkedTasks(pool, { app: "perfin", kinds: ["bill"], desired: [], retain: ["perfin:housing:2026-10"] });
    assert.equal(r.closed, 1);
  });
});

// ---------------------------------------------------------------- F18
describe("F18 — an auto-close isn't your completion", () => {
  it("closing announces nothing (no todo_completed automation, webhook or Slack post)", async () => {
    const pool = fakePool();
    await sync(pool, { desired: [rent("2026-11")] });
    announced = [];
    const r = await sync(pool, { desired: [] });
    assert.equal(r.closed, 1);
    assert.deepEqual(announced, []);
  });

  it("every completion count leaves auto-closed tasks out", () => {
    const analytics = read("routes/analytics.js");
    assert.equal((analytics.match(/completed = true AND NOT auto_closed AND completed_at >= \$1/g) || []).length, 4);
    assert.match(analytics, /FROM todos WHERE deleted_at IS NULL AND NOT auto_closed AND created_at >= \$1`, \[sd\]\)/);
    assert.match(analytics, /FROM todos WHERE deleted_at IS NULL AND NOT auto_closed AND created_at >= \$1 GROUP BY category/);
    assert.match(read("routes/review.js"), /FROM todos WHERE deleted_at IS NULL AND NOT auto_closed AND completed_at >= \$1/);
    const ai = read("routes/ai.js");
    assert.match(ai, /NOT COALESCE\(missed, false\) AND NOT auto_closed\) AS todos_done/);
    assert.match(ai, /t\.auto_closed\?'closed by Perfin'/);
    assert.match(read("routes/settings.js"), /NOT COALESCE\(missed, false\) AND NOT auto_closed\) as done/);
  });
});

// ---------------------------------------------------------------- F19
describe("F19 — outside parties never get a linked task's figures", () => {
  const row = { id: 9, title: "Pay Sam Lee $1,800.00 for Nov 2026", description: "$1,800.00 owed: Rent", priority: "high",
    due_date: "2026-11-01", completed: true, source_app: "perfin", source_key: "perfin:housing:2026-11",
    source_snapshot: { title: "Pay Sam Lee $1,800.00" }, source_url: "/housing" };

  it("linkedTaskWebhookData keeps only the kind, dates and state", () => {
    const d = helpers.linkedTaskWebhookData(row);
    assert.deepEqual(d, { id: 9, title: "Perfin task: rent & utilities due", linked: true, source_app: "perfin", kind: "housing",
      priority: "high", due_date: "2026-11-01", completed: true });
    assert.ok(!JSON.stringify(d).includes("1,800"));
    assert.ok(!JSON.stringify(d).includes("Sam"));
    assert.equal(helpers.slackLineFor("todo_completed", d), "Completed: Perfin task: rent & utilities due");
    assert.equal(helpers.linkedTaskWebhookData({ ...row, source_key: "perfin:new-kind:1" }).title, "Perfin task: finance task");
  });

  it("fireWebhooks reduces any todo_* event for a linked task before webhooks and Slack", () => {
    const src = read("helpers.js");
    const at = src.indexOf("async function fireWebhooks");
    assert.match(src.slice(at, at + 200), /if \(data && data\.source_key && String\(eventType\)\.startsWith\("todo_"\)\) data = linkedTaskWebhookData\(data\);/);
  });
});

// ---------------------------------------------------------------- F20
describe("F20 — one sync at a time across processes", () => {
  it("runs in a transaction under the lock and announces only after COMMIT", async () => {
    const pool = fakePool();
    const seen = [];
    helpers.announceTodoEvent = (ev, r) => seen.push([ev, r.source_key, pool.queries[pool.queries.length - 1]]);
    await sync(pool, { desired: [rent("2026-11")] });
    assert.equal(pool.queries[0], "BEGIN");
    assert.match(pool.queries[1], /^SELECT pg_advisory_xact_lock/);
    assert.equal(pool.queries[pool.queries.length - 1], "COMMIT");
    assert.deepEqual(seen, [["todo_created", "perfin:housing:2026-11", "COMMIT"]]);
    assert.equal(pool.released, 1);
  });

  it("a failure rolls back, releases the client and announces nothing", async () => {
    const pool = fakePool();
    const inner = pool.query;
    pool.query = async (sql, params) => { if (/^UPDATE todos SET completed = true/.test(sql)) throw new Error("boom"); return inner(sql, params); };
    await assert.rejects(sync(pool, { desired: [rent("2026-11")] }), /boom/);
    assert.equal(pool.queries[pool.queries.length - 1], "ROLLBACK");
    assert.deepEqual(announced, []);
    assert.equal(pool.released, 1);
  });

  it("the lock key is its own (not a migration lock)", () => {
    assert.equal(linked.LINKED_TASKS_LOCK_KEY, 727274010);
  });
});

// ---------------------------------------------------------------- F23
describe("F23 — the open task is the rent reminder", () => {
  const { housingDueUnlessTask, housingTaskOpen } = require("../routes/housing-due");
  const CFG = { enabled: true, payee_name: "Sam", rent_due_day: 1, reminder_lead_days: 5 };
  const perfin = { query: async (sql) => (/housing_config/.test(sql) ? { rows: [{ housing_config: CFG }] } : { rows: [{ balance: "1500.00", n: 1 }] }) };
  const ps = (open) => ({ query: async (sql) => { assert.match(sql, /source_key LIKE 'perfin:housing:%'/); return { rows: open ? [{}] : [] }; } });

  it("hides the rent line while a housing task is open, shows it otherwise", async () => {
    assert.equal(await housingDueUnlessTask(perfin, ps(true), "2026-10-01"), null);
    assert.equal((await housingDueUnlessTask(perfin, ps(false), "2026-10-01")).status, "due_today");
  });

  it("is fail-soft: a failed task lookup keeps the line, no pool reads as no task", async () => {
    const bad = { query: async () => { throw new Error("boom"); } };
    assert.equal(await housingTaskOpen(bad), false);
    assert.equal((await housingDueUnlessTask(perfin, bad, "2026-10-01")).status, "due_today");
    assert.equal(await housingTaskOpen(null), false);
  });

  it("both surfaces use it", () => {
    assert.match(read("routes/notifications.js"), /housingDueUnlessTask\(perfinPool, pool, today\)/);
    assert.match(read("routes/ai.js"), /await housingDueUnlessTask\(perfinPool, pool\)/);
  });
});
