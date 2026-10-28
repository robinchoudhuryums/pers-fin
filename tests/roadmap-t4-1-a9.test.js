// Roadmap T4.1 A9 — sinking funds and subscription consolidation
// (services/advice.js): sinkingFunds (a yearly / quarterly detected
// subscription or manual bill of $100+, its next date by the app's own cadence
// rules, the monthly set-aside rounded up to the dollar until then and the
// steady amount after, a bill due within a month, soonest first, at most 8;
// monthly / small / stale-free bills left out); subscriptionReview (two or more
// services in one group — "keeping one would save $X to $Y a month" — word
// boundaries, a service counted once; a membership with no other purchase from
// its store in 90 days, the fee itself not counted, a new membership or Prime
// Video left out); the plan's fields and a failing read; the readers' SQL; the
// card, the prompt block and Ask.
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://localhost/test";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const a = require("../teller/services/advice");
const cadence = require("../teller/services/cadence");

const TODAY = "2026-10-28";
const MONTHS = ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"].map((m) => ({ month: m, income: 6000, spending: 2800 }));
const sub = (id, name, amount, cadence_days, over = {}) => ({
  id, display_name: name, amount, cadence_days, first_seen: "2025-01-01", last_charged: "2026-10-10", next_expected: "2026-11-10", category: "subscription", ...over,
});
const SOURCE = () => ({
  subs: [
    sub(1, "Netflix", 15.49, 30),
    sub(2, "Hulu", 7.99, 30),
    sub(3, "MAX.COM", 16.99, 30),
    sub(4, "Spotify", 11.99, 30),
    sub(5, "Amazon Prime", 139, 365, { last_charged: "2026-03-01", next_expected: "2027-03-01" }),
    sub(6, "Car Insurance", 450, 90, { last_charged: "2026-09-15", next_expected: "2026-12-15" }),
    sub(7, "Domain Renewal", 120, 365, { last_charged: "2025-11-02", next_expected: "2026-11-02" }),
    sub(8, "App Store", 29.99, 365, { last_charged: "2026-01-20", next_expected: "2027-01-20" }),
  ],
  bills: [{ id: 9, name: "Property Tax", amount: 2400, due_day: 15, cadence: "yearly", category: "bill", created_at: "2026-01-05" }],
  activity: [{ merchant: "amazon", amount: 139, date: "2026-09-01" }],
});

function inputs(over = {}) {
  return {
    today: TODAY, errors: [],
    months: MONTHS, streams: [],
    cash: { starting_balance: 15000, lowest: { date: "2026-11-20", balance: 14000 } },
    settings: { cash_alert_threshold: "500" },
    debts: [], activity: [], transfers: [], goals: [], deposits: [], categories: [],
    idle: { accounts: [], investments: [], snapshots: [] },
    allocation: { total_value: 0, has_targets: false, classes: [] },
    subscriptions: SOURCE(),
    ...over,
  };
}
const plan = (over) => a.buildAdvicePlan(inputs(over));

// ---------------------------------------------------------------------------
describe("T4.1 A9 — sinking funds", () => {
  it("each quarterly / yearly bill of $100+: its next date, the set-aside until then and after, soonest first", () => {
    const bills = a.sinkingFunds(SOURCE(), TODAY);
    assert.deepEqual(bills.map((b) => [b.name, b.due, b.months_until, b.monthly, b.steady_monthly]), [
      ["Domain Renewal", "2026-11-02", 1, 120, 10],
      ["Car Insurance", "2026-12-15", 2, 225, 150],
      ["Property Tax", "2027-01-15", 3, 800, 200],
      ["Amazon Prime", "2027-03-01", 5, 28, 12],
    ]);
    assert.equal(bills[0].text, "Domain Renewal: $120.00 (a year) is due Nov 2, 2026 — keep it ready, then set aside $10.00 a month for the next one.");
    assert.equal(bills[1].text, "Car Insurance: $450.00 (4 times a year) is due Dec 15, 2026 — set aside $225.00 a month until then, then $150.00 a month.");
    assert.equal(bills[2].kind, "manual_bill");
    assert.equal(bills[2].per_year, 1);
  });

  it("the dates come from the app's cadence rules (INV-70)", () => {
    const [car] = a.sinkingFunds({ subs: [sub(6, "Car Insurance", 450, 90, { last_charged: "2026-09-15", next_expected: "2026-12-15" })] }, TODAY);
    assert.equal(car.due, cadence.seriesOccurrences("2026-09-15", "2026-12-15", 90, TODAY, "2027-12-31")[0]);
    const bill = { id: 9, name: "Tax", amount: 2400, due_day: 31, cadence: "quarterly", created_at: "2026-01-05" };
    const [tax] = a.sinkingFunds({ bills: [bill] }, TODAY);
    assert.equal(tax.due, cadence.manualBillOccurrences(bill, TODAY, "2027-12-31")[0]);
    assert.equal(tax.due, "2026-10-31");
    assert.equal(tax.per_year, 4);
    // A stale stored next_expected is projected from today, not dropped.
    const [late] = a.sinkingFunds({ subs: [sub(7, "Domain", 120, 365, { last_charged: "2025-10-01", next_expected: "2026-10-01" })] }, TODAY);
    assert.equal(late.due, "2027-10-01");
  });

  it("left out: monthly subscriptions, a bill under $100, a monthly manual bill; capped at 8", () => {
    const bills = a.sinkingFunds({ subs: [sub(1, "Netflix", 15.49, 30), sub(8, "App Store", 29.99, 365), sub(2, "Gym", 150, 60)],
      bills: [{ id: 1, name: "Rent", amount: 2000, due_day: 1, cadence: "monthly", created_at: "2026-01-01" }] }, TODAY);
    assert.deepEqual(bills, []);
    const many = Array.from({ length: 12 }, (_, i) => sub(i + 1, "Bill " + i, 200 + i, 365, { last_charged: `2026-0${(i % 9) + 1}-10`, next_expected: `2027-0${(i % 9) + 1}-10` }));
    assert.equal(a.sinkingFunds({ subs: many }, TODAY).length, a.SINKING_MAX);
  });

  it("in the plan: the steady total and its sentence; none → empty; a failing read → null with its sentence", async () => {
    const p = plan();
    assert.equal(p.sinking_funds.total_monthly, 10 + 150 + 200 + 12);
    assert.equal(p.sinking_funds.text, "Your 4 quarterly or yearly bills come to about $372.00 a month — set that aside so each is covered when it comes due.");
    assert.deepEqual(plan({ subscriptions: { subs: [], bills: [], activity: [] } }).sinking_funds, { bills: [], total_monthly: 0, text: null });
    const quietly = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
    const deps = Object.fromEntries(Object.entries(inputs()).filter(([k]) => a.SOURCE_ERRORS[k]).map(([k, v]) => [k, async () => v]));
    deps.subscriptions = async () => { throw new Error("x"); };
    const fp = a.buildAdvicePlan(await quietly(() => a.getAdviceInputs({}, { today: TODAY, deps })));
    assert.equal(fp.ok, true);
    assert.equal(fp.sinking_funds, null);
    assert.equal(fp.subscription_review, null);
    assert.deepEqual(fp.errors, [{ source: "subscriptions", error: "Your subscriptions and bills couldn't be read." }]);
  });
});

// ---------------------------------------------------------------------------
describe("T4.1 A9 — subscription consolidation", () => {
  it("overlapping services: keeping one saves the total less the priciest to the total less the cheapest", () => {
    const r = a.subscriptionReview(SOURCE(), TODAY);
    assert.equal(r.overlaps.length, 1, "Spotify alone isn't an overlap");
    const o = r.overlaps[0];
    assert.equal(o.group, "video");
    assert.deepEqual(o.services.map((s) => s.name), ["MAX.COM", "Netflix", "Hulu"]);
    assert.equal(o.total_monthly, 40.47);
    assert.equal(o.save_min_monthly, 23.48);
    assert.equal(o.save_max_monthly, 32.48);
    assert.equal(o.text, "You pay for 3 video streaming services (MAX.COM, Netflix, Hulu) — $40.47 a month. Keeping just one would save $23.48 to $32.48 a month.");
  });

  it("word boundaries, the monthly equivalent and one group per service", () => {
    const r = a.subscriptionReview({ subs: [
      sub(1, "Maxwell Fitness", 30, 30), sub(2, "Hulu", 7.99, 30), sub(3, "Disney+ Annual", 139.99, 365),
      sub(4, "iCloud+", 2.99, 30), sub(5, "Google One", 19.99, 365),
    ] }, TODAY);
    assert.deepEqual(r.overlaps.map((o) => [o.group, o.services.map((s) => [s.name, s.monthly])]), [
      ["video", [["Disney+ Annual", 11.51], ["Hulu", 7.99]]],
      ["cloud", [["iCloud+", 2.99], ["Google One", 1.64]]],
    ]);
    assert.match(r.overlaps[1].text, /would save \$1\.64 to \$2\.99 a month\.$/);
    // A bundle in two groups counts in the first only.
    const b = a.subscriptionReview({ subs: [sub(1, "Hulu Spotify Bundle", 19.99, 30), sub(2, "Netflix", 15.49, 30), sub(3, "Spotify", 11.99, 30)] }, TODAY);
    assert.deepEqual(b.overlaps.map((o) => o.group), ["video"]);
  });

  it("a membership with no other purchase from its store in 90 days; the fee itself doesn't count", () => {
    const r = a.subscriptionReview(SOURCE(), TODAY);
    assert.deepEqual(r.unused.map((u) => [u.name, u.store, u.monthly]), [["Amazon Prime", "Amazon", 11.42]]);
    assert.equal(r.unused[0].text, "Amazon Prime costs $11.42 a month, and there were no other Amazon purchases in the last 90 days — worth checking you still use it.");
    assert.equal(r.save_max_monthly, 32.48 + 11.42);
  });

  it("not flagged: a purchase in the window, an older one, a new membership, Prime Video, a non-membership", () => {
    const base = SOURCE();
    const used = a.subscriptionReview({ ...base, activity: [{ merchant: "amazon.com", amount: 42.1, date: "2026-10-01" }] }, TODAY);
    assert.deepEqual(used.unused, []);
    const old = a.subscriptionReview({ ...base, activity: [{ merchant: "amazon", amount: 42.1, date: "2026-07-01" }] }, TODAY);
    assert.equal(old.unused.length, 1, "a purchase before the 90 days doesn't count");
    const fresh = a.subscriptionReview({ subs: [sub(5, "Amazon Prime", 14.99, 30, { first_seen: "2026-09-01" })], activity: [] }, TODAY);
    assert.deepEqual(fresh.unused, []);
    const video = a.subscriptionReview({ subs: [sub(5, "Amazon Prime Video", 8.99, 30)], activity: [] }, TODAY);
    assert.deepEqual(video.unused, []);
    const costco = a.subscriptionReview({ subs: [sub(6, "COSTCO MEMBERSHIP", 65, 365)], activity: [{ merchant: "costco whse #123", amount: 210, date: "2026-10-20" }] }, TODAY);
    assert.deepEqual(costco.unused, []);
    const uberOne = a.subscriptionReview({ subs: [sub(7, "Uber One", 9.99, 30)], activity: [{ merchant: "uber trip", amount: 9.99, date: "2026-10-20" }] }, TODAY);
    assert.equal(uberOne.unused.length, 1, "a $9.99 Uber charge is the fee, not a purchase");
  });

  it("in the plan", () => {
    const p = plan();
    assert.equal(p.subscription_review.overlaps.length, 1);
    assert.equal(p.subscription_review.unused.length, 1);
  });
});

// ---------------------------------------------------------------------------
describe("T4.1 A9 — the readers and the surfaces", () => {
  it("the readers: active, not cancelled or dismissed; quarterly / yearly manual bills; 90 days of store purchases", async () => {
    const seen = [];
    const pool = { query: async (sql, params) => { seen.push({ sql: sql.replace(/\s+/g, " "), params }); return { rows: [] }; } };
    const deps = Object.fromEntries(Object.keys(a.SOURCE_ERRORS).filter((k) => k !== "subscriptions").map((k) => [k, async () => (k === "cash" ? { starting_balance: 0 } : [])]));
    const out = await a.getAdviceInputs(pool, { today: TODAY, deps });
    assert.deepEqual(out.errors, []);
    assert.deepEqual(out.subscriptions, { subs: [], bills: [], activity: [] });
    const subs = seen.find((q) => /FROM detected_subscriptions/.test(q.sql));
    assert.match(subs.sql, /WHERE is_active = true AND is_dismissed = false AND cancelled_at IS NULL/);
    assert.match(subs.sql, /last_charged::text AS last_charged, next_expected::text AS next_expected, first_seen::text AS first_seen/);
    assert.match(seen.find((q) => /FROM manual_bills/.test(q.sql)).sql, /is_active = true AND cadence IN \('quarterly', 'yearly'\)/);
    const act = seen.find((q) => /FROM transactions t/.test(q.sql));
    assert.deepEqual(act.params, [TODAY]);
    assert.match(act.sql, /t\.amount > 0 AND t\.pending = false AND t\.date >= \$1::date - 90 AND t\.date <= \$1::date/);
    assert.match(act.sql, /~\* '\\y\(amazon\|amzn\|costco\|walmart\|wal\\-mart\|instacart\|doordash\|uber\|grubhub\)\\y'/);
  });

  it("the card: the sinking-fund total and lines, the overlap and the membership, escaped", () => {
    const dash = read("teller/views/dashboard.ejs");
    const i = dash.indexOf("    var ADVICE_DISCLAIMER"), j = dash.indexOf("    // Design D3: the Summary card + Needs attention");
    const ctx = {
      esc: (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
      fmt: (n) => "$" + Number(n).toFixed(2), emptyState: () => "EMPTY", Number, String, Date, JSON,
    };
    vm.runInNewContext(dash.slice(i, j), ctx);
    const src = SOURCE();
    src.subs[1].display_name = "Hulu <Live>";
    const html = ctx.renderAdvice(plan({ subscriptions: src }));
    assert.match(html, /<li>Your 4 quarterly or yearly bills come to about \$372\.00 a month/);
    assert.match(html, /<li>Car Insurance: \$450\.00 \(4 times a year\) is due Dec 15, 2026/);
    assert.match(html, /<li>You pay for 3 video streaming services \(MAX\.COM, Netflix, Hulu &lt;Live&gt;\)/);
    assert.match(html, /<li>Amazon Prime costs \$11\.42 a month/);
    assert.doesNotMatch(ctx.renderAdvice(plan({ subscriptions: { subs: [], bills: [], activity: [] } })), /quarterly or yearly/);
  });

  it("the insight prompt block carries both", () => {
    const block = require("../teller/routes/insights").cashPlanPromptBlock(plan());
    assert.match(block, /\nSinking funds \(quarterly \/ yearly bills\):\n- Your 4 quarterly or yearly bills come to about \$372\.00 a month.*\n- Domain Renewal: /);
    assert.match(block, /\nSubscriptions to review:\n- You pay for 3 video streaming services .*\n- Amazon Prime costs \$11\.42 a month/);
  });

  it("Ask's get_cash_plan carries them", async () => {
    const real = a.getAdvicePlan;
    const p = plan();
    a.getAdvicePlan = async () => p;
    try {
      const ask = require("../teller/routes/ask");
      const out = await (ask._TOOL_EXECUTORS || ask.TOOL_EXECUTORS).get_cash_plan({});
      assert.deepEqual(out.sinking_funds, p.sinking_funds);
      assert.deepEqual(out.subscription_review, p.subscription_review);
    } finally { a.getAdvicePlan = real; }
  });
});
