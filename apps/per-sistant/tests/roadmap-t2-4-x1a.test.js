// ============================================================================
// Roadmap T2.4 X1a — linked tasks: the sync core (services/linked-tasks.js)
// ============================================================================
// syncLinkedTasks over an in-memory fake pool that applies the module's own
// statements to a todos array: a key in the desired set is created once (and
// announced), a re-run changes nothing, a key that left the set is closed as
// auto_closed, an auto_closed task whose key came back is reopened, a task
// completed by hand (source_detached — db/030's trigger, checked on real
// Postgres in tests/contract/linked-tasks) is never reopened or closed, a
// trashed row is not recreated, only listed kinds are closed, a malformed key /
// unlisted kind / bad field is refused without closing its key; ensureLinkedTask
// creates once and never closes; the migration file is idempotent. The fake
// only models the statements' intent — their SQL predicates (detached, kinds,
// trash) are judged on real Postgres by tests/contract/linked-tasks.
// ============================================================================
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const helpers = require("../helpers");
const linked = require("../services/linked-tasks");

let announced;
const savedAnnounce = helpers.announceTodoEvent;
beforeEach(() => { announced = []; helpers.announceTodoEvent = (ev, row) => announced.push([ev, row.source_key]); });
afterEach(() => { helpers.announceTodoEvent = savedAnnounce; });

// A fake pool that understands exactly the statements linked-tasks.js sends.
function fakePool() {
  const rows = [];
  let nextId = 1;
  const queries = [];
  return {
    rows,
    queries,
    async query(sql, params) {
      queries.push(sql);
      if (/^INSERT INTO todos/.test(sql)) {
        const [title, description, priority, due_date, source_app, source_key, source_url, snapshot] = params;
        if (rows.some((r) => r.source_key === source_key)) return { rows: [], rowCount: 0 };
        const row = { id: nextId++, title, description, priority, horizon: "short", category: "finance", due_date,
          source_app, source_key, source_url, source_snapshot: JSON.parse(snapshot),
          completed: false, completed_at: null, auto_closed: false, source_detached: false, deleted_at: null };
        rows.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (/^UPDATE todos SET completed = false/.test(sql)) {
        const [app, keys] = params;
        const hit = rows.filter((r) => r.source_app === app && keys.includes(r.source_key) && r.completed && r.auto_closed && !r.source_detached && !r.deleted_at);
        for (const r of hit) { r.completed = false; r.completed_at = null; r.auto_closed = false; }
        return { rows: hit.map((r) => ({ id: r.id })), rowCount: hit.length };
      }
      if (/^UPDATE todos SET completed = true/.test(sql)) {
        const [app, keys, kinds] = params;
        const hit = rows.filter((r) => r.source_app === app && kinds.includes(r.source_key.split(":")[1]) && !keys.includes(r.source_key) && !r.completed && !r.source_detached && !r.deleted_at);
        for (const r of hit) { r.completed = true; r.completed_at = "now"; r.auto_closed = true; }
        return { rows: hit, rowCount: hit.length };
      }
      if (/^SELECT id FROM todos WHERE source_key/.test(sql)) {
        const r = rows.find((x) => x.source_key === params[0]);
        return { rows: r ? [{ id: r.id }] : [], rowCount: r ? 1 : 0 };
      }
      throw new Error("unexpected SQL: " + sql);
    },
  };
}

const KINDS = ["housing", "bill"];
const rent = (period, extra = {}) => ({ key: `perfin:housing:${period}`, title: `Pay rent for ${period}`, url: "/perfin/housing", due_date: `${period}-01`, priority: "high", ...extra });
const bill = (id) => ({ key: `perfin:bill:${id}:2026-11-03`, title: `Pay bill ${id}`, url: "/perfin/calendar", due_date: "2026-11-03" });
const sync = (pool, desired, kinds = KINDS) => linked.syncLinkedTasks(pool, { app: "perfin", kinds, desired });

describe("syncLinkedTasks", () => {
  it("creates a missing task once, with the finance shape and a snapshot, and announces it", async () => {
    const pool = fakePool();
    const r = await sync(pool, [rent("2026-11")]);
    assert.deepEqual(r, { created: 1, closed: 0, reopened: 0, skipped: 0 });
    const row = pool.rows[0];
    assert.equal(row.category, "finance");
    assert.equal(row.horizon, "short");
    assert.equal(row.priority, "high");
    assert.equal(row.source_app, "perfin");
    assert.equal(row.source_url, "/perfin/housing");
    assert.deepEqual(row.source_snapshot, { title: "Pay rent for 2026-11", description: null, due_date: "2026-11-01", priority: "high" });
    assert.deepEqual(announced, [["todo_created", "perfin:housing:2026-11"]]);
  });

  it("a re-run over the same set changes nothing", async () => {
    const pool = fakePool();
    await sync(pool, [rent("2026-11"), bill(4)]);
    announced = [];
    const r = await sync(pool, [rent("2026-11"), bill(4)]);
    assert.deepEqual(r, { created: 0, closed: 0, reopened: 0, skipped: 0 });
    assert.equal(pool.rows.length, 2);
    assert.deepEqual(announced, []);
  });

  it("closes a task whose key left the set as auto_closed, and reopens it when the key comes back", async () => {
    const pool = fakePool();
    await sync(pool, [rent("2026-11")]);
    announced = [];
    let r = await sync(pool, []);
    assert.equal(r.closed, 1);
    assert.equal(pool.rows[0].completed, true);
    assert.equal(pool.rows[0].auto_closed, true);
    assert.deepEqual(announced, [["todo_completed", "perfin:housing:2026-11"]]);
    r = await sync(pool, [rent("2026-11")]);
    assert.deepEqual(r, { created: 0, closed: 0, reopened: 1, skipped: 0 });
    assert.equal(pool.rows[0].completed, false);
    assert.equal(pool.rows[0].auto_closed, false);
  });

  it("a hand completion is final: never reopened, and a hand reopen is never closed", async () => {
    const pool = fakePool();
    await sync(pool, [rent("2026-11"), rent("2026-12")]);
    // what db/030's trigger does when a route completes / reopens a linked task
    Object.assign(pool.rows[0], { completed: true, source_detached: true });
    let r = await sync(pool, [rent("2026-11"), rent("2026-12")]);
    assert.equal(r.reopened, 0);
    assert.equal(pool.rows[0].completed, true);
    Object.assign(pool.rows[1], { source_detached: true }); // reopened by hand after an auto-close
    r = await sync(pool, []);
    assert.equal(r.closed, 0);
    assert.equal(pool.rows[1].completed, false);
  });

  it("does not recreate or reopen a trashed task", async () => {
    const pool = fakePool();
    await sync(pool, [rent("2026-11")]);
    pool.rows[0].deleted_at = "yesterday";
    const r = await sync(pool, [rent("2026-11")]);
    assert.deepEqual(r, { created: 0, closed: 0, reopened: 0, skipped: 0 });
    assert.equal(pool.rows.length, 1);
  });

  it("closes only the listed kinds — a failed source's tasks stay open", async () => {
    const pool = fakePool();
    await sync(pool, [rent("2026-11"), bill(4)]);
    const r = await sync(pool, [], ["bill"]); // the housing query failed this run
    assert.equal(r.closed, 1);
    assert.equal(pool.rows.find((x) => x.source_key.includes("housing")).completed, false);
    assert.equal(pool.rows.find((x) => x.source_key.includes("bill")).completed, true);
  });

  it("closes nothing at all when no kind is listed", async () => {
    const pool = fakePool();
    await sync(pool, [rent("2026-11")]);
    const n = pool.queries.length;
    const r = await sync(pool, [], []);
    assert.equal(r.closed, 0);
    assert.equal(pool.queries.length, n, "no UPDATE sent");
  });

  it("refuses a malformed key, another app's key and an unlisted kind", async () => {
    const pool = fakePool();
    const r = await sync(pool, [
      { key: "perfin:housing", title: "no id" },
      { key: "persistent:housing:1", title: "other app" },
      { key: "perfin:goal:1", title: "unlisted kind" },
      { key: "perfin:housing:2026-11 x", title: "space in id" },
      { key: "perfin:Housing:1", title: "kind case" },
      null,
    ]);
    assert.equal(r.skipped, 6);
    assert.equal(r.created, 0);
    assert.equal(pool.rows.length, 0);
  });

  it("refuses bad fields, but a valid key with a bad field still counts as desired (not closed)", async () => {
    const pool = fakePool();
    await sync(pool, [rent("2026-11")]);
    const bad = [
      rent("2026-11", { title: "" }),
      rent("2026-11", { title: "x".repeat(301) }),
      rent("2026-11", { description: "x".repeat(2001) }),
      rent("2026-11", { url: "javascript:alert(1)" }),
      rent("2026-11", { url: "//evil.example/x" }),
      rent("2026-11", { url: "/x\\y" }),
      rent("2026-11", { due_date: "2026-02-30" }),
      rent("2026-11", { priority: "High" }),
    ];
    for (const item of bad) {
      const r = await sync(pool, [item]);
      assert.equal(r.skipped, 1, JSON.stringify(item).slice(0, 80));
      assert.equal(r.closed, 0, "its key is still desired");
    }
    assert.equal(pool.rows[0].completed, false);
  });

  it("defaults priority to medium and allows a null url / due date", async () => {
    const pool = fakePool();
    await sync(pool, [{ key: "perfin:bill:9:2026-11-03", title: "Pay it" }]);
    assert.equal(pool.rows[0].priority, "medium");
    assert.equal(pool.rows[0].source_url, null);
    assert.equal(pool.rows[0].due_date, null);
  });

  it("throws on a bad app name", async () => {
    await assert.rejects(linked.syncLinkedTasks(fakePool(), { app: "Perfin", kinds: [], desired: [] }), /bad app/);
  });
});

describe("ensureLinkedTask", () => {
  const sc = { key: "perfin:still-charging:7:txn_abc", title: "Netflix charged you after you cancelled", url: "/perfin/subscriptions", priority: "high" };

  it("creates once, then reports the existing id, and announces only the first", async () => {
    const pool = fakePool();
    const a = await linked.ensureLinkedTask(pool, { app: "perfin", task: sc });
    assert.deepEqual(a, { created: true, id: 1 });
    const b = await linked.ensureLinkedTask(pool, { app: "perfin", task: sc });
    assert.deepEqual(b, { created: false, id: 1 });
    assert.equal(announced.length, 1);
  });

  it("is never closed by a sync that doesn't list its kind", async () => {
    const pool = fakePool();
    await linked.ensureLinkedTask(pool, { app: "perfin", task: sc });
    await sync(pool, []);
    assert.equal(pool.rows[0].completed, false);
  });

  it("refuses a bad task without writing", async () => {
    const pool = fakePool();
    const r = await linked.ensureLinkedTask(pool, { app: "perfin", task: { ...sc, url: "https://x.example" } });
    assert.equal(r.created, false);
    assert.match(r.error, /same-app path/);
    assert.equal(pool.rows.length, 0);
    const k = await linked.ensureLinkedTask(pool, { app: "perfin", task: { ...sc, key: "still-charging:7" } });
    assert.equal(k.error, "bad key");
  });
});

describe("db/030_linked_tasks.sql", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../db/030_linked_tasks.sql"), "utf8");
  it("is idempotent (every statement re-runnable — the migration test runs it twice)", () => {
    const stmts = sql.replace(/--[^\n]*/g, "").split(/;\s*(?=\n|$)/).map((s) => s.trim()).filter(Boolean);
    for (const s of stmts) {
      assert.ok(/IF NOT EXISTS|IF EXISTS|CREATE OR REPLACE|^\$\$|^END|^RETURN|^BEGIN|^NEW\./.test(s) || /^CREATE TRIGGER/.test(s), s.slice(0, 60));
    }
    assert.match(sql, /DROP TRIGGER IF EXISTS trg_todos_detach_linked ON todos;\s*CREATE TRIGGER trg_todos_detach_linked/);
  });
  it("covers trashed rows in the unique key and detaches only changes the sync didn't make", () => {
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_todos_source_key ON todos \(source_key\) WHERE source_key IS NOT NULL;/);
    assert.match(sql, /NEW\.auto_closed IS NOT DISTINCT FROM OLD\.auto_closed/);
  });
});
