// ============================================================================
// Perfin API tests — the real app over a recording fake pool
// ============================================================================
// This file used to assert on values it built itself: 29 of its 33 tests
// re-typed a route's logic inside the test (a WHERE switch, a merchant-key
// expression, a net-worth loop, the CSRF conditions) and so passed whatever the
// production code did (cycle-9 F61 — the class TQ-1 deleted elsewhere). Every
// test below drives production code: the standalone Perfin app
// (teller/server.js — its real middleware order and routers) through supertest,
// the detector's exported helpers, and the browser's own esc() run in a vm.
// What only Postgres can judge (the monthly-cost SQL, the cleanup windows, the
// investment account types the table accepts) is in
// tests/contract/c9-batch10.contract.test.js.
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";
// A standalone Perfin with no login and no API key: every request reaches the
// CSRF check and the routes.
delete process.env.SESSION_PIN;
delete process.env.SESSION_PASSWORD;
delete process.env.API_KEY;
delete process.env.NODE_ENV;
process.env.APP_TIMEZONE = "UTC";

const { describe, it, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const supertest = require("supertest");

const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
const originalConnect = dbModule.pool.connect;

// A recording pool: each query is matched against `answers` ([regex, result |
// fn]) in order; anything unmatched returns no rows.
let queries, answers;
function fakeQuery(sql, params) {
  queries.push({ sql: String(sql), params });
  for (const [re, result] of answers) {
    if (re.test(String(sql))) return Promise.resolve(typeof result === "function" ? result(sql, params) : result);
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}
const ran = (re) => queries.filter((q) => re.test(q.sql));

let app;
before(() => {
  dbModule.pool.query = fakeQuery;
  dbModule.pool.connect = async () => ({ query: fakeQuery, release() {} });
  app = require("../teller/server").app;
});
after(() => {
  dbModule.pool.query = originalQuery;
  dbModule.pool.connect = originalConnect;
});
beforeEach(() => { queries = []; answers = []; });

const json = (req) => req.set("Content-Type", "application/json");

// ---------------------------------------------------------------------------
describe("POST /api/subscriptions (manual add)", () => {
  it("refuses a body missing name, amount or cadence_days before any query", async () => {
    for (const body of [{ name: "Netflix" }, { amount: 9.99, cadence_days: 30 }, { name: "Netflix", amount: 9.99 }, {}]) {
      const res = await json(supertest(app).post("/api/subscriptions")).send(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.body.error, /name, amount, and cadence_days are required/);
    }
    assert.deepEqual(queries, []);
  });

  it("refuses an amount or cadence that isn't a positive number", async () => {
    const post = (body) => json(supertest(app).post("/api/subscriptions")).send(body);
    assert.match((await post({ name: "X", amount: "abc", cadence_days: 30 })).body.error, /amount must be a positive number/);
    assert.match((await post({ name: "X", amount: -5, cadence_days: 30 })).body.error, /amount must be a positive number/);
    assert.match((await post({ name: "X", amount: 5, cadence_days: "soon" })).body.error, /cadence_days must be a positive integer/);
    assert.match((await post({ name: "X", amount: 5, cadence_days: -7 })).body.error, /cadence_days must be a positive integer/);
    assert.deepEqual(ran(/INSERT INTO detected_subscriptions/), []);
  });

  describe("with the clock on 31 January", () => {
    before(() => mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 0, 31, 12) }));
    after(() => mock.timers.reset());

    it("keys the row manual_<name>, dates it today, and steps a monthly cadence by calendar month", async () => {
      answers = [[/INSERT INTO detected_subscriptions/, (sql, p) => ({ rows: [{ id: 7, merchant_key: p[0], next_expected: p[5] }] })]];
      const res = await json(supertest(app).post("/api/subscriptions")).send({ name: "HBO Max Streaming!", amount: "15.99", cadence_days: "30" });
      assert.equal(res.status, 200);
      const [insert] = ran(/INSERT INTO detected_subscriptions/);
      assert.deepEqual(insert.params, [
        "manual_hbo_max_streaming_", "HBO Max Streaming!", 15.99, 30,
        "2026-01-31",   // first_seen = last_charged = today
        "2026-02-28",   // one calendar month on, the day clamped — not Jan 31 + 30 days (Mar 2)
        null,
      ]);
      assert.match(insert.sql, /'manual'/);
      assert.deepEqual(res.body, { id: 7, merchant_key: "manual_hbo_max_streaming_", next_expected: "2026-02-28" });
    });

    it("steps a 14-day cadence in days and stores the notes", async () => {
      await json(supertest(app).post("/api/subscriptions")).send({ name: "Meal Kit", amount: 60, cadence_days: 14, notes: "pause in August" }).expect(200);
      const [insert] = ran(/INSERT INTO detected_subscriptions/);
      assert.deepEqual(insert.params, ["manual_meal_kit", "Meal Kit", 60, 14, "2026-01-31", "2026-02-14", "pause in August"]);
    });
  });

  it("re-adding a name can't re-activate an auto-detected row the user cancelled or dismissed", async () => {
    await json(supertest(app).post("/api/subscriptions")).send({ name: "Gym", amount: 30, cadence_days: 30 }).expect(200);
    const [insert] = ran(/INSERT INTO detected_subscriptions/);
    assert.match(insert.sql, /ON CONFLICT \(merchant_key, cadence_days\)/);
    for (const col of ["is_active", "is_dismissed", "cancelled_at"]) {
      assert.match(insert.sql, new RegExp(col + " = CASE WHEN detected_subscriptions\\.source = 'manual' THEN"), col + " is only reset on the user's own manual row");
    }
  });

  it("a failed insert is a fixed 500, never the database's message", async () => {
    answers = [[/INSERT INTO detected_subscriptions/, () => { throw new Error("duplicate key value violates unique constraint \"secret_idx\""); }]];
    const res = await json(supertest(app).post("/api/subscriptions")).send({ name: "Gym", amount: 30, cadence_days: 30 });
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: "An internal error occurred." });
  });
});

// ---------------------------------------------------------------------------
describe("GET /api/subscriptions", () => {
  const LIST = /FROM detected_subscriptions ds/;
  const whereOf = () => {
    const [q] = ran(LIST);
    return q.sql.slice(q.sql.indexOf("FROM detected_subscriptions ds") + 30, q.sql.indexOf("ORDER BY")).replace(/\s+/g, " ").trim();
  };

  it("lists active subscriptions by default: not dismissed, not cancelled", async () => {
    await supertest(app).get("/api/subscriptions").expect(200);
    assert.equal(whereOf(), "WHERE ds.is_active = true AND ds.is_dismissed = false AND ds.cancelled_at IS NULL");
    queries = [];
    await supertest(app).get("/api/subscriptions?filter=active").expect(200);
    assert.equal(whereOf(), "WHERE ds.is_active = true AND ds.is_dismissed = false AND ds.cancelled_at IS NULL");
  });

  it("filter=dismissed, cancelled and all each read their own set", async () => {
    const expected = {
      dismissed: "WHERE ds.is_dismissed = true AND ds.cancelled_at IS NULL",
      cancelled: "WHERE ds.cancelled_at IS NOT NULL",
      all: "",
    };
    for (const [filter, where] of Object.entries(expected)) {
      queries = [];
      await supertest(app).get("/api/subscriptions?filter=" + filter).expect(200);
      assert.equal(whereOf(), where, filter);
    }
  });

  it("an unknown filter falls back to the active list — the value never reaches the SQL", async () => {
    await supertest(app).get("/api/subscriptions?filter=" + encodeURIComponent("all'; DROP TABLE transactions;--")).expect(200);
    assert.equal(whereOf(), "WHERE ds.is_active = true AND ds.is_dismissed = false AND ds.cancelled_at IS NULL");
    assert.doesNotMatch(ran(LIST)[0].sql, /DROP TABLE/);
  });

  it("the summary splits subscriptions from utilities and leaves out dismissed and cancelled rows", async () => {
    answers = [[LIST, { rows: [
      { id: 1, display_name: "NETFLIX.COM", merchant_key: "netflix", category: "subscription", monthly_cost: "15.99", is_dismissed: false, cancelled_at: null },
      { id: 2, display_name: "Quarterly Box", merchant_key: "box", category: "subscription", monthly_cost: "16.66", is_dismissed: false, cancelled_at: null },
      { id: 3, display_name: "City Water", merchant_key: "water", category: "utility", monthly_cost: "60.00", is_dismissed: false, cancelled_at: null },
      { id: 4, display_name: "Old Gym", merchant_key: "gym", category: "subscription", monthly_cost: "40.00", is_dismissed: true, cancelled_at: null },
      { id: 5, display_name: "Spotify Premium", merchant_key: "spotify", category: "subscription", monthly_cost: "11.99", is_dismissed: false, cancelled_at: "2026-01-02T00:00:00Z" },
    ] }]];
    const body = (await supertest(app).get("/api/subscriptions?filter=all").expect(200)).body;
    assert.deepEqual(body.summary, {
      total_active: 3,
      monthly_cost: 92.65,          // 15.99 + 16.66 + 60.00
      yearly_cost: 1111.8,
      subscriptions_monthly: 32.65,
      utilities_monthly: 60,
      subscription_count: 2,
      utility_count: 1,
    });
    assert.equal(body.subscriptions.length, 5, "the list itself keeps every row the filter returned");
    const byId = Object.fromEntries(body.subscriptions.map((s) => [s.id, s]));
    assert.equal(byId[1].cancel_url, "https://www.netflix.com/cancelplan");
    assert.equal(byId[5].cancel_url, "https://www.spotify.com/account/subscription/");
    assert.equal(byId[3].cancel_url, null);
  });

  it("a failed read is a fixed 500", async () => {
    answers = [[LIST, () => { throw new Error("relation does not exist"); }]];
    const res = await supertest(app).get("/api/subscriptions");
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: "An internal error occurred." });
  });
});

// ---------------------------------------------------------------------------
describe("Cancel URL lookup (reference-data findCancelUrl)", () => {
  const { findCancelUrl } = require("../teller/data/reference-data");

  it("finds Netflix cancel URL", () => {
    assert.equal(findCancelUrl("NETFLIX.COM"), "https://www.netflix.com/cancelplan");
  });
  it("finds Spotify cancel URL (case insensitive)", () => {
    assert.equal(findCancelUrl("Spotify Premium"), "https://www.spotify.com/account/subscription/");
  });
  it("returns null for unknown merchant", () => {
    assert.equal(findCancelUrl("My Local Gym"), null);
  });
  it("returns null for null input", () => {
    assert.equal(findCancelUrl(null), null);
  });
});

// ---------------------------------------------------------------------------
// The detector's own helpers (scripts/detect-subscriptions.js exports them —
// this file used to carry inline copies).
describe("detect-subscriptions helpers", () => {
  const { findModeAmount, addDays } = require("../scripts/detect-subscriptions");

  it("findModeAmount: null for no amounts", () => {
    assert.equal(findModeAmount([], 0.1), null);
  });
  it("findModeAmount: the amount with the most peers within the tolerance", () => {
    // 9.99 has four peers within 1% (9.98, 9.99, 10.00, 10.01 — 10.01 is 0.2% off);
    // 15.99 stands alone.
    assert.equal(findModeAmount([15.99, 9.99, 10.0, 10.01, 9.98], 0.01), 9.99);
  });
  it("findModeAmount: with no tolerance only exact matches count, and the first of a tie wins", () => {
    assert.equal(findModeAmount([20.0, 5.0, 5.0, 5.0], 0.0), 5.0);
    assert.equal(findModeAmount([7, 8], 0.0), 7);
  });
  it("addDays: forward, across a month end, and backwards over February", () => {
    const day = (d) => d.toISOString().slice(0, 10);
    assert.equal(day(addDays(new Date("2025-01-01T12:00:00Z"), 30)), "2025-01-31");
    assert.equal(day(addDays(new Date("2025-01-31T12:00:00Z"), 1)), "2025-02-01");
    assert.equal(day(addDays(new Date("2025-03-01T12:00:00Z"), -1)), "2025-02-28");
    assert.equal(day(addDays(new Date("2024-03-01T12:00:00Z"), -1)), "2024-02-29");
  });
  it("addDays never changes the date it was given", () => {
    const d = new Date("2025-01-01T12:00:00Z");
    addDays(d, 45);
    assert.equal(d.toISOString(), "2025-01-01T12:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
describe("POST /api/cleanup", () => {
  it("prunes old transactions and idle inactive subscriptions, and reports both counts", async () => {
    answers = [
      [/DELETE FROM transactions/, { rows: [{}, {}, {}], rowCount: 3 }],
      [/DELETE FROM detected_subscriptions/, { rows: [{}], rowCount: 1 }],
    ];
    const res = await json(supertest(app).post("/api/cleanup")).send({});
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { transactions_pruned: 3, subscriptions_pruned: 1 });
    // 36 months: never shorter than the longest window anything analyses
    // (detection reads 36 months) — and the same window as the reference SQL.
    const [txn] = ran(/DELETE FROM transactions/);
    assert.match(txn.sql, /WHERE date < \(CURRENT_DATE - INTERVAL '36 months'\)/);
    const reference = fs.readFileSync(path.join(__dirname, "..", "scripts", "retention-cleanup.sql"), "utf8");
    assert.match(reference, /INTERVAL '36 months'/);
    // Only INACTIVE subscriptions, untouched for six months.
    const [sub] = ran(/DELETE FROM detected_subscriptions/);
    assert.match(sub.sql, /WHERE is_active = false AND updated_at < \(CURRENT_DATE - INTERVAL '6 months'\)/);
  });

  it("a failed delete is a fixed 500 and the second delete never runs", async () => {
    answers = [[/DELETE FROM transactions/, () => { throw new Error("deadlock detected"); }]];
    const res = await json(supertest(app).post("/api/cleanup")).send({});
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: "An internal error occurred." });
    assert.deepEqual(ran(/DELETE FROM detected_subscriptions/), []);
  });
});

// ---------------------------------------------------------------------------
describe("POST /api/investment-accounts", () => {
  const INSERT = /INSERT INTO investment_accounts/;
  const post = (body) => json(supertest(app).post("/api/investment-accounts")).send(body);
  beforeEach(() => { answers = [[INSERT, (sql, p) => ({ rows: [{ id: 1, name: p[0], account_type: p[2] }] })]]; });

  it("requires a name — nothing is written without one", async () => {
    const res = await post({ balance: 50000, account_type: "401k" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Name is required" });
    assert.deepEqual(ran(INSERT), []);
  });

  it("stores each known account type as given", async () => {
    for (const type of ["brokerage", "retirement", "401k", "ira", "roth_ira", "529", "hsa", "crypto", "other"]) {
      queries = [];
      await post({ name: "Acct", account_type: type }).expect(200);
      assert.equal(ran(INSERT)[0].params[2], type);
    }
  });

  it("stores an unknown or missing type as brokerage", async () => {
    await post({ name: "Mystery", account_type: "invalid_type" }).expect(200);
    await post({ name: "No type" }).expect(200);
    assert.deepEqual(ran(INSERT).map((q) => q.params[2]), ["brokerage", "brokerage"]);
  });

  it("parses the balance, and blanks become null / 0", async () => {
    await post({ name: "Vanguard", institution: "Vanguard", account_type: "ira", balance: "50000.25", notes: "rollover" }).expect(200);
    await post({ name: "Empty", balance: "n/a" }).expect(200);
    assert.deepEqual(ran(INSERT).map((q) => q.params), [
      ["Vanguard", "Vanguard", "ira", 50000.25, "rollover"],
      ["Empty", null, "brokerage", 0, null],
    ]);
  });
});

// ---------------------------------------------------------------------------
// The CSRF check in teller/server.js: a state-changing /api request must carry
// something a cross-site form can't send.
describe("CSRF protection (standalone Perfin)", () => {
  const CSRF = { error: "CSRF validation failed. Include X-Requested-With header." };
  const INSERT = /INSERT INTO investment_accounts/;
  const form = () => supertest(app).post("/api/investment-accounts").type("form").send("name=Evil&balance=1");

  it("refuses a cross-site form post — and the route never runs", async () => {
    const res = await form();
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, CSRF);
    assert.deepEqual(ran(INSERT), []);
  });

  it("refuses PATCH and DELETE without the header too", async () => {
    assert.equal((await supertest(app).delete("/api/watchlist/1")).status, 403);
    assert.equal((await supertest(app).patch("/api/settings").type("form").send("theme=light")).status, 403);
    assert.deepEqual(ran(/watchlist|UPDATE user_settings/i), []);
  });

  it("lets a request with X-Requested-With through", async () => {
    answers = [[INSERT, { rows: [{ id: 1 }] }]];
    const res = await form().set("X-Requested-With", "XMLHttpRequest");
    assert.equal(res.status, 200);
    assert.equal(ran(INSERT).length, 1);
  });

  it("only the exact header value counts", async () => {
    assert.equal((await form().set("X-Requested-With", "yes")).status, 403);
  });

  it("lets a JSON body through (a cross-site form can't send that content type)", async () => {
    answers = [[INSERT, { rows: [{ id: 1 }] }]];
    const res = await json(supertest(app).post("/api/investment-accounts")).send({ name: "Roth" });
    assert.equal(res.status, 200);
  });

  it("lets a request carrying x-api-key through to the key check", async () => {
    answers = [[INSERT, { rows: [{ id: 1 }] }]];
    const res = await form().set("x-api-key", "anything");
    assert.notEqual(res.status, 403, "the CSRF check steps aside for an API-key client");
  });

  it("never applies to reads", async () => {
    for (const res of [
      await supertest(app).get("/api/subscriptions"),
      await supertest(app).head("/api/subscriptions"),
      await supertest(app).options("/api/subscriptions"),
    ]) assert.notEqual(res.status, 403);
  });

  it("leaves the login, logout and SSO-validate posts to their own checks", async () => {
    for (const p of ["/api/login", "/api/logout", "/api/sso/validate"]) {
      const res = await supertest(app).post(p).type("form").send("x=1");
      assert.notDeepEqual(res.body, CSRF, p);
    }
  });
});

// ---------------------------------------------------------------------------
// The browser's esc() — the function every Perfin page builds HTML with — run
// from perfin-shared.js itself (this file used to test a copy it typed in).
describe("esc (perfin-shared.js)", () => {
  const shared = fs.readFileSync(path.join(__dirname, "..", "teller", "public", "perfin-shared.js"), "utf8");
  const start = shared.indexOf("function esc(s)");
  const end = shared.indexOf("// --- Prefix helper", start);
  assert.ok(start >= 0 && end > start, "esc() found in perfin-shared.js");
  const ctx = {};
  vm.runInNewContext(shared.slice(start, end) + "\nthis.esc = esc;", ctx);
  const { esc } = ctx;

  it("escapes tags", () => {
    assert.equal(esc("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
  });
  it("escapes ampersands first, so an entity isn't double-read", () => {
    assert.equal(esc("A & B"), "A &amp; B");
    assert.equal(esc("&lt;"), "&amp;lt;");
  });
  it("escapes both quote characters, so a value can't leave an attribute", () => {
    assert.equal(esc('He said "hi"'), "He said &quot;hi&quot;");
    assert.equal(esc("O'Brien's"), "O&#39;Brien&#39;s");
    assert.equal(esc('" onmouseover="x'), "&quot; onmouseover=&quot;x");
  });
  it("leaves plain text alone and turns null / undefined into an empty string", () => {
    assert.equal(esc("Hello World"), "Hello World");
    assert.equal(esc(null), "");
    assert.equal(esc(undefined), "");
  });
  it("accepts a number", () => {
    assert.equal(esc(0), "0");
    assert.equal(esc(12.5), "12.5");
  });
});
