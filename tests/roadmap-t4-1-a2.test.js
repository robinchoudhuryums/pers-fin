// ============================================================================
// Roadmap T4.1 A2 — GET /api/advice, the dashboard "Your plan" card, Ask's
// get_cash_plan
// ============================================================================
// The route hands over services/advice.js's plan (an ok:false plan is still a
// 200; a throw a fixed 500); the card's renderers run in a vm from
// dashboard.ejs over the REAL engine's output (headline, why, the steps with
// their current step marked, the per-debt table per paycheck, the snowball
// line, tips, notes, the disclaimer, escaping, the empty state, a plan that
// couldn't be worked out, a failed load); the widget key sits in page order;
// Ask's tool returns the engine's figures, trimmed. The real-Postgres half is
// tests/contract/advice-a1.contract.test.js (its route test).
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
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
function slice(src, start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, "slice markers: " + start);
  return src.slice(i, j);
}
const advice = require("../teller/services/advice");
const dash = read("teller/views/dashboard.ejs");

// A real plan from the engine: a 24.99% card and a PFC card at an assumed 22%,
// a 0% card on its minimum, a paid-in-full card with a utilization tip.
function realPlan(over = {}) {
  return advice.buildAdvicePlan({
    today: "2026-10-27",
    errors: [],
    months: [{ month: "2026-07", income: 5000, spending: 3500 }, { month: "2026-08", income: 5000, spending: 3600 }, { month: "2026-09", income: 5000, spending: 3400 }],
    streams: [{ source: "ACME", amount: 2500, cadence: "semimonthly" }],
    cash: { starting_balance: 15000, lowest: { date: "2026-11-20", balance: 14000 } },
    settings: { cash_alert_threshold: "500" },
    debts: [
      { id: 1, account_id: "c1", name: "Visa <b>", type: "credit", current_balance: "3000", apr: "24.99", minimum_payment: "90" },
      { id: 2, account_id: "c2", name: "Store card", type: "credit", current_balance: "800", apr: null, available_balance: "1200" },
      { id: 3, account_id: "c3", name: "Zero card", type: "credit", current_balance: "2400", apr: "0", minimum_payment: "100" },
      { id: 4, account_id: "c4", name: "Amex", type: "credit", current_balance: "1800", apr: "21", minimum_payment: "40", last_payment_amount: "1650", credit_limit: "3000" },
    ],
    activity: [{ account_id: "c1", txns: 3, interest: true }, { account_id: "c2", txns: 3, interest: true }, { account_id: "c3", txns: 3, interest: true }, { account_id: "c4", txns: 9, interest: false }],
    transfers: [],
    ...over,
  });
}

// The card's code, in a vm with the page's globals stubbed.
function card(extra = {}) {
  const ctx = {
    esc: (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    fmt: (n) => (Number(n) < 0 ? "-$" : "$") + Math.abs(Number(n)).toFixed(2),
    emptyState: (o) => "EMPTY(" + JSON.stringify(o) + ")",
    Number, String, Date, JSON,
    ...extra,
  };
  vm.runInNewContext(slice(dash, "    var ADVICE_DISCLAIMER", "    // Design D3: the Summary card + Needs attention"), ctx);
  return ctx;
}

describe("T4.1 A2 — GET /api/advice", () => {
  const original = advice.getAdvicePlan;
  afterEach(() => { advice.getAdvicePlan = original; });
  const app = () => { const a = express(); a.use(require("../teller/routes/advice")); return a; };

  it("answers the engine's plan", async () => {
    const plan = realPlan();
    advice.getAdvicePlan = async () => plan;
    const body = (await supertest(app()).get("/api/advice").expect(200)).body;
    assert.deepEqual(body, JSON.parse(JSON.stringify(plan)));
  });

  it("a plan that couldn't be worked out is still a 200 with its fixed sentence", async () => {
    advice.getAdvicePlan = async () => ({ ok: false, error: advice.PLAN_ERROR, disclaimer: advice.DISCLAIMER, errors: [{ source: "debts", error: advice.SOURCE_ERRORS.debts }] });
    const body = (await supertest(app()).get("/api/advice").expect(200)).body;
    assert.equal(body.ok, false);
    assert.equal(body.error, advice.PLAN_ERROR);
  });

  it("a throw is a fixed 500 — never the error text", async () => {
    advice.getAdvicePlan = async () => { throw new Error("relation secret_table does not exist"); };
    const err = console.error; console.error = () => {};
    try {
      const res = await supertest(app()).get("/api/advice").expect(500);
      assert.deepEqual(res.body, { error: "An internal error occurred." });
    } finally { console.error = err; }
  });

  it("is mounted in server.js after the dashboard summary", () => {
    const server = read("teller/server.js");
    assert.ok(server.indexOf('require("./routes/advice")') > server.indexOf('require("./routes/dashboard-summary")'));
  });
});

describe("T4.1 A2 — the \"Your plan\" card", () => {
  it("headline, steps with the current one marked, the per-debt table per paycheck, lists and the disclaimer", () => {
    const html = card().renderAdvice(realPlan());
    assert.match(html, /^<p class="advice-headline">Pay down Visa &lt;b&gt; first: \$375\.00 per paycheck on top of its minimum\.<\/p>/);
    assert.match(html, /<li class="is-done"><span class="advice-mark" aria-hidden="true">✓<\/span><span><span class="advice-sr">Done: <\/span>Keep a starter cash buffer<\/span><\/li>/);
    assert.match(html, /<li class="is-current" aria-current="step"><span class="advice-mark" aria-hidden="true">▶<\/span><span><span class="advice-sr">Now: <\/span>Pay off high-interest debt \(APR 8% or more\)<\/span><\/li>/);
    assert.equal((html.match(/aria-current="step"/g) || []).length, 1);
    assert.match(html, /<table class="advice-table responsive-cards"><thead><tr><th scope="col">Debt<\/th>.*<th scope="col" class="num">Pay per paycheck<\/th>/);
    // Visa: minimum + the extra, per paycheck; payoff as a month; interest saved.
    const visa = /<tr><td class="cell-primary" data-label="Debt">Visa &lt;b&gt;<\/td>(.*?)<\/tr>/.exec(html)[1];
    assert.match(visa, /data-label="APR">24\.99%<\/td>/);
    assert.match(visa, /data-label="Balance">\$3000\.00<\/td>/);
    assert.match(visa, /data-label="Pay per paycheck">\$420\.00<\/td>/);
    assert.match(visa, /data-label="Paid off">[A-Z][a-z]{2} 20\d\d<\/td>/);
    assert.match(visa, /data-label="Interest saved">\$\d+\.\d\d<\/td>/);
    // The assumed APR says so; a debt on its minimum shows no "interest saved".
    const store = /<tr><td class="cell-primary" data-label="Debt">Store card<\/td>(.*?)<\/tr>/.exec(html)[1];
    assert.match(store, /data-label="APR">22% \(assumed\)<\/td>/);
    assert.match(store, /data-label="Interest saved">—<\/td>/);
    assert.ok(html.includes("Zero card"), "the 0% card is listed on its minimum");
    assert.ok(!/<td class="cell-primary" data-label="Debt">Amex/.test(html), "a card paid in full isn't a debt row");
    assert.match(html, /<li>Paying \$900\.00 on Amex before its due date brings it under 30% of its limit\.<\/li>/);
    assert.match(html, /<li>Paying the smallest balance first instead/);
    assert.match(html, /<li>Store card: APR unknown — assumed 22%; set it on the card\.<\/li>/);
    assert.match(html, /<p class="advice-disclaimer">Educational, based on your data — not financial advice\.<\/p>$/);
  });

  it("money colours: red only for a minimum that never pays a debt off; no inline colours", () => {
    const html = card().renderAdvice(realPlan());
    assert.doesNotMatch(html, /amt-bad|style=/);
    const never = realPlan({
      months: [{ month: "2026-07", income: 5000, spending: 4900 }, { month: "2026-08", income: 5000, spending: 4900 }, { month: "2026-09", income: 5000, spending: 4900 }],
      debts: [{ id: 9, account_id: "c9", name: "Huge", type: "credit", current_balance: "20000", apr: "29", minimum_payment: "300" }],
      activity: [{ account_id: "c9", txns: 3, interest: true }],
    });
    assert.match(card().renderAdvice(never), /data-label="Paid off"><span class="amt-bad">Minimum never pays it off<\/span><\/td>/);
  });

  it("why is shown when there's no recommendation", () => {
    const p = realPlan({ months: [{ month: "2026-07", income: 5000, spending: 4950 }, { month: "2026-08", income: 5000, spending: 3600 }, { month: "2026-09", income: 5000, spending: 4950 }] });
    assert.match(card().renderAdvice(p), /<p class="advice-why">2 of the last 3 months left less than \$200\.00/);
  });

  it("no history and no debts → the empty state with the next step", () => {
    const p = realPlan({ months: [], debts: [], activity: [] });
    const html = card().renderAdvice(p);
    const opts = JSON.parse(/^EMPTY\((.*)\)<p class="advice-disclaimer">/.exec(html)[1]);
    assert.deepEqual(opts, { title: "Your plan needs more history", text: "Your plan needs 3 complete months of history (0 so far).", action: { label: "Link an account", href: "/accounts" } });
  });

  it("a plan that couldn't be worked out says so, escaped, with the disclaimer", () => {
    const html = card().renderAdvice({ ok: false, error: "Your <plan> couldn't be worked out.", disclaimer: advice.DISCLAIMER });
    assert.equal(html, '<p class="advice-note">Your &lt;plan&gt; couldn\'t be worked out.</p><p class="advice-disclaimer">' + advice.DISCLAIMER + "</p>");
  });

  it("per month when there's no paycheck", () => {
    const html = card().renderAdvice(realPlan({ streams: [] }));
    assert.match(html, /<th scope="col" class="num">Pay per month<\/th>/);
  });

  it("loadAdvice: the plan rendered, a failed or refused load one line; aria-busy removed either way", async () => {
    const body = { innerHTML: "", attrs: { "aria-busy": "true" }, removeAttribute(k) { delete this.attrs[k]; } };
    const plan = realPlan();
    const run = async (apiFetch) => {
      body.innerHTML = ""; body.attrs = { "aria-busy": "true" };
      const c = card({ apiFetch, document: { getElementById: (id) => (id === "advice-body" ? body : null) } });
      await c.loadAdvice();
    };
    await run(async (url) => { assert.equal(url, "/api/advice"); return { ok: true, json: async () => plan }; });
    assert.match(body.innerHTML, /^<p class="advice-headline">/);
    assert.deepEqual(body.attrs, {});
    await run(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    assert.equal(body.innerHTML, '<p class="advice-note">Your plan couldn\'t be loaded.</p>');
    assert.deepEqual(body.attrs, {});
    await run(async () => { throw new Error("offline"); });
    assert.equal(body.innerHTML, '<p class="advice-note">Your plan couldn\'t be loaded.</p>');
  });

  it("the markup: after the review queue, before the charts; loaded after the forecast", () => {
    const body = dash.slice(dash.indexOf("<%- include('partials/nav'"));
    const at = (m) => body.indexOf(m);
    assert.ok(at('id="review-queue-section"') < at('id="advice-section"'));
    assert.ok(at('id="advice-section"') < at('class="charts-grid"'));
    assert.match(dash, /<section class="section" id="advice-section" aria-labelledby="advice-title" style="margin-bottom:28px;">\s*<h2 id="advice-title">Your plan<\/h2>\s*<div id="advice-body" aria-busy="true">/);
    assert.match(dash, /loadForecast\(\);\s+loadAdvice\(\);/);
  });

  it("is a Settings widget toggle, key advice, right after Review Uncategorized", () => {
    const shared = read("teller/public/perfin-shared.js");
    assert.match(shared, /\{ key: 'reviewQueue', [^\n]*\n\s*\{ key: 'advice', label: 'Your Plan', selector: '#advice-section' \},\n\s*\{ key: 'charts'/);
  });
});

describe("T4.1 A2 — Ask's get_cash_plan", () => {
  const ask = require("../teller/routes/ask");
  const original = advice.getAdvicePlan;
  afterEach(() => { advice.getAdvicePlan = original; });

  it("advertised with an executor", () => {
    const t = ask.TOOLS.find((x) => x.name === "get_cash_plan");
    assert.ok(t);
    assert.deepEqual(t.input_schema, { type: "object", properties: {} });
    assert.equal(typeof ask.TOOL_EXECUTORS.get_cash_plan, "function");
  });

  it("returns the engine's figures, trimmed — the model only words them", async () => {
    const plan = realPlan();
    advice.getAdvicePlan = async () => plan;
    const r = await ask.TOOL_EXECUTORS.get_cash_plan({});
    assert.equal(r.ok, true);
    assert.equal(r.disclaimer, advice.DISCLAIMER);
    assert.deepEqual(r.headline, plan.headline);
    assert.deepEqual(r.allocation, plan.allocation);
    assert.deepEqual(r.steps, plan.steps);
    assert.deepEqual(Object.keys(r.debts[0]).sort(), ["apr", "apr_assumed", "balance", "carried", "minimum", "name", "tier", "type", "utilization_pct", "utilization_tip"]);
    assert.equal(r.debts.find((d) => d.name === "Amex").utilization_tip, "Paying $900.00 on Amex before its due date brings it under 30% of its limit.");
    assert.equal("errors" in r, false);
  });

  it("a plan that couldn't be worked out passes its sentence on", async () => {
    advice.getAdvicePlan = async () => ({ ok: false, error: advice.PLAN_ERROR, disclaimer: advice.DISCLAIMER, errors: [] });
    assert.deepEqual(await ask.TOOL_EXECUTORS.get_cash_plan({}), { ok: false, error: advice.PLAN_ERROR, disclaimer: advice.DISCLAIMER });
  });

  it("the system prompt sends plan questions to the tool, with the disclaimer and no securities", () => {
    const src = read("teller/routes/ask.js");
    assert.match(src, /call get_cash_plan and give its figures as they are; say it is educational, not financial " \+\s*"advice, and never name a specific security or fund\. "/);
  });
});
