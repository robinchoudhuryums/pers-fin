// Real-Postgres contract tests for Seams & Invariants audit #3:
//  C1 — GET /api/items lists linked items only; a manual account isn't
//    grouped into a null "plaid" item.
//  X1 — repairCredentialIds rewrites a double-encoded WebAuthn credential id
//    to the real one, removes a stale duplicate and is idempotent.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("Seams audit #3 on real Postgres", { skip: SKIP }, () => {
  let pool, app;
  const q = (s, p) => pool.query(s, p);

  before(async () => {
    pool = await perfinDb("seams3");
    app = perfinApp();
  });
  after(async () => { if (pool) await pool.end(); });

  it("C1: a manual account isn't listed as an item; a Plaid item is", async () => {
    await q(`INSERT INTO linked_accounts (account_id, name, type, subtype, current_balance, is_manual)
             VALUES ('manual_cash', 'Cash', 'depository', 'checking', 50, true)`);
    let items = (await supertest(app).get("/api/items").expect(200)).body;
    const list = Array.isArray(items) ? items : items.items;
    assert.deepEqual(list, [], "only a manual account — no items");

    await q("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status) VALUES ('i1','Bank','x','GOOD')");
    const item = (await q("SELECT id FROM plaid_items WHERE item_id = 'i1'")).rows[0].id;
    await q(`INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype, current_balance)
             VALUES ($1,'chk','Checking','depository','checking',100)`, [item]);
    items = (await supertest(app).get("/api/items").expect(200)).body;
    const after = Array.isArray(items) ? items : items.items;
    assert.equal(after.length, 1);
    assert.equal(after[0].institution_name, "Bank");
    assert.deepEqual(after[0].accounts.map((a) => a.name), ["Checking"]);
  });

  it("X1: repairCredentialIds fixes double-encoded ids on the real table", async () => {
    const { repairCredentialIds } = require("../../teller/services/webauthn-ids");
    const real = Buffer.from("00112233445566778899aabbccddeeff", "hex").toString("base64url");
    const dupReal = Buffer.from("ffeeddccbbaa99887766554433221100", "hex").toString("base64url");
    const enc = (s) => Buffer.from(s).toString("base64url");
    await q("INSERT INTO webauthn_credentials (credential_id, public_key, device_name) VALUES ($1,'pk','phone'), ($2,'pk','old'), ($3,'pk','laptop')",
      [enc(real), enc(dupReal), dupReal]);
    const client = await pool.connect();
    try {
      assert.equal(await repairCredentialIds(client), 2);
      assert.equal(await repairCredentialIds(client), 0);
    } finally { client.release(); }
    const rows = (await q("SELECT credential_id, device_name FROM webauthn_credentials ORDER BY device_name")).rows;
    assert.deepEqual(rows.map((r) => [r.device_name, r.credential_id]), [["laptop", dupReal], ["phone", real]]);
  });
});
