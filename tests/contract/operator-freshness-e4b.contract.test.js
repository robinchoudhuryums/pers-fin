// Real-Postgres contract tests for cycle-8 E4b (G3 — one freshness definition):
//  - a Plaid item synced 15 minutes ago (the webhook path stamps only its own
//    plaid_items.last_synced_at) reads fresh through GET /api/data-freshness
//    while the global last_txn_sync_at is two days old;
//  - a second item 30 hours old makes the badge stale and names it; a CSV item
//    and a suspended Teller enrollment are never counted;
//  - a re-auth code makes it stale with reason reauth;
//  - GET /api/data-health lists the same connections.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("cycle-8 E4b connection freshness on real Postgres", { skip: SKIP }, () => {
  let pool, app;
  before(async () => {
    pool = await perfinDb("freshness_e4b");
    app = perfinApp();
    const PASS = process.env.TOKEN_ENCRYPTION_PASSPHRASE;
    await pool.query("INSERT INTO user_settings (id) VALUES (1) ON CONFLICT DO NOTHING");
    await pool.query("UPDATE user_settings SET last_txn_sync_at = now() - interval '48 hours', last_auto_sync_at = now() - interval '50 hours' WHERE id = 1");
    await pool.query("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status, last_synced_at) VALUES ('p_fresh','Webhook Bank', pgp_sym_encrypt('t', $1), 'GOOD', now() - interval '15 minutes')", [PASS]);
    await pool.query("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status) VALUES ('csv_x','CSV Bank', pgp_sym_encrypt('t', $1), 'CSV')", [PASS]);
    await pool.query("INSERT INTO teller_enrollments (enrollment_id, institution_name, access_token_enc, status) VALUES ('e_s','Suspended Bank', pgp_sym_encrypt('t', $1), 'SUSPENDED')", [PASS]);
  });
  after(async () => { if (pool) await pool.end(); });

  const freshness = async () => (await supertest(app).get("/api/data-freshness").expect(200)).body;

  it("a webhook-synced item is fresh while the global stamp is two days old", async () => {
    const f = await freshness();
    assert.equal(f.transactions.level, "stale");
    assert.equal(f.overall.basis, "connections");
    assert.equal(f.overall.level, "fresh");
    assert.deepEqual(f.connections.map((c) => c.institution), ["Webhook Bank"]);
  });

  it("a second item 30 hours old makes it stale and names it; data-health lists the same connections", async () => {
    const PASS = process.env.TOKEN_ENCRYPTION_PASSPHRASE;
    await pool.query("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status, last_synced_at) VALUES ('p_old','Quiet Bank', pgp_sym_encrypt('t', $1), 'GOOD', now() - interval '30 hours')", [PASS]);
    const f = await freshness();
    assert.equal(f.overall.level, "stale");
    assert.equal(f.overall.reason, null);
    assert.equal(f.overall.connection.institution, "Quiet Bank");
    const dh = (await supertest(app).get("/api/data-health").expect(200)).body;
    assert.deepEqual(dh.connections.map((c) => [c.institution, c.status, c.last_synced.level]),
      f.connections.map((c) => [c.institution, c.status, c.last_synced.level]));
  });

  it("a re-auth code makes the badge stale with reason reauth", async () => {
    await pool.query("UPDATE plaid_items SET last_error_code = 'ITEM_LOGIN_REQUIRED', last_synced_at = now() WHERE item_id = 'p_old'");
    const f = await freshness();
    assert.equal(f.overall.level, "stale");
    assert.equal(f.overall.reason, "reauth");
    assert.equal(f.overall.connection.institution, "Quiet Bank");
  });
});
