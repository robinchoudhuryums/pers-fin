// Design pass D7 — the landing page's status lines and the phone polish
// (`.cycle/plan-design-ux.md`, decisions 13 and 14).
// - landingStatus (shell/landing-status.js) over injected readers: both lines,
//   each line fail-soft, a slow read timed out, nothing when both fail, no pool →
//   no read; the Perfin line from Perfin's own gatherDashboardSummary (parts rent /
//   bills / uncategorized only) and the Per-sistant line from taskDueCounts;
// - gatherDashboardSummary's parts option reading only the named parts;
// - taskDueCounts' SQL over a fake pool;
// - landing.ejs rendered with and without lines (escaped), and the shell route;
// - the phone drawer's Tax link: January to April only (the nav script run in a
//   vm with the real taxSeason), never in the desktop top nav;
// - the Activity page's Filters toggle beside "+ Add cash transaction" at the
//   button height.
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
function slice(src, start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, "slice markers: " + start);
  return src.slice(i, j);
}

const { landingStatus, perfinLine, persistentLine, TIMEOUT_MS } = require("../shell/landing-status");

const summary = (items, errors = []) => ({ attention: { items, errors } });
const RENT = { kind: "rent", text: "Owed to Sam Lee", amount: 1850, count: 2, href: "/housing" };
const BILLS = { kind: "bills", text: "3 bills due in the next 7 days", amount: 120.5, count: 3, href: "/calendar" };
const UNCAT = { kind: "uncategorized", text: "5 transactions to categorize", count: 5, href: "/dashboard#review-queue-section" };

function quietly(fn) {
  const warn = console.warn;
  const lines = [];
  console.warn = (...a) => lines.push(a.join(" "));
  return Promise.resolve().then(fn).finally(() => { console.warn = warn; }).then((v) => ({ v, lines }));
}

describe("the status lines (decision 13)", () => {
  it("Perfin: rent, bills and the review count, from the summary's attention items", () => {
    assert.equal(perfinLine(summary([RENT, BILLS, UNCAT])), "$1,850.00 owed to Sam Lee · 3 bills due this week · 5 to review");
    assert.equal(perfinLine(summary([{ ...BILLS, count: 1 }])), "1 bill due this week");
    assert.equal(perfinLine(summary([])), "Nothing needs attention");
    assert.equal(perfinLine(summary([], [{ source: "rent", error: "x" }])), null, "a failed source never reads as 'nothing'");
    assert.equal(perfinLine(summary([UNCAT], [{ source: "bills", error: "x" }])), "5 to review", "what was read still shows");
    assert.equal(perfinLine(null), null);
    assert.equal(perfinLine({}), null);
  });

  it("Per-sistant: tasks due today and overdue", () => {
    assert.equal(persistentLine({ due_today: 2, overdue: 1 }), "2 tasks due today · 1 overdue");
    assert.equal(persistentLine({ due_today: 1, overdue: 0 }), "1 task due today · 0 overdue");
    assert.equal(persistentLine({ due_today: 0, overdue: 0 }), "Nothing due today");
    assert.equal(persistentLine(null), null);
  });

  it("landingStatus reads Perfin's summary (three parts only) and Per-sistant's counts from the wired pools", async () => {
    const perfinPool = { name: "perfin" };
    const persistentPool = { name: "persistent" };
    const calls = [];
    const status = await landingStatus({
      perfinPool,
      persistentPool,
      deps: {
        gatherDashboardSummary: async (db, opts) => { calls.push(["summary", db, opts]); return summary([RENT]); },
        taskDueCounts: async (db) => { calls.push(["counts", db]); return { due_today: 3, overdue: 2 }; },
      },
    });
    assert.deepEqual(status, { perfin: "$1,850.00 owed to Sam Lee", persistent: "3 tasks due today · 2 overdue" });
    assert.deepEqual(calls, [
      ["summary", perfinPool, { parts: ["rent", "bills", "uncategorized"] }],
      ["counts", persistentPool],
    ]);
    assert.equal(TIMEOUT_MS, 1500);
  });

  it("each line is fail-soft: a throw (sync or async) leaves only that line out", async () => {
    let r = await quietly(() => landingStatus({
      perfinPool: {}, persistentPool: {},
      deps: { gatherDashboardSummary: () => { throw new Error("boom"); }, taskDueCounts: async () => ({ due_today: 1, overdue: 0 }) },
    }));
    assert.deepEqual(r.v, { perfin: null, persistent: "1 task due today · 0 overdue" });
    assert.match(r.lines.join("\n"), /perfin failed: boom/);
    r = await quietly(() => landingStatus({
      perfinPool: {}, persistentPool: {},
      deps: { gatherDashboardSummary: async () => summary([]), taskDueCounts: async () => { throw new Error("db down"); } },
    }));
    assert.deepEqual(r.v, { perfin: "Nothing needs attention", persistent: null });
  });

  it("a slow read is cut off at the budget; the other line still shows", async () => {
    const t0 = Date.now();
    const r = await quietly(() => landingStatus({
      perfinPool: {}, persistentPool: {}, timeoutMs: 30,
      deps: {
        gatherDashboardSummary: () => new Promise((res) => setTimeout(() => res(summary([RENT])), 300)),
        taskDueCounts: async () => ({ due_today: 0, overdue: 4 }),
      },
    }));
    assert.ok(Date.now() - t0 < 250, "didn't wait for the slow read");
    assert.deepEqual(r.v, { perfin: null, persistent: "0 tasks due today · 4 overdue" });
    assert.match(r.lines.join("\n"), /perfin took longer than 30ms/);
  });

  it("nothing when both fail, and no read without a pool", async () => {
    const r = await quietly(() => landingStatus({
      perfinPool: {}, persistentPool: {},
      deps: { gatherDashboardSummary: async () => { throw new Error("a"); }, taskDueCounts: () => Promise.reject(new Error("b")) },
    }));
    assert.deepEqual(r.v, { perfin: null, persistent: null });
    let read = 0;
    const none = await landingStatus({ deps: { gatherDashboardSummary: () => { read++; }, taskDueCounts: () => { read++; } } });
    assert.deepEqual(none, { perfin: null, persistent: null });
    assert.equal(read, 0);
  });
});

describe("gatherDashboardSummary's parts option", () => {
  const { gatherDashboardSummary, PARTS } = require("../teller/routes/dashboard-summary");
  function deps(called) {
    const mark = (k, v) => async () => { called.push(k); return v; };
    return {
      todayStr: () => "2026-10-27",
      getBudgetStatus: mark("spending", []),
      getCashFlowForecast: mark("cash", {}),
      getBillsDue: mark("bills", [{ amount: 10 }, { amount: 5 }]),
      getHousingOwed: mark("rent", { configured: true, payee: "Sam", balance: 100, unpaid_count: 1 }),
      countUncategorized: mark("uncategorized", 4),
      gatherDataHealth: mark("sync_health", { issues: [{ severity: "warning" }] }),
    };
  }
  const pool = { query: async () => { throw new Error("net worth isn't asked for"); } };

  it("reads only the named parts and leaves the others out", async () => {
    const called = [];
    const out = await gatherDashboardSummary(pool, { parts: ["rent", "bills", "uncategorized"], deps: deps(called) });
    assert.deepEqual(called.sort(), ["bills", "rent", "uncategorized"]);
    assert.deepEqual(Object.keys(out).sort(), ["attention", "month", "today"]);
    assert.deepEqual(out.attention.items.map((i) => i.kind), ["rent", "bills", "uncategorized"]);
    assert.deepEqual(out.attention.errors, []);
  });

  it("without parts every part is read, as before", async () => {
    const called = [];
    const quiet = console.error;
    console.error = () => {};
    try {
      const out = await gatherDashboardSummary(pool, { deps: deps(called) });
      assert.deepEqual(called.sort(), PARTS.filter((p) => p !== "net_worth").sort());
      assert.equal(out.net_worth.ok, false, "net worth read (and failed on this pool)");
      assert.ok("spending" in out && "cash" in out);
      assert.equal(out.attention.items.length, 4);
    } finally {
      console.error = quiet;
    }
  });
});

describe("taskDueCounts (Per-sistant)", () => {
  const { taskDueCounts } = require("../apps/per-sistant/routes/settings");
  it("counts open, untrashed tasks due today and before today, separately", async () => {
    let seen;
    const pool = { query: async (sql, params) => { seen = { sql, params }; return { rows: [{ due_today: "2", overdue: 5 }] }; } };
    assert.deepEqual(await taskDueCounts(pool, "2026-10-27"), { due_today: 2, overdue: 5 });
    assert.deepEqual(seen.params, ["2026-10-27"]);
    assert.match(seen.sql, /due_date = \$1::date/);
    assert.match(seen.sql, /due_date < \$1::date/);
    assert.match(seen.sql, /deleted_at IS NULL AND NOT completed/);
    assert.deepEqual(await taskDueCounts({ query: async () => ({ rows: [] }) }, "2026-10-27"), { due_today: 0, overdue: 0 });
  });
});

describe("the landing page", () => {
  const ejs = require("ejs");
  const render = (locals) => new Promise((resolve, reject) =>
    ejs.renderFile(path.join(ROOT, "shell", "views", "landing.ejs"), locals, (err, out) => (err ? reject(err) : resolve(out))));

  it("shows each tile's line, escaped, under its description", async () => {
    const html = await render({ status: { perfin: "$5.00 owed to <b>Sam</b>", persistent: "1 task due today · 0 overdue" } });
    assert.match(html, /<p>Personal finance, transactions, and AI insights\.<\/p>\s*<p class="tile-status">\$5\.00 owed to &lt;b&gt;Sam&lt;\/b&gt;<\/p>/);
    assert.match(html, /<p>Tasks, notes, scheduled emails\.<\/p>\s*<p class="tile-status">1 task due today · 0 overdue<\/p>/);
  });

  it("keeps just the description when a line is missing, or with no status at all", async () => {
    let html = await render({ status: { perfin: null, persistent: "Nothing due today" } });
    assert.equal((html.match(/class="tile-status"/g) || []).length, 1);
    html = await render({});
    assert.doesNotMatch(html, /tile-status/);
  });

  it("the shell route reads both wired pools and the line is styled", () => {
    const shell = read("shell/index.js");
    assert.match(shell, /const \{ landingStatus \} = require\("\.\/landing-status"\);/);
    assert.match(shell, /app\.get\("\/", async \(_req, res, next\) => \{[\s\S]{0,200}landingStatus\(\{ perfinPool: perfin\.pool, persistentPool: persistent\.pool \}\)[\s\S]{0,80}res\.render\("landing", \{ status \}\)/);
    assert.ok(shell.indexOf("app.use(auth.requireAuth)") < shell.indexOf('app.get("/", async'), "behind the auth gate");
    assert.match(read("shell/public/landing.css"), /\.tile p\.tile-status \{/);
    // The module reads through each app's own functions, never an HTTP self-fetch.
    const mod = read("shell/landing-status.js");
    assert.doesNotMatch(mod, /fetch\(|http:\/\/|localhost/);
  });
});

describe("the phone drawer's Tax link (decision 14)", () => {
  const nav = read("teller/views/partials/nav.ejs");
  const shared = read("teller/public/perfin-shared.js");

  it("sits after Rent, hidden until the script shows it, and never in the desktop top nav", () => {
    assert.match(nav, />Rent<\/a>\s*<%#[^%]*%>\s*<a href="<%= __basePath %>\/tax" id="nav-tax-link" class="nav-tax-link[^"]*"[^>]*\bhidden>Tax<\/a>/);
    assert.match(read("teller/public/perfin-shared.css"), /@media \(min-width: 641px\) \{ \.topnav \.nav-links \.nav-tax-link \{ display: none; \} \}/);
  });

  function runNav(today) {
    const link = { hidden: true };
    const ctx = { window: {}, document: { getElementById: (id) => (id === "nav-tax-link" ? link : null) } };
    vm.runInNewContext(slice(shared, "function taxSeason(today)", "function localDateStr(d)") + "window.taxSeason = taxSeason;", ctx);
    ctx.window.localTodayStr = () => today;
    ctx.whenShared = (fn) => fn();
    vm.runInNewContext(slice(nav, "    whenShared(function() {\n      var link = document.getElementById('nav-tax-link');", "    // Populate the \"Last synced"), ctx);
    return link.hidden;
  }

  it("is shown January to April only", () => {
    for (const d of ["2027-01-01", "2027-02-15", "2027-04-30"]) assert.equal(runNav(d), false, d);
    for (const d of ["2026-05-01", "2026-10-27", "2026-12-31"]) assert.equal(runNav(d), true, d);
  });
});

describe("the Activity page's Filters toggle", () => {
  const view = read("teller/views/transactions.ejs");
  it("sits in one row with '+ Add cash transaction', both at the touch height on a phone", () => {
    assert.match(view, /<div class="txn-actions">\s*<button type="button" class="btn btn-sm" id="add-cash-btn">\+ Add cash transaction<\/button>\s*<button type="button" class="btn btn-sm filters-toggle" id="filters-toggle"/);
    assert.match(view, /\.txn-actions \{ display: flex; flex-wrap: wrap; align-items: center; gap: 8px;/);
    const phone = slice(view, "@media (max-width: 640px) {", ".search-bar { display: none !important; }");
    assert.match(phone, /\.filters-toggle \{ display: inline-flex; align-items: center; justify-content: center; \}/);
    assert.match(phone, /\.txn-actions \.btn \{ min-height: var\(--btn-h-touch\); \}/);
    assert.doesNotMatch(view, /id="add-cash-btn" style=/, "no per-button margin left to offset it");
  });

  it("the page renders through EJS", async () => {
    const ejs = require("ejs");
    for (const basePath of ["", "/perfin"]) {
      const html = await new Promise((resolve, reject) =>
        ejs.renderFile(path.join(ROOT, "teller", "views", "transactions.ejs"), { nonce: "n", v: "1", basePath, activePage: "transactions" },
          (err, out) => (err ? reject(err) : resolve(out))));
      assert.match(html, /id="nav-tax-link"/);
      assert.match(html, /class="txn-actions"/);
    }
  });
});
