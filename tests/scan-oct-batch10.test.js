// ============================================================================
// Broad-scan (Oct 2026, cycle 7) Batch 10 — Perfin UI correctness and a11y
// ============================================================================
// The budget upsert keeping rollover / one-time settings (F39) is also pinned
// against real Postgres in tests/contract/ui-writes.contract.test.js. The
// Settings / Subscriptions label scan (F101) extends IF-3 in
// tests/scan-sept-batch13.test.js. This file covers:
// F91   the dashboard charts read /api/spending-summary; local month labels
// F94   the nav wraps between 641 and 960px
// F95   the calendar grid columns are minmax(0, 1fr)
// F96   one dashboard widget list shared by Settings and the dashboard
// F97   prompt amounts go through parseAmountInput
// F98   goal + credit-score dates read as calendar days
// F99   the listed writes report failures
// F100  the Add forms open on the first click
// F102  the session-expiry redirect keeps return_to
// F103  the Split modal stops when it can't read the splits; keeps merchant_name
// F104  one style attribute on paid Upcoming Bills rows
// F105  a manual loan is shown as owed
// F106  error text is escaped
// F107  the service worker's cache key and what it stores
// F108  failed loads replace "Loading..."
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

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
afterEach(() => { dbModule.pool.query = originalQuery; });

const dash = read("teller", "views", "dashboard.ejs");
const shared = read("teller", "public", "perfin-shared.js");
const settings = read("teller", "views", "settings.ejs");

// ---------------------------------------------------------------------------
describe("F91 — the dashboard charts", () => {
  // Run the real loadCharts against a canned spending summary and a fake Chart.
  async function runCharts(summary) {
    const start = dash.indexOf("    async function loadCharts() {");
    const end = dash.indexOf("  </script>", start);
    const charts = [];
    class Chart { constructor(ctx, cfg) { charts.push({ id: ctx.id, cfg }); } }
    Chart.defaults = {};
    const el = (id) => ({ id, parentElement: {} });
    const document = { documentElement: { getAttribute: () => "dark" }, getElementById: el };
    // eslint-disable-next-line no-new-func
    const loadCharts = new Function("getSpendingSummary", "Chart", "document", "window", "apiFetch",
      dash.slice(start, end) + "\nreturn loadCharts;")(async () => summary, Chart, document, { innerWidth: 1200 },
      () => { throw new Error("charts must not fetch raw transactions"); });
    await loadCharts();
    return charts;
  }

  it("draws the spending summary's (filtered, split-adjusted) totals, oldest first", async () => {
    const charts = await runCharts({
      monthly_trend: [{ month: "2026-10", total_spend: "120.50" }, { month: "2026-09", total_spend: "900" }],
      by_category: [{ category: "Dining", total: "300" }, { category: "Groceries", total: "250.5" }],
    });
    const trend = charts.find((c) => c.id === "trend-chart");
    assert.deepEqual(trend.cfg.data.datasets[0].data, [900, 120.5]);
    const cat = charts.find((c) => c.id === "category-chart");
    assert.deepEqual(cat.cfg.data.labels, ["Dining", "Groceries"]);
    assert.doesNotMatch(dash, /\/api\/transactions\?months=6/);
  });

  it("month labels are the month itself west of UTC (not the month before)", async () => {
    const prev = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const charts = await runCharts({ monthly_trend: [{ month: "2026-09", total_spend: "1" }], by_category: [] });
      const label = charts.find((c) => c.id === "trend-chart").cfg.data.labels[0];
      assert.match(label, /Sep/, label);
    } finally {
      if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
    }
  });

  it("F108: a failed spending load replaces the four tables' Loading rows", () => {
    const body = dash.slice(dash.indexOf("async function loadSpendingSummary()"), dash.indexOf("async function syncTransactions()"));
    assert.match(body, /\['monthly-body', 4\], \['category-body', 3\], \['merchant-body', 3\], \['upcoming-body', 3\]/);
    assert.match(body, /Could not load spending data\./);
  });
});

// ---------------------------------------------------------------------------
describe("F94 / F95 — layout", () => {
  it("the nav wraps; between 641 and 960px the links take their own row", () => {
    const css = read("teller", "public", "perfin-shared.css");
    assert.match(css, /\.topnav \{ flex-wrap: wrap; row-gap: 10px; \}/);
    assert.match(css, /@media \(min-width: 641px\) and \(max-width: 960px\) \{\s*\.topnav \.nav-links \{ order: 10; flex-basis: 100%; flex-wrap: wrap;/);
  });
  it("the calendar's day columns can't be widened by a long event name", () => {
    const cal = read("teller", "views", "calendar.ejs");
    assert.equal((cal.match(/grid-template-columns: repeat\(7, minmax\(0, 1fr\)\)/g) || []).length, 2);
    assert.doesNotMatch(cal, /repeat\(7, 1fr\)/);
    assert.match(cal, /\.month-nav \{ display: flex; flex-wrap: wrap;/);
  });
});

// ---------------------------------------------------------------------------
describe("F96 — one dashboard widget list", () => {
  const start = shared.indexOf("  var DASHBOARD_WIDGETS = [");
  const end = shared.indexOf("];", start) + 2;
  const ctx = {};
  vm.runInNewContext(shared.slice(start, end) + "this.W = DASHBOARD_WIDGETS;", ctx);
  const W = ctx.W;

  it("every widget's selector exists on the dashboard", () => {
    for (const w of W) {
      const sel = w.selector;
      let found;
      if (sel.startsWith("#")) found = dash.includes(`id="${sel.slice(1)}"`);
      else if (sel.startsWith(".")) found = dash.includes(`class="${sel.slice(1)}"`);
      else found = dash.includes(sel.replace(/^\[|\]$/g, ""));
      assert.ok(found, `${w.key}: ${sel}`);
    }
  });

  it("covers the documented keys and every default the settings route returns", () => {
    const keys = W.map((w) => w.key);
    for (const k of ["whatsNew", "investmentReturns", "settlement", "monthlySpend", "calendar"]) assert.ok(keys.includes(k), k);
    const defaults = read("teller", "routes", "settings.js").match(/dashboard_widgets: \{([^}]*)\}/)[1];
    for (const k of defaults.split(",").map((p) => p.split(":")[0].trim())) assert.ok(keys.includes(k), k);
  });

  it("Settings renders from it and the dashboard hides by class through it", () => {
    assert.match(settings, /window\.DASHBOARD_WIDGETS\.map\(/);
    assert.doesNotMatch(settings, /WIDGET_LABELS/);
    assert.match(dash, /applyDashboardWidgets\(s\.dashboard_widgets \|\| \{\}\);/);
    assert.match(read("teller", "public", "perfin-shared.css"), /\.widget-off \{ display: none !important; \}/);
    // A switched-off key adds the class; anything else removes it.
    const fnStart = shared.indexOf("  function applyDashboardWidgets(");
    const fnEnd = shared.indexOf("\n  }\n", fnStart) + 4;
    const els = {};
    const mk = () => { const set = new Set(); return { classList: { toggle: (c, on) => (on ? set.add(c) : set.delete(c)), has: (c) => set.has(c) } }; };
    const document = { querySelectorAll: (sel) => [(els[sel] = els[sel] || mk())] };
    const c2 = { document };
    vm.runInNewContext(shared.slice(start, end) + shared.slice(fnStart, fnEnd) + "this.apply = applyDashboardWidgets;", c2);
    c2.apply({ whatsNew: false, ask: true });
    assert.equal(els["#whats-new-widget"].classList.has("widget-off"), true);
    assert.equal(els["#ask-section"].classList.has("widget-off"), false);
  });
});

// ---------------------------------------------------------------------------
describe("F97 / F98 / F99 / F100 — page writes and dates", () => {
  it("F97: the budget and manual-balance prompts parse the whole amount", () => {
    const b = read("teller", "views", "budgets.ejs");
    assert.match(b, /var limit = parseAmountInput\(val\);/);
    assert.doesNotMatch(b, /monthly_limit: parseFloat\(val\)/);
    const a = read("teller", "views", "accounts.ejs");
    const upd = a.slice(a.indexOf("async function updateManualBalance"), a.indexOf("async function updateManualBalance") + 900);
    assert.match(upd, /var num = parseAmountInput\(val\);/);
  });

  it("F98: goal and credit-score dates are read as calendar days", () => {
    const g = read("teller", "views", "goals.ejs");
    assert.match(g, /parseCalDate\(g\.estimated_date\)/);
    assert.match(g, /parseCalDate\(g\.target_date\)/);
    assert.match(dash, /parseCalDate\(s\.checked_at\)/);
    assert.doesNotMatch(dash, /new Date\(s\.checked_at\)/);
  });

  it("F99: push subscribe, Remember, Review Apply, insights and housing generate report failures", () => {
    assert.match(settings, /if \(await writeOk\(subRes, 'Could not enable push'\)\)/);
    assert.match(settings, /else await newSub\.unsubscribe\(\)/);
    assert.match(settings, /data\.modules_failed \|\| \[\]\)\.length/);
    assert.match(settings, /data\.summary_status && data\.summary_status !== 'updated'/);
    assert.match(read("teller", "public", "transactions.js"), /writeOk\(ruleRes, 'Category updated, but not remembered'\)/);
    assert.match(dash, /writeOk\(res, 'Could not apply the category'\)/);
    assert.match(dash, /result\.rule_error/);
    const hz = read("teller", "views", "housing.ejs");
    assert.doesNotMatch(hz, /housing\/generate', \{ method:'POST' \}\)\.catch\(function\(\)\{\}\)/);
    assert.match(hz, /writeOk\(gen, /);
  });

  it("F100: the Add forms read the computed display", () => {
    assert.match(read("teller", "views", "budgets.ejs"), /getComputedStyle\(f\)\.display === 'none'/);
    assert.match(read("teller", "views", "subscriptions.ejs"), /getComputedStyle\(form\)\.display === 'none'/);
  });
});

// ---------------------------------------------------------------------------
describe("F39 — budget rollover and one-time budgets", () => {
  function app() { const a = express(); a.use(express.json()); a.use(require("../teller/routes/budgets")); return a; }

  it("re-saving a category without the fields keeps its rollover / type / notes", async () => {
    const calls = [];
    dbModule.pool.query = async (sql, p) => { calls.push({ sql, p }); return { rows: [{ id: 1 }] }; };
    await supertest(app()).post("/api/budgets").send({ category: "Dining", monthly_limit: 300 }).expect(200);
    const ins = calls.find((c) => /INSERT INTO budgets/.test(c.sql));
    assert.match(ins.sql, /rollover_enabled = COALESCE\(\$4::boolean, budgets\.rollover_enabled\)/);
    assert.match(ins.sql, /budget_type = COALESCE\(\$5::text, budgets\.budget_type\)/);
    assert.match(ins.sql, /notes = COALESCE\(\$3, budgets\.notes\)/);
    assert.deepEqual(ins.p, ["Dining", 300, null, null, null, null]);
  });

  it("sent fields are stored; a bad type or month is a 400", async () => {
    const calls = [];
    dbModule.pool.query = async (sql, p) => { calls.push({ sql, p }); return { rows: [{ id: 1 }] }; };
    await supertest(app()).post("/api/budgets").send({ category: "Gifts", monthly_limit: 200, budget_type: "one_time", effective_month: "2026-12", rollover_enabled: false }).expect(200);
    assert.deepEqual(calls[0].p.slice(3), [false, "one_time", "2026-12"]);
    await supertest(app()).post("/api/budgets").send({ category: "x", monthly_limit: 1, budget_type: "weekly" }).expect(400);
    await supertest(app()).post("/api/budgets").send({ category: "x", monthly_limit: 1, budget_type: "one_time", effective_month: "2026-13" }).expect(400);
  });

  it("the Budgets page has the type / month / rollover controls and a rollover toggle", () => {
    const b = read("teller", "views", "budgets.ejs");
    assert.match(b, /<select id="b-type">/);
    assert.match(b, /<input id="b-month" type="month">/);
    assert.match(b, /<input id="b-rollover" type="checkbox"/);
    assert.match(b, /data-action="rollover"/);
    assert.match(b, /body: JSON\.stringify\(\{ rollover_enabled: !on \}\)/);
  });
});

// ---------------------------------------------------------------------------
describe("F101–F108 — per-item fixes", () => {
  it("F101: the Goals link picker and the investment remove button are named", () => {
    assert.match(read("teller", "views", "goals.ejs"), /'<select aria-label="Account to fund this goal"/);
    assert.match(dash, /class="inv-remove"[^\n]*\n[^\n]*aria-label="Remove ' \+ esc\(a\.name\)/);
  });

  it("F102: the expiry redirect carries the page as return_to", () => {
    assert.match(shared, /win\.location\.href = '\/login\?return_to=' \+ encodeURIComponent\(win\.location\.pathname \+ win\.location\.search\);/);
  });

  it("F103: the Split modal stops on a failed read and keeps merchant_name", () => {
    const tx = read("teller", "public", "transactions.js");
    assert.match(tx, /if \(!\(await writeOk\(r, 'Could not load this transaction\\'s splits'\)\)\) return;/);
    assert.match(tx, /merchant_name: x\.merchant_name \|\| null/);
    assert.doesNotMatch(tx, /if \(r\.ok\) existing = /);
  });

  it("F104: a paid Upcoming Bills row has one style attribute", () => {
    assert.doesNotMatch(dash, /'<div' \+ paid \+ ' style=/);
    assert.match(dash, /'<div style="' \+ paid \+ 'display:flex;/);
  });

  it("F105: a manual loan is shown as owed (not red since design D2)", () => {
    assert.match(read("teller", "views", "accounts.ejs"), /var isDebt = a\.type === 'credit' \|\| a\.type === 'loan';/);
  });

  it("F106: the accuracy panel escapes error text", () => {
    assert.match(settings, /esc\(d\.error \|\| 'Failed to load sample'\)/);
    assert.match(settings, /\+ esc\(e\.message\) \+ '<\/div>'; \}/);
  });

  it("F107: the service worker keys by path and never stores a redirect or stray HTML", () => {
    const src = read("teller", "public", "sw.js");
    const ctx = vm.createContext({
      self: { location: { href: "https://host/perfin/sw.js", origin: "https://host" }, addEventListener: () => {} },
      URL, Response, Headers, Promise,
    });
    vm.runInContext(src + "\nthis.cacheKey = cacheKey; this.shouldCache = shouldCache;", ctx);
    assert.equal(ctx.cacheKey(new URL("https://host/perfin/perfin-shared.js?v=12")), "https://host/perfin/perfin-shared.js");
    const res = (type, extra) => Object.assign({ ok: true, type: "basic", redirected: false, headers: new Headers({ "content-type": type }) }, extra);
    assert.equal(ctx.shouldCache({ mode: "no-cors" }, res("application/javascript")), true);
    assert.equal(ctx.shouldCache({ mode: "no-cors" }, res("text/html; charset=utf-8")), false, "login HTML under an asset URL");
    assert.equal(ctx.shouldCache({ mode: "navigate" }, res("text/html")), true);
    assert.equal(ctx.shouldCache({ mode: "navigate" }, res("text/html", { redirected: true })), false);
    assert.equal(ctx.shouldCache({ mode: "no-cors" }, res("text/css", { ok: false })), false);
  });

  it("F108: AI usage says when it couldn't load", () => {
    assert.match(settings, /Could not load AI usage \(HTTP ' \+ res\.status \+ '\)\./);
    assert.match(settings, /sumEl\.textContent = 'Could not load AI usage: ' \+ e\.message;/);
  });
});
