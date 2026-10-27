// ============================================================================
// Roadmap T1.5 — Batch B (Perfin quick wins)
// ============================================================================
//  B1  the dashboard charts and the Spending-by-Category month selector are
//      redrawn from the fresh spending summary after a sync / split / detection
//  B2  the Budgets page has month navigation and lists one-month budgets set
//      for other months (GET /api/budgets/one-time)
//  B3  merchant rename rules can be renamed and switched off / on
//      (PATCH /api/merchant-rename-rules/:id)
// The real-Postgres half is tests/contract/quickwins.contract.test.js.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const express = require("express");
const supertest = require("supertest");

process.env.NEON_DATABASE_URL = process.env.NEON_DATABASE_URL || "postgres://test:test@127.0.0.1:1/test";
process.env.TOKEN_ENCRYPTION_PASSPHRASE = process.env.TOKEN_ENCRYPTION_PASSPHRASE || "test-passphrase";

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const dbModule = require("../teller/services/database");
const dash = read("teller", "views", "dashboard.ejs");

// ---------------------------------------------------------------------------
describe("B1 — dashboard charts redraw", () => {
  // The real loadCharts (+ its helpers, which follow it) with a fake Chart that
  // records destroy(), and canvases inside fake wrappers.
  function harness() {
    const start = dash.indexOf("    async function loadCharts() {");
    const end = dash.indexOf("  </script>", start);
    const live = [];
    class Chart {
      constructor(ctx, cfg) { this.id = ctx.id; this.cfg = cfg; this.destroyed = false; live.push(this); }
      destroy() { this.destroyed = true; }
    }
    Chart.defaults = {};
    function makeEl(tag) {
      return {
        tagName: tag, className: "", textContent: "", hidden: false, style: {}, children: [],
        appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
        querySelector(sel) { return this.children.find((c) => "." + c.className === sel) || null; },
      };
    }
    const canvases = {};
    for (const id of ["trend-chart", "category-chart"]) {
      const wrap = makeEl("div");
      canvases[id] = wrap.appendChild(Object.assign(makeEl("canvas"), { id }));
    }
    const document = {
      documentElement: { getAttribute: () => "dark" },
      getElementById: (id) => canvases[id] || null,
      createElement: makeEl,
    };
    let summary;
    // eslint-disable-next-line no-new-func
    const loadCharts = new Function("getSpendingSummary", "Chart", "document", "window",
      dash.slice(start, end) + "\nreturn loadCharts;")(async () => summary, Chart, document, { innerWidth: 1200 });
    return { live, canvases, load: async (s) => { summary = s; await loadCharts(); } };
  }

  it("a second load destroys the old charts and draws the fresh figures", async () => {
    const h = harness();
    // Three months each — fewer is a sentence, not a chart (design D4).
    await h.load({ monthly_trend: [{ month: "2026-09", total_spend: "100" }, { month: "2026-08", total_spend: "90" }, { month: "2026-07", total_spend: "80" }],
      by_category: [{ category: "Dining", total: "100" }] });
    await h.load({ monthly_trend: [{ month: "2026-10", total_spend: "250" }, { month: "2026-09", total_spend: "100" }, { month: "2026-08", total_spend: "90" }],
      by_category: [{ category: "Dining", total: "180" }, { category: "Travel", total: "70" }] });
    assert.equal(h.live.length, 4);
    assert.deepEqual(h.live.slice(0, 2).map((c) => c.destroyed), [true, true], "the first charts are destroyed");
    assert.deepEqual(h.live.slice(2).map((c) => c.destroyed), [false, false]);
    const trend = h.live.find((c) => c.id === "trend-chart" && !c.destroyed);
    assert.deepEqual(trend.cfg.data.datasets[0].data, [90, 100, 250]);
    const cat = h.live.find((c) => c.id === "category-chart" && !c.destroyed);
    assert.deepEqual(cat.cfg.data.labels, ["Dining", "Travel"]);
  });

  it("an empty load keeps the canvas (hidden, with a note) so a later load can draw again", async () => {
    const h = harness();
    await h.load({ monthly_trend: [], by_category: [] });
    const c = h.canvases["trend-chart"];
    assert.equal(c.style.display, "none");
    const note = c.parentElement.querySelector(".chart-empty");
    assert.equal(note.textContent, "No spending data yet");
    assert.equal(note.hidden, false);
    await h.load({ monthly_trend: [{ month: "2026-10", total_spend: "5" }, { month: "2026-09", total_spend: "4" }, { month: "2026-08", total_spend: "3" }],
      by_category: [{ category: "Fees", total: "5" }] });
    assert.equal(c.style.display, "");
    assert.equal(note.hidden, true);
    assert.equal(h.live.filter((x) => !x.destroyed).length, 2);
  });

  it("sync, detection and a shared-split change refresh the tables AND the charts", () => {
    const fn = (name) => dash.slice(dash.indexOf("async function " + name + "("), dash.indexOf("\n    }\n", dash.indexOf("async function " + name + "(")));
    for (const name of ["syncTransactions", "runDetection", "toggleShared"]) {
      assert.match(fn(name), /refreshSpending\(\);/, name);
      assert.doesNotMatch(fn(name), /loadSpendingSummary\(\);/, name);
    }
    const refresh = dash.slice(dash.indexOf("function refreshSpending()"), dash.indexOf("async function loadSpendingSummary()"));
    // The tables fetch fresh first, so the charts reuse that same response.
    assert.match(refresh, /loadSpendingSummary\(\);\s*if \(typeof Chart !== 'undefined'\) loadCharts\(\);/);
  });

  // The Spending-by-Category table: the aggregate comes from the LATEST
  // summary (the change handler used to close over the first one).
  function categoryHarness() {
    const start = dash.indexOf("    // The Spending-by-Category table.");
    const end = dash.indexOf("    // After a write that changes spending");
    const body = { innerHTML: "" };
    const fetches = [];
    const ctx = {
      document: { getElementById: (id) => (id === "category-body" ? body : null) },
      barColors: ["#000"], fmt: (v) => "$" + Number(v).toFixed(2), esc: (s) => String(s),
      encodeURIComponent,
      apiFetch: (url) => new Promise((resolve) => fetches.push({ url, resolve })),
    };
    vm.runInNewContext(dash.slice(start, end) + "\nthis.set = (d) => { latestCategoryData = d; }; this.render = renderCategoryMonth;", ctx);
    return { body, fetches, set: ctx.set, render: ctx.render };
  }

  it("the aggregate view re-renders from the latest summary", async () => {
    const h = categoryHarness();
    h.set({ by_category: [{ category: "Dining", total: "100" }] });
    await h.render("");
    assert.match(h.body.innerHTML, /Dining/);
    h.set({ by_category: [{ category: "Travel", total: "300" }] });
    await h.render("");
    assert.match(h.body.innerHTML, /Travel/);
    assert.doesNotMatch(h.body.innerHTML, /Dining/);
  });

  it("a slow month fetch can't overwrite a later choice", async () => {
    const h = categoryHarness();
    h.set({ by_category: [{ category: "Aggregate", total: "1" }] });
    const slow = h.render("2026-09");
    assert.equal(h.fetches[0].url, "/api/spending-categories?month=2026-09");
    await h.render("");
    h.fetches[0].resolve({ ok: true, json: async () => ({ categories: [{ category: "Stale", spent: 9 }] }) });
    await slow;
    assert.match(h.body.innerHTML, /Aggregate/);
    assert.doesNotMatch(h.body.innerHTML, /Stale/);
  });

  it("the month options are rebuilt on every load, keeping a still-listed choice", () => {
    const load = dash.slice(dash.indexOf("async function loadSpendingSummary()"), dash.indexOf("async function syncTransactions()"));
    assert.match(load, /latestCategoryData = data;/);
    assert.match(load, /Array\.prototype\.slice\.call\(catSel\.options, 1\)\.forEach/);
    assert.match(load, /catSel\.value = \(data\.monthly_trend \|\| \[\]\)\.some\(function\(m\) \{ return m\.month === keep; \}\) \? keep : '';/);
    assert.match(load, /renderCategoryMonth\(catSel\.value\);/);
  });
});

// ---------------------------------------------------------------------------
describe("B2 — Budgets month picker", () => {
  const page = read("teller", "views", "budgets.ejs");

  it("GET /api/budgets/one-time lists one-month budgets with their month", async () => {
    const orig = dbModule.pool.query;
    let seen;
    dbModule.pool.query = async (sql) => { seen = sql; return { rows: [{ id: 3, category: "Gifts", monthly_limit: "200", effective_month: "2026-12" }] }; };
    try {
      const app = express();
      app.use(require("../teller/routes/budgets"));
      const r = await supertest(app).get("/api/budgets/one-time").expect(200);
      assert.deepEqual(r.body.budgets, [{ id: 3, category: "Gifts", monthly_limit: "200", effective_month: "2026-12" }]);
      assert.match(seen, /budget_type = 'one_time' AND effective_month IS NOT NULL/);
    } finally {
      dbModule.pool.query = orig;
    }
  });

  it("month arithmetic crosses year ends and labels months locally", () => {
    const start = page.indexOf("    function shiftMonth(");
    const end = page.indexOf("    function setViewMonth(");
    const ctx = {};
    vm.runInNewContext(page.slice(start, end) + "this.shift = shiftMonth; this.name = monthName;", ctx);
    assert.equal(ctx.shift("2026-12", 1), "2027-01");
    assert.equal(ctx.shift("2027-01", -1), "2026-12");
    assert.equal(ctx.shift("2026-03", -14), "2025-01");
    assert.match(ctx.name("2026-09"), /September/);
  });

  it("loads the viewed month, defaults a one-month budget to it, and links other months", () => {
    assert.match(page, /apiFetch\('\/api\/budgets\?month=' \+ encodeURIComponent\(viewMonth\)\)/);
    assert.match(page, /body\.effective_month = document\.getElementById\('b-month'\)\.value \|\| viewMonth;/);
    assert.match(page, /document\.getElementById\('b-month'\)\.value = viewMonth;/);
    assert.match(page, /apiFetch\('\/api\/budgets\/one-time'\)/);
    assert.match(page, /return b\.effective_month !== viewMonth;/);
    assert.match(page, /onDelegate\('other-months', 'click', '\[data-month\]'/);
    for (const id of ["month-prev", "month-next", "month-today"]) assert.ok(page.includes('id="' + id + '"'), id);
    assert.match(page, /\.other-months\[hidden\] \{ display: none; \}/, "the flex list must still hide");
  });
});

// ---------------------------------------------------------------------------
describe("B3 — editable rename rules", () => {
  const { updateRenameRule } = require("../teller/routes/merchant-rename");
  const rule = (extra = {}) => ({ id: 7, merchant_pattern: "SPOTIFY USA", match_type: "exact", rename_to: "Spotify", is_active: true, times_applied: 3, ...extra });
  function fakeDb(current) {
    const calls = [];
    return {
      calls,
      query: async (sql, params) => {
        calls.push(sql);
        if (/SELECT \* FROM merchant_rename_rules WHERE id = \$1/.test(sql)) return { rows: current ? [current] : [] };
        if (/UPDATE merchant_rename_rules SET is_active = false/.test(sql)) {
          return { rows: [{ ...current, is_active: false, rename_to: params[1] || current.rename_to }] };
        }
        if (/UPDATE transactions SET user_merchant_name = NULL/.test(sql)) return { rowCount: 3, rows: [] };
        return { rows: [], rowCount: 0 };
      },
    };
  }

  it("validates the body", async () => {
    assert.equal((await updateRenameRule(7, {}, fakeDb(rule()))).status, 400);
    assert.equal((await updateRenameRule(7, { isActive: "yes" }, fakeDb(rule()))).status, 400);
    assert.equal((await updateRenameRule(7, { renameTo: "  " }, fakeDb(rule()))).status, 400);
    assert.equal((await updateRenameRule(7, { renameTo: "x".repeat(201) }, fakeDb(rule()))).status, 400);
    assert.equal((await updateRenameRule(7, { renameTo: "New" }, fakeDb(null))).status, 404);
  });

  it("turning a rule off reverts its rows like Delete and keeps the rule", async () => {
    const db = fakeDb(rule());
    const out = await updateRenameRule(7, { isActive: false }, db);
    assert.equal(out.rule.is_active, false);
    assert.equal(out.reverted, 3);
    assert.equal(out.redetect, false);
    assert.ok(db.calls.some((s) => /WHERE user_merchant_rule_id = \$1/.test(s)));
    assert.ok(!db.calls.some((s) => /DELETE FROM merchant_rename_rules/.test(s)));
  });

  it("a new name on a rule that stays off is only stored", async () => {
    const db = fakeDb(rule({ is_active: false }));
    const out = await updateRenameRule(7, { renameTo: "Spotify Family" }, db);
    assert.equal(out.rule.rename_to, "Spotify Family");
    assert.equal(out.reverted, 0);
    assert.ok(!db.calls.some((s) => /UPDATE transactions/.test(s)), "no rows touched");
  });

  it("an unchanged name on an active rule is a no-op", async () => {
    const db = fakeDb(rule());
    const out = await updateRenameRule(7, { renameTo: " Spotify " }, db);
    assert.equal(out.redetect, false);
    assert.equal(db.calls.length, 1);
  });

  it("the route rejects a malformed id and is declared alongside DELETE", async () => {
    const app = express();
    app.use(express.json());
    app.use(require("../teller/routes/merchant-rename"));
    await supertest(app).patch("/api/merchant-rename-rules/7abc").send({ is_active: false }).expect(400);
    const src = read("teller", "routes", "merchant-rename.js");
    assert.match(src, /router\.patch\("\/api\/merchant-rename-rules\/:id"/);
    assert.match(src, /if \(needed\) body\.redetected = await redetect\(\);/);
  });

  it("Settings → Rules offers Edit and Turn off / Turn on", () => {
    const ui = read("teller", "public", "settings-rules.js");
    assert.match(ui, /data-action="edit-rename-rule"/);
    assert.match(ui, /data-action="toggle-rename-rule"/);
    assert.match(ui, /method: "PATCH", headers: \{ "Content-Type": "application\/json" \}, body: JSON\.stringify\(body\)/);
    assert.match(ui, /await writeOk\(res, "Couldn't update the rename rule"\)/);
  });
});
