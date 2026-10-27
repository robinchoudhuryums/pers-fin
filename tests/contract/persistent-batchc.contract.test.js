// Real-Postgres contract tests for roadmap T1.5 Batch C (Per-sistant):
//  C1 — Send Now includes the email's stored attachments; one whose file is
//    gone makes Send Now a 400 that leaves the email unsent, and makes the
//    scheduler mark the row failed with the reason.
//  C2 — the failed email's error is listed, and Retry (POST …/send) sends it
//    once the attachment is removed; a second Retry is refused.
//  C3 — an AI route answers 501 without ANTHROPIC_API_KEY.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, persistentDb, persistentApp } = require("./_setup");

describe("Per-sistant Batch C on real Postgres", { skip: SKIP }, () => {
  let pool, app, server, sent;
  const q = (s, p) => pool.query(s, p);
  const email = (subject, extra = {}) => q(
    `INSERT INTO emails (recipient_email, subject, body, status, scheduled_at)
     VALUES ('ada@example.com', $1, 'hello', $2, $3) RETURNING id`,
    [subject, extra.status || "draft", extra.scheduled_at || null]).then((r) => r.rows[0].id);
  const attach = (emailId, name, data) => q(
    `INSERT INTO attachments (filename, original_name, mime_type, size_bytes, entity_type, entity_id, data)
     VALUES ($1, $2, 'text/plain', $3, 'email', $4, $5) RETURNING id`,
    ["x-" + name, name, data ? data.length : 0, emailId, data]).then((r) => r.rows[0].id);

  before(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    pool = await persistentDb("batchc");
    app = persistentApp(pool);
    process.env.SMTP_HOST = "smtp.invalid";
    sent = [];
    const nodemailer = require("nodemailer");
    nodemailer.createTransport = () => ({ sendMail: async (m) => { sent.push(m); } });
    server = require("../../apps/per-sistant/server");
  });
  after(async () => { if (pool) await pool.end(); });

  it("C1: Send Now includes the stored attachments", async () => {
    const id = await email("With files");
    await attach(id, "notes.txt", Buffer.from("first file"));
    await attach(id, "more.txt", Buffer.from("second"));
    await supertest(app).post(`/api/emails/${id}/send`).expect(200);
    const m = sent.at(-1);
    assert.equal(m.subject, "With files");
    assert.deepEqual(m.attachments.map((a) => [a.filename, a.content.toString(), a.contentType]),
      [["notes.txt", "first file", "text/plain"], ["more.txt", "second", "text/plain"]]);
  });

  it("C1: a missing attachment makes Send Now a 400 and leaves the email unsent", async () => {
    const id = await email("Missing file");
    await attach(id, "gone.pdf", null);
    const before = sent.length;
    const r = await supertest(app).post(`/api/emails/${id}/send`).expect(400);
    assert.match(r.body.error, /"gone\.pdf" is no longer available/);
    assert.equal(sent.length, before);
    assert.equal((await q("SELECT status FROM emails WHERE id = $1", [id])).rows[0].status, "draft");
  });

  let failedId, goneAtt;
  it("C1/C2: the scheduler marks such an email failed with the reason, and the list shows it", async () => {
    failedId = await email("Scheduled with a gone file", { status: "scheduled", scheduled_at: new Date(Date.now() - 60000) });
    goneAtt = await attach(failedId, "old.doc", null);
    const before = sent.length;
    await server.processScheduledEmails();
    assert.equal(sent.length, before, "not sent without its attachment");
    const row = (await q("SELECT status, error_message, sent_at FROM emails WHERE id = $1", [failedId])).rows[0];
    assert.equal(row.status, "failed");
    assert.match(row.error_message, /"old\.doc" is no longer available/);
    assert.equal(row.sent_at, null);
    const list = (await supertest(app).get("/api/emails?status=failed").expect(200)).body;
    assert.deepEqual(list.map((e) => [e.id, /old\.doc/.test(e.error_message)]), [[failedId, true]]);
  });

  it("C2: Retry sends the failed email once its attachment is removed; a second Retry is refused", async () => {
    await supertest(app).delete(`/api/attachments/${goneAtt}`).expect(200);
    await supertest(app).post(`/api/emails/${failedId}/send`).expect(200);
    assert.equal(sent.at(-1).subject, "Scheduled with a gone file");
    assert.equal(sent.at(-1).attachments, undefined, "no attachments left");
    assert.equal((await q("SELECT status FROM emails WHERE id = $1", [failedId])).rows[0].status, "sent");
    await supertest(app).post(`/api/emails/${failedId}/send`).expect(409);
  });

  it("C3: an AI route answers 501 without a key", async () => {
    await q("UPDATE user_settings SET ai_model_review_summary = 'haiku' WHERE id = 1");
    const r = await supertest(app).post("/api/ai/review-summary").send({ stats: { tasks_completed: 2 } }).expect(501);
    assert.equal(r.body.ai_unavailable, true);
  });
});
