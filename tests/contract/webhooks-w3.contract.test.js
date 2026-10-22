// Real-Postgres contract test for roadmap T2.1 W3: a signed Plaid
// SYNC_UPDATES_AVAILABLE through the PRODUCTION router (mounted in server.js
// order) syncs that one item with the real sync engine — only the Plaid client
// object is stubbed:
//  - the row is inserted, the item's cursor advances and its last_synced_at is
//    set, the event ends 'done'; last_txn_sync_at / last_sync_result untouched;
//    the anomaly watermark moved (the post-sync steps ran)
//  - a second delivery with nothing new adds nothing and is 'done' too
//  - the other GOOD item is not synced; an event for a CSV item is 'ignored'
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const express = require("express");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

const KID = "kid-w3";
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" });
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
let seq = 0;
function plaidJwt(body) {
  const h = b64u({ alg: "ES256", kid: KID, typ: "JWT" });
  // A distinct claim per delivery → a distinct JWT → a distinct dedupe key.
  const p = b64u({ iat: Math.floor(Date.now() / 1000), n: ++seq, request_body_sha256: crypto.createHash("sha256").update(body).digest("hex") });
  return `${h}.${p}.${crypto.sign("sha256", Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

describe("Webhooks W3 on real Postgres", { skip: SKIP }, () => {
  let pool, app, itemA, itemB;
  const q = (s, p) => pool.query(s, p);
  const PASS = () => process.env.TOKEN_ENCRYPTION_PASSPHRASE;
  const synced = [];
  let pages = {};

  async function deliver(itemId) {
    const raw = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: itemId, initial_update_complete: true, historical_update_complete: true });
    await supertest(app).post("/api/webhooks/plaid").set("Content-Type", "application/json").set("Plaid-Verification", plaidJwt(raw)).send(raw).expect(200);
    const id = (await q("SELECT max(id) AS id FROM webhook_events")).rows[0].id;
    for (let i = 0; i < 200; i++) {
      const r = (await q("SELECT status FROM webhook_events WHERE id = $1", [id])).rows[0];
      if (r && !["received", "processing"].includes(r.status)) return r.status;
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error("the event never finished");
  }

  before(async () => {
    pool = await perfinDb("webhooks_w3");
    require("../../teller/services/plaid-client").getPlaidClient = () => ({
      webhookVerificationKeyGet: async () => ({ data: { key: { ...jwk, alg: "ES256", kid: KID, use: "sig", created_at: 1, expired_at: null } } }),
      accountsGet: async ({ access_token }) => ({ data: { accounts: access_token === "tok_a"
        ? [{ account_id: "w3_chk", name: "Checking", type: "depository", subtype: "checking", mask: "3333", balances: { current: 900, available: 900 } }]
        : [] } }),
      transactionsSync: async ({ access_token, cursor }) => {
        synced.push(access_token);
        const page = (pages[access_token] || {})[cursor || ""];
        return { data: { added: [], modified: [], removed: [], next_cursor: cursor || "", has_more: false, ...(page || {}) } };
      },
      liabilitiesGet: async () => { throw Object.assign(new Error("n/a"), { response: { data: { error_code: "PRODUCTS_NOT_SUPPORTED" } } }); },
    });
    delete require.cache[require.resolve("../../teller/routes/webhooks")];
    app = express();
    app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
    app.use(perfinApp());

    await q("INSERT INTO plaid_items (item_id, institution_id, institution_name, access_token_enc, status) VALUES ('w3_a','ins_a','Hook Bank', pgp_sym_encrypt('tok_a', $1), 'GOOD'), ('w3_b','ins_b','Other Bank', pgp_sym_encrypt('tok_b', $1), 'GOOD'), ('w3_csv','csv','CSV Bank', pgp_sym_encrypt('csv', $1), 'CSV')", [PASS()]);
    itemA = (await q("SELECT id FROM plaid_items WHERE item_id='w3_a'")).rows[0].id;
    itemB = (await q("SELECT id FROM plaid_items WHERE item_id='w3_b'")).rows[0].id;
    // The link exchange creates each item's cursor row.
    await q("INSERT INTO sync_cursors (plaid_item_id, cursor) VALUES ($1, ''), ($2, '')", [itemA, itemB]);
    await q("INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype, mask) VALUES ($1,'w3_chk','Checking','depository','checking','3333')", [itemA]);
    await q("INSERT INTO user_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING");
  });
  after(async () => { if (pool) await pool.end(); });

  it("SYNC_UPDATES_AVAILABLE syncs that item: new row, cursor, last_synced_at, done — nothing global", async () => {
    pages = { tok_a: { "": { added: [{ transaction_id: "w3t1", account_id: "w3_chk", amount: 18.25, date: "2026-10-21", name: "LUNCH SPOT", merchant_name: "Lunch Spot", pending: false }], next_cursor: "cur_1" } } };
    const settingsBefore = (await q("SELECT last_txn_sync_at, last_sync_result FROM user_settings WHERE id = 1")).rows[0];
    assert.equal(await deliver("w3_a"), "done");
    assert.deepEqual(synced, ["tok_a"], "only that item was synced");
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM transactions WHERE transaction_id='w3t1'")).rows[0].n, 1);
    assert.equal((await q("SELECT cursor FROM sync_cursors WHERE plaid_item_id=$1", [itemA])).rows[0].cursor, "cur_1");
    const items = (await q("SELECT item_id, last_synced_at FROM plaid_items ORDER BY item_id")).rows;
    assert.ok(items.find((i) => i.item_id === "w3_a").last_synced_at, "the item's own freshness moved");
    assert.equal(items.find((i) => i.item_id === "w3_b").last_synced_at, null);
    const bal = (await q("SELECT current_balance FROM linked_accounts WHERE account_id='w3_chk'")).rows[0];
    assert.equal(Number(bal.current_balance), 900, "the item's balances were refreshed too");
    const after = (await q("SELECT last_txn_sync_at, last_sync_result, last_anomaly_check_at FROM user_settings WHERE id = 1")).rows[0];
    assert.deepEqual([after.last_txn_sync_at, after.last_sync_result], [settingsBefore.last_txn_sync_at, settingsBefore.last_sync_result]);
    assert.ok(after.last_anomaly_check_at, "the post-sync anomaly check ran");
  });

  it("a second delivery with nothing new adds nothing and is done", async () => {
    synced.length = 0;
    assert.equal(await deliver("w3_a"), "done");
    assert.deepEqual(synced, ["tok_a"]);
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM transactions WHERE account_id='w3_chk'")).rows[0].n, 1);
  });

  it("an event for a CSV item, or an item we don't have, is ignored and syncs nothing", async () => {
    synced.length = 0;
    assert.equal(await deliver("w3_csv"), "ignored");
    assert.equal(await deliver("w3_unknown"), "ignored");
    assert.deepEqual(synced, []);
    assert.equal((await q("SELECT last_synced_at FROM plaid_items WHERE id=$1", [itemB])).rows[0].last_synced_at, null);
  });
});
