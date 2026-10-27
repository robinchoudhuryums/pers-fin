// Real-Postgres contract test for roadmap T2.1 W6 (webhook visibility), the
// production routers mounted in server.js order — only the Plaid client object
// is stubbed:
//  - GET /api/data-health reports per provider the last event and its status,
//    the last 24 hours' count and failures (older rows not counted), a failed
//    event as an issue, and each connection's own last_synced_at (CSV items and
//    suspended enrollments left out, a re-auth code shown)
//  - the operator checks warn while a Plaid connection isn't registered at
//    PUBLIC_URL (an Item registered at another address doesn't count), and the
//    warning goes away after POST /api/plaid/webhooks/register
//  - Teller with enrollments but no secret is an info check
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

const BASE = "https://fin.example.com";

describe("Webhooks W6 on real Postgres", { skip: SKIP }, () => {
  let pool, app, itemA;
  const q = (s, p) => pool.query(s, p);
  const PASS = () => process.env.TOKEN_ENCRYPTION_PASSPHRASE;
  const saved = { PUBLIC_URL: process.env.PUBLIC_URL, TELLER_WEBHOOK_SECRET: process.env.TELLER_WEBHOOK_SECRET };
  const health = async () => (await supertest(app).get("/api/data-health").expect(200)).body;
  const check = (h, id) => (h.operator_checks.checks || []).find((c) => c.id === id);

  before(async () => {
    pool = await perfinDb("webhooks_w6");
    process.env.PUBLIC_URL = BASE;
    delete process.env.TELLER_WEBHOOK_SECRET;
    require("../../teller/services/plaid-client").getPlaidClient = () => ({
      itemWebhookUpdate: async () => ({ data: {} }),
    });
    app = perfinApp();

    await q("INSERT INTO user_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING");
    await q(`INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status, last_synced_at, webhook_url, last_error_code) VALUES
               ('w6_a', 'Fresh Bank', pgp_sym_encrypt('tok_a', $1), 'GOOD', now() - interval '2 hours', $2, NULL),
               ('w6_b', 'Moved Bank', pgp_sym_encrypt('tok_b', $1), 'GOOD', NULL, 'https://old.example.com/api/webhooks/plaid', 'ITEM_LOGIN_REQUIRED'),
               ('w6_csv', 'CSV Bank', pgp_sym_encrypt('csv', $1), 'CSV', NULL, NULL, NULL)`,
      [PASS(), BASE + "/perfin/api/webhooks/plaid"]);
    itemA = (await q("SELECT id FROM plaid_items WHERE item_id='w6_a'")).rows[0].id;
    await q(`INSERT INTO teller_enrollments (enrollment_id, institution_name, access_token_enc, status, last_synced_at) VALUES
               ('enr_w6', 'Chase', pgp_sym_encrypt('t1', $1), 'GOOD', now() - interval '30 hours'),
               ('enr_w6s', 'Paused Bank', pgp_sym_encrypt('t2', $1), 'SUSPENDED', NULL)`, [PASS()]);
    await q(`INSERT INTO webhook_events (provider, event_type, event_code, subject, dedupe_key, status, error, received_at) VALUES
               ('plaid', 'TRANSACTIONS', 'SYNC_UPDATES_AVAILABLE', 'w6_a', 'k1', 'done', NULL, now() - interval '3 hours'),
               ('plaid', 'TRANSACTIONS', 'SYNC_UPDATES_AVAILABLE', 'w6_a', 'k2', 'failed', 'The event''s sync failed — see the server log.', now() - interval '1 hour'),
               ('plaid', 'ITEM', 'ERROR', 'w6_b', 'k3', 'failed', 'x', now() - interval '3 days')`);
  });
  after(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (pool) await pool.end();
  });

  it("data-health: per-provider webhook status, a failed event as an issue, per-connection freshness", async () => {
    const h = await health();
    const p = h.webhooks.plaid;
    assert.deepEqual([p.configured, p.opted_in, p.base_url, p.items_total, p.items_registered, p.last_status, p.events_24h, p.failed_24h],
      [true, true, BASE, 2, 1, "failed", 2, 1]);
    assert.equal(h.webhooks.teller.configured, false);
    assert.equal(h.webhooks.teller.enrollments_total, 1, "a suspended enrollment isn't counted");
    assert.ok(h.issues.some((i) => /1 Plaid webhook event\(s\) failed in the last 24 hours/.test(i.message)));
    const byName = Object.fromEntries(h.connections.map((c) => [c.institution, c]));
    assert.deepEqual(Object.keys(byName).sort(), ["Chase", "Fresh Bank", "Moved Bank"], "no CSV item, no suspended enrollment");
    assert.equal(byName["Fresh Bank"].last_synced.level, "fresh");
    assert.equal(byName["Fresh Bank"].id, itemA);
    assert.equal(byName["Chase"].last_synced.level, "stale");
    assert.equal(byName["Moved Bank"].last_synced.timestamp, null);
    assert.equal(byName["Moved Bank"].status, "NEEDS_REAUTH");
  });

  it("operator checks: an Item registered elsewhere is a warning (and an issue); Teller without a secret is info", async () => {
    const h = await health();
    const c = check(h, "webhooks:plaid");
    assert.equal(c.status, "warn");
    assert.match(c.detail, /1 of 2 Plaid connection\(s\) aren't registered at https:\/\/fin\.example\.com/);
    assert.ok(h.issues.some((i) => i.source === "operator" && i.check === "webhooks:plaid"));
    assert.equal(check(h, "webhooks:teller").status, "info");
  });

  it("after Register, every Item is registered and the warning is gone", async () => {
    const r = (await supertest(app).post("/api/plaid/webhooks/register").send({}).expect(200)).body;
    assert.equal(r.registered, 2);
    const h = await health();
    assert.equal(h.webhooks.plaid.items_registered, 2);
    assert.notEqual(check(h, "webhooks:plaid").status, "warn");
    assert.ok(!h.issues.some((i) => i.check === "webhooks:plaid"));
  });
});
