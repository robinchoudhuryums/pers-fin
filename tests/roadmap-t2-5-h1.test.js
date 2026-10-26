// ============================================================================
// Roadmap T2.5 H1 — Re-authenticate / Add accounts through Plaid's hosted page
// (iOS / iPadOS, the home-screen app, the Capacitor wrapper).
//
//   - POST /api/plaid/link-token-update { hosted: true, redirect_uri }: the
//     update-mode request plus the hosted_link object (same values as
//     /api/plaid/hosted-link); 400 without a redirect_uri, nothing read.
//   - POST /api/plaid/update-complete { link_token }: the Link session read
//     through linkTokenGet BEFORE anything else — finished → the unchanged
//     body; exited / unfinished / none → 400, a Plaid error → 502, and in each
//     of those nothing is written and Plaid isn't asked for the accounts.
//   - updateSessionState over session shapes.
//   - The Accounts page (accounts.ejs, run in a vm): prefersHostedPlaidLink
//     over user agents / touch / standalone / Capacitor; updatePlaidItem's
//     hosted and in-page paths; handlePlaidUpdateReturn (state removed and URL
//     cleaned before the call, the link_token sent, an error toast); the OAuth
//     return handler leaving an update return alone.
// The database-backed half is tests/contract/plaid-update.contract.test.js.
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";
const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const express = require("express");
const supertest = require("supertest");

const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const dbModule = require("../teller/services/database");
const plaidClientModule = require("../teller/services/plaid-client");
const notifications = require("../teller/routes/notifications");

const originalQuery = dbModule.pool.query;
const originalGetPlaidClient = plaidClientModule.getPlaidClient;
const originalSendToAll = notifications.sendToAll;

let S, inv, app;
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

function setup(db, plaid) {
  S = { log: [], plaid: {} };
  for (const [name, fn] of Object.entries(plaid || {})) {
    S.plaid[name] = async (req) => { S.log.push({ plaid: name, req }); return fn(req); };
  }
  dbModule.pool.query = async (sql, params) => {
    S.log.push({ sql, params: params || [] });
    return (await db(sql, params || [])) || { rows: [] };
  };
  notifications.sendToAll = async () => ({ sent: 1 });
}
const ITEM = { id: 7, item_id: "it_7", institution_name: "Capital Bank", status: "GOOD", access_token: "tok_7" };
const itemDb = (extra) => async (sql, params) => {
  if (extra) { const r = await extra(sql, params); if (r) return r; }
  if (/FROM plaid_items WHERE id = \$1/.test(sql)) return { rows: params[0] === 7 ? [ITEM] : [] };
  if (sql.includes("SELECT cursor FROM sync_cursors")) return { rows: [{ cursor: "c0" }] };
  return undefined;
};
const writes = () => S.log.filter((c) => c.sql && /^\s*(INSERT|UPDATE|DELETE)/i.test(c.sql));
const plaidCalls = (name) => S.log.filter((c) => c.plaid === name);

describe("H1 — POST /api/plaid/link-token-update { hosted }", () => {
  it("adds the hosted_link object and redirect_uri to the update-mode request and returns hosted_link_url", async () => {
    setup(itemDb(), { linkTokenCreate: async () => ({ data: { link_token: "link-upd", hosted_link_url: "https://hosted.plaid.com/x" } }) });
    const res = await supertest(app).post("/api/plaid/link-token-update")
      .send({ item_id: 7, kind: "transactions", hosted: true, redirect_uri: "https://app.example/perfin/accounts" }).expect(200);
    assert.deepEqual(res.body, { link_token: "link-upd", kind: "transactions", institution: "Capital Bank", hosted_link_url: "https://hosted.plaid.com/x" });
    const req = plaidCalls("linkTokenCreate")[0].req;
    assert.equal(req.access_token, "tok_7");
    assert.equal(req.products, undefined, "update mode sends no products");
    assert.deepEqual(req.update, { account_selection_enabled: true });
    assert.equal(req.redirect_uri, "https://app.example/perfin/accounts");
    assert.deepEqual(req.hosted_link, { url_lifetime_seconds: 3600, completion_redirect_uri: "https://app.example/perfin/accounts" });
  });

  it("the in-page request is unchanged: no hosted_link, no redirect_uri, no hosted_link_url", async () => {
    setup(itemDb(), { linkTokenCreate: async () => ({ data: { link_token: "link-upd", hosted_link_url: "ignored" } }) });
    for (const body of [{ item_id: 7, kind: "transactions" }, { item_id: 7, kind: "transactions", hosted: "true", redirect_uri: "x" }]) {
      S.log.length = 0;
      const res = await supertest(app).post("/api/plaid/link-token-update").send(body).expect(200);
      assert.equal("hosted_link_url" in res.body, false);
      const req = plaidCalls("linkTokenCreate")[0].req;
      assert.equal(req.hosted_link, undefined);
      assert.equal(req.redirect_uri, undefined);
    }
  });

  it("hosted without a redirect_uri is a 400 before the item is read", async () => {
    setup(itemDb(), { linkTokenCreate: async () => ({ data: { link_token: "x" } }) });
    for (const redirect_uri of [undefined, "", 42]) {
      await supertest(app).post("/api/plaid/link-token-update").send({ item_id: 7, kind: "transactions", hosted: true, redirect_uri }).expect(400);
    }
    assert.equal(S.log.length, 0);
  });
});

describe("H1 — updateSessionState", () => {
  const { updateSessionState } = require("../teller/routes/investments");
  it("reads Link's sessions", () => {
    assert.equal(updateSessionState(undefined), "none");
    assert.equal(updateSessionState([]), "none");
    assert.equal(updateSessionState([{ link_session_id: "a", started_at: "t" }]), "unfinished");
    assert.equal(updateSessionState([{ finished_at: "t", exit: null, on_exit: null }]), "finished");
    assert.equal(updateSessionState([{ finished_at: "t", exit: { error: null } }]), "exited");
    assert.equal(updateSessionState([{ finished_at: "t", on_exit: { status: "x" } }]), "exited");
    assert.equal(updateSessionState([{ finished_at: "t1", exit: {} }, { finished_at: "t2" }]), "finished", "a later session that finished counts");
    assert.equal(updateSessionState([{ finished_at: "t1" }, { exit: {} }]), "finished", "an earlier finished session still re-authenticated the item");
  });
});

describe("H1 — POST /api/plaid/update-complete { link_token }", () => {
  function plaidWith(sessions, extra = {}) {
    return {
      linkTokenGet: typeof sessions === "function" ? sessions : async () => ({ data: { link_sessions: sessions } }),
      accountsGet: async () => ({ data: { accounts: [{ account_id: "acc_1", name: "Checking", type: "depository", mask: "1111" }] } }),
      transactionsSync: async () => ({ data: { added: [], modified: [], removed: [], next_cursor: "c1", has_more: false } }),
      ...extra,
    };
  }

  it("a finished session runs the update: the session read first, then the flag cleared", async () => {
    setup(itemDb(), plaidWith([{ link_session_id: "s1", finished_at: "2026-10-26T10:00:00Z", exit: null }]));
    const res = await supertest(app).post("/api/plaid/update-complete").send({ item_id: 7, kind: "transactions", link_token: "link-upd" }).expect(200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(plaidCalls("linkTokenGet").map((c) => c.req), [{ link_token: "link-upd" }]);
    const get = S.log.findIndex((c) => c.plaid === "linkTokenGet");
    const acc = S.log.findIndex((c) => c.plaid === "accountsGet");
    const clear = S.log.findIndex((c) => c.sql && /SET last_error_code = NULL/.test(c.sql));
    assert.ok(get >= 0 && acc > get && clear > get, `order: session ${get} < accounts ${acc}, clear ${clear}`);
  });

  for (const [label, sessions, reason] of [
    ["an exited session", [{ link_session_id: "s1", finished_at: "t", exit: { error: null } }], "exited"],
    ["an unfinished session", [{ link_session_id: "s1", started_at: "t" }], "unfinished"],
    ["no session", [], "none"],
  ]) {
    it(`${label} is a 400 and nothing is written`, async () => {
      setup(itemDb(), plaidWith(sessions));
      const res = await supertest(app).post("/api/plaid/update-complete").send({ item_id: 7, kind: "transactions", link_token: "link-upd" }).expect(400);
      assert.equal(res.body.reason, reason);
      assert.match(res.body.error, /^Plaid re-authentication wasn't finished, so nothing was changed\./);
      assert.deepEqual(writes(), []);
      assert.equal(plaidCalls("accountsGet").length, 0);
    });
  }

  it("a Plaid error reading the session is a fixed 502 and nothing is written", async () => {
    setup(itemDb(), plaidWith(async () => { throw Object.assign(new Error("secret detail tok_7"), { response: { data: { error_code: "INVALID_LINK_TOKEN" } } }); }));
    const errs = [];
    const orig = console.error;
    console.error = (...a) => errs.push(a.join(" "));
    try {
      const res = await supertest(app).post("/api/plaid/update-complete").send({ item_id: 7, kind: "transactions", link_token: "link-upd" }).expect(502);
      assert.equal(res.body.error, "Couldn't read the Plaid session, so nothing was changed. Press Re-authenticate to try again.");
    } finally { console.error = orig; }
    assert.deepEqual(writes(), []);
    assert.equal(plaidCalls("accountsGet").length, 0);
    assert.ok(errs.some((e) => /INVALID_LINK_TOKEN/.test(e)) && !errs.some((e) => /tok_7/.test(e)), "logs the code, not the message");
  });

  it("an investments update checks the session too", async () => {
    setup(async (sql, params) => {
      if (/FROM plaid_investment_items WHERE id = \$1/.test(sql)) return { rows: [{ id: 3, item_id: "pi_3", institution_name: "Broker", status: "GOOD", access_token: "tok_3" }] };
      return undefined;
    }, plaidWith([{ exit: {} }]));
    await supertest(app).post("/api/plaid/update-complete").send({ item_id: 3, kind: "investments", link_token: "link-inv" }).expect(400);
    assert.deepEqual(writes(), []);
    assert.equal(plaidCalls("accountsGet").length, 0);
  });

  it("a non-string link_token is a 400 before anything is read; an unknown item is a 404 before the session is read", async () => {
    setup(itemDb(), plaidWith([{ finished_at: "t" }]));
    for (const link_token of [42, "", { a: 1 }]) {
      await supertest(app).post("/api/plaid/update-complete").send({ item_id: 7, kind: "transactions", link_token }).expect(400);
    }
    assert.equal(S.log.length, 0);
    await supertest(app).post("/api/plaid/update-complete").send({ item_id: 8, kind: "transactions", link_token: "x" }).expect(404);
    assert.equal(plaidCalls("linkTokenGet").length, 0);
  });

  it("without a link_token (the in-page flow) the session isn't read", async () => {
    setup(itemDb(), plaidWith([]));
    await supertest(app).post("/api/plaid/update-complete").send({ item_id: 7, kind: "transactions" }).expect(200);
    assert.equal(plaidCalls("linkTokenGet").length, 0);
  });
});

describe("H1 — the Accounts page (accounts.ejs in a vm)", () => {
  const page = read("teller/views/accounts.ejs");
  const block = page.slice(page.indexOf("var PLAID_UPDATE_KEY"), page.indexOf("// --- Plaid transactions link"));

  function load(opts = {}) {
    const store = new Map(Object.entries(opts.session || {}));
    const log = [];
    const win = {
      navigator: opts.navigator || { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130", maxTouchPoints: 0 },
      matchMedia: (q) => ({ matches: !!opts.standalone && q === "(display-mode: standalone)" }),
      location: { origin: "https://app.example", pathname: "/perfin/accounts/", search: "?x=1", href: "https://app.example/perfin/accounts/?x=1" },
      history: { replaceState: (_a, _b, url) => log.push(["replaceState", url]) },
      Capacitor: opts.capacitor ? {} : undefined,
      Plaid: { create: (cfg) => { log.push(["Plaid.create", cfg.token]); win._cfg = cfg; return { open: () => log.push(["open"]) }; } },
    };
    const ctx = {
      window: win, JSON, encodeURIComponent,
      sessionStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { log.push(["setItem", k]); store.set(k, String(v)); },
        removeItem: (k) => { log.push(["removeItem", k]); store.delete(k); },
      },
      apiFetch: async (url, o) => {
        log.push(["fetch", url, o && o.body ? JSON.parse(o.body) : null]);
        return opts.api ? opts.api(url) : { ok: true, status: 200, json: async () => ({}) };
      },
      writeOk: async (r, what) => { if (!r.ok) log.push(["toast", what]); return r.ok; },
      showStatus: (t, ok) => log.push(["status", t, ok]),
      loadItems: () => log.push(["loadItems"]),
      loadInvestments: () => log.push(["loadInvestments"]),
      ensurePlaidSdk: async () => {},
    };
    vm.runInNewContext(block, ctx);
    return { ctx, win, log, store };
  }

  it("prefersHostedPlaidLink: iOS / iPadOS, standalone and Capacitor take the hosted page; desktop and Android don't", () => {
    const { ctx } = load();
    const pick = (ua, extra = {}) => ctx.prefersHostedPlaidLink({ navigator: { userAgent: ua, maxTouchPoints: 0, ...(extra.nav || {}) }, matchMedia: extra.matchMedia, Capacitor: extra.capacitor });
    assert.equal(pick("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1"), true);
    assert.equal(pick("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)"), true);
    assert.equal(pick("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605", { nav: { maxTouchPoints: 5 } }), true, "iPadOS reports a Mac UA with touch points");
    assert.equal(pick("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605"), false, "a real Mac");
    assert.equal(pick("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130"), false);
    assert.equal(pick("Mozilla/5.0 (Linux; Android 14) Chrome/130"), false);
    assert.equal(pick("Mozilla/5.0 (Linux; Android 14) Chrome/130", { matchMedia: (q) => ({ matches: q === "(display-mode: standalone)" }) }), true, "an installed PWA");
    assert.equal(pick("Mozilla/5.0 (Windows NT 10.0)", { nav: { standalone: true } }), true, "iOS's navigator.standalone");
    assert.equal(pick("Mozilla/5.0 (Windows NT 10.0)", { capacitor: {} }), true, "the Capacitor wrapper");
    assert.equal(ctx.prefersHostedPlaidLink(null), false);
  });

  it("on iOS updatePlaidItem asks for a hosted token, saves the state and redirects", async () => {
    const t = load({
      navigator: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" },
      api: () => ({ ok: true, status: 200, json: async () => ({ link_token: "link-upd", hosted_link_url: "https://hosted.plaid.com/u" }) }),
    });
    await t.ctx.updatePlaidItem(7, "transactions", "Capital Bank");
    assert.deepEqual(t.log[0], ["fetch", "/api/plaid/link-token-update", { item_id: 7, kind: "transactions", hosted: true, redirect_uri: "https://app.example/perfin/accounts" }]);
    assert.deepEqual(JSON.parse(t.store.get("perfin_plaid_update")), { item_id: 7, kind: "transactions", name: "Capital Bank", link_token: "link-upd" });
    assert.equal(t.win.location.href, "https://hosted.plaid.com/u");
    assert.equal(t.log.some((e) => e[0] === "Plaid.create"), false);
  });

  it("no hosted_link_url → an error, nothing saved, no redirect; a refused token → writeOk", async () => {
    const t = load({ standalone: true, api: () => ({ ok: true, status: 200, json: async () => ({ link_token: "x" }) }) });
    await t.ctx.updatePlaidItem(7, "transactions", "Capital Bank");
    assert.equal(t.store.has("perfin_plaid_update"), false);
    assert.equal(t.win.location.href, "https://app.example/perfin/accounts/?x=1");
    assert.deepEqual(t.log.at(-1), ["status", "Could not open Plaid for Capital Bank: Plaid returned no hosted page.", false]);
    const t2 = load({ capacitor: true, api: () => ({ ok: false, status: 409, json: async () => ({}) }) });
    await t2.ctx.updatePlaidItem(7, "transactions", "Capital Bank");
    assert.deepEqual(t2.log.at(-1), ["toast", "Could not open Plaid for Capital Bank"]);
  });

  it("on desktop the in-page Link opens and onSuccess finishes without a link_token", async () => {
    const t = load({ api: (url) => ({ ok: true, status: 200, json: async () => (url.includes("token") ? { link_token: "link-upd" } : { accounts_added: 1, transactions_added: 2 }) }) });
    await t.ctx.updatePlaidItem(7, "transactions", "Capital Bank");
    assert.deepEqual(t.log[0], ["fetch", "/api/plaid/link-token-update", { item_id: 7, kind: "transactions" }]);
    assert.ok(t.log.some((e) => e[0] === "Plaid.create" && e[1] === "link-upd"));
    await t.win._cfg.onSuccess();
    assert.ok(t.log.some((e) => e[0] === "fetch" && e[1] === "/api/plaid/update-complete" && JSON.stringify(e[2]) === JSON.stringify({ item_id: 7, kind: "transactions" })));
    assert.ok(t.log.some((e) => e[0] === "status" && e[1] === "Capital Bank updated: 1 new account(s), 2 new transaction(s)."));
  });

  it("the return handler removes the state and cleans the URL BEFORE calling update-complete with the link_token", async () => {
    const t = load({
      session: { perfin_plaid_update: JSON.stringify({ item_id: 3, kind: "investments", name: "Broker", link_token: "link-inv" }) },
      api: () => ({ ok: true, status: 200, json: async () => ({ accounts_added: 0, transactions_added: 0 }) }),
    });
    await t.ctx.handlePlaidUpdateReturn();
    const i = (pred) => t.log.findIndex(pred);
    const rm = i((e) => e[0] === "removeItem" && e[1] === "perfin_plaid_update");
    const clean = i((e) => e[0] === "replaceState" && e[1] === "https://app.example/perfin/accounts/");
    const call = i((e) => e[0] === "fetch" && e[1] === "/api/plaid/update-complete");
    assert.ok(rm >= 0 && clean > rm && call > clean, `order: remove ${rm} < clean ${clean} < call ${call}`);
    assert.deepEqual(t.log[call][2], { item_id: 3, kind: "investments", link_token: "link-inv" });
    assert.ok(t.log.some((e) => e[0] === "loadInvestments"));
    assert.equal(t.store.has("perfin_plaid_update"), false);
  });

  it("a refused finish is toasted and the items reload; bad saved state is reported; no state does nothing", async () => {
    const t = load({
      session: { perfin_plaid_update: JSON.stringify({ item_id: 7, kind: "transactions", name: "Capital Bank", link_token: "x" }) },
      api: () => ({ ok: false, status: 400, json: async () => ({ error: "not finished" }) }),
    });
    await t.ctx.handlePlaidUpdateReturn();
    assert.ok(t.log.some((e) => e[0] === "toast" && e[1] === "Could not refresh Capital Bank"));
    assert.ok(t.log.some((e) => e[0] === "loadItems"));

    const bad = load({ session: { perfin_plaid_update: "{not json" } });
    await bad.ctx.handlePlaidUpdateReturn();
    assert.equal(bad.log.some((e) => e[0] === "fetch"), false);
    assert.deepEqual(bad.log.at(-1), ["status", "Could not finish the Plaid update — press Re-authenticate again.", false]);
    assert.equal(bad.store.has("perfin_plaid_update"), false);

    const none = load();
    await none.ctx.handlePlaidUpdateReturn();
    assert.deepEqual(none.log, []);
  });

  it("the handlers are wired: the return handler runs on load, the OAuth return handler leaves an update return alone, the buttons are off the e2e sweep", () => {
    assert.match(page, /setTimeout\(handlePlaidHostedReturn, 100\);\n\s+setTimeout\(handlePlaidUpdateReturn, 100\);/);
    assert.match(page, /function handlePlaidOAuthReturn\(\) \{\n\s+if \(sessionStorage\.getItem\(PLAID_UPDATE_KEY\)\) return;/);
    const hosted = page.slice(page.indexOf("async function handlePlaidHostedReturn("), page.indexOf("setTimeout(handlePlaidHostedReturn"));
    assert.doesNotMatch(hosted, /PLAID_UPDATE_KEY|perfin_plaid_update/, "the new-link return reads only its own keys");
    assert.match(page, /data-action="plaid-update" data-mode="reauth" data-e2e-skip'/);
    assert.match(page, /data-action="plaid-update" data-mode="add" data-e2e-skip'/);
  });
});
