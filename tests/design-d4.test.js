// Design pass D4 (Perfin dashboard, part 2: order and density) —
// `.cycle/plan-design-ux.md`, decisions 6, 7 and 15.
// - the decision-6 order on the page, and DASHBOARD_WIDGETS in that same order
//   (so Settings lists the toggles as they appear);
// - the pyramid below the charts, collapsible, collapsed by default on a phone
//   until it's opened once; its mode tabs one scrollable row;
// - Cash Flow (the lowest day first, 4 weeks + "Show all", "—" for a $0 income
//   or bills cell) and Savings Rate (the latest month + "Show all");
// - the trend chart: a sentence until 3 months of history, the empty state at 0.
// Everything runs the real code from dashboard.ejs / perfin-shared.js in a vm.
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
function slice(src, start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, "slice markers: " + start);
  return src.slice(i, j);
}
const dash = read("teller", "views", "dashboard.ejs");
const shared = read("teller", "public", "perfin-shared.js");

function widgets() {
  const ctx = {};
  vm.runInNewContext(slice(shared, "  var DASHBOARD_WIDGETS = [", "  ];\n") + "  ];\nthis.W = DASHBOARD_WIDGETS;", ctx);
  return ctx.W;
}
// Where a widget's selector first appears in the page markup (the body, not the CSS).
const body = dash.slice(dash.indexOf("<%- include('partials/nav'"));
function posOf(sel) {
  let re;
  if (sel.startsWith("#")) re = new RegExp(`id="${sel.slice(1)}"`);
  else if (sel.startsWith(".")) re = new RegExp(`class="(?:[^"]* )?${sel.slice(1)}(?: [^"]*)?"`);
  else re = new RegExp(sel.replace(/^\[|\]$/g, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const m = re.exec(body);
  return m ? m.index : -1;
}

describe("decision 6 — the dashboard order", () => {
  it("the page follows the decision-6 order", () => {
    const order = [
      'id="dash-summary"',            // 1. Summary + Needs attention
      'id="sync-health-strip"',       // 2. the sync strip
      'id="whats-new-widget"',        // 3. Since you last looked
      'id="review-queue-section"',    // 4. Review Uncategorized
      'id="advice-section"',          // 4b. Your plan (roadmap T4.1 A2 — after the summary, before the charts)
      'class="charts-grid"',          // 5. the two charts
      'id="accounts-section"',        // 6. Accounts
      'id="cashflow-section"',        // 7. Cash Flow + Upcoming Bills
      'id="calendar-widget"',
      'data-collapse-key="monthlySpend"', // 8. the spending tables
      'data-collapse-key="upcoming"',
      'id="settlement-section"',      // 9. Settle Up … YoY
      'id="housing-widget-section"',
      'id="investments-section"',
      'id="savings-rate-section"',
      'id="yoy-section"',
      'data-collapse-key="pyramid"',  // 10. the pyramid
      'id="ask-section"',             // 11. Ask, AI Insights, AI Memory, Credit Score
      'id="insights-widget"',
      'id="ai-memory-section"',
      'id="credit-score-widget"',
    ];
    const at = order.map((m) => { const i = body.indexOf(m); assert.ok(i >= 0, m); return i; });
    for (let k = 1; k < at.length; k++) assert.ok(at[k - 1] < at[k], order[k - 1] + " before " + order[k]);
  });

  it("DASHBOARD_WIDGETS is in page order (Settings lists the toggles as they appear)", () => {
    const W = widgets();
    const at = W.map((w) => { const i = posOf(w.selector); assert.ok(i >= 0, w.key + " " + w.selector); return [w.key, i]; });
    for (let k = 1; k < at.length; k++) assert.ok(at[k - 1][1] < at[k][1], at[k - 1][0] + " before " + at[k][0]);
    assert.equal(W[0].key, "whatsNew");
    assert.equal(W.length, 21, "no widget added or dropped (T4.1 A2 added advice)");
    assert.doesNotMatch(shared, /selector: '#dash-summary'/, "the summary isn't a toggle");
  });

  it("applyDashboardWidgets still hides exactly the switched-off keys", () => {
    const W = widgets();
    const els = {};
    const document = { querySelectorAll: (sel) => (els[sel] = els[sel] || [{ classList: { on: false, toggle(c, v) { this.on = v; } } }]) };
    const ctx = { document };
    vm.runInNewContext(slice(shared, "  var DASHBOARD_WIDGETS = [", "  win.DASHBOARD_WIDGETS") + "this.apply = applyDashboardWidgets;", ctx);
    ctx.apply({ pyramid: false, charts: true });
    for (const w of W) assert.equal(els[w.selector][0].classList.on, w.key === "pyramid", w.key);
  });
});

describe("decision 6 / 15 — the pyramid", () => {
  it("is collapsible, phone-collapsed by default, with its own key", () => {
    assert.match(dash, /<div class="wellness-section collapsible" data-collapse-key="pyramid" data-collapse-phone="1">\s*<h3 id="pyramid-title">/);
    assert.match(dash, /\.wellness-section\.collapsed > \*:not\(h3\) \{ display: none !important; \}/);
    assert.match(dash, /document\.querySelectorAll\('\.section\.collapsible, \.wellness-section\.collapsible'\)/);
  });

  it("collapsedFromStore: a stored choice wins; otherwise collapsed only on a phone for a phone-default section", () => {
    const ctx = {};
    vm.runInNewContext(slice(dash, "function collapsedFromStore(", "    (function initCollapsibles()") + "this.f = collapsedFromStore;", ctx);
    const f = ctx.f;
    assert.equal(f(null, true, true), true, "pyramid on a phone, never opened");
    assert.equal(f(null, true, false), false, "pyramid on a desktop");
    assert.equal(f("0", true, true), false, "opened once on a phone stays open");
    assert.equal(f("1", true, false), true, "collapsed by hand on a desktop");
    assert.equal(f(null, false, true), false, "the tables aren't collapsed by default on a phone");
    assert.equal(f("1", false, true), true);
  });

  it("opening a phone-default section stores '0'; an ordinary one removes its key", () => {
    const init = slice(dash, "    (function initCollapsibles()", "    })();\n");
    assert.match(init, /if \(c\) localStorage\.setItem\(key, '1'\);\s*else if \(phoneDefault\) localStorage\.setItem\(key, '0'\);\s*else localStorage\.removeItem\(key\);/);
  });

  it("the mode tabs are one scrollable row on a phone; the active tab is scrolled into view within the row", () => {
    const mq = slice(dash, "/* Design D4 (decision 15): one scrollable row, never wrapped. */", "    }\n");
    assert.match(mq, /flex-wrap: nowrap;/);
    assert.match(mq, /overflow-x: auto;/);
    assert.doesNotMatch(mq, /flex-wrap: wrap/);

    const ctx = {};
    vm.runInNewContext(slice(dash, "function scrollActiveTab(row)", "\n    }\n") + "\n    }\nthis.f = scrollActiveTab;", ctx);
    const act = { offsetLeft: 330, offsetWidth: 80 };
    const row = { offsetLeft: 10, clientWidth: 300, scrollWidth: 520, scrollLeft: 0, querySelector: () => act };
    ctx.f(row);
    assert.equal(row.scrollLeft, 210, "centred: 320 − (300 − 80) / 2");
    const fits = { clientWidth: 600, scrollWidth: 600, scrollLeft: 0, querySelector: () => act };
    ctx.f(fits);
    assert.equal(fits.scrollLeft, 0, "a row that fits isn't scrolled");
    ctx.f(null); // no row (collapsed section without a switcher) — no throw
    // Called when the mode changes and when the pyramid is opened.
    assert.match(dash, /b\.classList\.toggle\('active', b\.dataset\.mode === dataSource\);\s*\}\);\s*scrollActiveTab\(document\.getElementById\('pyramid-switcher'\)\);/);
    assert.match(dash, /if \(!c\) scrollActiveTab\(sec\.querySelector\('\.pyramid-switcher'\)\);/);
  });
});

// ---------------------------------------------------------------------------
// decision 7 — Cash Flow and Savings Rate, run from the real section
// ---------------------------------------------------------------------------
const fmtSrc = slice(shared, "function fmt(n) {", "// Calendar dates (DATE columns)");
function cashFlowCtx() {
  const ctx = { fmtDate: (d) => "D(" + d + ")", esc: (s) => String(s).replace(/</g, "&lt;") };
  vm.runInNewContext(fmtSrc + slice(dash, "    // --- Cash Flow Projection ---", "    async function loadCashFlow()") +
    "this.table = cashFlowTableHtml; this.summary = cashFlowSummaryHtml; this.toggle = toggleShowAll; this.showAll = showAllButton;", ctx);
  return ctx;
}
const week = (n, over = {}) => Object.assign({ week: n, start_date: "2026-11-0" + Math.min(9, n), income: 0, bills: 0, discretionary: 24.29, end_balance: 1000 - n * 25 }, over);

describe("decision 7 — Cash Flow", () => {
  it("shows the first 4 weeks, the rest hidden behind 'Show all 13 weeks'", () => {
    const { table } = cashFlowCtx();
    const html = table(Array.from({ length: 13 }, (_, i) => week(i + 1)));
    const rows = html.match(/<tr[^>]*>/g).slice(1); // past the header
    assert.equal(rows.length, 13);
    assert.equal(rows.filter((r) => !/hidden/.test(r)).length, 4);
    assert.ok(rows.slice(4).every((r) => r === '<tr data-extra="cashflow" hidden>'));
    assert.match(html, /<button type="button" class="btn-sm show-all-btn" data-show-all="cashflow" data-total="13" data-noun="weeks" aria-expanded="false"[^>]*>Show all 13 weeks<\/button>$/);
  });

  it("four weeks or fewer: no button, nothing hidden", () => {
    const { table } = cashFlowCtx();
    const html = table([week(1), week(2), week(3), week(4)]);
    assert.doesNotMatch(html, /hidden|show-all-btn/);
    assert.equal(table([]).includes("<tbody></tbody>"), true);
  });

  it("a $0.00 income or bills cell reads '—'; a real figure keeps its money class; spending and balance always show", () => {
    const { table } = cashFlowCtx();
    const html = table([week(1, { income: 0, bills: 0.004, discretionary: 0, end_balance: -12 }), week(2, { income: 2000, bills: 15.49 })]);
    const r1 = html.split("<tr")[2];
    assert.equal((r1.match(/aria-label="none">—<\/td>/g) || []).length, 2, "income and bills");
    assert.match(r1, />\$0\.00<\/td>/, "spending of $0 still shows");
    assert.match(r1, / class="amt-bad">-\$12\.00<\/td>/);
    const r2 = html.split("<tr")[3];
    assert.match(r2, / class="amt-in">\$2,000\.00<\/td>/);
    assert.match(r2, />\$15\.49<\/td>/);
    assert.doesNotMatch(r2, /—/);
  });

  it("the summary leads with the lowest projected day", () => {
    const { summary } = cashFlowCtx();
    const html = summary({ starting_balance: 500, ending_balance: 300, avg_daily_spend: 25, recurring_income: [{ source: "<Acme>" }], lowest_balance: -50, lowest_balance_date: "2026-11-14" });
    assert.ok(html.indexOf("Lowest projected") < html.indexOf("Starting balance"));
    assert.match(html, /Lowest projected: <strong class="amt-bad">-\$50\.00<\/strong> on D\(2026-11-14\)<\/div>Starting balance/);
    assert.match(html, /Income sources: &lt;Acme>/);
    assert.doesNotMatch(summary({ starting_balance: 1, ending_balance: 1, avg_daily_spend: 0 }), /Lowest projected/);
  });

  it("Show all reveals the rows and turns into Show fewer; pressing again restores", () => {
    const { toggle } = cashFlowCtx();
    const trs = [{ hidden: true }, { hidden: true }];
    const attrs = { "data-show-all": "cashflow", "aria-expanded": "false", "data-total": "13", "data-noun": "weeks" };
    const btn = { textContent: "Show all 13 weeks", getAttribute: (k) => attrs[k], setAttribute: (k, v) => { attrs[k] = v; } };
    let asked;
    const root = { querySelectorAll: (sel) => { asked = sel; return trs; } };
    toggle(btn, root);
    assert.equal(asked, 'tr[data-extra="cashflow"]');
    assert.deepEqual(trs.map((t) => t.hidden), [false, false]);
    assert.equal(btn.textContent, "Show fewer");
    assert.equal(attrs["aria-expanded"], "true");
    toggle(btn, root);
    assert.deepEqual(trs.map((t) => t.hidden), [true, true]);
    assert.equal(btn.textContent, "Show all 13 weeks");
    // One delegated listener, outside the section the loaders' tests slice.
    assert.equal((dash.match(/closest\('\.show-all-btn\[data-show-all\]'\)/g) || []).length, 1);
  });
});

describe("decision 7 — Savings Rate", () => {
  it("shows the latest month (months arrive newest first); the rest behind 'Show all N months'", async () => {
    const els = {};
    const document = { getElementById: (id) => (els[id] = els[id] || { style: {}, innerHTML: "" }) };
    const ctx = {
      document, esc: (s) => String(s), fmtMonth: (m) => "M(" + m + ")",
      apiFetch: async () => ({ ok: true, json: async () => ({
        averages: { income: 2000, spending: 1500, saved: 500, savings_rate: 25 }, recommendation: "ok",
        months: [{ month: "2026-10", income: 2000, spending: 184.29, saved: 1815.71, savings_rate: 90 },
          { month: "2026-09", income: 2000, spending: 1900, saved: 100, savings_rate: 5 },
          { month: "2026-08", income: 2000, spending: 2100, saved: -100, savings_rate: -5 }],
      }) }),
    };
    vm.runInNewContext(fmtSrc + slice(dash, "    // --- Savings Rate ---", "    // --- Year-over-Year Comparison ---") + "this.load = loadSavingsRate;", ctx);
    await ctx.load();
    const html = els["savings-rate-content"].innerHTML;
    const rows = html.match(/<tr[^>]*><td[^>]*>M\([^)]*\)/g);
    assert.equal(rows.length, 3);
    assert.match(rows[0], /^<tr><td[^>]*>M\(2026-10\)/, "the latest month is shown");
    assert.ok(rows.slice(1).every((r) => r.startsWith('<tr data-extra="savings" hidden>')));
    assert.match(html, /data-show-all="savings" data-total="3" data-noun="months"[^>]*>Show all 3 months<\/button>/);
  });
});

// ---------------------------------------------------------------------------
// decision 7 — the trend chart, the real loadCharts (the T1.5 B harness)
// ---------------------------------------------------------------------------
function chartHarness() {
  const start = dash.indexOf("    async function loadCharts() {");
  const end = dash.indexOf("  </script>", start);
  const live = [];
  class Chart { constructor(ctx, cfg) { this.id = ctx.id; this.cfg = cfg; this.destroyed = false; live.push(this); } destroy() { this.destroyed = true; } }
  Chart.defaults = {};
  function makeEl(tag) {
    return {
      tagName: tag, className: "", textContent: "", hidden: false, style: {}, children: [],
      appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
      querySelector(sel) { return this.children.find((c) => "." + c.className === sel) || null; },
    };
  }
  const canvases = {};
  for (const id of ["trend-chart", "category-chart"]) canvases[id] = makeEl("div").appendChild(Object.assign(makeEl("canvas"), { id }));
  const document = { documentElement: { getAttribute: () => "dark" }, getElementById: (id) => canvases[id] || null, createElement: makeEl };
  let summary;
  // eslint-disable-next-line no-new-func
  const loadCharts = new Function("getSpendingSummary", "Chart", "document", "window", dash.slice(start, end) + "\nreturn loadCharts;")(
    async () => summary, Chart, document, { innerWidth: 1200 });
  const note = () => canvases["trend-chart"].parentElement.querySelector(".chart-empty");
  return { live, canvases, note, load: async (s) => { summary = s; await loadCharts(); } };
}
const months = (n) => Array.from({ length: n }, (_, i) => ({ month: "2026-" + String(10 - i).padStart(2, "0"), total_spend: String(100 + i) }));

describe("decision 7 — the trend chart needs 3 months", () => {
  for (const [n, text] of [[1, "Spending trends appear after 3 months of history — 1 so far"], [2, "Spending trends appear after 3 months of history — 2 so far"]]) {
    it(n + " month(s): a sentence instead of a lone dot; the category chart still draws", async () => {
      const h = chartHarness();
      await h.load({ monthly_trend: months(n), by_category: [{ category: "Dining", total: "50" }] });
      assert.ok(!h.live.some((c) => c.id === "trend-chart"), "no trend chart");
      assert.ok(h.live.some((c) => c.id === "category-chart"));
      assert.equal(h.note().textContent, text);
      assert.equal(h.note().hidden, false);
      assert.equal(h.canvases["trend-chart"].style.display, "none");
    });
  }

  it("3 months: the chart, oldest first, and the note hidden", async () => {
    const h = chartHarness();
    await h.load({ monthly_trend: months(2), by_category: [] });
    await h.load({ monthly_trend: months(3), by_category: [] });
    const trend = h.live.find((c) => c.id === "trend-chart");
    assert.deepEqual(trend.cfg.data.datasets[0].data, [102, 101, 100]);
    assert.equal(h.note().hidden, true);
    assert.equal(h.canvases["trend-chart"].style.display, "");
  });

  it("0 months keeps the existing empty state", async () => {
    const h = chartHarness();
    await h.load({ monthly_trend: [], by_category: [] });
    assert.equal(h.note().textContent, "No spending data yet");
  });
});

describe("the dashboard template compiles", () => {
  // The page CSS lives in a JS template literal (the head partial's
  // extraStyles), where a CSS escape like '\25be' is an octal escape and the
  // whole page 500s — this renders it for real (a D4 regression caught by e2e).
  it("renders standalone and under /perfin, with the reordered sections", async () => {
    const ejs = require("ejs");
    for (const basePath of ["", "/perfin"]) {
      const html = await new Promise((resolve, reject) =>
        ejs.renderFile(path.join(ROOT, "teller", "views", "dashboard.ejs"), { nonce: "n", v: "1", basePath, activePage: "dashboard" },
          (e, h) => (e ? reject(e) : resolve(h))));
      assert.ok(html.indexOf('id="dash-summary"') < html.indexOf('class="charts-grid"'));
      assert.ok(html.indexOf('class="charts-grid"') < html.indexOf('data-collapse-key="pyramid"'));
      assert.match(html, /\.wellness-section\.collapsible > h3::after \{ content: '\\25be';/);
    }
  });
});
