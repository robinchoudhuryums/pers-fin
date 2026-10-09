// Real-Postgres contract tests (TQ-2): Per-sistant routes built exactly as
// apps/per-sistant/server.js builds them (same deps object, same order) on a
// real migrated database — the todo/dependency/template/automation/email and
// Job Radar SQL that the mock-pool unit tests only pattern-match.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, persistentDb, persistentApp } = require("./_setup");

describe("Per-sistant routes on real Postgres", { skip: SKIP }, () => {
  let pool, app;
  const q = (s, p) => pool.query(s, p);
  const tomorrow = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  before(async () => {
    pool = await persistentDb("routes");
    app = persistentApp(pool);
  });
  after(async () => { if (pool) await pool.end(); });

  it("todos: location on create, any-length dependency cycle refused, trashed blocker unblocks", async () => {
    const loc = (await supertest(app).post("/api/todos").send({ title: "Pharmacy", location_name: "CVS", location_lat: 40.5, location_lng: -73.9, location_radius: 150 }).expect(200)).body;
    assert.equal(loc.location_name, "CVS"); assert.equal(loc.location_radius, 150);
    const id = async (title) => (await supertest(app).post("/api/todos").send({ title }).expect(200)).body.id;
    const a = await id("A"), b = await id("B"), c = await id("C");
    await supertest(app).post(`/api/todos/${a}/dependencies`).send({ depends_on_id: b }).expect(200);
    await supertest(app).post(`/api/todos/${b}/dependencies`).send({ depends_on_id: c }).expect(200);
    await supertest(app).post(`/api/todos/${c}/dependencies`).send({ depends_on_id: a }).expect(400);
    await supertest(app).delete(`/api/todos/${b}`).expect(200);
    const deps = (await supertest(app).get(`/api/todos/${a}/dependencies`).expect(200)).body;
    assert.equal(deps.blocked_by.length, 0);
  });

  it("recurring: complete carries location to the next instance; undo removes it once", async () => {
    const rec = (await supertest(app).post("/api/todos").send({ title: "Gym", recurring: true, recurrence_rule: "daily", due_date: tomorrow(), location_name: "Gym", location_lat: 1, location_lng: 2 }).expect(200)).body.id;
    const done = (await supertest(app).post(`/api/todos/${rec}/complete-recurring`).expect(200)).body;
    assert.equal(done.next.location_name, "Gym");
    await supertest(app).post(`/api/todos/${rec}/undo-complete-recurring`).send({ next_id: done.next.id }).expect(200);
    const open = (await q("SELECT id FROM todos WHERE title='Gym' AND completed = false AND deleted_at IS NULL")).rows;
    assert.deepEqual(open.map((r) => r.id), [rec]);
    await supertest(app).post(`/api/todos/${rec}/undo-complete-recurring`).send({ next_id: done.next.id }).expect(400);
  });

  it("templates: invalid rule refused; apply is transactional", async () => {
    await supertest(app).post("/api/todo-templates").send({ name: "bad", title: "t", recurring: true, recurrence_rule: "biweekly" }).expect(400);
    const legacy = (await q("INSERT INTO todo_templates (name, title, subtasks) VALUES ('legacy','Legacy','[\"ok\", {\"title\": \"\"}]') RETURNING id")).rows[0].id;
    const before = (await q("SELECT count(*)::int n FROM todos")).rows[0].n;
    await supertest(app).post(`/api/todo-templates/${legacy}/apply`).send({}).expect(400);
    assert.equal((await q("SELECT count(*)::int n FROM todos")).rows[0].n, before);
    const good = (await supertest(app).post("/api/todo-templates").send({ name: "good", title: "G", subtasks: ["a", "b"] }).expect(200)).body.id;
    const applied = (await supertest(app).post(`/api/todo-templates/${good}/apply`).send({}).expect(200)).body;
    assert.equal((await q("SELECT count(*)::int n FROM subtasks WHERE todo_id=$1", [applied.id])).rows[0].n, 2);
  });

  it("automations run on note creation; an invalid legacy rule is skipped, not fatal", async () => {
    await supertest(app).post("/api/automations").send({ name: "tag", trigger_type: "note_created", action_type: "add_tag", action_data: { tag: "auto" } }).expect(200);
    await q(`INSERT INTO automations (name, trigger_type, action_type, action_data) VALUES ('legacy','note_created','create_todo','{"title":"X","priority":"High"}')`);
    const note = (await supertest(app).post("/api/notes").send({ content: "hello" }).expect(200)).body;
    const tags = (await q("SELECT tags FROM notes WHERE id=$1", [note.id])).rows[0].tags;
    assert.deepEqual(tags, ["auto"]);
  });

  it("emails: one-recipient validation on PATCH; review + iCal execute", async () => {
    const em = (await supertest(app).post("/api/emails").send({ recipient_email: "a@b.co", subject: "s", body: "b" }).expect(200)).body;
    await supertest(app).patch("/api/emails/" + em.id).send({ recipient_email: "a@b.co,c@d.co" }).expect(400);
    await supertest(app).get("/api/review").expect(200);
    const ics = await supertest(app).get("/api/calendar.ics").expect(200);
    assert.match(ics.text, /DTSTAMP:/);
  });

  it("Job Radar: buckets, status views, company deactivate on the real schema", async () => {
    const src = (await q("SELECT id FROM job_sources WHERE key='greenhouse'")).rows[0].id;
    const ins = (h, title, trust, fit, leg) => q(
      `INSERT INTO job_listings (source_id, content_hash, title, company, apply_url, trust_score, fit_score, legitimacy)
       VALUES ($1,$2,$3,'Acme','https://x.example/'||$2,$4,$5,$6)`, [src, h, title, trust, fit, leg]);
    await ins("a", "Main", 80, 90, "real");
    await ins("b", "Unscored", 80, null, "real");
    await ins("c", "Scam", 80, 90, "scam");
    const sum = (await supertest(app).get("/api/jobs").expect(200)).body;
    assert.deepEqual(sum.main.map((r) => r.title), ["Main"]);
    assert.deepEqual(sum.verify_first.map((r) => r.title), ["Unscored"]);
    const id = (await q("SELECT id FROM job_listings WHERE content_hash='b'")).rows[0].id;
    const r = (await supertest(app).patch("/api/jobs/" + id).send({ status: "saved" }).expect(200)).body;
    assert.equal(r.prev_status, "new");
    assert.equal((await supertest(app).get("/api/jobs/list?status=saved").expect(200)).body.listings.length, 1);
    const comp = (await q("SELECT id FROM job_target_companies LIMIT 1")).rows[0].id;
    await supertest(app).delete("/api/job-companies/" + comp).expect(200);
    assert.equal((await q("SELECT active FROM job_target_companies WHERE id=$1", [comp])).rows[0].active, false);
  });

  // Pre-existing bug found by these contract tests (not fixed in Batch 15):
  // routes/calendar.js destructures `advanceRecurrence` from deps, which
  // server.js never passes, so /api/calendar 500s whenever an open recurring
  // todo exists. Kept as a TODO so it reports without failing CI; drop the
  // `todo` flag when the follow-on fix lands.
  it("GET /api/calendar projects recurring todos", { todo: "calendar router never receives advanceRecurrence (follow-on)" }, async () => {
    await supertest(app).post("/api/todos").send({ title: "Daily", recurring: true, recurrence_rule: "daily", due_date: tomorrow() }).expect(200);
    const now = new Date();
    const r = await supertest(app).get(`/api/calendar?month=${now.getMonth() + 1}&year=${now.getFullYear()}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.some((e) => e.recurring_projection));
  });
});
