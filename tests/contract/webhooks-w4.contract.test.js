// Real-Postgres contract test for roadmap T2.1 W4: signed Plaid ITEM / HOLDINGS
// events through the PRODUCTION router (server.js order) with the real handler,
// sync code and notification log — only the Plaid client object is stubbed:
//  - ITEM ERROR (ITEM_LOGIN_REQUIRED) sets last_error_code and logs ONE
//    re-auth notification; an outage ERROR changes nothing
//  - PENDING_EXPIRATION survives a clean webhook-triggered sync; LOGIN_REPAIRED
//    clears it
//  - NEW_ACCOUNTS_AVAILABLE logs one notification however often it arrives
//  - HOLDINGS / DEFAULT_UPDATE for an investments-only Item writes its holdings
//  - POST /api/plaid/webhooks/register (PUBLIC_URL set) points every Item at
//    the URL and records it; without PUBLIC_URL it's a 400
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const express = require("express");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

const KID = "kid-w4";
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" });
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
let seq = 0;
function plaidJwt(body) {
  const h = b64u({ alg: "ES256", kid: KID, typ: "JWT" });
  const p = b64u({ iat: Math.floor(Date.now() / 1000), n: ++seq, request_body_sha256: crypto.createHash("sha256").update(body).digest("hex") });
  return `${h}.${p}.${crypto.sign("sha256", Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

describe("Webhooks W4 on real Postgres", { skip: SKIP }, () => {
  let pool, app, itemA, itemB;
  const q = (s, p) => pool.query(s, p);
  const PASS = () => process.env.TOKEN_ENCRYPTION_PASSPHRASE;
  const webhookUpdates = [];
  const savedPublicUrl = process.env.PUBLIC_URL;

  async function deliver(body) {
    const raw = JSON.stringify(body);
    await supertest(app).post("/api/webhooks/plaid").set("Content-Type", "application/json").set("Plaid-Verification", plaidJwt(raw)).send(raw).expect(200);
    const id = (await q("SELECT max(id) AS id FROM webhook_events")).rows[0].id;
    for (let i = 0; i < 200; i++) {
      const r = (await q("SELECT status FROM webhook_events WHERE id = $1", [id])).rows[0];
      if (r && !["received", "processing"].includes(r.status)) return r.status;
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error("the event never finished");
  }
  const code = async (id) => (await q("SELECT last_error_code FROM plaid_items WHERE id = $1", [id])).rows[0].last_error_code;
  const notes = async (re) => (await q("SELECT type, title FROM notification_log ORDER BY id")).rows.filter((n) => re.test(n.type));

  before(async () => {
    pool = await perfinDb("webhooks_w4");
    require("../../teller/services/plaid-client").getPlaidClient = () => ({
      webhookVerificationKeyGet: async () => ({ data: { key: { ...jwk, alg: "ES256", kid: KID, use: "sig", created_at: 1, expired_at: null } } }),
      accountsGet: async () => ({ data: { accounts: [] } }),
      transactionsSync: async ({ cursor }) => ({ data: { added: [], modified: [], removed: [], next_cursor: cursor || "", has_more: false } }),
      liabilitiesGet: async () => { throw Object.assign(new Error("n/a"), { response: { data: { error_code: "PRODUCTS_NOT_SUPPORTED" } } }); },
      investmentsHoldingsGet: async () => ({ data: {
        accounts: [{ account_id: "w4_brk", name: "Brokerage", type: "investment", subtype: "brokerage", mask: "4444", balances: { current: 1500 } }],
        holdings: [{ account_id: "w4_brk", security_id: "sec_1", quantity: 10, institution_value: 1500, cost_basis: 1000 }],
        securities: [{ security_id: "sec_1", ticker_symbol: "VTI", name: "Total Market", type: "etf" }],
      } }),
      itemWebhookUpdate: async (req) => { webhookUpdates.push(req); return { data: {} }; },
    });
    delete require.cache[require.resolve("../../teller/routes/webhooks")];
    app = express();
    app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
    app.use(perfinApp());

    await q("INSERT INTO plaid_items (item_id, institution_id, institution_name, access_token_enc, status) VALUES ('w4_a','ins_a','Login Bank', pgp_sym_encrypt('tok_a', $1), 'GOOD'), ('w4_b','ins_b','Expiring Bank', pgp_sym_encrypt('tok_b', $1), 'GOOD')", [PASS()]);
    itemA = (await q("SELECT id FROM plaid_items WHERE item_id='w4_a'")).rows[0].id;
    itemB = (await q("SELECT id FROM plaid_items WHERE item_id='w4_b'")).rows[0].id;
    await q("INSERT INTO sync_cursors (plaid_item_id, cursor) VALUES ($1, ''), ($2, '')", [itemA, itemB]);
    await q("INSERT INTO plaid_investment_items (item_id, institution_name, access_token_enc) VALUES ('w4_inv', 'Broker Co', pgp_sym_encrypt('tok_inv', $1))", [PASS()]);
    await q("INSERT INTO user_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING");
  });
  after(async () => {
    if (savedPublicUrl === undefined) delete process.env.PUBLIC_URL; else process.env.PUBLIC_URL = savedPublicUrl;
    if (pool) await pool.end();
  });

  it("ITEM ERROR with a re-auth code sets the signal and notifies once; an outage ERROR changes nothing", async () => {
    assert.equal(await deliver({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: "w4_a", error: { error_code: "INSTITUTION_DOWN", error_message: "down" } }), "ignored");
    assert.equal(await code(itemA), null);
    assert.equal(await deliver({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: "w4_a", error: { error_code: "ITEM_LOGIN_REQUIRED", error_message: "x" } }), "done");
    assert.equal(await deliver({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: "w4_a", error: { error_code: "ITEM_LOGIN_REQUIRED", error_message: "x" } }), "done");
    assert.equal(await code(itemA), "ITEM_LOGIN_REQUIRED");
    const n = await notes(new RegExp(`^plaid-reauth-${itemA}$`));
    assert.deepEqual(n.map((x) => x.title), ["Bank connection needs re-authentication"]);
  });

  it("PENDING_EXPIRATION survives a clean sync; LOGIN_REPAIRED clears it", async () => {
    assert.equal(await deliver({ webhook_type: "ITEM", webhook_code: "PENDING_EXPIRATION", item_id: "w4_b", consent_expiration_time: "2026-11-01T00:00:00Z" }), "done");
    assert.equal(await code(itemB), "PENDING_EXPIRATION");
    assert.deepEqual((await notes(new RegExp(`^plaid-reauth-${itemB}$`))).map((x) => x.title), ["Bank connection expires soon"]);
    assert.equal(await deliver({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "w4_b" }), "done");
    assert.equal(await code(itemB), "PENDING_EXPIRATION", "a clean sync keeps the advance warning");
    assert.ok((await q("SELECT last_synced_at FROM plaid_items WHERE id=$1", [itemB])).rows[0].last_synced_at);
    assert.equal(await deliver({ webhook_type: "ITEM", webhook_code: "LOGIN_REPAIRED", item_id: "w4_b" }), "done");
    assert.equal(await code(itemB), null);
  });

  it("NEW_ACCOUNTS_AVAILABLE logs one notification however often it arrives", async () => {
    assert.equal(await deliver({ webhook_type: "ITEM", webhook_code: "NEW_ACCOUNTS_AVAILABLE", item_id: "w4_a" }), "done");
    assert.equal(await deliver({ webhook_type: "ITEM", webhook_code: "NEW_ACCOUNTS_AVAILABLE", item_id: "w4_a" }), "done");
    assert.equal((await notes(/^plaid-new-accounts-/)).length, 1);
  });

  it("HOLDINGS / DEFAULT_UPDATE for an investments-only Item writes its holdings", async () => {
    assert.equal(await deliver({ webhook_type: "HOLDINGS", webhook_code: "DEFAULT_UPDATE", item_id: "w4_inv", new_holdings: 1, updated_holdings: 0 }), "done");
    const acct = (await q("SELECT balance FROM investment_accounts WHERE plaid_account_id='w4_brk'")).rows[0];
    assert.equal(Number(acct.balance), 1500);
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM investment_holdings WHERE plaid_account_id='w4_brk'")).rows[0].n, 1);
    assert.equal(await deliver({ webhook_type: "HOLDINGS", webhook_code: "DEFAULT_UPDATE", item_id: "nobody" }), "ignored");
  });

  it("register: a 400 without PUBLIC_URL; with it, every Item is pointed at the URL and records it", async () => {
    delete process.env.PUBLIC_URL;
    await supertest(app).post("/api/plaid/webhooks/register").send({}).expect(400);
    process.env.PUBLIC_URL = "https://fin.example.com";
    const res = await supertest(app).post("/api/plaid/webhooks/register").send({}).expect(200);
    assert.equal(res.body.url, "https://fin.example.com/api/webhooks/plaid");
    assert.equal(res.body.registered, 3);
    assert.deepEqual(webhookUpdates.map((u) => u.access_token).sort(), ["tok_a", "tok_b", "tok_inv"]);
    const urls = (await q("SELECT item_id, webhook_url FROM plaid_items UNION ALL SELECT item_id, webhook_url FROM plaid_investment_items ORDER BY 1")).rows;
    assert.deepEqual(urls.map((u) => [u.item_id, u.webhook_url]), [
      ["w4_a", res.body.url], ["w4_b", res.body.url], ["w4_inv", res.body.url],
    ]);
  });
});
