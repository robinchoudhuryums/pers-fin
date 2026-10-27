// Real-Postgres contract test for cycle-7 Batch 19 (G3 — Plaid Link update
// mode): a Plaid item flagged for re-authentication, with transactions the
// user edited, goes through POST /api/plaid/update-complete — the flag clears,
// a new account at the same login is registered, the existing rows keep their
// edits and aren't duplicated — through the hosted flow's Link-session check
// (roadmap T2.5 H1; an exited session first, which changes nothing). Also: GET /api/items carries last_error_code,
// the investments-only exchange refuses a duplicate of an earlier
// investments-only Item (mask column), and the holdings sync runs for one Item.
// Only the Plaid client object is stubbed.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("Plaid Link update mode on real Postgres", { skip: SKIP }, () => {
  let pool, app, itemId;
  const q = (s, p) => pool.query(s, p);
  const PASS = () => process.env.TOKEN_ENCRYPTION_PASSPHRASE;
  let plaid;
  const calls = [];

  before(async () => {
    pool = await perfinDb("plaidupd");
    const plaidClientModule = require("../../teller/services/plaid-client");
    plaidClientModule.getPlaidClient = () => plaid;
    app = perfinApp();

    await q("INSERT INTO plaid_items (item_id, institution_id, institution_name, access_token_enc, status, last_error_code) VALUES ('p_up','ins_5','Upd Bank', pgp_sym_encrypt('tok_up', $1), 'GOOD', 'ITEM_LOGIN_REQUIRED')", [PASS()]);
    itemId = (await q("SELECT id FROM plaid_items WHERE item_id='p_up'")).rows[0].id;
    await q("INSERT INTO sync_cursors (plaid_item_id, cursor) VALUES ($1, 'cur_old')", [itemId]);
    await q("INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype, mask) VALUES ($1,'up_chk','Checking','depository','checking','1111')", [itemId]);
    await q(`INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, category, pending,
                                       user_merchant_name, user_category, user_notes)
             VALUES ('up_chk','ut1',12.00,'2026-10-01','SQ *CAFE','SQ *CAFE',ARRAY['Food'],false,'Corner Cafe','Dining','with Sam'),
                    ('up_chk','ut2',40.00,'2026-10-02','GROCER','GROCER',ARRAY['Shops'],false,NULL,NULL,NULL)`);
  });
  after(async () => { if (pool) await pool.end(); });

  it("GET /api/items lists the flag", async () => {
    const items = (await supertest(app).get("/api/items").expect(200)).body;
    const row = items.find((i) => i.item_id === "p_up");
    assert.equal(row.last_error_code, "ITEM_LOGIN_REQUIRED");
  });

  it("the update token request carries the item's own token, no products", async () => {
    plaid = { linkTokenCreate: async (req) => { calls.push(req); return { data: { link_token: "link-u" } }; } };
    await supertest(app).post("/api/plaid/link-token-update").send({ item_id: itemId, kind: "transactions" }).expect(200);
    assert.equal(calls[0].access_token, "tok_up");
    assert.equal(calls[0].products, undefined);
  });

  it("the hosted update token (roadmap T2.5 H1) carries the hosted_link object", async () => {
    plaid = { linkTokenCreate: async (req) => { calls.push(req); return { data: { link_token: "link-h", hosted_link_url: "https://hosted.plaid.com/h" } }; } };
    const res = await supertest(app).post("/api/plaid/link-token-update")
      .send({ item_id: itemId, kind: "transactions", hosted: true, redirect_uri: "https://app.example/perfin/accounts" }).expect(200);
    assert.equal(res.body.hosted_link_url, "https://hosted.plaid.com/h");
    const req = calls[calls.length - 1];
    assert.equal(req.access_token, "tok_up");
    assert.deepEqual(req.hosted_link, { url_lifetime_seconds: 3600, completion_redirect_uri: "https://app.example/perfin/accounts" });
  });

  it("a hosted update whose Link session exited changes nothing (T2.5 H1)", async () => {
    let asked = false;
    plaid = {
      linkTokenGet: async () => ({ data: { link_sessions: [{ link_session_id: "s0", finished_at: "2026-10-26T10:00:00Z", exit: { error: null } }] } }),
      accountsGet: async () => { asked = true; return { data: { accounts: [] } }; },
    };
    const res = await supertest(app).post("/api/plaid/update-complete").send({ item_id: itemId, kind: "transactions", link_token: "link-h" }).expect(400);
    assert.equal(res.body.reason, "exited");
    assert.equal(asked, false);
    const item = (await q("SELECT last_error_code FROM plaid_items WHERE id=$1", [itemId])).rows[0];
    assert.equal(item.last_error_code, "ITEM_LOGIN_REQUIRED", "the flag stays");
    assert.equal((await q("SELECT cursor FROM sync_cursors WHERE plaid_item_id=$1", [itemId])).rows[0].cursor, "cur_old");
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM linked_accounts WHERE account_id='up_card'")).rows[0].n, 0);
  });

  it("update-complete (a hosted session that finished — T2.5 H1) clears the flag, registers the new account and keeps every edit", async () => {
    plaid = {
      linkTokenGet: async ({ link_token }) => {
        assert.equal(link_token, "link-h");
        return { data: { link_sessions: [{ link_session_id: "s1", finished_at: "2026-10-26T10:05:00Z", exit: null }] } };
      },
      accountsGet: async () => ({ data: { accounts: [
        { account_id: "up_chk", name: "Checking", type: "depository", subtype: "checking", mask: "1111", balances: { current: 500 } },
        { account_id: "up_card", name: "New Card", type: "credit", subtype: "credit card", mask: "2222", balances: { current: 30 } },
      ] } }),
      transactionsSync: async ({ cursor }) => {
        assert.equal(cursor, "cur_old", "the same Item continues from its own cursor");
        return { data: {
          // Plaid re-delivers an existing row as modified and adds the new card's charge.
          added: [{ transaction_id: "ut3", account_id: "up_card", amount: 30, date: "2026-10-05", name: "BOOKS", merchant_name: "Books", pending: false, category: ["Shops"] }],
          modified: [{ transaction_id: "ut1", account_id: "up_chk", amount: 12, date: "2026-10-01", name: "SQ *CAFE", merchant_name: "SQ *CAFE", pending: false, category: ["Food"] }],
          removed: [], next_cursor: "cur_new", has_more: false,
        } };
      },
    };
    const before = (await q("SELECT COUNT(*)::int AS n FROM transactions WHERE account_id='up_chk'")).rows[0].n;
    const res = await supertest(app).post("/api/plaid/update-complete").send({ item_id: itemId, kind: "transactions", link_token: "link-h" }).expect(200);
    assert.equal(res.body.accounts_added, 1);
    assert.equal(res.body.transactions_added, 1);

    const item = (await q("SELECT last_error_code, (SELECT COUNT(*)::int FROM plaid_items) AS items FROM plaid_items WHERE id=$1", [itemId])).rows[0];
    assert.equal(item.last_error_code, null, "re-auth flag cleared");
    assert.equal(item.items, 1, "no second Item");
    const card = (await q("SELECT plaid_item_id FROM linked_accounts WHERE account_id='up_card'")).rows[0];
    assert.equal(card.plaid_item_id, itemId, "new account registered under the same Item");
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM transactions WHERE account_id='up_chk'")).rows[0].n, before, "existing rows not duplicated");
    const ut1 = (await q("SELECT user_merchant_name, user_category, user_notes FROM transactions WHERE transaction_id='ut1'")).rows[0];
    assert.deepEqual(ut1, { user_merchant_name: "Corner Cafe", user_category: "Dining", user_notes: "with Sam" }, "edits intact");
    assert.equal((await q("SELECT cursor FROM sync_cursors WHERE plaid_item_id=$1", [itemId])).rows[0].cursor, "cur_new");
  });

  it("the investments-only exchange refuses a duplicate of an earlier investments-only Item", async () => {
    await q("INSERT INTO plaid_investment_items (item_id, institution_name, access_token_enc) VALUES ('pi_a','Mega Broker', pgp_sym_encrypt('tok_a', $1))", [PASS()]);
    await q("INSERT INTO investment_accounts (name, institution, account_type, balance, plaid_account_id, mask) VALUES ('Individual','Mega Broker','brokerage',100,'ia_a','5555')");
    const removed = [];
    plaid = {
      itemPublicTokenExchange: async () => ({ data: { access_token: "tok_b", item_id: "pi_b" } }),
      accountsGet: async () => ({ data: { accounts: [{ account_id: "ia_b", name: "Individual", type: "investment", subtype: "brokerage", mask: "5555" }] } }),
      itemRemove: async ({ access_token }) => { removed.push(access_token); return { data: {} }; },
    };
    const res = await supertest(app).post("/api/plaid/exchange").send({ public_token: "pub", institution: { name: "mega broker" } }).expect(409);
    assert.match(res.body.error, /Re-authenticate \/ Add accounts/);
    assert.equal(res.body.duplicate_of.institution, "Mega Broker");
    assert.deepEqual(removed, ["tok_b"]);
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM plaid_investment_items WHERE item_id='pi_b'")).rows[0].n, 0);
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM investment_accounts WHERE plaid_account_id='ia_b'")).rows[0].n, 0);
  });

  it("investments update-complete syncs that Item's holdings (new account created, mask stored)", async () => {
    const piA = (await q("SELECT id FROM plaid_investment_items WHERE item_id='pi_a'")).rows[0].id;
    const tokens = [];
    plaid = {
      accountsGet: async () => ({ data: { accounts: [
        { account_id: "ia_a", type: "investment", subtype: "brokerage", mask: "5555" },
        { account_id: "ia_a2", type: "investment", subtype: "roth", mask: "6666" },
      ] } }),
      investmentsHoldingsGet: async ({ access_token }) => {
        tokens.push(access_token);
        return { data: {
          accounts: [
            { account_id: "ia_a", name: "Individual", type: "investment", subtype: "brokerage", mask: "5555", balances: { current: 120 } },
            { account_id: "ia_a2", name: "Roth", type: "investment", subtype: "roth", mask: "6666", balances: { current: 80 } },
          ],
          holdings: [], securities: [],
        } };
      },
    };
    const res = await supertest(app).post("/api/plaid/update-complete").send({ item_id: piA, kind: "investments" }).expect(200);
    assert.equal(res.body.accounts_added, 1);
    assert.deepEqual(tokens, ["tok_a"], "only this Item's holdings were fetched");
    const roth = (await q("SELECT balance, mask, is_active FROM investment_accounts WHERE plaid_account_id='ia_a2'")).rows[0];
    assert.deepEqual({ ...roth, balance: Number(roth.balance) }, { balance: 80, mask: "6666", is_active: true });
  });

  it("a stale token is a 409 decryption_failed", async () => {
    await q("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status) VALUES ('p_stale2','Old Bank', pgp_sym_encrypt('x', 'old-passphrase'), 'GOOD')");
    const id = (await q("SELECT id FROM plaid_items WHERE item_id='p_stale2'")).rows[0].id;
    const res = await supertest(app).post("/api/plaid/link-token-update").send({ item_id: id, kind: "transactions" }).expect(409);
    assert.equal(res.body.reason, "decryption_failed");
  });
});
