// Real-Postgres contract test for roadmap T2.1 W5: signed Teller events through
// the PRODUCTION router (server.js order) with the real handler and Teller sync
// engine — only Teller's HTTP client (tellerRequest) is stubbed:
//  - transactions.processed naming only account ids syncs the owning
//    enrollment: the row inserted, its watermark and last_synced_at set, the
//    other enrollment untouched, 'done', last_txn_sync_at / last_sync_result
//    untouched, the anomaly watermark moved
//  - enrollment.disconnected marks it DISCONNECTED with ONE notification across
//    two deliveries; webhook.test is 'done'; an unknown enrollment 'ignored'
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const express = require("express");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

const SECRET = "w5-teller-secret";
let seq = 0;

describe("Webhooks W5 on real Postgres", { skip: SKIP }, () => {
  let pool, app, enrA, enrB, today;
  const q = (s, p) => pool.query(s, p);
  const PASS = () => process.env.TOKEN_ENCRYPTION_PASSPHRASE;
  const savedSecret = process.env.TELLER_WEBHOOK_SECRET;
  const fetched = [];

  async function deliver(type, payload) {
    const raw = JSON.stringify({ id: "wh_w5_" + ++seq, type, timestamp: new Date().toISOString(), payload });
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac("sha256", SECRET).update(`${t}.${raw}`).digest("hex");
    await supertest(app).post("/api/webhooks/teller").set("Content-Type", "application/json").set("Teller-Signature", `t=${t},v1=${sig}`).send(raw).expect(200);
    const id = (await q("SELECT max(id) AS id FROM webhook_events")).rows[0].id;
    for (let i = 0; i < 200; i++) {
      const r = (await q("SELECT status FROM webhook_events WHERE id = $1", [id])).rows[0];
      if (r && !["received", "processing"].includes(r.status)) return r.status;
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error("the event never finished");
  }

  before(async () => {
    pool = await perfinDb("webhooks_w5");
    process.env.TELLER_WEBHOOK_SECRET = SECRET;
    today = require("../../teller/services/financial-queries").todayStr();
    const tellerApi = require("../../teller/services/teller-api");
    tellerApi.tellerRequest = async (endpoint, token) => {
      fetched.push(token);
      if (endpoint.includes("/transactions")) {
        return endpoint.includes("from_id") ? [] : [{ id: "w5t1", amount: "-22.50", date: today, description: "BOOK NOOK", status: "posted", details: { counterparty: { name: "Book Nook" }, category: "shopping" } }];
      }
      throw new Error("unexpected Teller endpoint " + endpoint);
    };
    // Modules destructure tellerRequest at require time — require after the stub.
    for (const m of ["enrollments", "webhooks"]) delete require.cache[require.resolve("../../teller/routes/" + m)];
    app = express();
    app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
    app.use(perfinApp());

    await q("INSERT INTO teller_enrollments (enrollment_id, institution_name, access_token_enc) VALUES ('enr_w5a','Hook Bank', pgp_sym_encrypt('tok_a', $1)), ('enr_w5b','Other Bank', pgp_sym_encrypt('tok_b', $1))", [PASS()]);
    enrA = (await q("SELECT id FROM teller_enrollments WHERE enrollment_id='enr_w5a'")).rows[0].id;
    enrB = (await q("SELECT id FROM teller_enrollments WHERE enrollment_id='enr_w5b'")).rows[0].id;
    await q("INSERT INTO linked_accounts (teller_enrollment_id, account_id, name, type, subtype) VALUES ($1,'acc_w5a','Checking','depository','checking'), ($2,'acc_w5b','Card','credit','credit_card')", [enrA, enrB]);
    await q("INSERT INTO user_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING");
  });
  after(async () => {
    if (savedSecret === undefined) delete process.env.TELLER_WEBHOOK_SECRET; else process.env.TELLER_WEBHOOK_SECRET = savedSecret;
    if (pool) await pool.end();
  });

  it("transactions.processed syncs the enrollment owning its accounts — nothing global", async () => {
    const before = (await q("SELECT last_txn_sync_at, last_sync_result FROM user_settings WHERE id = 1")).rows[0];
    assert.equal(await deliver("transactions.processed", { transactions: [{ id: "w5t1", account_id: "acc_w5a", amount: "-22.50" }] }), "done");
    assert.deepEqual([...new Set(fetched)], ["tok_a"], "only that enrollment was fetched");
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM transactions WHERE transaction_id='w5t1'")).rows[0].n, 1);
    const rows = (await q("SELECT id, last_synced_at, last_synced_txn_date FROM teller_enrollments ORDER BY id")).rows;
    const a = rows.find((r) => r.id === enrA), b = rows.find((r) => r.id === enrB);
    assert.ok(a.last_synced_at, "the enrollment's own freshness moved");
    assert.ok(a.last_synced_txn_date, "its watermark advanced");
    assert.equal(b.last_synced_at, null);
    const after = (await q("SELECT last_txn_sync_at, last_sync_result, last_anomaly_check_at FROM user_settings WHERE id = 1")).rows[0];
    assert.deepEqual([after.last_txn_sync_at, after.last_sync_result], [before.last_txn_sync_at, before.last_sync_result]);
    assert.ok(after.last_anomaly_check_at, "the post-sync anomaly check ran");
  });

  it("enrollment.disconnected marks it DISCONNECTED and notifies once", async () => {
    assert.equal(await deliver("enrollment.disconnected", { enrollment_id: "enr_w5b", reason: "disconnected.account_locked" }), "done");
    assert.equal(await deliver("enrollment.disconnected", { enrollment_id: "enr_w5b", reason: "disconnected.account_locked" }), "done");
    assert.equal((await q("SELECT status FROM teller_enrollments WHERE id=$1", [enrB])).rows[0].status, "DISCONNECTED");
    const n = (await q("SELECT title, body FROM notification_log WHERE type = $1", [`teller-disconnected-${enrB}`])).rows;
    assert.equal(n.length, 1);
    assert.match(n[0].body, /Other Bank was disconnected at Teller — the bank account is locked/);
    assert.equal((await q("SELECT status FROM teller_enrollments WHERE id=$1", [enrA])).rows[0].status, "GOOD");
  });

  it("webhook.test is done; an unknown enrollment is ignored", async () => {
    assert.equal(await deliver("webhook.test", {}), "done");
    assert.equal(await deliver("enrollment.disconnected", { enrollment_id: "enr_nobody" }), "ignored");
    assert.equal(await deliver("transactions.processed", { transactions: [{ account_id: "acc_nobody" }] }), "ignored");
  });
});
