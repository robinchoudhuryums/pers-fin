// Real-Postgres contract tests for roadmap T2.1 W1 (bank webhook receivers):
//  - the migrations create webhook_events with its provider / status checks
//  - a verified event is recorded once; a re-delivery with the same dedupe key
//    is answered 200 and not processed again
//  - the detached handler's outcome lands on the row (done / ignored / failed)
//  - the prune removes rows older than 30 days and keeps newer ones
//  - the production router (no verifier configured) records nothing
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("Webhooks W1 on real Postgres", { skip: SKIP }, () => {
  let pool;
  const q = (s, p) => pool.query(s, p);
  const settle = () => new Promise((r) => setTimeout(r, 50));
  const verifier = (key) => ({
    configured: () => true,
    verify: async () => ({ ok: true, dedupeKey: key, event: { type: "TRANSACTIONS", code: "SYNC_UPDATES_AVAILABLE", subject: "item-1" } }),
  });
  function app(opts) {
    const { createWebhookRouter } = require("../../teller/routes/webhooks");
    const a = express();
    a.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
    a.use(createWebhookRouter({ db: pool, ...opts }));
    return a;
  }

  before(async () => { pool = await perfinDb("webhooks_w1"); });
  after(async () => { if (pool) await pool.end(); });

  it("the table enforces its provider and status values", async () => {
    await assert.rejects(q("INSERT INTO webhook_events (provider, dedupe_key) VALUES ('stripe', 'x')"));
    await assert.rejects(q("INSERT INTO webhook_events (provider, dedupe_key, status) VALUES ('plaid', 'x', 'weird')"));
  });

  it("records a verified event once and marks it done; a re-delivery is not processed again", async () => {
    let runs = 0;
    const a = app({ verifiers: { plaid: verifier("delivery-1") }, handlers: { plaid: async () => { runs++; return { status: "done" }; } } });
    await supertest(a).post("/api/webhooks/plaid").send({ any: "thing" }).expect(200);
    await settle();
    const r2 = await supertest(a).post("/api/webhooks/plaid").send({ any: "thing" }).expect(200);
    assert.equal(r2.body.duplicate, true);
    await settle();
    assert.equal(runs, 1);
    const rows = (await q("SELECT provider, event_type, event_code, subject, status, error, processed_at FROM webhook_events WHERE dedupe_key = 'delivery-1'")).rows;
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].provider, rows[0].event_type, rows[0].event_code, rows[0].subject, rows[0].status, rows[0].error],
      ["plaid", "TRANSACTIONS", "SYNC_UPDATES_AVAILABLE", "item-1", "done", null]);
    assert.ok(rows[0].processed_at);
  });

  it("the same dedupe key from the other provider is a separate event", async () => {
    const a = app({ verifiers: { teller: verifier("delivery-1") } });
    await supertest(a).post("/api/webhooks/teller").send({ x: 1 }).expect(200);
    await settle();
    const row = (await q("SELECT status FROM webhook_events WHERE provider = 'teller' AND dedupe_key = 'delivery-1'")).rows[0];
    assert.equal(row.status, "ignored", "no Teller handler yet");
  });

  it("a failing handler leaves the row failed with a fixed error", async () => {
    const a = app({ verifiers: { teller: verifier("delivery-2") }, handlers: { teller: async () => { throw new Error("Teller API error 500: {\"secret\":\"x\"}"); } } });
    const orig = console.error; console.error = () => {};
    try { await supertest(a).post("/api/webhooks/teller").send({ x: 1 }).expect(200); await settle(); } finally { console.error = orig; }
    const row = (await q("SELECT status, error FROM webhook_events WHERE dedupe_key = 'delivery-2'")).rows[0];
    assert.deepEqual([row.status, row.error], ["failed", "The event's sync failed — see the server log."]);
  });

  it("the prune drops rows older than 30 days only", async () => {
    await q("INSERT INTO webhook_events (provider, dedupe_key, received_at) VALUES ('plaid', 'old', now() - interval '31 days'), ('plaid', 'recent', now() - interval '29 days')");
    const a = app({ verifiers: { plaid: verifier("delivery-3") } });
    await supertest(a).post("/api/webhooks/plaid").send({ x: 1 }).expect(200);
    await settle();
    const keys = (await q("SELECT dedupe_key FROM webhook_events WHERE dedupe_key IN ('old', 'recent', 'delivery-3') ORDER BY dedupe_key")).rows.map((r) => r.dedupe_key);
    assert.deepEqual(keys, ["delivery-3", "recent"]);
  });

  it("the production router, mounted in server.js order, records nothing (503)", async () => {
    const before = (await q("SELECT count(*)::int AS n FROM webhook_events")).rows[0].n;
    const a = express();
    a.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
    a.use(perfinApp());
    await supertest(a).post("/api/webhooks/plaid").send({ webhook_type: "TRANSACTIONS" }).expect(503);
    await supertest(a).post("/api/webhooks/teller").send({ type: "webhook.test" }).expect(503);
    assert.equal((await q("SELECT count(*)::int AS n FROM webhook_events")).rows[0].n, before);
  });
});
