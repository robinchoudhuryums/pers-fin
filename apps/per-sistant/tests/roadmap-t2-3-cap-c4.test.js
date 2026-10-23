// ============================================================================
// Roadmap T2.3 C4 — the Per-sistant AI budget made visible and settable
// ============================================================================
// getAiBudgetInfo's three sources (settings → env → default) and the pool it
// reads; GET /api/ai/usage (the APP_TIMEZONE month, the ai_usage rows grouped
// by feature, the budget and its source, Perfin's spend beside it — null
// standalone, null on a failure); the AI limiter skipping only the two
// read-only GETs; PATCH /api/settings ai_monthly_budget_cents (integer
// 1–10000 or null, 400 otherwise); the Settings card run in a vm; the pages
// showing the over-cap message instead of hiding it.
// ============================================================================
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const vm = require("vm");
const express = require("express");
const supertest = require("supertest");

const ai = require("../ai");
const quiet = async (fn) => { const o = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = o; } };

function settingsPool(value, opts = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/ai_monthly_budget_cents FROM user_settings/.test(sql)) {
        if (opts.budgetThrows) throw new Error("db down");
        return { rows: [{ ai_monthly_budget_cents: value }] };
      }
      if (/FROM ai_usage/.test(sql)) {
        if (opts.usageThrows) throw new Error("ledger down");
        return { rows: opts.usage || [] };
      }
      return { rows: [] };
    },
  };
}

describe("getAiBudgetInfo: settings → env → default", () => {
  let savedEnv;
  beforeEach(() => { savedEnv = process.env.PERSISTENT_AI_BUDGET_CENTS; delete process.env.PERSISTENT_AI_BUDGET_CENTS; });
  afterEach(() => { if (savedEnv === undefined) delete process.env.PERSISTENT_AI_BUDGET_CENTS; else process.env.PERSISTENT_AI_BUDGET_CENTS = savedEnv; });

  it("the setting wins, read from the pool it is given", async () => {
    process.env.PERSISTENT_AI_BUDGET_CENTS = "300";
    const p = settingsPool(450);
    assert.deepEqual(await ai.getAiBudgetInfo(p), { cents: 450, source: "settings" });
    assert.equal(p.calls.length, 1);
    assert.equal(await ai.getAiBudgetCents(p), 450);
  });

  it("no setting → the env var, then the $1.00 default", async () => {
    process.env.PERSISTENT_AI_BUDGET_CENTS = "300";
    assert.deepEqual(await ai.getAiBudgetInfo(settingsPool(null)), { cents: 300, source: "env" });
    delete process.env.PERSISTENT_AI_BUDGET_CENTS;
    assert.deepEqual(await ai.getAiBudgetInfo(settingsPool(null)), { cents: 100, source: "default" });
    process.env.PERSISTENT_AI_BUDGET_CENTS = "abc";
    assert.deepEqual(await ai.getAiBudgetInfo(settingsPool(0)), { cents: 100, source: "default" });
  });

  it("an unreadable setting is logged and falls back (the spend read is what fails closed)", async () => {
    const logged = [];
    const o = console.error; console.error = (...a) => logged.push(a.join(" "));
    try {
      assert.deepEqual(await ai.getAiBudgetInfo(settingsPool(500, { budgetThrows: true })), { cents: 100, source: "default" });
    } finally { console.error = o; }
    assert.match(logged.join("\n"), /AI budget setting read error: db down/);
  });

  it("checkAiCap reads the budget from the pool it was given", async () => {
    const saved = { b: ai.getAiBudgetCents, s: ai.monthlyAiSpendCents };
    const seen = [];
    ai.getAiBudgetCents = async (p) => { seen.push(p); return 100; };
    ai.monthlyAiSpendCents = async () => 10;
    try {
      const p = settingsPool(100);
      assert.deepEqual(await ai.checkAiCap(p), { ok: true, spent: 10, budget: 100 });
      assert.equal(seen[0], p);
    } finally { ai.getAiBudgetCents = saved.b; ai.monthlyAiSpendCents = saved.s; }
  });
});

describe("GET /api/ai/usage", () => {
  const aiRoutes = require("../routes/ai");
  const usageRows = [
    { entry_type: "rag_query", calls: 3, cents: "41.237" },
    { entry_type: "daily_briefing", calls: 1, cents: "2.5" },
  ];
  function app(pool, perfinPool) {
    const a = express();
    a.use(express.json());
    if (perfinPool) a.set("perfinPool", perfinPool);
    a.use(aiRoutes({ pool }));
    return a;
  }

  it("this month's spend by feature, the budget and its source; perfin null standalone", async () => {
    const savedTz = process.env.APP_TIMEZONE;
    process.env.APP_TIMEZONE = "Pacific/Kiritimati"; // aiMonthStart reads it per call
    const p = settingsPool(250, { usage: usageRows });
    let r, month_start, tz;
    try {
      r = await supertest(app(p)).get("/api/ai/usage").expect(200);
      ({ month_start, tz } = ai.aiMonthStart());
    } finally { if (savedTz === undefined) delete process.env.APP_TIMEZONE; else process.env.APP_TIMEZONE = savedTz; }
    assert.equal(tz, "Pacific/Kiritimati");
    assert.equal(r.body.month, month_start.slice(0, 7));
    assert.deepEqual(r.body.by_feature, [
      { entry_type: "rag_query", calls: 3, cents: 41.24 },
      { entry_type: "daily_briefing", calls: 1, cents: 2.5 },
    ]);
    assert.equal(r.body.spent_cents, 43.74);
    assert.equal(r.body.budget_cents, 250);
    assert.equal(r.body.budget_source, "settings");
    assert.equal(r.body.perfin, null);
    assert.equal(typeof r.body.available, "boolean");
    const q = p.calls.find((c) => /FROM ai_usage/.test(c.sql));
    assert.match(q.sql, /created_at >= \(\$1::date::timestamp AT TIME ZONE \$2\) GROUP BY entry_type/);
    assert.deepEqual(q.params, [month_start, tz]);
  });

  it("a ledger read error is a 500 (never a $0 spend)", async () => {
    await quiet(() => supertest(app(settingsPool(250, { usageThrows: true }))).get("/api/ai/usage").expect(500));
  });

  it("Perfin's spend beside it through the wired pool, null when that read fails", async () => {
    const insightsPath = path.resolve(__dirname, "../../../teller/routes/insights.js");
    const saved = require.cache[insightsPath];
    let spentArg;
    require.cache[insightsPath] = { id: insightsPath, filename: insightsPath, loaded: true, exports: {
      monthAiSpendCents: async (db) => { spentArg = db; return 12.345; },
      getAiBudgetCents: async () => 50,
    } };
    try {
      const perfinPool = { query: async () => ({ rows: [] }) };
      const r = await supertest(app(settingsPool(null), perfinPool)).get("/api/ai/usage").expect(200);
      assert.deepEqual(r.body.perfin, { spent_cents: 12.35, budget_cents: 50 });
      assert.equal(spentArg, perfinPool);
      require.cache[insightsPath].exports.monthAiSpendCents = async () => { throw new Error("perfin down"); };
      const r2 = await quiet(() => supertest(app(settingsPool(null), perfinPool)).get("/api/ai/usage").expect(200));
      assert.equal(r2.body.perfin, null);
    } finally {
      if (saved) require.cache[insightsPath] = saved; else delete require.cache[insightsPath];
    }
  });
});

describe("the AI limiter skips only the read-only GETs", () => {
  it("GET /api/ai/usage and /models pass the 20/min limit; a model-calling GET does not", async () => {
    const db = require("../db");
    const savedQuery = db.pool.query;
    db.pool.query = async () => ({ rows: [] });
    try {
      const a = express();
      require("../middleware").setup(a);
      a.get("/api/ai/usage", (req, res) => res.json({ ok: true }));
      a.get("/api/ai/models", (req, res) => res.json({ ok: true }));
      a.get("/api/ai/daily-briefing", (req, res) => res.json({ ok: true }));
      for (let i = 0; i < 25; i++) {
        await supertest(a).get("/api/ai/usage").expect(200);
        await supertest(a).get("/api/ai/models").expect(200);
      }
      let limited = 0;
      for (let i = 0; i < 22; i++) if ((await supertest(a).get("/api/ai/daily-briefing")).status === 429) limited++;
      assert.ok(limited >= 1, "the briefing GET calls the model and stays limited");
    } finally { db.pool.query = savedQuery; }
  });
});

describe("PATCH /api/settings ai_monthly_budget_cents", () => {
  const settingsRoutes = require("../routes/settings");
  function app() {
    const calls = [];
    const pool = { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: 1 }] }; } };
    const a = express();
    a.use(express.json());
    a.use(settingsRoutes({ pool, config: require("../config"), helpers: require("../helpers"), views: require("../views") }));
    return { a, calls };
  }

  it("an integer 1–10000 is stored; null clears it", async () => {
    for (const [v, want] of [[500, 500], ["250", 250], [1, 1], [10000, 10000]]) {
      const { a, calls } = app();
      await supertest(a).patch("/api/settings").send({ ai_monthly_budget_cents: v }).expect(200);
      const u = calls.find((c) => /UPDATE user_settings/.test(c.sql));
      assert.match(u.sql, /ai_monthly_budget_cents = \$1/);
      assert.deepEqual(u.params, [want]);
    }
    const { a, calls } = app();
    await supertest(a).patch("/api/settings").send({ ai_monthly_budget_cents: null }).expect(200);
    assert.match(calls.find((c) => /UPDATE user_settings/.test(c.sql)).sql, /ai_monthly_budget_cents = NULL/);
  });

  it("anything else is a 400 with nothing written", async () => {
    for (const v of [0, -5, 10001, 1.5, "6abc", "", true, "1e3x", [100], {}]) {
      const { a, calls } = app();
      const r = await supertest(a).patch("/api/settings").send({ ai_monthly_budget_cents: v }).expect(400);
      assert.match(r.body.error, /ai_monthly_budget_cents must be an integer between 1 and 10000/);
      assert.equal(calls.filter((c) => /UPDATE/.test(c.sql)).length, 0, JSON.stringify(v));
    }
  });
});

function renderPage(mod, ...args) {
  let html = "";
  require(mod)(...args)({ app: { get: () => false } }, { send: (h) => { html = h; } });
  return html;
}
function scriptsOf(html) {
  return html.match(/<script[^>]*>[\s\S]*?<\/script>/g).map((b) => b.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, ""));
}

describe("Settings → AI: the usage card", () => {
  const html = renderPage("../pages/settings", "");
  const script = require("../pages/settings-script");

  it("markup: the line, a labelled cap input, Save / Use default, the breakdown and the Perfin line", () => {
    for (const id of ["ai-usage-line", "ai-budget-input", "save-ai-budget-btn", "reset-ai-budget-btn", "ai-budget-source", "ai-usage-breakdown", "perfin-ai-spend"]) {
      assert.ok(html.includes(`id="${id}"`), id);
    }
    assert.ok(html.includes('<label for="ai-budget-input"'));
    // Outside the models section, so it shows without an API key too.
    assert.ok(html.indexOf('id="ai-usage-section"') > html.indexOf('id="aim-job_fit"'));
    for (const js of scriptsOf(html)) if (js.trim()) new Function(js); // eslint-disable-line no-new-func
  });

  it("wiring: load() fetches it, Save / Use default go through withPending + writeOk", () => {
    assert.match(script, /\n  loadAiUsage\(\);\n/);
    assert.match(script, /\['save-ai-budget-btn','click',function\(\)\{ saveAiBudget\(false\); \}\]/);
    assert.match(script, /\['reset-ai-budget-btn','click',function\(\)\{ saveAiBudget\(true\); \}\]/);
    assert.match(script, /withPending\(btns, 'ai-budget', async function\(\) \{\s*var ok = await writeOk\(await tryFetch\('\/api\/settings', \{method:'PATCH'/);
  });

  // The card's two functions run in a vm against a fake DOM.
  function runCard(usage, inputValue) {
    const start = script.indexOf("var AI_FEATURE_LABELS");
    const end = script.indexOf("async function enableNotifications");
    const els = {};
    const el = (id) => (els[id] = els[id] || { id, textContent: "", innerHTML: "", value: inputValue || "", hidden: true });
    const sent = [];
    const toasts = [];
    const ctx = {
      document: { getElementById: el, activeElement: null },
      tryFetch: async (url, opts) => {
        sent.push({ url, opts });
        if (url === "/api/ai/usage") return usage === null ? null : { ok: true, json: async () => usage };
        return { ok: true };
      },
      writeOk: async (res) => !!(res && res.ok),
      withPending: async (_b, _k, fn) => fn(),
      showUndo: (m) => toasts.push(m),
      esc: (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;"),
      isFinite, parseFloat, Math, Number, String, JSON,
    };
    vm.createContext(ctx);
    vm.runInContext(script.slice(start, end) + "\nthis.loadAiUsage = loadAiUsage; this.saveAiBudget = saveAiBudget;", ctx);
    return { ctx, els, sent, toasts };
  }

  it("renders the spend, the source, the breakdown and Perfin's line", async () => {
    const { ctx, els } = runCard({ spent_cents: 43.74, budget_cents: 250, budget_source: "env",
      by_feature: [{ entry_type: "rag_query", calls: 3, cents: 41.24 }, { entry_type: "odd<type>", calls: 1, cents: 2.5 }],
      perfin: { spent_cents: 12.35, budget_cents: 50 } });
    await ctx.loadAiUsage();
    assert.equal(els["ai-usage-line"].textContent, "This month: $0.44 of $2.50.");
    assert.equal(els["ai-budget-input"].value, "2.50");
    assert.equal(els["ai-budget-source"].textContent, "From PERSISTENT_AI_BUDGET_CENTS on the server.");
    assert.match(els["ai-usage-breakdown"].innerHTML, /Knowledge Q&amp;A<\/span>.*3 calls · \$0\.41/);
    assert.match(els["ai-usage-breakdown"].innerHTML, /odd&lt;type>.*1 call · \$0\.03/);
    assert.equal(els["perfin-ai-spend"].hidden, false);
    assert.equal(els["perfin-ai-spend"].textContent, "Perfin (its own cap, set in Perfin → Settings): $0.12 of $0.50 this month.");
  });

  it("at the budget it says AI is paused; none yet → an empty note; a failed load says so", async () => {
    let c = runCard({ spent_cents: 100, budget_cents: 100, budget_source: "default", by_feature: [], perfin: null });
    await c.ctx.loadAiUsage();
    assert.match(c.els["ai-usage-line"].textContent, /^This month: \$1\.00 of \$1\.00 — budget reached/);
    assert.match(c.els["ai-usage-breakdown"].innerHTML, /No AI calls yet this month/);
    assert.equal(c.els["perfin-ai-spend"].hidden, true);
    c = runCard(null);
    await c.ctx.loadAiUsage();
    assert.equal(c.els["ai-usage-line"].textContent, "Couldn't load this month's AI spend.");
  });

  it("Save sends whole cents, refuses an out-of-range value locally; Use default sends null", async () => {
    let c = runCard({ spent_cents: 0, budget_cents: 250, budget_source: "settings", by_feature: [] }, "2.505");
    await c.ctx.saveAiBudget(false);
    const patch = c.sent.find((s) => s.url === "/api/settings");
    assert.deepEqual(JSON.parse(patch.opts.body), { ai_monthly_budget_cents: 251 });
    assert.ok(c.sent.filter((s) => s.url === "/api/ai/usage").length === 1, "the card reloads after a save");
    c = runCard({}, "250");
    await c.ctx.saveAiBudget(false);
    assert.equal(c.sent.length, 0);
    assert.match(c.toasts[0], /between \$0\.01 and \$100/);
    c = runCard({ spent_cents: 0, budget_cents: 100, budget_source: "default", by_feature: [] });
    await c.ctx.saveAiBudget(true);
    assert.deepEqual(JSON.parse(c.sent.find((s) => s.url === "/api/settings").opts.body), { ai_monthly_budget_cents: null });
  });
});

describe("pages show the over-cap message instead of hiding it", () => {
  const CAP = "(d.ai_cap || d.ai_cap_check_failed)";
  it("dashboard briefing + suggestions, Today's briefing and the Review summary", () => {
    const dash = require("../pages/dashboard-script");
    assert.ok(dash.includes("var text = d.briefing || (" + CAP + " && d.error);"));
    assert.ok(dash.includes("} else if (" + CAP + " && d.error) {\n      document.getElementById('suggestions-content').textContent = d.error;"));
    const today = renderPage("../pages/today");
    assert.ok(today.includes("var text = d && (d.briefing || (" + CAP + " && d.error));"));
    const review = renderPage("../pages/review");
    assert.ok(review.includes("var text = d.summary || (" + CAP + " && d.error);"));
    // Ask's 200 budget answer is never shown as the week's theme.
    assert.ok(review.includes("if (d && d.answer && !d.ai_cap && !d.ai_cap_check_failed) {"));
    for (const html of [today, review]) for (const js of scriptsOf(html)) if (js.trim()) new Function(js); // eslint-disable-line no-new-func
    new Function(dash); // eslint-disable-line no-new-func
  });

  it("the Knowledge capture shows the response's note (raw text saved over the cap)", () => {
    const k = renderPage("../pages/knowledge");
    assert.ok(k.includes("(r.note ? ' ' + esc(r.note) : '')"));
    for (const js of scriptsOf(k)) if (js.trim() && !/^\s*import /m.test(js)) new Function(js); // eslint-disable-line no-new-func
  });
});
