// ============================================================================
// Cycle-7 expansion Batch 19 (G3) — Plaid Link update mode
// ============================================================================
// Mock pool + a stubbed Plaid client:
//   - POST /api/plaid/link-token-update: the update-mode token request (the
//     item's own access_token, no products, account selection on), the
//     decryption_failed 409, validation / 404 / CSV items;
//   - POST /api/plaid/update-complete: new accounts registered BEFORE the
//     cursor walk, the re-auth flag cleared, ONLY that item synced; a re-auth
//     error keeps the flag (409); the investments kind runs the holdings sync
//     for that one Item;
//   - the investments-only POST /api/plaid/exchange refusing a duplicate (409,
//     the new Item released, nothing stored) and writing the account mask;
//   - the one re-auth notification on a NEW re-auth code (deep link /accounts);
//   - the Accounts page: Re-authenticate / Add accounts rendered by the REAL
//     loadItems in a vm, wired to update mode with no token exchange; the
//     data-health issue's /accounts link.
// The database-backed half is tests/contract/plaid-update.contract.test.js.

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const express = require("express");
const supertest = require("supertest");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const dbModule = require("../teller/services/database");
const plaidClientModule = require("../teller/services/plaid-client");
const notifications = require("../teller/routes/notifications");

const originalQuery = dbModule.pool.query;
const originalGetPlaidClient = plaidClientModule.getPlaidClient;
const originalSendToAll = notifications.sendToAll;

let S;
let inv;
let app;

before(() => {
  plaidClientModule.getPlaidClient = () => S.plaid;
  delete require.cache[require.resolve("../teller/routes/investments")];
  inv = require("../teller/routes/investments");
  app = express();
  app.use(express.json());
  app.use(inv);
});
after(() => {
  plaidClientModule.getPlaidClient = originalGetPlaidClient;
  dbModule.pool.query = originalQuery;
  notifications.sendToAll = originalSendToAll;
  delete require.cache[require.resolve("../teller/routes/investments")];
});
afterEach(() => {
  dbModule.pool.query = originalQuery;
  notifications.sendToAll = originalSendToAll;
});

// One ordered log of DB queries AND Plaid calls, so "registered before the
// sync" is checked on the real order.
function setup(db, plaid) {
  S = { log: [], plaid: {}, sent: [] };
  for (const [name, fn] of Object.entries(plaid || {})) {
    S.plaid[name] = async (req) => { S.log.push({ plaid: name, req }); return fn(req); };
  }
  dbModule.pool.query = async (sql, params) => {
    S.log.push({ sql, params: params || [] });
    return (await db(sql, params || [])) || { rows: [] };
  };
  notifications.sendToAll = async (payload) => { S.sent.push(payload); return { sent: 1 }; };
}
const ran = (re) => S.log.filter((q) => q.sql && re.test(q.sql));
const indexOf = (pred) => S.log.findIndex(pred);

const ITEM = { id: 7, item_id: "it_7", institution_name: "Capital Bank", status: "GOOD", access_token: "tok_7" };
function itemDb(item, extra) {
  return async (sql, params) => {
    if (extra) { const r = await extra(sql, params); if (r) return r; }
    if (/FROM plaid_items WHERE id = \$1/.test(sql)) return { rows: item && item.id === params[0] ? [item] : [] };
    return undefined;
  };
}

describe("G3 — POST /api/plaid/link-token-update", () => {
  it("asks Plaid for an update-mode token: the item's access_token, no products, account selection on", async () => {
    setup(itemDb(ITEM), { linkTokenCreate: async () => ({ data: { link_token: "link-upd" } }) });
    const res = await supertest(app).post("/api/plaid/link-token-update").send({ item_id: 7, kind: "transactions" }).expect(200);
    assert.equal(res.body.link_token, "link-upd");
    const call = S.log.find((c) => c.plaid === "linkTokenCreate");
    assert.equal(call.req.access_token, "tok_7");
    assert.deepEqual(call.req.update, { account_selection_enabled: true });
    assert.equal(call.req.products, undefined, "update mode sends no products");
    assert.equal(call.req.optional_products, undefined);
    // The token is decrypted fail-soft (F17), never with the raising pgp_sym_decrypt.
    assert.match(ran(/FROM plaid_items WHERE id = \$1/)[0].sql, /perfin_try_decrypt\(access_token_enc, \$2\)/);
  });

  it("the investments kind reads the investments-only registry", async () => {
    setup(async (sql, params) => /FROM plaid_investment_items WHERE id = \$1/.test(sql)
      ? { rows: [{ id: 3, item_id: "pi_3", institution_name: "Broker", status: "GOOD", access_token: "tok_3" }] } : undefined,
    { linkTokenCreate: async () => ({ data: { link_token: "link-inv" } }) });
    await supertest(app).post("/api/plaid/link-token-update").send({ item_id: 3, kind: "investments" }).expect(200);
    assert.equal(S.log.find((c) => c.plaid === "linkTokenCreate").req.access_token, "tok_3");
  });

  it("a token that won't decrypt is a 409 decryption_failed (unlink + link), with no Plaid call", async () => {
    setup(itemDb({ ...ITEM, access_token: null }), { linkTokenCreate: async () => ({ data: { link_token: "x" } }) });
    const res = await supertest(app).post("/api/plaid/link-token-update").send({ item_id: 7, kind: "transactions" }).expect(409);
    assert.equal(res.body.reason, "decryption_failed");
    assert.match(res.body.error, /Unlink it on this page, then link the bank again/);
    assert.equal(S.log.filter((c) => c.plaid).length, 0);
  });

  it("400 on a bad kind / id, 404 for an unknown item, 400 for a CSV item", async () => {
    setup(itemDb(ITEM), { linkTokenCreate: async () => ({ data: { link_token: "x" } }) });
    await supertest(app).post("/api/plaid/link-token-update").send({ item_id: 7, kind: "both" }).expect(400);
    await supertest(app).post("/api/plaid/link-token-update").send({ item_id: "7abc", kind: "transactions" }).expect(400);
    await supertest(app).post("/api/plaid/link-token-update").send({ item_id: 8, kind: "transactions" }).expect(404);
    setup(itemDb({ ...ITEM, status: "CSV" }), { linkTokenCreate: async () => ({ data: { link_token: "x" } }) });
    await supertest(app).post("/api/plaid/link-token-update").send({ item_id: 7, kind: "transactions" }).expect(400);
    assert.equal(S.log.filter((c) => c.plaid).length, 0);
  });
});

describe("G3 — POST /api/plaid/update-complete", () => {
  function txnDb(known) {
    return itemDb(ITEM, async (sql, params) => {
      if (sql.includes("INSERT INTO linked_accounts") && sql.includes("DO NOTHING")) {
        if (known.has(params[1])) return { rows: [] };
        known.add(params[1]);
        return { rows: [{ id: 90 }] };
      }
      if (sql.includes("SELECT cursor FROM sync_cursors")) return { rows: [{ cursor: "c0" }] };
      if (sql.includes("INSERT INTO transactions")) {
        if (!known.has(params[0])) throw new Error("violates foreign key constraint");
        return { rows: [{ inserted: true }] };
      }
      return undefined;
    });
  }

  it("registers the new account BEFORE the cursor walk, clears the re-auth flag and syncs only that item", async () => {
    const known = new Set(["acc_old"]);
    setup(txnDb(known), {
      accountsGet: async () => ({ data: { accounts: [
        { account_id: "acc_old", name: "Checking", type: "depository", mask: "1111" },
        { account_id: "acc_new", name: "New Card", type: "credit", mask: "2222" },
      ] } }),
      transactionsSync: async () => ({ data: {
        added: [{ transaction_id: "t_new", account_id: "acc_new", amount: 9.5, date: "2026-10-01", name: "Shop", pending: false }],
        modified: [], removed: [], next_cursor: "c1", has_more: false,
      } }),
    });
    const res = await supertest(app).post("/api/plaid/update-complete").send({ item_id: 7, kind: "transactions" }).expect(200);
    assert.equal(res.body.accounts_added, 1);
    assert.equal(res.body.transactions_added, 1);
    const reg = indexOf((c) => c.sql && c.sql.includes("INSERT INTO linked_accounts") && c.params[1] === "acc_new");
    const clear = indexOf((c) => c.sql && /SET last_error_code = NULL/.test(c.sql));
    const sync = indexOf((c) => c.plaid === "transactionsSync");
    assert.ok(reg >= 0 && clear > reg && sync > clear, `order: register ${reg} < clear ${clear} < sync ${sync}`);
    assert.equal(S.log[clear].params[0], 7);
    // Only this item: its token, its cursor — never the all-items query.
    assert.ok(S.log.filter((c) => c.plaid === "transactionsSync").every((c) => c.req.access_token === "tok_7"));
    assert.equal(ran(/WHERE pi\.status = 'GOOD'/).length, 0, "the all-items sync isn't run");
    assert.equal(ran(/SELECT cursor FROM sync_cursors/)[0].params[0], 7);
    assert.equal(S.log.filter((c) => c.plaid === "itemPublicTokenExchange").length, 0, "no token exchange in update mode");
  });

  it("a re-auth error (Link closed before the bank accepted) keeps the flag and answers 409", async () => {
    setup(itemDb(ITEM), {
      accountsGet: async () => { throw Object.assign(new Error("login"), { response: { data: { error_code: "ITEM_LOGIN_REQUIRED", error_message: "login required" } } }); },
    });
    const res = await supertest(app).post("/api/plaid/update-complete").send({ item_id: 7, kind: "transactions" }).expect(409);
    assert.equal(res.body.reason, "ITEM_LOGIN_REQUIRED");
    const set = ran(/UPDATE plaid_items SET last_error_code = \$2/);
    assert.equal(set.length, 1);
    assert.deepEqual(set[0].params, [7, "ITEM_LOGIN_REQUIRED"]);
  });

  it("decryption_failed is a 409 here too", async () => {
    setup(itemDb({ ...ITEM, access_token: null }), { accountsGet: async () => ({ data: { accounts: [] } }) });
    const res = await supertest(app).post("/api/plaid/update-complete").send({ item_id: 7, kind: "transactions" }).expect(409);
    assert.equal(res.body.reason, "decryption_failed");
  });

  it("the investments kind counts new investment accounts and runs the holdings sync for that Item only", async () => {
    setup(async (sql, params) => {
      if (/FROM plaid_investment_items WHERE id = \$1/.test(sql)) return { rows: [{ id: 3, item_id: "pi_3", institution_name: "Broker", status: "GOOD", access_token: "tok_3" }] };
      if (sql.includes("SELECT plaid_account_id FROM investment_accounts WHERE plaid_account_id = ANY")) return { rows: [{ plaid_account_id: "ia_old" }] };
      if (sql.includes("SELECT DISTINCT ON (item_id)")) {
        return { rows: params[1] === "pi_3" ? [{ item_id: "pi_3", institution_name: "Broker", access_token: "tok_3" }] : [] };
      }
      if (sql.includes("INSERT INTO investment_accounts")) return { rows: [{ id: 11, is_active: true }] };
      return undefined;
    }, {
      accountsGet: async () => ({ data: { accounts: [
        { account_id: "ia_old", type: "investment", subtype: "ira", mask: "1" },
        { account_id: "ia_new", type: "investment", subtype: "brokerage", mask: "2" },
        { account_id: "cash", type: "depository", mask: "3" },
      ] } }),
      investmentsHoldingsGet: async () => ({ data: { accounts: [
        { account_id: "ia_new", type: "investment", subtype: "brokerage", mask: "2", balances: { current: 50 } },
      ], holdings: [], securities: [] } }),
    });
    const res = await supertest(app).post("/api/plaid/update-complete").send({ item_id: 3, kind: "investments" }).expect(200);
    assert.equal(res.body.accounts_added, 1);
    assert.equal(res.body.transactions_added, 0);
    assert.equal(ran(/SELECT DISTINCT ON \(item_id\)/)[0].params[1], "pi_3", "holdings sync limited to the one Item");
    const upsert = ran(/INSERT INTO investment_accounts/)[0];
    assert.equal(upsert.params[5], "2", "the holdings sync writes the mask");
  });
});

describe("G3 — investments-only POST /api/plaid/exchange duplicate guard", () => {
  const plaidFor = (removed) => ({
    itemPublicTokenExchange: async () => ({ data: { access_token: "new_tok", item_id: "pi_new" } }),
    accountsGet: async () => ({ data: { accounts: [{ account_id: "ia_x", name: "Brokerage", type: "investment", subtype: "brokerage", mask: "7777" }] } }),
    itemRemove: async ({ access_token }) => { removed.push(access_token); return { data: {} }; },
    investmentsHoldingsGet: async () => ({ data: { accounts: [{ account_id: "ia_x", name: "Brokerage", type: "investment", subtype: "brokerage", mask: "7777", balances: { current: 10 } }], holdings: [], securities: [] } }),
  });

  it("a brokerage already linked through a Transactions link is refused: released at Plaid, nothing stored", async () => {
    const removed = [];
    setup(async (sql) => sql.includes("FROM plaid_items pi") && sql.includes("JOIN linked_accounts la")
      ? { rows: [{ id: 4, institution_name: "Big Broker" }] } : undefined, plaidFor(removed));
    const res = await supertest(app).post("/api/plaid/exchange")
      .send({ public_token: "pub", institution: { institution_id: "ins_1", name: "Big Broker" } }).expect(409);
    assert.equal(res.body.duplicate_of.id, 4);
    assert.match(res.body.error, /Re-authenticate \/ Add accounts/);
    assert.doesNotMatch(res.body.error, /unlink/i);
    assert.deepEqual(removed, ["new_tok"]);
    assert.equal(ran(/INSERT INTO plaid_investment_items/).length, 0);
    assert.equal(ran(/INSERT INTO investment_accounts/).length, 0);
  });

  it("an earlier investments-only Item with the same institution + mask + type is a duplicate too", async () => {
    const removed = [];
    setup(async (sql, params) => {
      if (sql.includes("FROM investment_accounts ia")) {
        assert.deepEqual(params[1], ["ia_x"], "the new Item's own accounts are excluded");
        assert.deepEqual(params[3], ["7777|brokerage"]);
        return { rows: [{ id: 2, institution_name: "Big Broker" }] };
      }
      return undefined;
    }, plaidFor(removed));
    await supertest(app).post("/api/plaid/exchange").send({ public_token: "pub", institution: { name: "Big Broker" } }).expect(409);
    assert.deepEqual(removed, ["new_tok"]);
    assert.equal(ran(/INSERT INTO plaid_investment_items/).length, 0);
  });

  it("a new brokerage links and stores its mask", async () => {
    const removed = [];
    setup(async () => undefined, plaidFor(removed));
    const res = await supertest(app).post("/api/plaid/exchange").send({ public_token: "pub", institution: { name: "Big Broker" } }).expect(200);
    assert.equal(res.body.accounts_stored, 1);
    assert.deepEqual(removed, []);
    const ins = ran(/INSERT INTO investment_accounts/)[0];
    assert.equal(ins.params[6], "7777");
  });

  it("a failure before the Item is stored releases it", async () => {
    const removed = [];
    const p = plaidFor(removed);
    p.accountsGet = async () => { throw new Error("accountsGet down"); };
    setup(async () => undefined, p);
    await supertest(app).post("/api/plaid/exchange").send({ public_token: "pub", institution: { name: "Big Broker" } }).expect(500);
    assert.deepEqual(removed, ["new_tok"]);
    assert.equal(ran(/INSERT INTO plaid_investment_items/).length, 0);
  });
});

describe("G3 — re-auth notification and deep links", () => {
  const reauthPlaid = {
    accountsGet: async () => { throw Object.assign(new Error("login"), { response: { data: { error_code: "ITEM_LOGIN_REQUIRED" } } }); },
    transactionsSync: async () => { throw Object.assign(new Error("login"), { response: { data: { error_code: "ITEM_LOGIN_REQUIRED", error_message: "login required" } } }); },
  };
  const syncDb = (was) => async (sql) => {
    if (sql.includes("FROM plaid_items pi") && sql.includes("WHERE pi.status = 'GOOD'")) {
      return { rows: [{ id: 3, item_id: "item_3", institution_name: "PlaidBank", access_token: "ptok" }] };
    }
    if (sql.includes("SELECT cursor FROM sync_cursors")) return { rows: [{ cursor: "" }] };
    if (/UPDATE plaid_items SET last_error_code = \$2/.test(sql)) {
      return { rows: was === "unchanged" ? [] : [{ institution_name: "PlaidBank", was }] };
    }
    return undefined;
  };

  it("an item that NEWLY needs re-authentication notifies once, deep-linking to /accounts", async () => {
    setup(syncDb(null), reauthPlaid);
    await inv.syncAllPlaidTransactions();
    assert.equal(S.sent.length, 1);
    assert.equal(S.sent[0].data.url, "/accounts");
    assert.equal(S.sent[0].tag, "plaid-reauth-3");
    assert.match(S.sent[0].body, /PlaidBank needs you to sign in again/);
  });

  it("no notification when the item already had a code, or the code is unchanged", async () => {
    setup(syncDb("PENDING_EXPIRATION"), reauthPlaid);
    await inv.syncAllPlaidTransactions();
    setup(syncDb("unchanged"), reauthPlaid);
    await inv.syncAllPlaidTransactions();
    assert.equal(S.sent.length, 0);
    assert.match(ran(/UPDATE plaid_items SET last_error_code = \$2/)[0].sql, /last_error_code IS DISTINCT FROM \$2/);
  });

  it("the data-health re-auth issue links to /accounts; Settings and the dashboard strip render issue links", () => {
    const settings = read("teller/routes/settings.js");
    assert.match(settings, /Plaid item\(s\) need re-authentication — open Accounts → Re-authenticate\.`, link: "\/accounts" \}/);
    assert.match(read("teller/views/settings.ejs"), /i\.link \? '<a href="' \+ esc\(window\.withBase \? window\.withBase\(i\.link\) : i\.link\)/);
    assert.match(read("teller/views/dashboard.ejs"), /i\.link \? '<a href="' \+ esc\(window\.withBase \? window\.withBase\(i\.link\) : i\.link\)/);
  });

  it("GET /api/items carries last_error_code for Plaid items", () => {
    const enr = read("teller/routes/enrollments.js");
    assert.match(enr, /'plaid' END AS provider,\s+pi\.last_error_code,/);
    assert.match(enr, /pi\.created_at, pi\.last_error_code\s+ORDER BY/);
  });
});

describe("G3 — Accounts page buttons (the real loadItems, run in a vm)", () => {
  const page = read("teller/views/accounts.ejs");
  const src = page.slice(page.indexOf("async function loadItems()"), page.indexOf("async function unlinkAccount("));

  async function render(items) {
    const itemsList = { innerHTML: "", textContent: "" };
    const ctx = {
      itemsList,
      apiFetch: async () => ({ ok: true, json: async () => items }),
      esc: (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]),
      showStatus: () => {},
    };
    vm.createContext(ctx);
    vm.runInContext(src + "\nthis.loadItems = loadItems;", ctx);
    await ctx.loadItems();
    return itemsList.innerHTML;
  }

  it("a flagged Plaid item gets Re-authenticate + Add accounts; a healthy one only Add accounts; CSV / Teller none", async () => {
    const html = await render([
      { id: 7, provider: "plaid", status: "GOOD", last_error_code: "ITEM_LOGIN_REQUIRED", institution_name: "Capital Bank", accounts: [{}] },
      { id: 8, provider: "plaid", status: "GOOD", last_error_code: null, institution_name: "Discover", accounts: [{}] },
      { id: 9, provider: "plaid", status: "CSV", last_error_code: null, institution_name: "CSV Import", accounts: [{}] },
      { id: 2, provider: "teller", status: "GOOD", institution_name: "Chase", accounts: [{}] },
      { id: 3, provider: "plaid_investment", status: "GOOD", last_error_code: null, institution_name: "Broker", accounts: [] },
    ]);
    const rows = html.split('<div class="item">').slice(1);
    assert.match(rows[0], /data-mode="reauth" data-e2e-skip data-id="7" data-kind="transactions"[^>]*>Re-authenticate</);
    assert.match(rows[0], /data-mode="add" data-e2e-skip data-id="7" data-kind="transactions"[^>]*>Add accounts</);
    assert.match(rows[0], /needs re-authentication/);
    assert.doesNotMatch(rows[1], /Re-authenticate/);
    assert.match(rows[1], /data-id="8" data-kind="transactions"[^>]*>Add accounts</);
    assert.doesNotMatch(rows[2], /plaid-update/, "a CSV import isn't a Plaid connection");
    assert.doesNotMatch(rows[3], /plaid-update/, "Teller has no update mode");
    assert.match(rows[4], /data-id="3" data-kind="investments"[^>]*>Add accounts</);
    for (const r of rows) assert.match(r, /data-action="unlink"/, "Unlink stays on every row");
  });

  it("the buttons open update-mode Link and finish through update-complete via writeOk — never a token exchange", () => {
    const fn = page.slice(page.indexOf("async function completePlaidUpdate("), page.indexOf("// --- Plaid transactions link"));
    assert.match(fn, /apiFetch\('\/api\/plaid\/link-token-update'/);
    assert.match(fn, /var body = \{ item_id: id, kind: kind \};/);
    assert.match(fn, /writeOk\(res, 'Could not open Plaid for '/);
    assert.match(fn, /apiFetch\('\/api\/plaid\/update-complete'/);
    assert.match(fn, /writeOk\(r, 'Could not refresh '/);
    assert.doesNotMatch(fn, /exchange/);
    assert.match(page, /onDelegate\('items-list', 'click', '\[data-action="plaid-update"\]', function\(\) \{\s+updatePlaidItem\(parseInt\(this\.dataset\.id\), this\.dataset\.kind, this\.dataset\.name\);/);
  });
});
