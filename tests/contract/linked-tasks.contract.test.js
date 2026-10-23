// Real-Postgres contract tests for roadmap T2.4 X1a — linked tasks: db/030's
// columns, unique source_key (trashed rows included) and detach trigger, and
// services/linked-tasks.js driven against them alongside the real Per-sistant
// routes: a linked create firing a todo_created automation, close → reopen, a
// hand completion through PATCH or bulk complete never reopened, a trashed task
// not recreated, ensureLinkedTask once, and the migrations re-run cleanly.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const supertest = require("supertest");
const { SKIP, ROOT, persistentDb, persistentApp } = require("./_setup");

describe("Linked tasks (T2.4 X1a) on real Postgres", { skip: SKIP }, () => {
  let pool, app, linked;
  const q = (s, p) => pool.query(s, p);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const KINDS = ["housing", "bill"];
  const rent = (p) => ({ key: `perfin:housing:${p}`, title: `Pay rent for ${p}`, url: "/perfin/housing", due_date: `${p}-01`, priority: "high" });
  const sync = (desired, kinds = KINDS) => linked.syncLinkedTasks(pool, { app: "perfin", kinds, desired });
  const byKey = async (k) => (await q("SELECT * FROM todos WHERE source_key = $1", [k])).rows[0];

  before(async () => {
    pool = await persistentDb("linked_tasks");
    app = persistentApp(pool);
    linked = require(path.join(ROOT, "apps/per-sistant/services/linked-tasks"));
  });
  after(async () => { if (pool) await pool.end(); });

  it("the migration re-runs cleanly and adds the columns, unique index and trigger", async () => {
    await require(path.join(ROOT, "apps/per-sistant/db")).runMigrations();
    const cols = (await q("SELECT column_name FROM information_schema.columns WHERE table_name = 'todos' AND column_name LIKE ANY (ARRAY['source_%','auto_closed'])")).rows.map((r) => r.column_name).sort();
    assert.deepEqual(cols, ["auto_closed", "source_app", "source_detached", "source_key", "source_snapshot", "source_url"]);
    assert.equal((await q("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'trg_todos_detach_linked'")).rows[0].n, 1);
    await q("INSERT INTO todos (title, source_key) VALUES ('a', 'perfin:x:dup')");
    await assert.rejects(q("INSERT INTO todos (title, source_key) VALUES ('b', 'perfin:x:dup')"), /uq_todos_source_key/);
    await q("DELETE FROM todos WHERE source_key = 'perfin:x:dup'");
  });

  it("a linked create runs todo_created automations; the row has the finance shape", async () => {
    await supertest(app).post("/api/automations").send({ name: "finance urgent", trigger_type: "todo_created", conditions: { category: "finance" }, action_type: "set_horizon", action_data: { horizon: "medium" } }).expect(200);
    const r = await sync([rent("2026-11")]);
    assert.equal(r.created, 1);
    await wait(300);
    const row = await byKey("perfin:housing:2026-11");
    assert.equal(row.category, "finance");
    assert.equal(row.priority, "high");
    assert.equal(row.horizon, "medium", "the automation ran on the linked task");
    assert.equal(row.source_url, "/perfin/housing");
    assert.equal(row.source_snapshot.title, "Pay rent for 2026-11");
    assert.equal(row.source_detached, false);
    const listed = (await supertest(app).get("/api/todos").expect(200)).body;
    const found = (Array.isArray(listed) ? listed : listed.todos || []).find((t) => t.id === row.id);
    assert.ok(found, "listed by GET /api/todos");
    assert.equal(found.source_key, "perfin:housing:2026-11");
  });

  it("a re-run adds nothing; a resolved item closes; it reopens when it comes back — never detached by the sync", async () => {
    assert.deepEqual(await sync([rent("2026-11")]), { created: 0, closed: 0, reopened: 0, skipped: 0 });
    assert.equal((await sync([])).closed, 1);
    let row = await byKey("perfin:housing:2026-11");
    assert.equal(row.completed, true);
    assert.ok(row.completed_at);
    assert.equal(row.auto_closed, true);
    assert.equal(row.source_detached, false);
    assert.equal((await sync([rent("2026-11")])).reopened, 1);
    row = await byKey("perfin:housing:2026-11");
    assert.equal(row.completed, false);
    assert.equal(row.completed_at, null);
    assert.equal(row.source_detached, false);
  });

  it("completing by hand (PATCH or bulk complete) detaches the task — the sync never reopens or re-closes it", async () => {
    await sync([rent("2026-11"), rent("2026-12")]);
    const a = await byKey("perfin:housing:2026-11");
    await supertest(app).patch(`/api/todos/${a.id}`).send({ completed: true }).expect(200);
    const b = await byKey("perfin:housing:2026-12");
    await supertest(app).post("/api/bulk/todos").send({ ids: [b.id], action: "complete" }).expect(200);
    assert.equal((await byKey("perfin:housing:2026-11")).source_detached, true);
    assert.equal((await byKey("perfin:housing:2026-12")).source_detached, true);
    // an auto-closed task reopened by hand stays open
    await sync([rent("2027-01")]);
    await sync([], ["housing"]);
    const c = await byKey("perfin:housing:2027-01");
    assert.equal(c.auto_closed, true);
    await supertest(app).patch(`/api/todos/${c.id}`).send({ completed: false }).expect(200);
    const r = await sync([rent("2026-11"), rent("2026-12")]);
    assert.equal(r.reopened, 0);
    assert.equal(r.closed, 0, "the hand-reopened 2027-01 stays open");
    assert.equal((await byKey("perfin:housing:2026-11")).completed, true);
    assert.equal((await byKey("perfin:housing:2027-01")).completed, false);
  });

  it("an auto-closed task you reopen and then complete by hand stays completed when its key comes back", async () => {
    await sync([rent("2027-04")]);
    await sync([], ["housing"]);
    const t = await byKey("perfin:housing:2027-04");
    await supertest(app).patch(`/api/todos/${t.id}`).send({ completed: false }).expect(200);
    await supertest(app).patch(`/api/todos/${t.id}`).send({ completed: true }).expect(200);
    const mid = await byKey("perfin:housing:2027-04");
    assert.equal(mid.auto_closed, true, "auto_closed is left as the sync set it");
    assert.equal(mid.source_detached, true);
    assert.equal((await sync([rent("2027-04")])).reopened, 0);
    assert.equal((await byKey("perfin:housing:2027-04")).completed, true);
  });

  it("a trashed task is not recreated while its row exists", async () => {
    await sync([rent("2027-02")]);
    const t = await byKey("perfin:housing:2027-02");
    await supertest(app).delete(`/api/todos/${t.id}`).expect(200);
    const r = await sync([rent("2027-02")]);
    assert.equal(r.created, 0);
    assert.equal((await q("SELECT count(*)::int AS n FROM todos WHERE source_key = 'perfin:housing:2027-02'")).rows[0].n, 1);
  });

  it("an auto-closed task trashed afterwards is neither reopened nor recreated", async () => {
    await sync([rent("2027-03")]);
    await sync([], ["housing"]);
    const t = await byKey("perfin:housing:2027-03");
    assert.equal(t.auto_closed, true);
    await supertest(app).delete(`/api/todos/${t.id}`).expect(200);
    const r = await sync([rent("2027-03")]);
    assert.equal(r.reopened, 0);
    assert.equal(r.created, 0);
    assert.equal((await byKey("perfin:housing:2027-03")).completed, true);
  });

  it("only the listed kinds close — a bill task stays open when only housing is listed", async () => {
    await sync([{ key: "perfin:bill:5:2026-11-03", title: "Pay bill 5" }], ["bill"]);
    await sync([], ["housing"]);
    assert.equal((await byKey("perfin:bill:5:2026-11-03")).completed, false);
    await sync([], ["bill"]);
    assert.equal((await byKey("perfin:bill:5:2026-11-03")).completed, true);
  });

  it("ensureLinkedTask creates once and a sync without its kind leaves it open", async () => {
    const task = { key: "perfin:still-charging:7:txn_abc", title: "Netflix charged you after you cancelled", url: "/perfin/subscriptions", priority: "high" };
    const a = await linked.ensureLinkedTask(pool, { app: "perfin", task });
    assert.equal(a.created, true);
    const b = await linked.ensureLinkedTask(pool, { app: "perfin", task });
    assert.deepEqual(b, { created: false, id: a.id });
    await sync([]);
    assert.equal((await byKey(task.key)).completed, false);
  });

  it("an ordinary task is untouched by the trigger and the sync", async () => {
    const t = (await supertest(app).post("/api/todos").send({ title: "Plain" }).expect(200)).body;
    await supertest(app).patch(`/api/todos/${t.id}`).send({ completed: true }).expect(200);
    const row = (await q("SELECT * FROM todos WHERE id = $1", [t.id])).rows[0];
    assert.equal(row.source_detached, false);
    assert.equal(row.source_key, null);
  });
});
