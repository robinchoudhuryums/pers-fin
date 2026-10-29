// ============================================================================
// Cycle 8 E2d (ST3) — "Since you last looked" on an id watermark
// ============================================================================
// GET /api/whats-new reads the mark (services/txn-watermark.readMark) before
// its queries and returns it as seen_token; new transactions are read by id
// (above last_dashboard_view_txn_id, up to the mark) once an id is stored,
// by created_at before that and for the daily digest. POST /seen stores the
// token (forward only, capped at the newest id / now()), 400s a malformed one
// and keeps the old "now" behaviour without one. The widget, run in a vm from
// dashboard.ejs, posts the token it was given. The database-backed half is
// tests/contract/whats-new-e2d.contract.test.js.
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const express = require("express");
const supertest = require("supertest");

const dbModule = require("../teller/services/database");
const tw = require("../teller/services/txn-watermark");
const whatsNew = require("../teller/routes/whats-new");
const originalQuery = dbModule.pool.query;
afterEach(() => { dbModule.pool.query = originalQuery; });
const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const app = () => { const a = express(); a.use(express.json()); a.use(whatsNew); return a; };

const MARK = { mark_id: "900", mark_at: "2026-10-29 10:00:00.123456+00" };
function fake(settings) {
  const log = [];
  dbModule.pool.query = async (sql, params) => {
    log.push({ sql, params });
    if (sql === tw.MARK_SQL) return { rows: [MARK] };
    if (/FROM user_settings WHERE id = 1/.test(sql) && sql.startsWith("SELECT")) return { rows: [settings] };
    return { rows: [] };
  };
  return log;
}
const txnQuery = (log) => log.find((x) => /FROM transactions t\s/.test(x.sql));

// ---------------------------------------------------------------------------
describe("the seen token", () => {
  it("parseSeenToken takes '<id>|<timestamptz>' and nothing else", () => {
    assert.deepEqual(whatsNew.parseSeenToken("900|2026-10-29 10:00:00.123456+00"), { id: "900", at: "2026-10-29 10:00:00.123456+00" });
    assert.deepEqual(whatsNew.parseSeenToken("0|2026-10-29T10:00:00.123Z"), { id: "0", at: "2026-10-29T10:00:00.123Z" });
    assert.deepEqual(whatsNew.parseSeenToken("5|2026-10-29 10:00:00-07:00"), { id: "5", at: "2026-10-29 10:00:00-07:00" });
    for (const bad of ["", "900", "|2026-10-29 10:00:00+00", "-1|2026-10-29 10:00:00+00", "9|now()", "9|2026-10-29 10:00:00+00; DROP TABLE x",
      "1234567890123456789|2026-10-29 10:00:00+00", 900, {}, ["900|2026-10-29 10:00:00+00"]]) {
      assert.equal(whatsNew.parseSeenToken(bad), null, String(bad));
    }
  });
});

// ---------------------------------------------------------------------------
describe("GET /api/whats-new", () => {
  it("reads the mark first and returns it as seen_token", async () => {
    const log = fake({ last_dashboard_view_at: new Date("2026-10-28T09:00:00Z"), last_dashboard_view_txn_id: "850" });
    const res = await supertest(app()).get("/api/whats-new").expect(200);
    assert.equal(log[0].sql, tw.MARK_SQL, "the mark comes before every other query");
    assert.equal(res.body.seen_token, "900|2026-10-29 10:00:00.123456+00");
    assert.equal(res.body.since, "2026-10-28T09:00:00.000Z");
  });

  it("with a stored id: new transactions by id, above it and up to the mark; the rest stay on the time", async () => {
    const log = fake({ last_dashboard_view_at: new Date("2026-10-28T09:00:00Z"), last_dashboard_view_txn_id: "850" });
    await supertest(app()).get("/api/whats-new").expect(200);
    const t = txnQuery(log);
    assert.match(t.sql, /WHERE t\.id > \$1::bigint AND t\.id <= \$3::bigint AND t\.pending = false/);
    assert.doesNotMatch(t.sql, /created_at > \$1/);
    assert.deepEqual(t.params, ["850", 25, "900"]);
    const subs = log.find((x) => /FROM detected_subscriptions/.test(x.sql));
    assert.deepEqual(subs.params[0], new Date("2026-10-28T09:00:00Z"));
  });

  it("no stored id yet: transactions by created_at (the old reading)", async () => {
    const log = fake({ last_dashboard_view_at: new Date("2026-10-28T09:00:00Z"), last_dashboard_view_txn_id: null });
    await supertest(app()).get("/api/whats-new").expect(200);
    const t = txnQuery(log);
    assert.match(t.sql, /WHERE t\.created_at > \$1 AND t\.pending = false/);
    assert.equal(t.params.length, 2);
  });

  it("the daily digest's gatherWhatsNew(since) stays on created_at", async () => {
    const log = fake({});
    await whatsNew.gatherWhatsNew(new Date("2026-10-28T09:00:00Z"));
    assert.match(txnQuery(log).sql, /t\.created_at > \$1/);
    const src = read("teller", "routes", "insights.js");
    assert.match(src, /gatherWhatsNew\(since\)/, "the digest passes only its time");
  });
});

// ---------------------------------------------------------------------------
describe("POST /api/whats-new/seen", () => {
  it("stores the token: forward only, capped at the newest id and now()", async () => {
    const log = fake({});
    await supertest(app()).post("/api/whats-new/seen").send({ seen_token: "900|2026-10-29 10:00:00.123456+00" }).expect(200);
    assert.equal(log.length, 1);
    assert.equal(log[0].sql, whatsNew.SEEN_SQL);
    assert.deepEqual(log[0].params, ["900", "2026-10-29 10:00:00.123456+00"]);
    assert.match(whatsNew.SEEN_SQL, /last_dashboard_view_txn_id = GREATEST\(COALESCE\(last_dashboard_view_txn_id, 0\), LEAST\(\$1::bigint, \(SELECT COALESCE\(MAX\(id\), 0\) FROM transactions\)\)\)/);
    assert.match(whatsNew.SEEN_SQL, /last_dashboard_view_at = GREATEST\(last_dashboard_view_at, LEAST\(\$2::timestamptz, now\(\)\)\)/);
  });

  it("a malformed token is a 400 that writes nothing", async () => {
    const log = fake({});
    for (const t of ["nope", 5, "9|later", { id: 9 }]) await supertest(app()).post("/api/whats-new/seen").send({ seen_token: t }).expect(400);
    assert.equal(log.length, 0);
  });

  it("no token (a page from before E2d): everything up to now, as before", async () => {
    const log = fake({});
    await supertest(app()).post("/api/whats-new/seen").expect(200);
    await supertest(app()).post("/api/whats-new/seen").send({ seen_token: null }).expect(200);
    assert.deepEqual(log.map((x) => x.sql), [whatsNew.SEEN_NOW_SQL, whatsNew.SEEN_NOW_SQL]);
    assert.match(whatsNew.SEEN_NOW_SQL, /last_dashboard_view_at = now\(\)/);
    assert.match(whatsNew.SEEN_NOW_SQL, /last_dashboard_view_txn_id = GREATEST\(COALESCE\(last_dashboard_view_txn_id, 0\), \(SELECT COALESCE\(MAX\(id\), 0\) FROM transactions\)\)/);
  });

  it("the migration adds the column", () => {
    assert.match(read("teller", "services", "database.js"), /ADD COLUMN IF NOT EXISTS last_dashboard_view_txn_id BIGINT/);
  });
});

// ---------------------------------------------------------------------------
describe("the widget posts the token back (dashboard.ejs, in a vm)", () => {
  const dash = read("teller", "views", "dashboard.ejs");
  const start = dash.indexOf("(async function loadWhatsNew() {");
  const end = dash.indexOf("// PWA — use the shared helper", start);
  const code = dash.slice(start, end);

  async function run(payload) {
    const el = () => ({ style: {}, textContent: "", innerHTML: "" });
    const els = { "whats-new-widget": el(), "whats-new-body": el(), "whats-new-since": el() };
    const calls = [];
    const timers = [];
    const ctx = {
      document: { getElementById: (id) => els[id] || null },
      esc: (s) => String(s),
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); },
      apiFetch: async (url, opts) => {
        calls.push({ url, opts });
        if (url === "/api/whats-new") return { ok: true, json: async () => payload };
        return { ok: true };
      },
    };
    await vm.runInNewContext(code, ctx);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    return { calls, timers, els };
  }
  const payload = (extra) => ({
    since: "2026-10-28T09:00:00.000Z",
    counts: { transactions: 1, subscriptions: 0, notifications: 0, balance_changes: 0 },
    transactions: [{}], subscriptions: [], notifications: [], balance_changes: [],
    ...extra,
  });

  it("4 s after rendering, POSTs the seen_token it was given as JSON", async () => {
    const { calls, timers, els } = await run(payload({ seen_token: "900|2026-10-29 10:00:00.123456+00" }));
    assert.equal(els["whats-new-widget"].style.display, "block");
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 4000);
    timers[0].fn();
    const post = calls.find((c) => c.url === "/api/whats-new/seen");
    assert.equal(post.opts.method, "POST");
    assert.equal(post.opts.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(post.opts.body), { seen_token: "900|2026-10-29 10:00:00.123456+00" });
  });

  it("an older server with no token: the plain POST", async () => {
    const { calls, timers } = await run(payload({}));
    timers[0].fn();
    const post = calls.find((c) => c.url === "/api/whats-new/seen");
    assert.deepEqual(Object.keys(post.opts), ["method"]);
    assert.equal(post.opts.method, "POST");
  });

  it("nothing new: no POST (unchanged)", async () => {
    const { timers } = await run(payload({ counts: { transactions: 0, subscriptions: 0, notifications: 0, balance_changes: 0 }, seen_token: "1|2026-10-29 10:00:00+00" }));
    assert.equal(timers.length, 0);
  });
});
