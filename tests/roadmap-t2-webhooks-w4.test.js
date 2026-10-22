// ============================================================================
// Roadmap T2.1 — W4: Plaid item events + webhook registration
// ============================================================================
//  - the handler: ITEM ERROR with a re-auth code / PENDING_EXPIRATION /
//    PENDING_DISCONNECT / USER_PERMISSION_REVOKED set the item's signal,
//    LOGIN_REPAIRED clears it, an outage ERROR and other ITEM codes are
//    ignored, an investments-only Item's re-auth events are ignored;
//    NEW_ACCOUNTS_AVAILABLE notifies once a day per item; HOLDINGS and
//    INVESTMENTS_TRANSACTIONS run that Item's holdings / flow sync (a failed
//    sync fails the event); an unknown item is ignored
//  - setPlaidItemErrorCode: a clean sync keeps an advance warning, a full clear
//    doesn't; the notification text per code
//  - the verifier passes Plaid's error_code through
//  - registration: the webhook URL only from PUBLIC_URL (never
//    RENDER_EXTERNAL_URL), with the /perfin mount when embedded; the four link
//    tokens carry it only then; POST /api/plaid/webhooks/register (400 without
//    PUBLIC_URL, per-item itemWebhookUpdate, webhook_url recorded, error codes
//    only, decryption failures never sent); the flows sync's one-Item filter
// The database-backed half is tests/contract/webhooks-w4.contract.test.js.

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const dbModule = require("../teller/services/database");
const plaidClientModule = require("../teller/services/plaid-client");
const notifications = require("../teller/routes/notifications");
const hosting = require("../teller/services/hosting");
const { createPlaidEventHandler } = require("../teller/routes/plaid-webhook-events");
const { createPlaidVerifier } = require("../teller/services/webhook-verify");

const originalQuery = dbModule.pool.query;
const originalGetPlaidClient = plaidClientModule.getPlaidClient;
const originalSendToAll = notifications.sendToAll;
const savedEnv = { PUBLIC_URL: process.env.PUBLIC_URL, RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL };

let S;
let inv;
before(() => {
  plaidClientModule.getPlaidClient = () => S.plaid;
  delete require.cache[require.resolve("../teller/routes/investments")];
  inv = require("../teller/routes/investments");
});
after(() => {
  plaidClientModule.getPlaidClient = originalGetPlaidClient;
  dbModule.pool.query = originalQuery;
  notifications.sendToAll = originalSendToAll;
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
afterEach(() => {
  dbModule.pool.query = originalQuery;
  notifications.sendToAll = originalSendToAll;
  delete process.env.PUBLIC_URL;
  delete process.env.RENDER_EXTERNAL_URL;
});

function setup({ db, plaid = {} } = {}) {
  S = { log: [], sent: [], plaid: {} };
  for (const [name, fn] of Object.entries(plaid)) {
    S.plaid[name] = async (req) => { S.log.push({ plaid: name, req }); return fn(req); };
  }
  dbModule.pool.query = async (sql, params = []) => {
    S.log.push({ sql, params });
    return (db && (await db(sql, params))) || { rows: [], rowCount: 0 };
  };
  notifications.sendToAll = async (payload) => { S.sent.push(payload); return { sent: 1 }; };
}
const ran = (re) => S.log.filter((q) => q.sql && re.test(q.sql));
const plaidCalls = (name) => S.log.filter((q) => q.plaid === name);

// ---------------------------------------------------------------------------
describe("W4 — the Plaid ITEM / investment event handler", () => {
  const TXN = { kind: "txn", id: 7, institution_name: "Capital Bank" };
  const INV = { kind: "inv", id: 3, institution_name: "Big Broker" };
  function handlerWith({ rows = [TXN], holdings = { ok: true }, flows = { ok: true }, recently = false } = {}) {
    const calls = { db: [], set: [], notify: [], holdings: [], flows: [], sync: [] };
    const h = createPlaidEventHandler({
      db: { query: async (sql, params) => { calls.db.push({ sql, params }); return { rows }; } },
      syncItem: async (id) => { calls.sync.push(id); return { ok: true, added: 0 }; },
      postSync: async () => {},
      setErrorCode: async (id, code) => { calls.set.push([id, code]); },
      isReauthCode: (code) => ["ITEM_LOGIN_REQUIRED", "INVALID_CREDENTIALS"].includes(code),
      syncHoldings: async (itemId) => { calls.holdings.push(itemId); return holdings; },
      syncFlows: async (itemId) => { calls.flows.push(itemId); return flows; },
      notify: async (n) => { calls.notify.push(n); },
      sentRecently: async () => recently,
    });
    return { h, calls };
  }
  const ev = (type, code, extra = {}) => ({ type, code, subject: "it_7", error_code: null, ...extra });

  it("ERROR with a re-auth code sets the signal; an outage ERROR is ignored", async () => {
    let t = handlerWith();
    assert.deepEqual(await t.h(ev("ITEM", "ERROR", { error_code: "ITEM_LOGIN_REQUIRED" })), { status: "done" });
    assert.deepEqual(t.calls.set, [[7, "ITEM_LOGIN_REQUIRED"]]);
    t = handlerWith();
    assert.deepEqual(await t.h(ev("ITEM", "ERROR", { error_code: "INSTITUTION_DOWN" })), { status: "ignored" });
    assert.deepEqual(await t.h(ev("ITEM", "ERROR")), { status: "ignored" });
    assert.deepEqual(t.calls.set, []);
  });

  it("PENDING_EXPIRATION / PENDING_DISCONNECT / USER_PERMISSION_REVOKED set themselves; LOGIN_REPAIRED clears", async () => {
    const t = handlerWith();
    for (const code of ["PENDING_EXPIRATION", "PENDING_DISCONNECT", "USER_PERMISSION_REVOKED", "LOGIN_REPAIRED"]) {
      assert.deepEqual(await t.h(ev("ITEM", code)), { status: "done" });
    }
    assert.deepEqual(t.calls.set, [[7, "PENDING_EXPIRATION"], [7, "PENDING_DISCONNECT"], [7, "USER_PERMISSION_REVOKED"], [7, null]]);
  });

  it("other ITEM codes, unknown items and investments-only re-auth events are ignored", async () => {
    let t = handlerWith();
    assert.deepEqual(await t.h(ev("ITEM", "WEBHOOK_UPDATE_ACKNOWLEDGED")), { status: "ignored" });
    t = handlerWith({ rows: [] });
    assert.deepEqual(await t.h(ev("ITEM", "PENDING_EXPIRATION")), { status: "ignored" });
    t = handlerWith({ rows: [INV] });
    assert.deepEqual(await t.h(ev("ITEM", "ERROR", { error_code: "ITEM_LOGIN_REQUIRED" })), { status: "ignored" });
    assert.deepEqual(await t.h(ev("ITEM", "LOGIN_REPAIRED")), { status: "ignored" });
    assert.deepEqual(t.calls.set, []);
    assert.deepEqual(await t.h({ type: "ITEM", code: "ERROR", subject: null }), { status: "ignored" });
  });

  it("the lookup covers GOOD plaid_items and the investments-only registry", async () => {
    const t = handlerWith();
    await t.h(ev("ITEM", "LOGIN_REPAIRED"));
    assert.match(t.calls.db[0].sql, /FROM plaid_items WHERE item_id = \$1 AND status = 'GOOD'/);
    assert.match(t.calls.db[0].sql, /FROM plaid_investment_items WHERE item_id = \$1/);
    assert.deepEqual(t.calls.db[0].params, ["it_7"]);
  });

  it("NEW_ACCOUNTS_AVAILABLE notifies once a day per item, deep-linking to /accounts", async () => {
    let t = handlerWith();
    assert.deepEqual(await t.h(ev("ITEM", "NEW_ACCOUNTS_AVAILABLE")), { status: "done" });
    assert.equal(t.calls.notify.length, 1);
    assert.equal(t.calls.notify[0].tag, "plaid-new-accounts-txn-7");
    assert.equal(t.calls.notify[0].data.url, "/accounts");
    assert.match(t.calls.notify[0].body, /Capital Bank has an account you haven't added\. Open Accounts → Add accounts\./);
    t = handlerWith({ recently: true });
    assert.deepEqual(await t.h(ev("ITEM", "NEW_ACCOUNTS_AVAILABLE")), { status: "done" });
    assert.equal(t.calls.notify.length, 0);
    t = handlerWith({ rows: [INV] });
    await t.h(ev("ITEM", "NEW_ACCOUNTS_AVAILABLE"));
    assert.equal(t.calls.notify[0].tag, "plaid-new-accounts-inv-3");
    t = handlerWith({ rows: [] });
    assert.deepEqual(await t.h(ev("ITEM", "NEW_ACCOUNTS_AVAILABLE")), { status: "ignored" });
  });

  it("HOLDINGS / INVESTMENTS_TRANSACTIONS run that Item's holdings / flow sync", async () => {
    const t = handlerWith({ rows: [INV] });
    assert.deepEqual(await t.h(ev("HOLDINGS", "DEFAULT_UPDATE")), { status: "done" });
    assert.deepEqual(await t.h(ev("INVESTMENTS_TRANSACTIONS", "DEFAULT_UPDATE")), { status: "done" });
    assert.deepEqual(await t.h(ev("INVESTMENTS_TRANSACTIONS", "HISTORICAL_UPDATE")), { status: "done" });
    assert.deepEqual(t.calls.holdings, ["it_7"]);
    assert.deepEqual(t.calls.flows, ["it_7", "it_7"]);
    assert.deepEqual(t.calls.sync, [], "no transaction sync for an investments event");
  });

  it("a failed or partly failed investment sync fails the event; an unknown item is ignored", async () => {
    let t = handlerWith({ holdings: { ok: false, error: "x" } });
    await assert.rejects(() => t.h(ev("HOLDINGS", "DEFAULT_UPDATE")), /holdings sync failed/);
    t = handlerWith({ flows: { ok: true, errors: [{ institution: "B", error: "decryption_failed" }] } });
    await assert.rejects(() => t.h(ev("INVESTMENTS_TRANSACTIONS", "DEFAULT_UPDATE")), /investment transactions sync failed/);
    t = handlerWith({ rows: [] });
    assert.deepEqual(await t.h(ev("HOLDINGS", "DEFAULT_UPDATE")), { status: "ignored" });
    assert.deepEqual(t.calls.holdings, []);
  });
});

// ---------------------------------------------------------------------------
describe("W4 — the re-auth signal", () => {
  it("a clean sync keeps an advance warning; a full clear (LOGIN_REPAIRED, update-complete) doesn't", async () => {
    setup();
    await inv.setPlaidItemErrorCode(7, null, { keepWarnings: true });
    await inv.setPlaidItemErrorCode(7, null);
    const [kept, full] = ran(/SET last_error_code = NULL/);
    assert.match(kept.sql, /last_error_code <> ALL\(\$2::text\[\]\)/);
    assert.deepEqual(kept.params, [7, ["PENDING_EXPIRATION", "PENDING_DISCONNECT"]]);
    assert.doesNotMatch(full.sql, /ALL\(/);
    assert.deepEqual(full.params, [7]);
  });

  it("the per-item sync clears with keepWarnings", () => {
    const src = read("teller/routes/investments.js");
    const one = src.slice(src.indexOf("async function syncOnePlaidItem("), src.indexOf("// syncPlaidItem — sync ONE"));
    assert.match(one, /await setPlaidItemErrorCode\(item\.id, null, \{ keepWarnings: true \}\);/);
    const upd = src.slice(src.indexOf('router.post("/api/plaid/update-complete"'));
    assert.match(upd.slice(0, 1500), /await setPlaidItemErrorCode\(item\.id, null\);/, "re-authentication clears everything");
  });

  it("the notification names what happened", async () => {
    for (const [code, title, body] of [
      ["PENDING_EXPIRATION", "Bank connection expires soon", /Capital Bank's connection will stop syncing soon/],
      ["USER_PERMISSION_REVOKED", "Bank connection access revoked", /Access to Capital Bank was revoked at Plaid/],
      ["ITEM_LOGIN_REQUIRED", "Bank connection needs re-authentication", /Capital Bank needs you to sign in again/],
    ]) {
      setup({ db: async (sql) => /SET last_error_code = \$2/.test(sql) ? { rows: [{ institution_name: "Capital Bank", was: null }] } : undefined });
      await inv.setPlaidItemErrorCode(7, code);
      assert.equal(S.sent.length, 1);
      assert.equal(S.sent[0].title, title);
      assert.match(S.sent[0].body, body);
      assert.equal(S.sent[0].tag, "plaid-reauth-7");
      assert.equal(S.sent[0].data.url, "/accounts");
    }
  });
});

// ---------------------------------------------------------------------------
describe("W4 — the verifier passes Plaid's error_code through", () => {
  it("an ITEM / ERROR event carries error.error_code (nothing else of the error object)", async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const raw = Buffer.from(JSON.stringify({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: "it_7", error: { error_code: "ITEM_LOGIN_REQUIRED", error_message: "the login details changed" } }));
    const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const h = b({ alg: "ES256", kid: "k" });
    const p = b({ iat: Math.floor(Date.now() / 1000), request_body_sha256: crypto.createHash("sha256").update(raw).digest("hex") });
    const token = `${h}.${p}.${crypto.sign("sha256", Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
    const verifier = createPlaidVerifier({ getClient: () => ({ webhookVerificationKeyGet: async () => ({ data: { key: { ...jwk, expired_at: null } } }) }) });
    const r = await verifier.verify({ headers: { "plaid-verification": token }, rawBody: raw, body: JSON.parse(raw) });
    assert.equal(r.ok, true);
    assert.deepEqual(r.event, { type: "ITEM", code: "ERROR", subject: "it_7", error_code: "ITEM_LOGIN_REQUIRED" });
  });
});

// ---------------------------------------------------------------------------
describe("W4 — webhook registration", () => {
  function appFor(embedded) {
    const app = express();
    app.set("embedded", embedded);
    app.use(express.json());
    app.use(inv);
    return app;
  }

  it("the URL comes from PUBLIC_URL only, with the /perfin mount when embedded", () => {
    assert.equal(hosting.webhookBaseUrl({ RENDER_EXTERNAL_URL: "https://x.onrender.com" }), null);
    assert.equal(hosting.webhookBaseUrl({ PUBLIC_URL: "https://fin.example.com/" }), "https://fin.example.com");
    process.env.RENDER_EXTERNAL_URL = "https://x.onrender.com";
    assert.equal(inv.plaidWebhookUrl({ app: { get: () => true } }), null);
    process.env.PUBLIC_URL = "https://fin.example.com";
    assert.equal(inv.plaidWebhookUrl({ app: { get: () => true } }), "https://fin.example.com/perfin/api/webhooks/plaid");
    assert.equal(inv.plaidWebhookUrl({ app: { get: () => false } }), "https://fin.example.com/api/webhooks/plaid");
  });

  async function tokenRequests() {
    setup({
      db: async (sql, params) => /FROM plaid_items WHERE id = \$1/.test(sql)
        ? { rows: [{ id: 7, item_id: "it_7", institution_name: "Capital Bank", status: "GOOD", access_token: "tok_7" }] } : undefined,
      plaid: { linkTokenCreate: async () => ({ data: { link_token: "lt", hosted_link_url: "https://hosted" } }) },
    });
    const app = appFor(true);
    await supertest(app).post("/api/plaid/link-token").send({}).expect(200);
    await supertest(app).post("/api/plaid/link-token-transactions").send({}).expect(200);
    await supertest(app).post("/api/plaid/hosted-link").send({ redirect_uri: "https://fin.example.com/perfin/accounts" }).expect(200);
    await supertest(app).post("/api/plaid/link-token-update").send({ item_id: 7, kind: "transactions" }).expect(200);
    return plaidCalls("linkTokenCreate").map((c) => c.req);
  }

  it("the four link tokens carry the webhook only when PUBLIC_URL is set", async () => {
    let reqs = await tokenRequests();
    assert.equal(reqs.length, 4);
    for (const r of reqs) assert.equal(r.webhook, undefined);
    process.env.PUBLIC_URL = "https://fin.example.com";
    reqs = await tokenRequests();
    assert.equal(reqs.length, 4);
    for (const r of reqs) assert.equal(r.webhook, "https://fin.example.com/perfin/api/webhooks/plaid");
  });

  it("every link exchange records the URL its Item was created with", () => {
    const src = read("teller/routes/investments.js");
    assert.equal((src.match(/await noteItemWebhook\("plaid_items", itemId, plaidWebhookUrl\(req\)\);/g) || []).length, 2);
    assert.equal((src.match(/await noteItemWebhook\("plaid_investment_items", itemId, plaidWebhookUrl\(req\)\);/g) || []).length, 2);
  });

  it("register: 400 without PUBLIC_URL, 501 without Plaid", async () => {
    setup({ plaid: {} });
    const r = await supertest(appFor(true)).post("/api/plaid/webhooks/register").send({}).expect(400);
    assert.match(r.body.error, /Set PUBLIC_URL/);
    process.env.PUBLIC_URL = "https://fin.example.com";
    S.plaid = null;
    await supertest(appFor(true)).post("/api/plaid/webhooks/register").send({}).expect(501);
  });

  it("register: itemWebhookUpdate per item, URL recorded on success, error codes only, no undecryptable token sent", async () => {
    process.env.PUBLIC_URL = "https://fin.example.com";
    setup({
      db: async (sql) => /UNION ALL\s+SELECT 'plaid_investment_items'/.test(sql) ? { rows: [
        { tbl: "plaid_items", item_id: "it_7", institution_name: "Capital Bank", access_token: "tok_7" },
        { tbl: "plaid_investment_items", item_id: "pi_3", institution_name: "Big Broker", access_token: "tok_3" },
        { tbl: "plaid_items", item_id: "it_8", institution_name: "Bad Bank", access_token: "tok_8" },
        { tbl: "plaid_items", item_id: "it_9", institution_name: "Locked Bank", access_token: null },
      ] } : undefined,
      plaid: {
        itemWebhookUpdate: async (req) => {
          if (req.access_token === "tok_8") throw Object.assign(new Error("secret detail"), { response: { data: { error_code: "ITEM_LOGIN_REQUIRED", error_message: "secret detail" } } });
          return { data: {} };
        },
      },
    });
    const quiet = console.error; console.error = () => {};
    let res;
    try { res = await supertest(appFor(true)).post("/api/plaid/webhooks/register").send({}).expect(200); }
    finally { console.error = quiet; }
    assert.equal(res.body.url, "https://fin.example.com/perfin/api/webhooks/plaid");
    assert.equal(res.body.registered, 2);
    assert.equal(res.body.failed, 2);
    assert.deepEqual(res.body.errors, [{ institution: "Bad Bank", error: "ITEM_LOGIN_REQUIRED" }, { institution: "Locked Bank", error: "decryption_failed" }]);
    assert.doesNotMatch(JSON.stringify(res.body), /secret detail/);
    assert.deepEqual(plaidCalls("itemWebhookUpdate").map((c) => [c.req.access_token, c.req.webhook]),
      [["tok_7", res.body.url], ["tok_3", res.body.url], ["tok_8", res.body.url]]);
    const marks = ran(/SET webhook_url = \$2 WHERE item_id = \$1/).map((q) => [q.sql.match(/UPDATE (\w+)/)[1], q.params[0]]);
    assert.deepEqual(marks, [["plaid_items", "it_7"], ["plaid_investment_items", "it_7"], ["plaid_investment_items", "pi_3"]]);
    const sel = ran(/UNION ALL\s+SELECT 'plaid_investment_items'/)[0].sql;
    assert.match(sel, /perfin_try_decrypt\(access_token_enc, \$1\)/);
    assert.match(sel, /WHERE status = 'GOOD'/);
    assert.match(sel, /NOT EXISTS \(SELECT 1 FROM plaid_items pi WHERE pi\.item_id = pii\.item_id\)/);
  });

  it("the flow sync can be limited to one Item", async () => {
    setup({ plaid: {} });
    const r = await inv.syncAllPlaidInvestmentFlows({ itemId: "pi_3" });
    assert.equal(r.ok, true);
    const q = ran(/FROM plaid_investment_items/)[0];
    assert.match(q.sql, /WHERE \(\$2::text IS NULL OR item_id = \$2::text\)/);
    assert.equal(q.params[1], "pi_3");
    await inv.syncAllPlaidInvestmentFlows();
    assert.equal(ran(/FROM plaid_investment_items/)[1].params[1], null);
  });
});
