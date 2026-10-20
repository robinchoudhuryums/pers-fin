// Real-Postgres contract tests for the cycle-7 Batch 11 Per-sistant fixes:
// attachments stored in Postgres and purged with their entity (F121), the
// 30-day trash purge (F122), the reminder_due claim (F116), the email PATCH
// rules (F120), the recipient setting and failed-email notification (F112),
// Job Radar's new-only nudge and refresh skip (F114/F117), the streak restored
// on undo of a late completion, literal search and bulk-complete automations
// (F124), and the weekly review's upcoming list (F119). Routes are built with
// apps/per-sistant/server.js's own deps and order.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const supertest = require("supertest");
const { SKIP, ROOT, persistentDb, persistentApp } = require("./_setup");

describe("Per-sistant Batch 11 on real Postgres", { skip: SKIP }, () => {
  let pool, app, todayStr;
  const q = (s, p) => pool.query(s, p);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  before(async () => {
    pool = await persistentDb("batch11");
    app = persistentApp(pool);
    todayStr = require(path.join(ROOT, "apps/per-sistant/routes/health")).todayStr;
  });
  after(async () => { if (pool) await pool.end(); });

  it("F121: an attachment lives in the row, downloads without a disk file, and goes with a purged email", async () => {
    const em = (await supertest(app).post("/api/emails").send({ recipient_email: "a@b.co", subject: "s", body: "b" }).expect(200)).body;
    const up = (await supertest(app).post(`/api/attachments/email/${em.id}`).attach("file", Buffer.from("hello world"), "note.txt").expect(200)).body;
    assert.equal(up.stored, true);
    assert.equal(up.data, undefined, "the bytes are never echoed");
    const list = (await supertest(app).get(`/api/attachments/email/${em.id}`).expect(200)).body;
    assert.equal(list.length, 1);
    assert.equal(list[0].data, undefined);
    const dl = await supertest(app).get(`/api/attachments/download/${up.id}`).buffer(true).parse((res, cb) => {
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    assert.equal(dl.body.toString(), "hello world");
    const todo = (await supertest(app).post(`/api/emails/${em.id}/create-todo`).send({}).expect(200)).body;
    assert.equal((await q("SELECT count(*)::int AS n FROM entity_links WHERE source_type='email' AND source_id=$1", [em.id])).rows[0].n, 1);
    await supertest(app).delete(`/api/emails/${em.id}`).expect(200);
    await supertest(app).delete(`/api/trash/email/${em.id}`).expect(200);
    assert.equal((await q("SELECT count(*)::int AS n FROM attachments WHERE entity_id=$1 AND entity_type='email'", [em.id])).rows[0].n, 0);
    assert.equal((await q("SELECT count(*)::int AS n FROM entity_links WHERE source_type='email' AND source_id=$1", [em.id])).rows[0].n, 0);
    assert.ok(todo.id);
  });

  it("F122: the purge removes items trashed more than 30 days ago only", async () => {
    await q("INSERT INTO todos (title, deleted_at) VALUES ('old', now() - interval '40 days'), ('recent', now() - interval '5 days')");
    const trash = require(path.join(ROOT, "apps/per-sistant/routes/trash"));
    await trash.purgeTrash(pool, trash.TRASH_RETENTION_DAYS);
    const left = (await q("SELECT title FROM todos WHERE deleted_at IS NOT NULL ORDER BY title")).rows.map((r) => r.title);
    assert.ok(left.includes("recent") && !left.includes("old"), JSON.stringify(left));
  });

  it("F116: a due note reminder is claimed once; an old one isn't replayed", async () => {
    const { processDueReminders } = require(path.join(ROOT, "apps/per-sistant/helpers"));
    await q(`INSERT INTO notes (title, content, reminder_at) VALUES
             ('due', 'x', now() - interval '5 minutes'), ('old', 'x', now() - interval '3 days'), ('later', 'x', now() + interval '1 hour')`);
    assert.equal(await processDueReminders(pool), 1);
    assert.equal(await processDueReminders(pool), 0, "fires once");
    // Moving the reminder later re-arms it.
    await q("UPDATE notes SET reminder_at = now() + interval '1 second' WHERE title = 'due'");
    await wait(1500);
    assert.equal(await processDueReminders(pool), 1);
  });

  it("F120: a sent email is final; 'scheduled' needs a send time", async () => {
    const em = (await supertest(app).post("/api/emails").send({ recipient_email: "a@b.co", subject: "s", body: "b" }).expect(200)).body;
    await supertest(app).patch(`/api/emails/${em.id}`).send({ status: "scheduled" }).expect(400);
    await supertest(app).patch(`/api/emails/${em.id}`).send({ status: "scheduled", scheduled_at: "2031-01-01T09:00:00Z" }).expect(200);
    await q("UPDATE emails SET status = 'sent', sent_at = now() WHERE id = $1", [em.id]);
    await supertest(app).patch(`/api/emails/${em.id}`).send({ subject: "changed", status: "draft" }).expect(409);
    assert.equal((await q("SELECT status, subject FROM emails WHERE id = $1", [em.id])).rows[0].status, "sent");
  });

  it("F112: the recipient setting is validated; a failed email shows in the notification check", async () => {
    await supertest(app).patch("/api/settings").send({ perfin_webhook_recipient: "not-an-address" }).expect(400);
    await supertest(app).patch("/api/settings").send({ perfin_webhook_recipient: "me@example.com" }).expect(200);
    await q("INSERT INTO emails (recipient_email, subject, body, status, error_message) VALUES ('x@y.co', 'Digest', 'b', 'failed', 'connect ECONNREFUSED')");
    const body = (await supertest(app).get("/api/notifications/check").expect(200)).body;
    const n = body.notifications.find((x) => x.type === "email_failed");
    assert.ok(n, JSON.stringify(body.notifications.map((x) => x.type)));
    assert.match(n.title, /"Digest" to x@y\.co: connect ECONNREFUSED/);
  });

  it("F114 / F117: the nudge counts new listings only; a scheduled refresh right after one is skipped", async () => {
    await q("UPDATE user_settings SET job_radar_enabled = true WHERE id = 1");
    const src = (await q("SELECT id FROM job_sources WHERE key='greenhouse'")).rows[0].id;
    const ins = (h, status) => q(
      `INSERT INTO job_listings (source_id, content_hash, title, company, apply_url, trust_score, fit_score, legitimacy, status)
       VALUES ($1,$2,$3,'Acme','https://x.example/'||$2,80,90,'real',$4)`, [src, h, "Role " + h, status]);
    await ins("s1", "saved");
    await ins("n1", "new");
    const body = (await supertest(app).get("/api/notifications/check").expect(200)).body;
    const jr = body.notifications.find((x) => x.type === "job_radar");
    assert.match(jr.title, /^Job Radar: 1 new high-fit role/);
    assert.ok(jr.id, "keyed to the newest listing");
    const r = (await supertest(app).post("/api/jobs/refresh").expect(200)).body;
    assert.deepEqual(r, { ok: true, skipped: "recent" });
  });

  it("F124: undo of a late completion restores the old streak", async () => {
    const yesterday = new Date(Date.parse(todayStr() + "T00:00:00Z") - 3 * 86400000).toISOString().slice(0, 10);
    const id = (await q(`INSERT INTO todos (title, recurring, recurrence_rule, due_date, streak_count, best_streak)
                          VALUES ('Floss', true, 'daily', $1, 12, 12) RETURNING id`, [yesterday])).rows[0].id;
    const done = (await supertest(app).post(`/api/todos/${id}/complete-recurring`).expect(200)).body;
    assert.equal(done.streak, 1, "a late completion resets the streak");
    await supertest(app).post(`/api/todos/${id}/undo-complete-recurring`).send({ next_id: done.next.id }).expect(200);
    assert.equal((await q("SELECT streak_count FROM todos WHERE id = $1", [id])).rows[0].streak_count, 12);
  });

  it("F124: search is literal; bulk complete runs todo_completed automations", async () => {
    await q("INSERT INTO todos (title) VALUES ('100% done'), ('1000 things')");
    const hits = (await supertest(app).get("/api/search?q=" + encodeURIComponent("100%")).expect(200)).body.filter((x) => x.type === "todo").map((x) => x.title);
    assert.deepEqual(hits, ["100% done"]);
    await supertest(app).post("/api/automations").send({ name: "f", trigger_type: "todo_completed", action_type: "create_todo", action_data: { title: "Follow up" } }).expect(200);
    const t = (await supertest(app).post("/api/todos").send({ title: "Plain" }).expect(200)).body;
    await supertest(app).post("/api/bulk/todos").send({ ids: [t.id], action: "complete" }).expect(200);
    await wait(300);
    assert.equal((await q("SELECT count(*)::int AS n FROM todos WHERE title = 'Follow up'")).rows[0].n, 1);
  });

  it("F119: a task due later this week is in the review's upcoming list", async () => {
    await q("INSERT INTO todos (title, due_date) VALUES ('Due today', $1)", [todayStr()]);
    const r = (await supertest(app).get("/api/review").expect(200)).body;
    assert.ok(r.upcoming_tasks.some((t) => t.title === "Due today"), JSON.stringify(r.upcoming_tasks.map((t) => t.title)));
  });
});
