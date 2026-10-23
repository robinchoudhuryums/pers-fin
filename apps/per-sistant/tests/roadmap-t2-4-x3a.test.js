// ============================================================================
// Roadmap T2.4 X3a — unified search: the finance results
// ============================================================================
// GET /api/search over fake pools: standalone no Perfin query and no finance
// group; under the shell five read-only queries on perfinPool with the SAME
// escaped pattern (a "100%_x" query literal), each capped at 10, the
// transaction query on the display merchant / notes / category at the user's
// share (Perfin's own SPLIT_AMOUNT, newest first); each result's type, title,
// detail and url (a transaction: Activity with ?q= and its month); a failing
// query dropping only its results and logging once, a throw while building the
// SQL never rejecting; q over 200 characters a 400, a repeated q ignored. The
// dashboard widget's finance rows run in a vm (linked into Perfin through
// linkedAppHref, escaped, no inline actions, plain text without a safe link;
// a non-array reply "No results"). The two-database half is
// tests/contract/finance-search.
// ============================================================================
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("vm");
const express = require("express");
const supertest = require("supertest");

const fs = require("../routes/finance-search");
const { SPLIT_AMOUNT } = require("../../../teller/services/financial-queries");

const origError = console.error;
afterEach(() => { console.error = origError; });

// Per-sistant's own pool: every query empty.
const psPool = { query: async () => ({ rows: [] }) };
function perfinPool(rowsFor = {}, fail = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      const kind = /FROM transactions/.test(sql) ? "transactions" : /FROM detected_subscriptions/.test(sql) ? "subscriptions"
        : /FROM manual_bills/.test(sql) ? "bills" : /FROM financial_goals/.test(sql) ? "goals" : /FROM linked_accounts/.test(sql) ? "accounts" : "?";
      if (fail[kind]) throw new Error(fail[kind]);
      return { rows: rowsFor[kind] || [] };
    },
  };
}
function app(pfPool) {
  const a = express();
  if (pfPool) a.set("perfinPool", pfPool);
  a.use(require("../routes/search")({ pool: psPool }));
  return a;
}

const ROWS = {
  transactions: [
    { transaction_id: "t1", date: "2026-10-12", merchant: "Blue Bottle & Co", category: "Dining", amount: "12.00", share: "6.00", is_reimbursed: false, pending: false },
    { transaction_id: "t2", date: "2026-09-30", merchant: "Blue Bottle & Co", category: "Dining", amount: "40.00", share: "40.00", is_reimbursed: true, pending: true },
  ],
  subscriptions: [{ id: 3, display_name: "Netflix", amount: "15.49", cadence_days: 30, next_expected: "2026-11-02" }],
  bills: [{ id: 4, name: "Insurance", amount: "120.00", due_day: 31, cadence: "monthly", category: "insurance" }],
  goals: [{ id: 5, name: "House", target_amount: "60000.00", target_date: "2028-06-01" }],
  accounts: [{ id: 6, source: "linked", name: "Joint Checking", type: "depository", mask: "1234" }, { id: 7, source: "investment", name: "Brokerage", type: "brokerage", mask: null }],
};

describe("GET /api/search — finance group", () => {
  it("standalone: no Perfin query and no finance results", async () => {
    const r = (await supertest(app(null)).get("/api/search?q=rent").expect(200)).body;
    assert.deepEqual(r, []);
  });

  it("under the shell: five read-only queries with the escaped pattern, each capped at 10", async () => {
    const pf = perfinPool();
    await supertest(app(pf)).get("/api/search?q=" + encodeURIComponent("100%_x")).expect(200);
    assert.equal(pf.calls.length, 5);
    for (const c of pf.calls) {
      assert.deepEqual(c.params, ["%100\\%\\_x%"], "the same literal pattern");
      assert.match(c.sql, /^SELECT /, "read-only");
      assert.match(c.sql, /LIMIT 10\s*$/);
      assert.doesNotMatch(c.sql, /\b(INSERT|UPDATE|DELETE)\b/);
    }
  });

  it("transactions: display merchant / notes / category, the user's share via Perfin's SPLIT_AMOUNT, newest first", () => {
    const sql = fs.transactionSql();
    assert.ok(sql.includes(`${SPLIT_AMOUNT} AS share`), "the canonical share expression, imported");
    assert.match(sql, /WHERE COALESCE\(t\.user_merchant_name, t\.merchant_name, t\.name\) ILIKE \$1 OR t\.user_notes ILIKE \$1 OR COALESCE\(t\.user_category, t\.category\[1\]\) ILIKE \$1/);
    assert.match(sql, /LEFT JOIN linked_accounts la ON la\.account_id = t\.account_id/);
    assert.match(sql, /ORDER BY t\.date DESC, t\.id DESC/);
    assert.match(fs.SUBSCRIPTION_SQL, /is_active = true AND is_dismissed = false AND cancelled_at IS NULL/);
    assert.match(fs.BILL_SQL, /WHERE is_active = true/);
    assert.match(fs.GOAL_SQL, /WHERE is_active = true/);
    assert.match(fs.ACCOUNT_SQL, /NOT EXISTS \(SELECT 1 FROM investment_accounts ia WHERE ia\.plaid_account_id = la\.account_id AND ia\.is_active\)/, "no Plaid phantom twin");
  });

  it("each result names its type, a detail and the Perfin page that shows it", async () => {
    const r = (await supertest(app(perfinPool(ROWS))).get("/api/search?q=blue").expect(200)).body;
    assert.deepEqual(r.map((x) => [x.group, x.app, x.type, x.url]), [
      ["finance", "perfin", "transaction", "/transactions?q=Blue%20Bottle%20%26%20Co&month=2026-10"],
      ["finance", "perfin", "transaction", "/transactions?q=Blue%20Bottle%20%26%20Co&month=2026-09"],
      ["finance", "perfin", "subscription", "/subscriptions"],
      ["finance", "perfin", "bill", "/calendar"],
      ["finance", "perfin", "goal", "/goals"],
      ["finance", "perfin", "account", "/accounts/6/history?source=linked"],
      ["finance", "perfin", "account", "/accounts/7/history?source=investment"],
    ]);
    const d = r.map((x) => x.description);
    assert.equal(d[0], "$6.00 · your share of $12.00 · 2026-10-12 · Dining");
    assert.equal(d[1], "$40.00 · 2026-09-30 · Dining · reimbursed · pending");
    assert.equal(d[2], "$15.49 every 30 days · next 2026-11-02");
    assert.equal(d[3], "$120.00 monthly · due day 31 · insurance");
    assert.equal(d[4], "target $60,000.00 · by 2028-06-01");
    assert.equal(d[5], "depository · ··1234");
    assert.equal(d[6], "brokerage");
    assert.deepEqual(r.map((x) => x.id), ["t1", "t2", 3, 4, 5, "linked:6", "investment:7"]);
  });

  it("a failing query drops only its results and logs once; the Per-sistant results stay", async () => {
    const logs = [];
    console.error = (...a) => logs.push(a.join(" "));
    const pool = { query: async (sql) => ({ rows: /FROM todos/.test(sql) ? [{ id: 1, title: "Call bank", type: "todo" }] : [] }) };
    const a = express();
    a.set("perfinPool", perfinPool(ROWS, { transactions: "boom", goals: "bad" }));
    a.use(require("../routes/search")({ pool }));
    const r = (await supertest(a).get("/api/search?q=bank").expect(200)).body;
    assert.deepEqual(r.map((x) => x.type), ["todo", "subscription", "bill", "account", "account"]);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^finance search: transactions, goals failed: boom$/);
  });

  it("a throw while building the SQL is a failed query, never a rejection", async () => {
    console.error = () => {};
    const pf = { query: () => { throw new Error("sync throw"); } };
    assert.deepEqual(await fs.searchFinance(pf, "%x%"), []);
  });

  it("q over 200 characters is a 400; a repeated q or a short one returns nothing", async () => {
    const pf = perfinPool();
    const long = await supertest(app(pf)).get("/api/search?q=" + "a".repeat(201)).expect(400);
    assert.equal(long.body.error, "Search text must be 200 characters or fewer.");
    await supertest(app(pf)).get("/api/search?q=" + "a".repeat(200)).expect(200);
    assert.deepEqual((await supertest(app(pf)).get("/api/search?q=ab&q=cd").expect(200)).body, []);
    assert.deepEqual((await supertest(app(pf)).get("/api/search?q=a").expect(200)).body, []);
    assert.equal(pf.calls.length, 5, "only the 200-character query searched");
  });
});

describe("the dashboard widget's finance rows (emitted bundles in a vm)", () => {
  const JS = require("../views/js");
  const DASH = require("../pages/dashboard-script");
  function loadSearch(bases) {
    const a = JS.indexOf("function escAttr(");
    const h = JS.indexOf("function linkedAppHref(");
    const hEnd = JS.indexOf("\n}\n", h) + 3;
    const s = DASH.indexOf("function doSearch(q) {");
    const sEnd = DASH.indexOf("\n}\n", s) + 3;
    assert.ok(a >= 0 && h > 0 && s > 0);
    const el = { style: {}, innerHTML: "" };
    let pending = null;
    let reply = [];
    const ctx = {
      window: { LINKED_APP_BASES: bases }, BP: "/per-sistant", searchTimeout: null, el,
      document: { getElementById: () => el },
      clearTimeout() {}, setTimeout(fn) { pending = fn; },
      fetch: async () => ({ json: async () => reply }),
    };
    vm.runInNewContext(
      "function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}" +
      JS.slice(a, JS.indexOf("\n", a) + 1) + JS.slice(h, hEnd) + DASH.slice(s, sEnd), ctx);
    return {
      el,
      async search(q, results) { reply = results; ctx.doSearch(q); await pending(); return el.innerHTML; },
    };
  }
  const finance = (extra) => ({ group: "finance", app: "perfin", type: "transaction", id: "t1", title: "Blue <b>Bottle</b>", description: "$6.00 · 2026-10-12", url: "/transactions?q=Blue&month=2026-10", ...extra });

  it("a finance result links into Perfin through its mount, escaped, with no inline actions", async () => {
    const w = loadSearch({ perfin: "/perfin" });
    const html = await w.search("blue", [finance()]);
    assert.ok(html.startsWith('<a href="/perfin/transactions?q=Blue&amp;month=2026-10" class="result-item"'));
    assert.ok(html.includes('<div class="result-type">transaction · Perfin</div>'));
    assert.ok(html.includes("Blue &lt;b&gt;Bottle&lt;/b&gt;"));
    assert.ok(!html.includes("data-action"), "no inline actions");
    assert.ok(!html.includes("target="));
  });

  it("an unsafe url or no usable base renders plain text; a non-array reply reads as no results", async () => {
    const w = loadSearch({ perfin: "/perfin" });
    for (const url of ["javascript:alert(1)", "//evil.example", "goals"]) {
      const html = await w.search("blue", [finance({ url })]);
      assert.match(html, /^<div class="result-item">/, url);
      assert.ok(!html.includes("href"));
    }
    assert.match(await loadSearch({ perfin: "" }).search("blue", [finance()]), /^<div class="result-item">/);
    assert.equal(await w.search("blue", { error: "Search text must be 200 characters or fewer." }), '<div class="empty-msg">No results</div>');
    assert.equal(await w.search("blue", null), '<div class="empty-msg">No results</div>', "a null reply doesn't throw");
  });

  it("Per-sistant results keep their own links and actions", async () => {
    const w = loadSearch({ perfin: "/perfin" });
    const html = await w.search("call", [{ id: 1, type: "todo", title: "Call bank", completed: false }]);
    assert.ok(html.startsWith('<a href="/per-sistant/todos"'));
    assert.ok(html.includes('data-action="search-complete"'));
  });
});
