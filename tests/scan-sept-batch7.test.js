// ============================================================================
// Broad-scan (Sept 2026) Batch 7 regression tests — AI insights & audit
// ============================================================================
// AIN-9  model prices keyed by model ID (Haiku 4.5 $1/$5, Opus 4.6 $5/$25)
// AIN-10 POST /api/budgets/suggest is capped + charged (entry_type='suggest');
//        one shared monthAiSpendCents() reader
// AIN-1  Tier-1 audit compares only the amount NEAREST a category; budget /
//        benchmark / savings / per-item windows are skipped; the subscription
//        total needs total-phrasing (false-positive set from real outputs)
// AIN-2  Tier-2 ignores months, headings and finance nouns; categories known
// AIN-3  savings-rate + trend tiers use COMPLETE months
// AIN-4  partial current month labelled / dropped in the insight prompt
// AIN-5  anomaly candidate excluded from its own baseline
// AIN-7  unknown credit limit → "Utilization unknown", not 100%
// AIN-8  running summary preserved on max_tokens / missing keys; strict tool;
//        empty insight not stored
// AIN-11 recurring_transfers module toggle honored
// AIN-12 / SXE-7  tax report computed at export time from transactions
// AIN-14 digest alert severities coloured; AIN-16 doc/code alignment
// ============================================================================

delete process.env.APP_TIMEZONE;
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const express = require("express");
const supertest = require("supertest");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
afterEach(() => { dbModule.pool.query = originalQuery; });

const fq = require("../teller/services/financial-queries");
const ref = require("../teller/data/reference-data");

// ---------------------------------------------------------------------------
// AIN-9 — prices
// ---------------------------------------------------------------------------
describe("AIN-9 — model prices keyed by model ID", () => {
  it("Haiku 4.5 is $1/$5 (cache $0.10/$1.25)", () => {
    const r = ref.modelRates("claude-haiku-4-5");
    assert.deepEqual([r.input, r.output, r.cache_read, r.cache_write], [1, 5, 0.1, 1.25]);
  });
  it("Opus 4.6 is $5/$25 (cache $0.50/$6.25)", () => {
    const r = ref.modelRates("claude-opus-4-6");
    assert.deepEqual([r.input, r.output, r.cache_read, r.cache_write], [5, 25, 0.5, 6.25]);
  });
  it("Sonnet 4.6 is $3/$15", () => {
    const r = ref.modelRates("claude-sonnet-4-6");
    assert.deepEqual([r.input, r.output], [3, 15]);
  });
  it("legacy model IDs keep their own historical prices (rows are re-priced at read time)", () => {
    assert.equal(ref.modelRates("claude-3-5-haiku-20241022").input, 0.8);
    assert.equal(ref.modelRates("claude-opus-4-1").input, 15);
  });
  it("a dated snapshot ID resolves to its base model", () => {
    assert.equal(ref.modelRates("claude-haiku-4-5-20251001").input, 1);
  });
  it("granular cost of 1M in + 1M out on Haiku 4.5 = $6", () => {
    const c = ref.estimateCostGranular({ input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, "claude-haiku-4-5");
    assert.ok(Math.abs(c - 6) < 1e-9, String(c));
  });
  it("the family table resolves to the MODEL_MAP model's rates", () => {
    assert.equal(ref.MODEL_COST_PER_M.opus.input, 5);
    assert.equal(ref.MODEL_COST_PER_M.haiku.output, 5);
  });
});

// ---------------------------------------------------------------------------
// AIN-10 — suggest is capped + charged; shared spend reader
// ---------------------------------------------------------------------------
describe("AIN-10 — POST /api/budgets/suggest cap + charge", () => {
  let queue = [];
  let calls = 0;
  class FakeAnthropic {
    constructor() {
      this.messages = { create: async () => { calls++; const r = queue.shift(); if (!r) throw new Error("empty"); return r; } };
    }
  }
  const originalLoad = Module._load;
  before(() => {
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-key";
    Module._load = function (request) {
      if (request === "@anthropic-ai/sdk") return FakeAnthropic;
      return originalLoad.apply(this, arguments);
    };
    delete require.cache[require.resolve("../teller/routes/budgets")];
  });
  after(() => {
    Module._load = originalLoad;
    delete require.cache[require.resolve("../teller/routes/budgets")];
  });

  function mount(state) {
    dbModule.pool.query = async (sql, params) => {
      if (sql.includes("ai_monthly_budget_cents")) return { rows: [{ ai_monthly_budget_cents: state.budget }] };
      if (sql.includes("FROM financial_insights") && sql.includes("date_trunc('month'")) return { rows: state.usage };
      if (sql.includes("INSERT INTO financial_insights")) { state.inserts.push({ sql, params }); return { rows: [] }; }
      if (sql.includes("insights_model")) return { rows: [{ insights_model: "haiku" }] };
      if (sql.includes("FROM budgets")) return { rows: [] };
      if (/AS spent/i.test(sql)) return { rows: [{ category: "Dining", spent: "300" }] };
      return { rows: [] };
    };
    const app = express();
    app.use(express.json());
    app.use(require("../teller/routes/budgets"));
    return app;
  }

  it("429s with no model call once the monthly cap is reached", async () => {
    calls = 0;
    const state = { budget: 50, inserts: [], usage: [{ tokens_used: 0, model_used: "claude-opus-4-6", input_tokens: 2e6, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }] };
    const res = await supertest(mount(state)).post("/api/budgets/suggest");
    assert.equal(res.status, 429);
    assert.equal(calls, 0);
    assert.equal(state.inserts.length, 0);
  });

  it("charges an entry_type='suggest' usage row on a successful call", async () => {
    calls = 0;
    queue = [{ usage: { input_tokens: 400, output_tokens: 120 }, stop_reason: "tool_use",
      content: [{ type: "tool_use", name: "suggest_budgets", input: { suggestions: [{ category: "Dining", monthly_limit: 270, notes: "trim" }] } }] }];
    const state = { budget: 5000, inserts: [], usage: [] };
    const res = await supertest(mount(state)).post("/api/budgets/suggest");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(calls, 1);
    const charge = state.inserts.find(i => /'suggest'/.test(i.sql));
    assert.ok(charge, "a suggest usage row is written");
    assert.equal(charge.params[3], 400);
    assert.equal(charge.params[4], 120);
  });

  it("every cap reader uses the ONE shared monthAiSpendCents()", () => {
    const { monthAiSpendCents } = require("../teller/routes/insights");
    assert.equal(typeof monthAiSpendCents, "function");
    for (const f of ["ask.js", "categorize.js", "housing.js", "budgets.js"]) {
      assert.match(read("teller", "routes", f), /monthAiSpendCents\(/, f);
    }
    const insightsSrc = read("teller", "routes", "insights.js");
    assert.equal((insightsSrc.match(/WHERE created_at >= date_trunc\('month', CURRENT_DATE\)/g) || []).length, 1,
      "the month-spend query exists once, inside monthAiSpendCents");
  });

  it("monthAiSpendCents prices stored tokens at the corrected rates", async () => {
    const { monthAiSpendCents } = require("../teller/routes/insights");
    const db = { query: async () => ({ rows: [{ tokens_used: 0, model_used: "claude-opus-4-6", input_tokens: 1e6, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }] }) };
    assert.equal(Math.round(await monthAiSpendCents(db)), 500); // $5 not $15
  });
});

// ---------------------------------------------------------------------------
// AIN-1 / AIN-2 / AIN-3 — audit precision on correct insights
// ---------------------------------------------------------------------------
describe("AIN-1 / AIN-2 / AIN-3 — audit tiers", () => {
  const { auditInsight, isGenericName, extractMerchantNames } = require("../teller/services/ai-audit");
  const cm = fq.currentMonth();
  const pm = fq.previousMonthKey(cm);
  const ppm = fq.previousMonthKey(pm);

  // Ground truth this month: Food and Drink $450, Shopping $330; 7 subs = $150/mo.
  // Complete months: savings 24% (ppm) and 18% (pm), 21% overall; the partial
  // current month 90%. Total spending: ppm $3,800 → pm $4,100 (UP); current month so far $500.
  function mockAudit() {
    dbModule.pool.query = async (sql) => {
      if (/UPDATE financial_insights|INSERT INTO ai_audit_log/.test(sql)) return { rows: [] };
      if (/COUNT\(\*\) AS cnt/.test(sql)) return { rows: [{ cnt: 7, monthly: 150 }] };
      if (/display_name FROM detected_subscriptions/.test(sql)) return { rows: [{ display_name: "Hulu" }] };
      if (/AS c FROM transactions/.test(sql)) return { rows: [{ c: "food and drink" }, { c: "shopping" }] };
      if (/AS m FROM transactions/.test(sql)) return { rows: [{ m: "costco" }, { m: "netflix" }] };
      if (/financial_goals/.test(sql)) return { rows: [] };
      if (/total_income/.test(sql)) return { rows: [{ month: ppm, total_income: 5000 }, { month: pm, total_income: 5000 }, { month: cm, total_income: 5000 }] };
      if (/total_spend/.test(sql)) return { rows: [{ month: ppm, total_spend: 3800 }, { month: pm, total_spend: 4100 }, { month: cm, total_spend: 500 }] };
      if (/category/.test(sql)) return { rows: [{ category: "Food and Drink", spent: 450 }, { category: "Shopping", spent: 330 }] };
      return { rows: [] };
    };
  }
  async function findingsFor(text) {
    mockAudit();
    return (await auditInsight(text, null)).findings;
  }

  // False-positive set — CORRECT statements shaped like real module outputs.
  const correct = [
    // subscription_audit: per-item prices are not the subscription total
    "Cancel your Hulu subscription ($17.99) to save money.",
    "- **Hulu** ($17.99/mo): you also pay for Netflix ($15.49), consider cancelling one subscription.",
    "Entertainment: cancel Hulu ($17.99) and keep Netflix.",
    // spending_benchmarks: the national-average figure is a benchmark
    "Food and Drink spending hit $450, well above the national average of $275/mo.",
    "Your Food and Drink spend ($450) compares to a typical household's $320.",
    // budget-status: limits and overages are not spend totals
    "Shopping is $120 over your $330 budget.",
    "Shopping: $330 spent of a $210 budget limit.",
    // savings suggestions
    "Cutting Food and Drink by $100 would save $1,200 a year.",
    "Reduce Shopping by $50 to free up cash.",
    // correct totals
    "Food and Drink spending hit $450 this month.",
    "You spent $330 on shopping.",
    "Your 7 subscriptions total $150/mo.",
    // savings rate (AIN-3) — complete months 24% / 18%, overall 21%
    "Your savings rate averaged 21% over the last six months.",
    "Last month your savings rate was 18%.",
    "Your savings rate is 18%.",
    // trend (AIN-3) — last complete month is UP
    "Overall spending is up compared with the prior month.",
    // headings / months / finance nouns (AIN-2)
    "- **Spending trend**: March was higher than February.\n- **Emergency fund**: keep building it.\n- **Debt**: pay down the card.",
    "Move $200 to Emergency fund in October.",
  ];
  for (const t of correct) {
    it(`no finding on a correct insight: ${JSON.stringify(t).slice(0, 70)}`, async () => {
      const f = await findingsFor(t);
      assert.deepEqual(f.map(x => `${x.severity}:${x.check}:${x.claim}`), []);
    });
  }

  // True positives stay caught.
  it("a wrong category total is still CRITICAL", async () => {
    const f = await findingsFor("Food and Drink spending hit $900 this month.");
    assert.equal(f.length, 1);
    assert.equal(f[0].severity, "critical");
    assert.equal(f[0].check, "arithmetic");
  });
  it("a closed parenthetical between name and amount still attributes", async () => {
    const f = await findingsFor("Food and Drink (this month): $900");
    assert.equal(f[0]?.check, "arithmetic");
    assert.deepEqual(await findingsFor("Shopping (Amazon $45, Target $30) is your top area."), []);
  });
  it("'$X on <category>' is attributed", async () => {
    const f = await findingsFor("You spent $800 on shopping.");
    assert.equal(f[0]?.check, "arithmetic");
  });
  it("a wrong subscription TOTAL is still CRITICAL", async () => {
    const f = await findingsFor("Your 7 subscriptions total $400 per month.");
    assert.equal(f[0]?.check, "subscription_total");
    assert.equal(f[0]?.severity, "critical");
  });
  it("a wrong savings rate is still CRITICAL against the complete months", async () => {
    const f = await findingsFor("Your savings rate is 50%.");
    assert.equal(f[0]?.check, "savings_rate");
    assert.equal(f[0]?.expected, "21%");
  });
  it("an explicit this-month savings rate is checked against the partial month", async () => {
    assert.deepEqual(await findingsFor("Your savings rate is 90% this month."), []);
    const f = await findingsFor("Your savings rate is 20% this month.");
    assert.equal(f[0]?.expected, "90%");
  });
  it("a wrong overall trend is still flagged (complete months)", async () => {
    const f = await findingsFor("Overall spending is down.");
    assert.equal(f[0]?.check, "trend_direction");
  });
  it("an unknown merchant with a dollar heading is still flagged", async () => {
    const f = await findingsFor("- **Zorblax**: $30/mo");
    assert.equal(f[0]?.check, "entity_existence");
  });

  it("heading bullets only capture when a dollar amount follows", () => {
    const names = extractMerchantNames("- **Spending trend**: up 12%\n- **Netflix**: $15.99/mo");
    assert.deepEqual(names, ["Netflix"]);
  });
  it("isGenericName", () => {
    for (const n of ["March was", "February", "Spending trend", "Emergency fund", "Debt", "Your budget"]) assert.equal(isGenericName(n), true, n);
    for (const n of ["Netflix", "Costco Wholesale", "Hulu subscription"]) assert.equal(isGenericName(n), false, n);
  });
});

// ---------------------------------------------------------------------------
// generateInsights harness (fake SDK + mock pool) — AIN-4/5/7/8/11/12
// ---------------------------------------------------------------------------
describe("generateInsights — prompt + memory + tax persistence", () => {
  let queue = [];
  let sent = [];
  class FakeAnthropic {
    constructor() {
      this.messages = { create: async (req) => { sent.push(req); const r = queue.shift(); if (!r) throw new Error("empty"); return r; } };
    }
  }
  const originalLoad = Module._load;
  const persistent = require("../teller/routes/persistent");
  const origWebhook = persistent.sendPerSistantWebhook;
  let webhooks = [];
  before(() => {
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-key";
    Module._load = function (request) {
      if (request === "@anthropic-ai/sdk") return FakeAnthropic;
      return originalLoad.apply(this, arguments);
    };
    delete require.cache[require.resolve("../teller/routes/insights")];
    persistent.sendPerSistantWebhook = async (event, payload) => { webhooks.push({ event, payload }); return { sent: true }; };
  });
  after(() => {
    Module._load = originalLoad;
    delete require.cache[require.resolve("../teller/routes/insights")];
    persistent.sendPerSistantWebhook = origWebhook;
  });

  const cm = fq.currentMonth();
  const pm = fq.previousMonthKey(cm);
  const ppm = fq.previousMonthKey(pm);
  const prior = { trends: [{ category: "Dining", direction: "up", magnitude: "+10%", since_when: "May" }], completed_goals: [], pending_actions: [{ description: "Cancel Hulu", urgency: "low", first_recommended: "May" }], alerts: [] };

  function toolReply(input, stop = "tool_use") {
    return { model: "claude-haiku-4-5", stop_reason: stop, usage: { input_tokens: 1000, output_tokens: 300 },
      content: [{ type: "tool_use", name: "generate_financial_insight", input }] };
  }

  async function run({ modules = {}, reply, extra } = {}) {
    queue = [reply || toolReply({ insights_text: "- Spending is steady.", summary: prior })];
    sent = []; webhooks = [];
    const st = { inserts: [], updates: [], sql: [], deletes: [] };
    dbModule.pool.query = async (sql, params) => {
      st.sql.push({ sql, params });
      if (extra) { const r = extra(sql, params); if (r) return r; }
      if (sql.includes("ai_monthly_budget_cents")) return { rows: [{ ai_monthly_budget_cents: 5000 }] };
      if (sql.includes("FROM financial_insights") && sql.includes("date_trunc('month'")) return { rows: [] };
      if (/total_spend/.test(sql)) return { rows: [
        { month: ppm, total_spend: "3000", txn_count: 50 }, { month: pm, total_spend: "3300", txn_count: 55 }, { month: cm, total_spend: "400", txn_count: 6 }] };
      if (/total_income/.test(sql)) return { rows: [{ month: pm, total_income: "5000" }, { month: cm, total_income: "5000" }] };
      if (sql.includes("insight_modules FROM user_settings")) return { rows: [{ insights_model: "haiku", insight_modules: modules, insights_running_summary_json: prior, insights_running_summary: "x" }] };
      if (sql.includes("INSERT INTO financial_insights")) { st.inserts.push({ sql, params }); return { rows: [{ id: 77 }] }; }
      if (/UPDATE user_settings SET insights_running_summary/.test(sql)) { st.updates.push({ sql, params }); return { rows: [] }; }
      if (/DELETE FROM tax_deductions/.test(sql)) { st.deletes.push({ sql, params }); return { rows: [] }; }
      if (/COUNT\(\*\) AS cnt/.test(sql)) return { rows: [{ cnt: 0, monthly: 0 }] };
      return { rows: [] };
    };
    const { generateInsights } = require("../teller/routes/insights");
    const result = await generateInsights();
    return { result, st, userMsg: sent[0] ? sent[0].messages[0].content : "", req: sent[0] };
  }

  it("AIN-4: the current month is labelled partial and kept out of the deltas + seasonal history", async () => {
    const { result, st, userMsg } = await run();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(userMsg, new RegExp(cm + " \\(partial, through day \\d\\d\\)"));
    const deltas = userMsg.split("=== SPENDING TREND DELTAS")[1] || "";
    assert.match(deltas, new RegExp(pm + ": \\+\\$300\\.00 \\(\\+10%\\)"));
    assert.doesNotMatch(deltas.split("===")[1] || deltas, new RegExp(cm + ":"));
    const seasonal = st.sql.find(q => /AS month_name/.test(q.sql));
    assert.ok(seasonal, "seasonal query ran");
    assert.match(seasonal.sql, /t\.date < \$1::date/);
    assert.deepEqual(seasonal.params, [cm + "-01"]);
  });

  it("AIN-5: the anomaly baseline excludes the candidate's own row", async () => {
    const { st } = await run();
    const q = st.sql.find(x => /avg_tbl/.test(x.sql));
    assert.match(q.sql, /CROSS JOIN LATERAL/);
    assert.match(q.sql, /t2\.transaction_id <> t\.transaction_id/);
    assert.match(q.sql, /avg_tbl\.txn_count >= 3/);
  });

  it("AIN-7: an unknown credit limit is 'Utilization unknown', a manual limit counts", async () => {
    const { userMsg } = await run({ extra: (sql) => {
      if (/WHERE type = 'credit'/.test(sql)) return { rows: [
        { name: "Discover", mask: "1111", current_balance: "900", available_balance: null, credit_limit: null, apr: null },
        { name: "Chase", mask: "2222", current_balance: "500", available_balance: null, credit_limit: "5000", apr: "22" },
      ] };
      return null;
    } });
    assert.match(userMsg, /Discover \(\*\*\*\*1111\): Balance \$900\.00, Limit unknown, Utilization unknown/);
    assert.doesNotMatch(userMsg, /Utilization 100%/);
    assert.match(userMsg, /Chase \(\*\*\*\*2222\): Balance \$500\.00, Limit \$5000\.00, Utilization 10%/);
    assert.match(userMsg, /Total credit limit \(cards with a known limit\): \$5000\.00/);
    assert.match(userMsg, /Overall utilization \(cards with a known limit\): 10%/);
  });

  it("AIN-8: the insight tool is strict with additionalProperties:false on every object", () => {
    const { INSIGHT_TOOL } = require("../teller/routes/insights");
    assert.equal(INSIGHT_TOOL.strict, true);
    const walk = (o) => { if (o && o.type === "object") assert.equal(o.additionalProperties, false); for (const v of Object.values(o.properties || {})) walk(v); if (o.items) walk(o.items); };
    walk(INSIGHT_TOOL.input_schema);
  });

  it("AIN-8: sanitizeStructuredSummary requires all four arrays", () => {
    const { sanitizeStructuredSummary } = require("../teller/routes/insights");
    assert.equal(sanitizeStructuredSummary({}), null);
    assert.equal(sanitizeStructuredSummary({ trends: [], completed_goals: [], pending_actions: [] }), null);
    assert.equal(sanitizeStructuredSummary({ trends: [], completed_goals: [], pending_actions: [], alerts: "x" }), null);
    assert.equal(sanitizeStructuredSummary([]), null);
    const ok = sanitizeStructuredSummary({ trends: [{ category: "Dining", direction: "sideways" }], completed_goals: [], pending_actions: [], alerts: [{ message: "m", severity: "bogus" }], extra: 1 });
    assert.deepEqual(Object.keys(ok), ["trends", "completed_goals", "pending_actions", "alerts"]);
    assert.equal(ok.trends[0].direction, "stable");
    assert.equal(ok.alerts[0].severity, "info");
  });

  it("AIN-8: summary {} keeps prior memory (preserved_validation_failed)", async () => {
    const { result, st } = await run({ reply: toolReply({ insights_text: "- ok", summary: {} }) });
    assert.equal(result.summary_status, "preserved_validation_failed");
    assert.equal(st.updates.length, 0, "running summary not overwritten");
  });

  it("AIN-8: a max_tokens stop inside the tool block keeps prior memory", async () => {
    const { result, st } = await run({ reply: toolReply({ insights_text: "- ok", summary: { trends: [], completed_goals: [], pending_actions: [], alerts: [] } }, "max_tokens") });
    assert.equal(result.summary_status, "preserved_due_to_truncation");
    assert.equal(st.updates.length, 0);
  });

  it("AIN-8: empty insight text is charged but not stored, audited or emailed", async () => {
    const { result, st } = await run({ reply: { model: "claude-haiku-4-5", stop_reason: "end_turn", usage: { input_tokens: 900, output_tokens: 5 }, content: [] } });
    assert.equal(result.ok, false);
    assert.equal(result.status, 502);
    assert.equal(st.inserts.length, 1);
    assert.match(st.inserts[0].sql, /'insight_empty'/);
    assert.equal(st.inserts[0].params[3], 900);
    assert.equal(webhooks.length, 0, "no email");
    assert.ok(!st.sql.some(q => /INSERT INTO ai_audit_log|SET audited_at/.test(q.sql)), "not audited");
  });

  it("AIN-11: recurring_transfers=false skips the module", async () => {
    const off = await run({ modules: { recurring_transfers: false } });
    assert.ok(!off.st.sql.some(q => /FROM recurring_transfers/.test(q.sql)));
    assert.ok(!off.result.modules_used.includes("recurring_transfers"));
    const on = await run({ extra: (sql) => /FROM recurring_transfers/.test(sql)
      ? { rows: [{ display_name: "Vanguard", amount: "500", cadence_days: 30, transfer_type: "investment", direction: "outgoing" }] } : null });
    assert.ok(on.result.modules_used.includes("recurring_transfers"));
    assert.match(on.userMsg, /=== RECURRING TRANSFERS ===/);
  });

  it("AIN-12: tax persistence covers every match (no top-15 cap) and prunes stale auto rows", async () => {
    const txns = [];
    for (let i = 0; i < 20; i++) txns.push({ transaction_id: "t" + i, date: "2026-02-0" + ((i % 9) + 1), merchant: "Dental Office " + i, amount: String(10 + i) });
    const { st, userMsg } = await run({ extra: (sql) => /make_date\(\$1, 1, 1\)/.test(sql) ? { rows: txns } : null });
    const upserts = st.sql.filter(q => /INSERT INTO tax_deductions/.test(q.sql));
    assert.equal(upserts.length, 20, "all 20 merchants persisted");
    assert.equal(st.deletes.length, 1, "stale-row prune issued");
    assert.match(st.deletes[0].sql, /is_confirmed = false/);
    assert.equal(st.deletes[0].params[1].length, 20);
    const promptLines = (userMsg.split("=== POTENTIAL TAX-DEDUCTIBLE TRANSACTIONS (YTD) ===\n")[1] || "").split("\n\n")[0].split("\n");
    assert.equal(promptLines.length, 15, "the prompt still gets a top-15 summary");
  });
});

// ---------------------------------------------------------------------------
// AIN-8 rebuild, AIN-14 digest colours, AIN-16 empty weekly digest
// ---------------------------------------------------------------------------
describe("AIN-8 / AIN-14 / AIN-16 — rebuild + digest", () => {
  it("rebuild never writes a summary from a max_tokens stop", () => {
    const src = read("teller", "routes", "insights.js");
    const block = src.slice(src.indexOf('router.post("/api/insights/rebuild"'));
    const stopIdx = block.indexOf('message.stop_reason === "max_tokens"');
    const updIdx = block.indexOf("UPDATE user_settings SET insights_running_summary");
    const chargeIdx = block.indexOf("'rebuild'");
    assert.ok(stopIdx > 0 && updIdx > stopIdx, "max_tokens guard precedes the summary write");
    assert.ok(chargeIdx > 0 && chargeIdx < stopIdx, "the cap charge still precedes the guard (AIA2)");
  });

  it("weekly digest colours alert severities (critical red, warning amber)", () => {
    const { renderWeeklyDigestEmail } = require("../teller/routes/insights-email");
    const html = renderWeeklyDigestEmail({ trends: [], pending_actions: [], completed_goals: [], alerts: [
      { message: "Over budget", severity: "critical" }, { message: "Close to limit", severity: "warning" }, { message: "FYI", severity: "info" }] }, null);
    assert.match(html, /color:#eb6b6b;">Over budget/);
    assert.match(html, /color:#f0c36d;">Close to limit/);
    assert.match(html, /color:#9fd4c9;">FYI/);
  });

  it("an all-empty running summary sends no weekly digest", async () => {
    dbModule.pool.query = async () => ({ rows: [{ weekly_digest_enabled: true, last_weekly_digest_at: null,
      insights_running_summary_json: { trends: [], completed_goals: [], pending_actions: [], alerts: [] } }] });
    const { runWeeklyDigest } = require("../teller/routes/insights");
    const r = await runWeeklyDigest();
    assert.deepEqual(r, { sent: false, reason: "empty_summary" });
  });
});

// ---------------------------------------------------------------------------
// SXE-7 / AIN-12 — tax report computed at export time
// ---------------------------------------------------------------------------
describe("SXE-7 — tax report from transactions", () => {
  function mount(txns, notes) {
    dbModule.pool.query = async (sql, params) => {
      if (/make_date\(\$1, 1, 1\)/.test(sql)) { assert.equal(params[0], 2026); return { rows: txns }; }
      if (/FROM tax_deductions/.test(sql)) return { rows: notes };
      return { rows: [] };
    };
    delete require.cache[require.resolve("../teller/routes/settings")];
    const app = express();
    app.use(express.json());
    app.use(require("../teller/routes/settings"));
    return app;
  }
  const txns = [];
  for (let i = 1; i <= 18; i++) txns.push({ transaction_id: "x" + i, date: `2026-12-${String(i).padStart(2, "0")}`, merchant: i === 1 ? "CVS Pharmacy" : "Clinic Medical " + i, amount: "10.00" });
  txns.push({ transaction_id: "s1", date: "2026-03-01", merchant: "Navient Student Loan Interest", amount: "45.50" });

  it("JSON lists every matching transaction (no 15-merchant cap), dated, grouped by derived category", async () => {
    const res = await supertest(mount(txns, [])).get("/api/export/tax-report?year=2026&format=json");
    assert.equal(res.status, 200);
    assert.equal(res.body.item_count, 19);
    assert.equal(res.body.grand_total, 225.5);
    assert.equal(res.body.categories.medical.items.length, 18);
    assert.equal(res.body.categories.tax.items[0].txn_date, "2026-03-01");
    assert.equal(res.body.categories.tax.items[0].merchant, "Navient Student Loan Interest");
  });

  it("merchant annotations (confirmed / notes / category) apply to that merchant's rows", async () => {
    const res = await supertest(mount(txns, [{ merchant: "cvs pharmacy", category: "health-hsa", is_confirmed: true, notes: "Rx" },
      { merchant: "Clinic Medical 2", category: "flagged", is_confirmed: false, notes: null }])).get("/api/export/tax-report?year=2026&format=json");
    const cvs = res.body.categories["health-hsa"].items[0];
    assert.equal(cvs.merchant, "CVS Pharmacy");
    assert.equal(cvs.is_confirmed, true);
    assert.equal(cvs.notes, "Rx");
    assert.ok(res.body.categories.medical.items.some(i => i.merchant === "Clinic Medical 2"), "'flagged' is not a user category");
  });

  it("CSV carries the transaction date", async () => {
    const res = await supertest(mount(txns.slice(0, 1), [])).get("/api/export/tax-report?year=2026");
    assert.equal(res.status, 200);
    assert.match(res.text, /^Tax Year,Date,Merchant/);
    assert.match(res.text, /\n2026,2026-12-01,"CVS Pharmacy",10\.00,"medical"/);
  });

  it("the shared query: whole calendar year, display merchant, split-adjusted, reimbursed out, tax regex", async () => {
    let seen;
    const rows = await fq.getTaxDeductionTransactions({ query: async (sql, params) => { seen = { sql, params }; return { rows: [{ merchant: "Office Depot #4", amount: "12.00" }] }; } }, 2025);
    assert.equal(rows[0].category, "business");
    assert.deepEqual(seen.params, [2025, fq.TAX_REGEX]);
    assert.match(seen.sql, /make_date\(\$1 \+ 1, 1, 1\)/);
    assert.match(seen.sql, /COALESCE\(t\.is_reimbursed, false\) = false/);
    assert.ok(seen.sql.includes(fq.SPLIT_AMOUNT));
    assert.doesNotMatch(seen.sql, /LIMIT/);
  });

  it("taxCategoryFor: longest phrase wins", () => {
    assert.equal(fq.taxCategoryFor("Student Loan Interest"), "tax");
    assert.equal(fq.taxCategoryFor("Navient Student Loan"), "education");
    assert.equal(fq.taxCategoryFor("Red Cross Donation"), "charity");
  });

  it("the Sheets tab mirrors the canonical keyword groups + query (pinned)", () => {
    const ss = read("scripts", "sheets-sync.js");
    const m = ss.match(/const TAX_KEYWORD_GROUPS = (\{[\s\S]*?\n\});/);
    assert.ok(m, "sheets-sync TAX_KEYWORD_GROUPS present");
    // eslint-disable-next-line no-new-func
    const groups = new Function("return " + m[1])();
    assert.deepEqual(groups, fq.TAX_KEYWORD_GROUPS);
    const fn = ss.slice(ss.indexOf("async function syncTaxDeductionsYear"));
    assert.match(fn, /make_date\(\$1 \+ 1, 1, 1\)/);
    assert.match(fn, /COALESCE\(t\.user_merchant_name, t\.merchant_name, t\.name\) ~\* \$2/);
    assert.match(fn, /COALESCE\(t\.is_reimbursed, false\) = false/);
    assert.doesNotMatch(fn.slice(0, fn.indexOf("ensureSheet")), /LIMIT/);
    // the prior year is refreshed through April
    assert.match(ss, /parseInt\(today\.slice\(5, 7\), 10\) <= 4 \? \[year, year - 1\] : \[year\]/);
  });
});
