// Real-Postgres contract test for cycle-7 Batch 18 (ST1 — asynchronous sync):
// a background POST /api/sync and /api/sync-balances (no Teller enrollments,
// Plaid not configured) answer 202, finish, and write last_txn_sync_at /
// last_balance_sync_at + last_sync_result exactly as the synchronous path does;
// GET /api/sync/status reports the outcome through the real server.js mount
// order (the /api/sync prefix limiter skips GETs).
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("Background sync on real Postgres", { skip: SKIP }, () => {
  let pool, app;
  before(async () => {
    delete process.env.PLAID_CLIENT_ID;
    pool = await perfinDb("asyncsync");
    app = perfinApp();
  });
  after(async () => { if (pool) await pool.end(); });

  async function finish(kind, id) {
    for (let i = 0; i < 200; i++) {
      const st = (await supertest(app).get("/api/sync/status").query({ kind }).expect(200)).body;
      if (st.id === id && !st.running) return st;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(kind + " did not finish");
  }

  it("a background transaction sync records its outcome", async () => {
    const start = await supertest(app).post("/api/sync").send({ background: true }).expect(202);
    const st = await finish("sync", start.body.id);
    assert.equal(st.error, null);
    assert.equal(st.result.transactions_added, 0);
    const s = (await pool.query("SELECT last_txn_sync_at, last_sync_result FROM user_settings WHERE id = 1")).rows[0];
    assert.ok(s.last_txn_sync_at, "freshness stamped");
    assert.ok(s.last_sync_result.providers.teller_txn, "teller_txn recorded");
  });

  it("a background balance sync records its outcome", async () => {
    const start = await supertest(app).post("/api/sync-balances").send({ background: true }).expect(202);
    const st = await finish("sync-balances", start.body.id);
    assert.equal(st.error, null);
    const s = (await pool.query("SELECT last_balance_sync_at, last_sync_result FROM user_settings WHERE id = 1")).rows[0];
    assert.ok(s.last_balance_sync_at);
    assert.ok(s.last_sync_result.providers.teller_balance, "teller_balance recorded");
    assert.ok(s.last_sync_result.providers.teller_txn, "the earlier provider is kept (per-provider merge, INV-68)");
  });
});
