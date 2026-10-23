// ============================================================================
// Roadmap T2.2 L4 — per-account low-balance floors + the last evaluation
// ============================================================================
// services/cash-alerts.js's floor check through runCashAlerts over a fake pool
// (below → one push with the exact text, at the floor → none, a stale balance
// skipped, a recent alert deduped, an unlogged push leaving the check
// unstamped, the floor count in last_check, the floor SQL limited to spendable
// accounts); PATCH /api/accounts/:id low_balance_floor (400s, cents, null
// clears, a non-depository account a 400, a missing one a 404, the memo reset);
// GET /api/accounts returning the floor; the migration; the Settings UI's
// cashAlertLastText + loadCashFloors run in a vm.
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const express = require("express");
const supertest = require("supertest");

const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
afterEach(() => { dbModule.pool.query = originalQuery; });

const ca = require("../teller/services/cash-alerts");

const NOW = new Date("2026-03-10T15:00:00Z");
const TODAY = "2026-03-10";
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600e3);
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

function fakePool(floors) {
  const calls = { updates: [], stamps: [], floorSql: null };
  return {
    calls,
    query: async (sql, params) => {
      if (/UPDATE user_settings SET cash_alert_state/.test(sql)) { calls.updates.push(JSON.parse(params[0])); calls.stamps.push(params[2]); return { rows: [] }; }
      if (/FROM user_settings s/.test(sql)) {
        return { rows: [{ cash_alert_enabled: true, cash_alert_threshold: "500.00", cash_alert_horizon_days: 14,
          cash_alert_state: null, cash_alerts_checked_at: null, balances_at: hoursAgo(2), data_at: hoursAgo(2) }] };
      }
      if (/low_balance_floor IS NOT NULL/.test(sql)) { calls.floorSql = sql; return { rows: floors }; }
      throw new Error("unexpected query: " + sql.slice(0, 60));
    },
  };
}
const CLEAR = { projection: [{ date: "2026-03-11", balance: 2000 }], lowest: { date: "2026-03-11", balance: 2000 } };
function deps({ logged = true, recent = [] } = {}) {
  const sent = [], asked = [];
  return {
    sent, asked,
    forecast: async () => CLEAR,
    sendToAll: async (p) => { sent.push(p); return { logged }; },
    sendEmail: async () => { throw new Error("a floor alert sends no email"); },
    sentRecently: async (tag, h) => { asked.push([tag, h]); return recent.includes(tag); },
  };
}
const acct = (over = {}) => ({ id: 7, name: "Everyday Checking", balance: "180.25", floor: "250.00", balance_updated_at: hoursAgo(3), ...over });
const run = (pool, d) => ca.runCashAlerts(pool, { now: NOW, today: TODAY, deps: d });

beforeEach(() => ca._reset());

describe("runCashAlerts — per-account floors", () => {
  it("a balance below its floor pushes once with the exact text, push only", async () => {
    const pool = fakePool([acct()]);
    const d = deps();
    const r = await run(pool, d);
    assert.equal(r.status, "clear");
    assert.deepEqual(r.floors, { checked: 1, below: 1, notified: 1, unlogged: 0, stale: 0 });
    assert.deepEqual(d.sent, [{
      title: "Low balance: Everyday Checking",
      body: "Everyday Checking is at $180.25, below your $250.00 floor.",
      tag: "balance-floor-7", data: { url: "/dashboard" },
    }]);
    assert.deepEqual(d.asked, [["balance-floor-7", 24]]);
    assert.equal(pool.calls.updates[0].last_check.floors_below, 1);
    assert.equal(pool.calls.stamps[0], true);
  });

  it("at the floor is not below; a recent alert is not repeated; a stale balance is skipped", async () => {
    const d = deps({ recent: ["balance-floor-8"] });
    const r = await run(fakePool([
      acct({ id: 7, balance: "250.00" }),
      acct({ id: 8, balance: "10.00" }),
      acct({ id: 9, balance: "5.00", balance_updated_at: hoursAgo(40) }),
      acct({ id: 10, balance: "5.00", balance_updated_at: null }),
    ]), d);
    assert.deepEqual(r.floors, { checked: 4, below: 1, notified: 0, unlogged: 0, stale: 2 });
    assert.equal(d.sent.length, 0);
  });

  it("a negative balance is shown as -$X", async () => {
    const d = deps();
    await run(fakePool([acct({ balance: "-42.10", floor: "0" })]), d);
    assert.equal(d.sent[0].body, "Everyday Checking is at -$42.10, below your $0.00 floor.");
  });

  it("an unlogged floor push leaves the check unstamped (retried next tick) but saves the state", async () => {
    const pool = fakePool([acct()]);
    const r = await run(pool, deps({ logged: false }));
    assert.equal(r.status, "unlogged");
    assert.equal(r.floors.unlogged, 1);
    assert.equal(pool.calls.updates.length, 1, "the projection's state is still saved");
    assert.equal(pool.calls.stamps[0], false, "cash_alerts_checked_at not advanced");
  });

  it("the floor query reads only spendable accounts with a known balance", async () => {
    const pool = fakePool([]);
    const r = await run(pool, deps());
    assert.deepEqual(r.floors, { checked: 0, below: 0, notified: 0, unlogged: 0, stale: 0 });
    const sql = pool.calls.floorSql.replace(/\s+/g, " ");
    assert.match(sql, /la\.type = 'depository' AND NOT \(/);
    assert.match(sql, /COALESCE\(la\.available_balance, la\.current_balance\) IS NOT NULL/);
    assert.equal(pool.calls.updates[0].last_check.floors_below, 0);
  });

  it("off → no floor check either", async () => {
    let floorRead = false;
    const pool = { query: async (sql) => {
      if (/low_balance_floor/.test(sql)) floorRead = true;
      return { rows: [{ cash_alert_enabled: false }] };
    } };
    assert.equal((await run(pool, deps())).status, "disabled");
    assert.equal(floorRead, false);
  });
});

describe("PATCH /api/accounts/:id low_balance_floor", () => {
  const app = () => { const a = express(); a.use(express.json()); a.use(require("../teller/routes/enrollments")); return a; };

  it("400s a blank, non-numeric, negative or huge floor without touching the DB", async () => {
    dbModule.pool.query = async () => { throw new Error("should not reach the DB"); };
    for (const v of ["", "  ", "abc", -1, 1e8, true, [], {}]) {
      await supertest(app()).patch("/api/accounts/3").send({ low_balance_floor: v }).expect(400);
    }
  });

  it("stores a floor rounded to cents, only on a spendable account, and clears the off-for-today memo", async () => {
    const calls = [];
    dbModule.pool.query = async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: 3, low_balance_floor: "250.56" }] }; };
    let cleared = 0;
    const orig = ca.invalidate;
    ca.invalidate = () => { cleared++; };
    try {
      await supertest(app()).patch("/api/accounts/3").send({ low_balance_floor: "250.555" }).expect(200);
    } finally { ca.invalidate = orig; }
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /low_balance_floor = \$1 WHERE la\.id = \$2 AND la\.type = 'depository' AND NOT \(/);
    assert.deepEqual(calls[0].params, [250.56, "3"]);
    assert.equal(cleared, 1);
  });

  it("null clears the floor on any account (no type filter)", async () => {
    let sql, params;
    dbModule.pool.query = async (s, p) => { sql = s; params = p; return { rows: [{ id: 3 }] }; };
    await supertest(app()).patch("/api/accounts/3").send({ low_balance_floor: null }).expect(200);
    assert.deepEqual(params, [null, "3"]);
    assert.doesNotMatch(sql, /la\.type = 'depository'/);
  });

  it("a credit / investment account is a 400; a missing one a 404", async () => {
    dbModule.pool.query = async (sql) => (/^SELECT 1 FROM linked_accounts/.test(sql) ? { rows: [{ "?column?": 1 }] } : { rows: [] });
    const r = await supertest(app()).patch("/api/accounts/3").send({ low_balance_floor: 100 }).expect(400);
    assert.match(r.body.error, /checking or savings account/);
    dbModule.pool.query = async () => ({ rows: [] });
    await supertest(app()).patch("/api/accounts/99").send({ low_balance_floor: 100 }).expect(404);
  });

  it("APR edits don't clear the memo", async () => {
    dbModule.pool.query = async () => ({ rows: [{ id: 3 }] });
    let cleared = 0;
    const orig = ca.invalidate;
    ca.invalidate = () => { cleared++; };
    try {
      await supertest(app()).patch("/api/accounts/3").send({ apr: 5 }).expect(200);
    } finally { ca.invalidate = orig; }
    assert.equal(cleared, 0);
  });
});

describe("schema + GET /api/accounts", () => {
  it("the migration adds linked_accounts.low_balance_floor and GET /api/accounts returns it", () => {
    assert.match(read("teller/services/database.js"), /ALTER TABLE linked_accounts ADD COLUMN IF NOT EXISTS low_balance_floor NUMERIC\(12,2\)/);
    assert.match(read("teller/routes/enrollments.js"), /la\.monthly_payment, la\.low_balance_floor,/);
  });
  it("reset-fresh keeps linked_accounts (the floor survives a fresh start)", () => {
    const rf = require("../scripts/reset-fresh");
    assert.ok(rf.KEEP_TABLES.includes("linked_accounts"));
  });
});

describe("Settings UI — floors + last evaluation", () => {
  const src = read("teller/views/settings.ejs");
  const esc = (s) => (s == null ? "" : String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"));
  function loadUi(extra = {}) {
    const start = src.indexOf("var CASH_SKIP_REASONS");
    const end = src.indexOf("async function loadSettings()");
    assert.ok(start > 0 && end > start);
    const ctx = { esc, Date, isFinite, fmtDate: (d) => "D(" + d + ")", ...extra };
    vm.runInNewContext(src.slice(start, end), ctx);
    return ctx;
  }

  it("the section has the floor list and the last-check line", () => {
    assert.match(src, /<div id="cash-floor-list" class="desc"[^>]*>Loading…<\/div>/);
    assert.match(src, /<p class="desc" id="cash-alert-last" hidden><\/p>/);
    assert.match(src, /loadRecentErrors\(\); loadCashFloors\(\);/);
    assert.match(src, /renderCashAlertLast\(s\)/);
  });

  it("cashAlertLastText names each outcome", () => {
    const ui = loadUi();
    assert.equal(ui.cashAlertLastText({ cash_alert_enabled: false }), "");
    assert.equal(ui.cashAlertLastText({ cash_alert_enabled: true }), "Not checked yet — it runs after the next bank sync.");
    const at = "2026-03-10T15:00:00Z";
    const t = (lc) => ui.cashAlertLastText({ cash_alert_enabled: true, cash_alert_state: { last_check: { at, ...lc } } });
    assert.match(t({ outcome: "skipped", reason: "stale_balances" }), /: skipped — balances are more than 36 hours old\.$/);
    assert.match(t({ outcome: "skipped", reason: "no_balances" }), /: skipped — no checking or savings balance on file\.$/);
    assert.match(t({ outcome: "notified", breach_date: "2026-03-12" }), /: alert sent — cash projected below your floor on D\(2026-03-12\)\.$/);
    assert.match(t({ outcome: "held", breach_date: "2026-03-12" }), /still projected below your floor on D\(2026-03-12\) \(already alerted\)\.$/);
    assert.match(t({ outcome: "clear", floors_below: 2 }), /: no dip below your floor in the look-ahead · 2 account\(s\) below their floor\.$/);
    assert.match(t({ outcome: "clear", floors_below: 0 }), /look-ahead\.$/);
  });

  it("loadCashFloors lists only spendable accounts, escaped and labelled, and saves through PATCH", async () => {
    const handlers = [];
    const inputs = { "7": { value: "" }, "8": { value: "300" } };
    const el = {
      textContent: "", innerHTML: "",
      querySelectorAll: () => ["7", "8"].map((id) => ({ getAttribute: () => id, addEventListener: (_, fn) => handlers.push(fn) })),
      querySelector: (sel) => inputs[sel.match(/"(\d+)"/)[1]],
    };
    const calls = [], msgs = [];
    const ui = loadUi({
      document: { getElementById: () => el },
      apiFetch: async (url, opts) => {
        calls.push([url, opts && JSON.parse(opts.body)]);
        return { ok: true, json: async () => [
          { id: 7, name: "Joint <Checking>", mask: "1234", type: "depository", is_investment: false, low_balance_floor: "250.00" },
          { id: 8, name: "Savings", type: "depository", is_investment: false, low_balance_floor: null },
          { id: 9, name: "Card", type: "credit", is_investment: false },
          { id: 10, name: "Brokerage", type: "depository", is_investment: true },
        ] };
      },
      writeOk: async (r) => r.ok,
      parseAmountInput: (raw) => Number(String(raw).replace(/[$,]/g, "")),
      showMsg: (t, ok) => msgs.push([t, ok]),
    });
    await ui.loadCashFloors();
    assert.match(el.innerHTML, /Joint &lt;Checking&gt; ··1234/);
    assert.match(el.innerHTML, /aria-label="Low balance floor for Joint &lt;Checking&gt;"/);
    assert.match(el.innerHTML, /value="250" data-floor-input="7"/);
    assert.match(el.innerHTML, /data-floor-save="8"/);
    assert.doesNotMatch(el.innerHTML, /Card|Brokerage/);
    await handlers[0]();
    await handlers[1]();
    assert.deepEqual(calls.slice(1), [["/api/accounts/7", { low_balance_floor: null }], ["/api/accounts/8", { low_balance_floor: 300 }]]);
    assert.deepEqual(msgs, [["Floor removed.", true], ["Floor saved.", true]]);
    inputs["8"].value = "-5";
    await handlers[1]();
    assert.equal(calls.length, 3, "a negative floor is refused before the PATCH");
    assert.equal(msgs[2][1], false);
  });

  it("no spendable account → a plain note", async () => {
    const el = { textContent: "" };
    const ui = loadUi({
      document: { getElementById: () => el },
      apiFetch: async () => ({ ok: true, json: async () => [{ id: 9, type: "credit" }] }),
      writeOk: async (r) => r.ok,
    });
    await ui.loadCashFloors();
    assert.equal(el.textContent, "No checking or savings accounts yet.");
  });
});
