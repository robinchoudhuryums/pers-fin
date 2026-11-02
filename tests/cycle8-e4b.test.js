// ============================================================================
// Cycle-8 E4b (G3) — one freshness definition and the nav badge
// ============================================================================
//  - services/freshness.js: ageInfo's thresholds, overallFreshness (the OLDEST
//    active connection wins; a re-auth / disconnected connection is stale and
//    named; no complete sync recorded → stale 'never'; with no connection the
//    newest global stamp), readConnections' SQL and mapping, a failed read
//    falling back to the global basis
//  - GET /api/data-health's connections read through the same helper (the list
//    unchanged), GET /api/data-freshness keeping every old field and adding
//    connections + overall
//  - the badge run in a vm from nav.ejs: text, level class, tooltip, aria-label,
//    "Reconnect <bank>", a failed load leaving it empty; nav.ejs rendered through
//    EJS with the link to Sync Health under both mounts
// The database-backed half is tests/contract/operator-freshness-e4b.contract.test.js.

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, before, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const express = require("express");
const supertest = require("supertest");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const fr = require("../teller/services/freshness");

const NOW = Date.parse("2026-10-30T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
const conn = (over) => ({ provider: "plaid", id: 1, institution: "Bank", status: "GOOD", last_synced: fr.ageInfo(hoursAgo(1), NOW), ...over });

describe("services/freshness.js", () => {
  it("ageInfo: fresh under 6 h, aging under 24 h, stale at 24 h and when never synced", () => {
    assert.equal(fr.ageInfo(hoursAgo(5.9), NOW).level, "fresh");
    assert.equal(fr.ageInfo(hoursAgo(6), NOW).level, "aging");
    assert.equal(fr.ageInfo(hoursAgo(23.9), NOW).level, "aging");
    assert.equal(fr.ageInfo(hoursAgo(24), NOW).level, "stale");
    assert.deepEqual(fr.ageInfo(null, NOW), { timestamp: null, age_seconds: null, level: "stale" });
    assert.equal(fr.ageInfo(hoursAgo(2), NOW).age_seconds, 7200);
  });

  it("overall: the OLDEST active connection wins, named", () => {
    const o = fr.overallFreshness([
      conn({ id: 1, institution: "Fresh Bank", last_synced: fr.ageInfo(hoursAgo(0.2), NOW) }),
      conn({ id: 2, provider: "teller", institution: "Old Bank", last_synced: fr.ageInfo(hoursAgo(30), NOW) }),
      conn({ id: 3, institution: "Mid Bank", last_synced: fr.ageInfo(hoursAgo(8), NOW) }),
    ], { last_txn_sync_at: hoursAgo(0.1) }, NOW);
    assert.equal(o.basis, "connections");
    assert.equal(o.level, "stale");
    assert.equal(o.reason, null);
    assert.equal(o.age_seconds, 30 * 3600);
    assert.deepEqual(o.connection, { provider: "teller", id: 2, institution: "Old Bank" });
  });

  it("overall: a webhook-synced connection is fresh even when the global stamps are two days old", () => {
    const o = fr.overallFreshness([conn({ last_synced: fr.ageInfo(hoursAgo(0.25), NOW) })],
      { last_txn_sync_at: hoursAgo(48), last_auto_sync_at: hoursAgo(50) }, NOW);
    assert.equal(o.level, "fresh");
    assert.equal(o.basis, "connections");
  });

  it("overall: a re-auth or disconnected connection is stale with its reason, whatever the others' ages", () => {
    const reauth = fr.overallFreshness([
      conn({ id: 1, institution: "Fine" }),
      conn({ id: 4, institution: "Card Co", status: "NEEDS_REAUTH", last_synced: fr.ageInfo(hoursAgo(2), NOW) }),
    ], {}, NOW);
    assert.equal(reauth.level, "stale");
    assert.equal(reauth.reason, "reauth");
    assert.equal(reauth.connection.institution, "Card Co");
    const disc = fr.overallFreshness([conn({ provider: "teller", id: 7, institution: "T Bank", status: "DISCONNECTED", last_synced: fr.ageInfo(null, NOW) })], {}, NOW);
    assert.equal(disc.reason, "disconnected");
    assert.equal(disc.timestamp, null);
  });

  it("overall: a connection with no complete sync recorded is the oldest (stale, 'never')", () => {
    const o = fr.overallFreshness([conn({ id: 1 }), conn({ id: 2, institution: "New", last_synced: fr.ageInfo(null, NOW) })], {}, NOW);
    assert.equal(o.level, "stale");
    assert.equal(o.reason, "never");
    assert.equal(o.connection.institution, "New");
  });

  it("overall: no connections → the newest global stamp (basis global); none at all → never", () => {
    const g = fr.overallFreshness([], { last_auto_sync_at: hoursAgo(30), last_txn_sync_at: hoursAgo(3), last_balance_sync_at: hoursAgo(10) }, NOW);
    assert.deepEqual(g, { basis: "global", level: "fresh", reason: null, timestamp: hoursAgo(3), age_seconds: 3 * 3600, connection: null });
    const none = fr.overallFreshness([], {}, NOW);
    assert.equal(none.basis, "global");
    assert.equal(none.level, "stale");
    assert.equal(none.reason, "never");
  });

  it("readConnections: CSV items and suspended enrollments left out, a re-auth code mapped", async () => {
    assert.match(fr.CONNECTIONS_SQL, /FROM teller_enrollments WHERE status <> 'SUSPENDED'/);
    assert.match(fr.CONNECTIONS_SQL, /FROM plaid_items WHERE status <> 'CSV'/);
    assert.match(fr.CONNECTIONS_SQL, /CASE WHEN last_error_code IS NOT NULL THEN 'NEEDS_REAUTH' ELSE status END/);
    const db = { query: async () => ({ rows: [{ provider: "teller", id: 3, institution_name: "T", status: "GOOD", last_synced_at: hoursAgo(1) }] }) };
    assert.deepEqual(await fr.readConnections(db, NOW), [
      { provider: "teller", id: 3, institution: "T", status: "GOOD", last_synced: { timestamp: hoursAgo(1), age_seconds: 3600, level: "fresh" } },
    ]);
  });

  it("connectionFreshness: a failed read falls back to the global basis and says so", async () => {
    const r = await fr.connectionFreshness({ query: async () => { throw new Error("boom"); } },
      { now: NOW, globals: { last_txn_sync_at: hoursAgo(7) } });
    assert.deepEqual(r.connections, []);
    assert.equal(r.connections_error, true);
    assert.equal(r.overall.basis, "global");
    assert.equal(r.overall.level, "aging");
  });
});

describe("the routes read the one definition", () => {
  let dbModule, original;
  before(() => {
    dbModule = require("../teller/services/database");
    original = dbModule.pool.query;
  });
  afterEach(() => { dbModule.pool.query = original; });
  function app() {
    delete require.cache[require.resolve("../teller/routes/settings")];
    const a = express();
    a.use(express.json());
    a.use(require("../teller/routes/settings"));
    return a;
  }
  const rows = [
    { provider: "plaid", id: 4, institution_name: "Card Co", status: "GOOD", last_synced_at: new Date(Date.now() - 30 * 3600 * 1000).toISOString() },
    { provider: "teller", id: 2, institution_name: "Fresh Bank", status: "GOOD", last_synced_at: new Date(Date.now() - 600 * 1000).toISOString() },
  ];

  it("GET /api/data-freshness keeps its old fields and adds connections + overall (the oldest connection)", async () => {
    const twoDays = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    dbModule.pool.query = async (sql) => {
      if (/FROM user_settings/.test(sql)) return { rows: [{ last_auto_sync_at: twoDays, last_txn_sync_at: twoDays, last_balance_sync_at: null, insights_last_run: null }] };
      if (/'teller' AS provider/.test(sql)) return { rows };
      return { rows: [] };
    };
    const res = await supertest(app()).get("/api/data-freshness").expect(200);
    assert.deepEqual(res.body.thresholds, { fresh_seconds: 6 * 3600, stale_seconds: 24 * 3600 });
    assert.equal(res.body.transactions.level, "stale");
    assert.equal(res.body.transactions.stale, true);
    assert.deepEqual(res.body.balances, { timestamp: null, age_seconds: null, stale: true, level: "stale" });
    assert.equal(res.body.connections.length, 2);
    assert.equal(res.body.overall.basis, "connections");
    assert.equal(res.body.overall.level, "stale");
    assert.equal(res.body.overall.connection.institution, "Card Co");
  });

  it("GET /api/data-freshness with no connections reads the global stamps", async () => {
    const recent = new Date(Date.now() - 3600 * 1000).toISOString();
    dbModule.pool.query = async (sql) => {
      if (/FROM user_settings/.test(sql)) return { rows: [{ last_auto_sync_at: null, last_txn_sync_at: recent, last_balance_sync_at: null, insights_last_run: null }] };
      return { rows: [] };
    };
    const res = await supertest(app()).get("/api/data-freshness").expect(200);
    assert.equal(res.body.overall.basis, "global");
    assert.equal(res.body.overall.level, "fresh");
    assert.deepEqual(res.body.connections, []);
  });

  it("GET /api/data-health lists the same connections readConnections returns", async () => {
    dbModule.pool.query = async (sql) => {
      if (/FROM user_settings/.test(sql)) return { rows: [{ last_txn_sync_at: new Date(), last_balance_sync_at: new Date() }] };
      if (/'teller' AS provider/.test(sql)) return { rows };
      return { rows: [] };
    };
    const res = await supertest(app()).get("/api/data-health").expect(200);
    const direct = await fr.readConnections({ query: async () => ({ rows }) });
    assert.deepEqual(res.body.connections.map((c) => ({ ...c, last_synced: { ...c.last_synced, age_seconds: null } })),
      direct.map((c) => ({ ...c, last_synced: { ...c.last_synced, age_seconds: null } })));
  });
});

describe("the nav badge (nav.ejs)", () => {
  const nav = read("teller/views/partials/nav.ejs");
  const script = nav.slice(nav.indexOf("    function fmtAgoSeconds(s) {"), nav.indexOf("    whenShared(async function() {\n      var el = document.getElementById('nav-sync-badge');"));
  const loader = nav.slice(nav.indexOf("    whenShared(async function() {\n      var el = document.getElementById('nav-sync-badge');"), nav.indexOf("    // Notification bell"));

  function fakeEl() {
    const classes = new Set();
    const attrs = {};
    return {
      textContent: "", title: "", attrs,
      classList: { add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)), has: (c) => classes.has(c), list: () => [...classes] },
      setAttribute: (k, v) => { attrs[k] = v; },
    };
  }
  function run(d) {
    const ctx = vm.createContext({});
    vm.runInContext(script, ctx);
    const el = fakeEl();
    const ok = ctx.renderSyncBadge(el, d);
    return { el, ok };
  }

  it("shows the oldest connection's age, its level class, a per-connection tooltip and an aria-label", () => {
    const { el, ok } = run({
      overall: { basis: "connections", level: "aging", reason: null, age_seconds: 7 * 3600, connection: { institution: "Old Bank" } },
      connections: [
        { institution: "Old Bank", status: "GOOD", last_synced: { timestamp: "x", age_seconds: 7 * 3600 } },
        { institution: "Card Co", provider: "plaid", status: "GOOD", last_synced: { timestamp: "y", age_seconds: 300 } },
        { institution: null, provider: "teller", status: "GOOD", last_synced: { timestamp: null, age_seconds: null } },
      ],
    });
    assert.equal(ok, true);
    assert.equal(el.textContent, "Synced 7h ago");
    assert.deepEqual(el.classList.list(), ["sync-aging"]);
    assert.equal(el.title, "Old Bank: synced 7h ago\nCard Co: synced 5m ago\nTeller connection: no complete sync yet\nOpen Sync Health");
    assert.equal(el.attrs["aria-label"], "Synced 7h ago — open Sync Health");
  });

  it("says Reconnect <bank> for a re-auth or disconnected connection, red", () => {
    for (const reason of ["reauth", "disconnected"]) {
      const { el } = run({ overall: { basis: "connections", level: "stale", reason, age_seconds: 60, connection: { institution: "Card Co" } },
        connections: [{ institution: "Card Co", status: reason === "reauth" ? "NEEDS_REAUTH" : "DISCONNECTED", last_synced: {} }] });
      assert.equal(el.textContent, "Reconnect Card Co");
      assert.deepEqual(el.classList.list(), ["sync-stale"]);
      assert.match(el.title, reason === "reauth" ? /Card Co: needs re-authentication/ : /Card Co: disconnected/);
    }
  });

  it("the global basis: the old per-source tooltip; never synced → Not synced yet", () => {
    const { el } = run({ overall: { basis: "global", level: "fresh", reason: null, age_seconds: 30 },
      transactions: { timestamp: "a", age_seconds: 30 }, balances: { timestamp: "b", age_seconds: 4000 }, auto_sync: { timestamp: null } });
    assert.equal(el.textContent, "Synced just now");
    assert.deepEqual(el.classList.list(), ["sync-fresh"]);
    assert.equal(el.title, "Transactions: just now\nBalances: 1h ago\nOpen Sync Health");
    const never = run({ overall: { basis: "global", level: "stale", reason: "never", age_seconds: null } });
    assert.equal(never.el.textContent, "Not synced yet");
  });

  it("no overall (an older server or a bad reply) leaves the badge empty", () => {
    const { el, ok } = run({ transactions: {} });
    assert.equal(ok, false);
    assert.equal(el.textContent, "");
  });

  it("a failed load leaves the badge empty; a good one renders through /api/data-freshness", async () => {
    for (const reply of [{ ok: false }, null]) {
      const el = fakeEl();
      const ctx = vm.createContext({
        document: { getElementById: () => el },
        apiFetch: async (url) => { assert.equal(url, "/api/data-freshness"); if (!reply) throw new Error("offline"); return reply; },
        whenShared: (fn) => { ctx.__p = fn(); },
      });
      vm.runInContext(script + loader, ctx);
      await ctx.__p;
      assert.equal(el.textContent, "");
    }
    const el = fakeEl();
    const ctx = vm.createContext({
      document: { getElementById: () => el },
      apiFetch: async () => ({ ok: true, json: async () => ({ overall: { basis: "global", level: "stale", reason: null, age_seconds: 3 * 86400 } }) }),
      whenShared: (fn) => { ctx.__p = fn(); },
    });
    vm.runInContext(script + loader, ctx);
    await ctx.__p;
    assert.equal(el.textContent, "Synced 3d ago");
  });

  it("no inline colour: the level is a class, defined in perfin-shared.css; the old /api/settings read is gone", () => {
    assert.doesNotMatch(script + loader, /style\.color/);
    assert.doesNotMatch(loader, /\/api\/settings/);
    const css = read("teller/public/perfin-shared.css");
    assert.match(css, /\.topnav \.nav-sync-badge\.sync-aging \{ color: var\(--yellow\)/);
    assert.match(css, /\.topnav \.nav-sync-badge\.sync-stale \{ color: var\(--red\)/);
    assert.match(css, /\.topnav \.nav-sync-badge:empty \{ display: none; \}/);
  });

  it("renders as a link to Sync Health under both mounts", async () => {
    const ejs = require("ejs");
    for (const basePath of ["", "/perfin"]) {
      const html = await new Promise((resolve, reject) =>
        ejs.renderFile(path.join(ROOT, "teller", "views", "budgets.ejs"), { nonce: "n", v: "1", basePath, activePage: "budgets" },
          (err, out) => (err ? reject(err) : resolve(out))));
      assert.match(html, new RegExp(`<a class="nav-sync-badge" id="nav-sync-badge" href="${basePath}/settings#sync-health"`));
    }
  });
});
