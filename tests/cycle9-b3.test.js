// ============================================================================
// Cycle 9 Batch 3 — forecast and detection accuracy
// ============================================================================
// F20  one keyword source for both recurring detectors: a row the transfer
//      detector takes is never a subscription charge (unless the user dismissed
//      that transfer); subscription rows keyed on a transfer merchant are retired
// F28  a payday expected today that hasn't landed is carried to the first
//      projected day; a Teller per-enrollment (webhook) sync refreshes balances
// F21  a new row's prior price comes from its own series; a second plan under
//      the same merchant key isn't a price change; the early alert has its own
//      memory
// F22  a category the user set is never re-flipped by detection
// F23  a manual subscription's next date moves on
// F24  exact rules compare trimmed values
// The database-backed half is tests/contract/c9-batch3.contract.test.js.
// Every date is derived from today (cycle-9 F59).
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
const fq = require("../teller/services/financial-queries");
const { addDaysStr, stepDate } = require("../teller/services/cadence");
const keywords = require("../scripts/transfer-keywords");
const subsDetector = require("../scripts/detect-subscriptions");
const transferDetector = require("../scripts/detect-transfers");
const cf = require("../teller/services/cash-flow");

const TODAY = fq.todayStr();
const day = (n) => addDaysStr(TODAY, n);
const quiet = async (fn) => {
  const e = console.error, l = console.log;
  console.error = () => {}; console.log = () => {};
  try { return await fn(); } finally { console.error = e; console.log = l; }
};

// `count` charges `gap` days apart, the latest `lastAgo` days ago.
let seq = 0;
function series(key, amount, { count = 4, gap = 30, lastAgo = 5, raw = null, name = null } = {}) {
  const rows = [];
  for (let i = count - 1; i >= 0; i--) {
    rows.push({ transaction_id: "t" + (++seq), merchant_key: key, display_name: name || key, raw_description: raw, amount: String(amount), date: day(-(lastAgo + i * gap)) });
  }
  return rows;
}
const byDate = (rows) => rows.sort((a, b) => (a.merchant_key < b.merchant_key ? -1 : a.merchant_key > b.merchant_key ? 1 : a.date < b.date ? -1 : 1));

// The detectors' database, as much of it as they read.
function detectorPool({ rows = [], dismissed = [], live = [], stored = [] } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM transactions/.test(sql)) return { rows: byDate(rows.map((r) => ({ ...r }))) };
      if (/FROM recurring_transfers WHERE is_dismissed = true/.test(sql)) return { rows: dismissed.map((k) => ({ merchant_key: k })) };
      if (/SELECT id, merchant_key FROM detected_subscriptions WHERE is_active = true/.test(sql)) return { rows: live };
      if (/SELECT merchant_key, cadence_days, amount FROM detected_subscriptions/.test(sql)) return { rows: stored };
      return { rows: [], rowCount: 0 };
    },
  };
}
const keysOf = (detected) => [...new Set(detected.map((d) => d.merchant_key))].sort();

// ---------------------------------------------------------------------------
describe("F20 — one keyword source; a transfer row is never a subscription row", () => {
  it("both detectors read the same classifier objects", () => {
    assert.equal(transferDetector.classifyTransfer, keywords.classifyTransfer);
    assert.equal(transferDetector.classifyTransferTxn, keywords.classifyTransferTxn);
    assert.equal(transferDetector.TRANSFER_PATTERNS, keywords.TRANSFER_PATTERNS);
    const src = read("scripts", "detect-subscriptions.js");
    assert.match(src, /require\("\.\/transfer-keywords"\)/);
    assert.doesNotMatch(read("scripts", "detect-transfers.js"), /const TRANSFER_PATTERNS = \{/, "the lists live in one file");
  });

  const MIXED = () => [
    ...series("Netflix", 15.49),
    ...series("Wells Fargo Mortgage Payment", 1850),
    ...series("Vanguard", 500),
    ...series("Ally Savings", 300),
    ...series("City Water", 62.4, { raw: "ONLINE BILL PAY CITY WATER" }),
    ...series("Spotify", 11.99),
    ...series("John Smith", 900, { raw: "ZELLE TO JOHN SMITH" }),
  ];

  it("a mortgage payment, a brokerage contribution, a savings transfer and a bill-pay row are recurring transfers only", async () => {
    const subs = await quiet(() => subsDetector.detectSubscriptions(detectorPool({ rows: MIXED() })));
    const transfers = await quiet(() => transferDetector.detectRecurringTransfers(detectorPool({ rows: MIXED() })));
    assert.deepEqual(keysOf(subs), ["Netflix", "Spotify"]);
    assert.deepEqual(keysOf(transfers), ["Ally Savings", "City Water", "John Smith", "Vanguard", "Wells Fargo Mortgage Payment"]);
    const both = keysOf(subs).filter((k) => keysOf(transfers).includes(k));
    assert.deepEqual(both, [], "no series is in both lists — the forecast bills each once");
  });

  it("every merchant the transfer classifier names is left out of subscription detection", async () => {
    // One steady monthly series per transfer keyword, as its merchant key.
    const names = Object.values(keywords.TRANSFER_PATTERNS).flat().map((kw) => "Acme " + kw + " co");
    const rows = names.flatMap((n) => series(n, 100));
    const subs = await quiet(() => subsDetector.detectSubscriptions(detectorPool({ rows })));
    assert.deepEqual(keysOf(subs), []);
  });

  it("a transfer the user dismissed stays a subscription candidate", async () => {
    const subs = await quiet(() => subsDetector.detectSubscriptions(detectorPool({ rows: MIXED(), dismissed: ["Vanguard"] })));
    assert.deepEqual(keysOf(subs), ["Netflix", "Spotify", "Vanguard"]);
  });

  it("subscription rows keyed on a transfer merchant are retired; manual rows and dismissed-transfer merchants aren't", async () => {
    const pool = detectorPool({
      rows: MIXED(),
      dismissed: ["Acorns"],
      // The query itself leaves manual rows out (source != 'manual').
      live: [{ id: 1, merchant_key: "Vanguard" }, { id: 2, merchant_key: "Netflix" }, { id: 3, merchant_key: "Acorns" }, { id: 4, merchant_key: "Wells Fargo Mortgage Payment" }],
    });
    await quiet(() => subsDetector.detectSubscriptions(pool));
    const sel = pool.calls.find((c) => /SELECT id, merchant_key FROM detected_subscriptions/.test(c.sql));
    assert.match(sel.sql, /is_active = true AND source != 'manual'/);
    const retire = pool.calls.filter((c) => /UPDATE detected_subscriptions SET is_active = false, updated_at = now\(\) WHERE id = ANY\(\$1::int\[\]\)/.test(c.sql));
    assert.equal(retire.length, 1);
    assert.deepEqual(retire[0].params, [[1, 4]]);
  });

  it("nothing to retire → no write; a failed read never stops detection", async () => {
    const clean = detectorPool({ rows: MIXED(), live: [{ id: 2, merchant_key: "Netflix" }] });
    await quiet(() => subsDetector.detectSubscriptions(clean));
    assert.equal(clean.calls.filter((c) => /WHERE id = ANY\(\$1::int\[\]\)/.test(c.sql)).length, 0);
    const flaky = detectorPool({ rows: MIXED() });
    const q = flaky.query;
    flaky.query = async (sql, params) => {
      if (/FROM recurring_transfers WHERE is_dismissed|SELECT id, merchant_key FROM detected_subscriptions|SELECT merchant_key, cadence_days, amount/.test(sql)) throw new Error("db blip");
      return q(sql, params);
    };
    const subs = await quiet(() => subsDetector.detectSubscriptions(flaky));
    assert.deepEqual(keysOf(subs), ["Netflix", "Spotify"]);
  });
});

// ---------------------------------------------------------------------------
describe("F21 — price changes: the series' own prior price, and a second plan isn't a rise", () => {
  const at = (amount, ago) => ({ amount: String(amount), date: day(-ago) });

  it("isOtherPlan: a replaced price is a change; a price charged alongside the old one is another plan", () => {
    const o = subsDetector.isOtherPlan;
    // 15.49 for six months, then 17.99 for three: a real change.
    const switched = [185, 155, 125, 95].map((d) => at(15.49, d)).concat([65, 35, 5].map((d) => at(17.99, d)));
    assert.equal(o(switched, 15.49, 17.99, 30), false);
    // Creep at the first new charge.
    assert.equal(o([at(15.49, 65), at(15.49, 35), at(16.49, 5)], 15.49, 16.49, 30), false);
    // Two plans, interleaved: 0.99 on the 1st-ish, 10.99 on the 15th-ish.
    const twoPlans = [80, 50, 20].map((d) => at(0.99, d)).concat([65, 35, 5].map((d) => at(10.99, d)));
    assert.equal(o(twoPlans, 0.99, 10.99, 30), true);
    assert.equal(o(twoPlans, 10.99, 0.99, 30), true, "either direction");
    // A promotion that ended: 17.99 long ago, 15.49 for six months, 17.99 again.
    const promo = [at(17.99, 300), at(17.99, 270)].concat([240, 210, 180, 150, 120, 90].map((d) => at(15.49, d))).concat([60, 30, 1].map((d) => at(17.99, d)));
    assert.equal(o(promo, 15.49, 17.99, 30), false, "the old price coming back after months is still a rise");
    // Degenerate inputs.
    assert.equal(o(twoPlans, 10.99, 10.99, 30), false);
    assert.equal(o(twoPlans, 4.99, 10.99, 30), false, "the stored price was never charged here");
    assert.equal(o([], 1, 2, 30), false);
  });

  it("samePrice: a cent, or half a percent", () => {
    assert.equal(subsDetector.samePrice(10.99, 10.99), true);
    assert.equal(subsDetector.samePrice(10.99, 11.0), true);
    assert.equal(subsDetector.samePrice(200, 200.9), true);
    assert.equal(subsDetector.samePrice(15.49, 15.99), false);
  });

  it("a new subscription at a merchant with other purchases is not stored as a price rise", async () => {
    // A $4.99 one-off five days before the latest $14.99 charge: the merchant's
    // previous charge of ANY amount used to be the "prior price".
    const rows = [...series("Amazon", 14.99, { count: 3, lastAgo: 3 }), { transaction_id: "odd", merchant_key: "Amazon", display_name: "Amazon", raw_description: null, amount: "4.99", date: day(-8) }];
    const [sub] = await quiet(() => subsDetector.detectSubscriptions(detectorPool({ rows })));
    assert.equal(sub.amount, 14.99);
    assert.equal(sub.prior_amount, 14.99, "the previous charge of this series");
    assert.equal(sub.amount_changed, false);
  });

  it("a price that moved inside the series is still reported on a new row", async () => {
    const rows = [...series("Hulu", 9.99, { count: 3, lastAgo: 35 }), ...series("Hulu", 10.99, { count: 1, lastAgo: 5 })];
    const [sub] = await quiet(() => subsDetector.detectSubscriptions(detectorPool({ rows })));
    assert.equal(sub.amount, 10.99);
    assert.equal(sub.prior_amount, 9.99);
    assert.equal(sub.amount_changed, true);
  });

  const upsertOf = (pool, key) => pool.calls.find((c) => /INSERT INTO detected_subscriptions/.test(c.sql) && c.params[0] === key);

  it("a key that carries two plans: the amount follows the latest charge, the upsert is told it isn't a price change", async () => {
    const rows = [...series("Apple", 0.99, { count: 4, lastAgo: 20 }), ...series("Apple", 10.99, { count: 4, lastAgo: 5 })];
    const pool = detectorPool({ rows, stored: [{ merchant_key: "Apple", cadence_days: 30, amount: "0.99" }] });
    const [sub] = await quiet(() => subsDetector.detectSubscriptions(pool));
    assert.equal(sub.amount, 10.99);
    assert.equal(sub.other_plan, true);
    const up = upsertOf(pool, "Apple");
    assert.equal(up.params[10], true, "$11");
    assert.match(up.sql, /prior_amount\s+= CASE WHEN EXCLUDED\.amount <> detected_subscriptions\.amount AND NOT \$11::boolean/);
    assert.match(up.sql, /amount_changed = CASE WHEN EXCLUDED\.amount <> detected_subscriptions\.amount THEN NOT \$11::boolean/);
  });

  it("a replaced price is still a price change for the upsert", async () => {
    const rows = [...series("Spotify", 9.99, { count: 4, lastAgo: 95 }), ...series("Spotify", 11.99, { count: 3, lastAgo: 5 })];
    const pool = detectorPool({ rows, stored: [{ merchant_key: "Spotify", cadence_days: 30, amount: "9.99" }] });
    const [sub] = await quiet(() => subsDetector.detectSubscriptions(pool));
    assert.equal(sub.amount, 11.99);
    assert.equal(sub.other_plan, false);
    assert.equal(upsertOf(pool, "Spotify").params[10], false);
  });

  it("the watchdog: each rule writes its own memory and reads both; the early rule skips a second plan", () => {
    const src = read("teller", "routes", "subscriptions.js");
    const rise = src.slice(src.indexOf("const rises = await db.query("), src.indexOf("for (const r of rises.rows)"));
    assert.match(rise, /price_alerted_amount IS DISTINCT FROM amount\s+AND early_price_alerted_amount IS DISTINCT FROM amount/);
    const early = src.slice(src.indexOf("const early = await db.query("), src.indexOf("return out;", src.indexOf("const early = await db.query(")));
    assert.match(early, /ds\.price_alerted_amount IS DISTINCT FROM c\.amount\s+AND ds\.early_price_alerted_amount IS DISTINCT FROM c\.amount/);
    assert.match(early, /AND NOT EXISTS \(\s+SELECT 1 FROM transactions t[\s\S]*?t\.date <= ds\.last_charged AND t\.date >= ds\.last_charged - 2 \* ds\.cadence_days\s+AND ABS\(t\.amount - c\.amount\) <= GREATEST\(0\.01, 0\.005 \* c\.amount\)/);
    assert.match(early, /UPDATE detected_subscriptions SET early_price_alerted_amount = \$2 WHERE id = \$1/);
    assert.doesNotMatch(early, /SET price_alerted_amount/);
    assert.match(read("teller", "services", "database.js"), /ADD COLUMN IF NOT EXISTS early_price_alerted_amount NUMERIC\(12,2\)/);
  });

  it("the watchdog over a fake database: an early alert is remembered in its own column", async () => {
    const subs = require("../teller/routes/subscriptions");
    const notifications = require("../teller/routes/notifications");
    const persistent = require("../teller/routes/persistent");
    const send = notifications.sendToAll, mail = persistent.sendCriticalAlertEmail;
    const sent = [], writes = [];
    notifications.sendToAll = async (p) => { sent.push(p); return { logged: true }; };
    persistent.sendCriticalAlertEmail = async () => ({ sent: false });
    const db = {
      query: async (sql, params) => {
        if (/t\.amount > ds\.amount \* 1\.10/.test(sql)) return { rows: [{ id: 7, display_name: "Hulu", amount: "15.49", charged: "17.99" }] };
        if (/^\s*UPDATE detected_subscriptions/.test(sql)) { writes.push({ sql, params }); return { rows: [] }; }
        return { rows: [] };
      },
    };
    try {
      const out = await subs.runSubscriptionWatchdog(db);
      assert.equal(out.price_rises, 1);
      assert.equal(sent[0].title, "Hulu went up from $15.49 to $17.99");
      assert.equal(writes.length, 1);
      assert.match(writes[0].sql, /SET early_price_alerted_amount = \$2/);
      assert.deepEqual(writes[0].params, [7, "17.99"]);
    } finally {
      notifications.sendToAll = send;
      persistent.sendCriticalAlertEmail = mail;
    }
  });
});

// ---------------------------------------------------------------------------
describe("F22 — a category the user set survives detection", () => {
  afterEach(() => { dbModule.pool.query = originalQuery; });
  const app = () => { const a = express(); a.use(express.json()); a.use(require("../teller/routes/subscriptions")); return a; };

  it("PATCH /api/subscriptions/:id/category records that the user chose it", async () => {
    const calls = [];
    dbModule.pool.query = async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: 3, category: "subscription", category_user_set: true }] }; };
    const res = await supertest(app()).patch("/api/subscriptions/3/category").send({ category: "subscription" }).expect(200);
    assert.equal(res.body.category_user_set, true);
    assert.match(calls[0].sql, /SET category = \$1, category_user_set = true, updated_at = now\(\) WHERE id = \$2/);
    assert.deepEqual(calls[0].params, ["subscription", "3"]);
    await supertest(app()).patch("/api/subscriptions/3/category").send({ category: "bill" }).expect(400);
  });

  it("detection promotes Subscription → Utility only on rows the user hasn't set", async () => {
    const subs = require("../teller/routes/subscriptions");
    const { categorizeSubscription } = require("../teller/data/reference-data");
    const utility = ["Pacific Gas and Electric", "Comcast Internet", "City Water Utility", "Verizon Wireless"].find((n) => categorizeSubscription(n) === "utility");
    assert.ok(utility, "a merchant the reference data calls a utility");
    const calls = [];
    const rows = series(utility, 120);
    dbModule.pool.query = async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM transactions/.test(sql)) return { rows: byDate(rows.map((r) => ({ ...r }))) };
      return { rows: [], rowCount: 0 };
    };
    const out = await quiet(() => subs.runSubscriptionDetection());
    assert.equal(out.detected_count, 1);
    const promote = calls.filter((c) => /UPDATE detected_subscriptions SET category = \$1 WHERE merchant_key = \$2/.test(c.sql));
    assert.equal(promote.length, 1);
    assert.match(promote[0].sql, /AND category = 'subscription' AND NOT category_user_set$/);
    assert.deepEqual(promote[0].params, ["utility", utility]);
  });

  it("the column is migrated with a false default", () => {
    assert.match(read("teller", "services", "database.js"), /ADD COLUMN IF NOT EXISTS category_user_set BOOLEAN NOT NULL DEFAULT false/);
  });
});

// ---------------------------------------------------------------------------
describe("F23 — a manual subscription's next date moves on", () => {
  afterEach(() => { dbModule.pool.query = originalQuery; });
  const subs = require("../teller/routes/subscriptions");

  function manualDb(rows) {
    const calls = [];
    return { calls, query: async (sql, params) => {
      calls.push({ sql, params });
      if (/WHERE source = 'manual' AND is_active = true/.test(sql)) return { rows };
      return { rows: [], rowCount: 1 };
    } };
  }
  const updates = (db) => db.calls.filter((c) => /^UPDATE detected_subscriptions SET next_expected = \$2/.test(c.sql)).map((c) => c.params);

  it("reads only active, uncancelled manual rows whose next date has passed", async () => {
    const db = manualDb([]);
    assert.equal(await subs.rollManualSubscriptions(db, "2026-06-15"), 0);
    const sel = db.calls[0];
    assert.match(sel.sql, /WHERE source = 'manual' AND is_active = true AND cancelled_at IS NULL\s+AND next_expected IS NOT NULL AND next_expected < \$1::date/);
    assert.deepEqual(sel.params, ["2026-06-15"]);
    assert.deepEqual(updates(db), []);
  });

  it("monthly: the first date on or after today, on the day it was added (clamped per month)", async () => {
    const db = manualDb([
      { id: 1, cadence_days: 30, anchor: "2026-01-31", next: "2026-02-28" }, // added on the 31st
      { id: 2, cadence_days: 30, anchor: "2026-03-10", next: "2026-04-10" },
      { id: 3, cadence_days: 30, anchor: "2026-01-15", next: "2026-02-15" }, // due today → today
    ]);
    assert.equal(await subs.rollManualSubscriptions(db, "2026-06-15"), 3);
    assert.deepEqual(updates(db), [[1, "2026-06-30"], [2, "2026-07-10"], [3, "2026-06-15"]]);
  });

  it("quarterly, yearly and day-stepped cadences", async () => {
    const db = manualDb([
      { id: 1, cadence_days: 90, anchor: "2025-11-20", next: "2026-02-20" },
      { id: 2, cadence_days: 365, anchor: "2024-02-29", next: "2025-02-28" },
      { id: 3, cadence_days: 14, anchor: "2026-06-01", next: "2026-06-15" },
      { id: 4, cadence_days: 7, anchor: null, next: "2026-06-10" }, // no anchor: steps from its old date
    ]);
    assert.equal(await subs.rollManualSubscriptions(db, "2026-06-20"), 4);
    assert.deepEqual(updates(db), [[1, "2026-08-20"], [2, "2027-02-28"], [3, "2026-06-29"], [4, "2026-06-24"]]);
  });

  it("a bad cadence is skipped; the write is limited to manual rows", async () => {
    const db = manualDb([{ id: 1, cadence_days: 0, anchor: "2026-01-01", next: "2026-02-01" }, { id: 2, cadence_days: 30, anchor: "2026-01-05", next: "2026-02-05" }]);
    assert.equal(await subs.rollManualSubscriptions(db, "2026-06-15"), 1);
    const up = db.calls.find((c) => /^UPDATE detected_subscriptions SET next_expected/.test(c.sql));
    assert.match(up.sql, /WHERE id = \$1 AND source = 'manual'$/);
    assert.deepEqual(up.params, [2, "2026-07-05"]);
  });

  it("runs with detection and when the list is read; a failure stops neither", async () => {
    const src = read("teller", "routes", "subscriptions.js");
    const detection = src.slice(src.indexOf("async function runSubscriptionDetection()"), src.indexOf("// Subscription watchdog (cycle-7 F53 / G5)"));
    assert.match(detection, /try \{ await rollManualSubscriptions\(\); \}/);
    const seen = [];
    dbModule.pool.query = async (sql) => {
      seen.push(sql);
      if (/WHERE source = 'manual' AND is_active = true/.test(sql)) throw new Error("db blip");
      return { rows: [] };
    };
    const app = express(); app.use(express.json()); app.use(subs);
    const res = await quiet(() => supertest(app).get("/api/subscriptions"));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.subscriptions, []);
    assert.match(seen[0], /WHERE source = 'manual' AND is_active = true/, "the roll comes before the list is read");
  });
});

// ---------------------------------------------------------------------------
describe("F24 — exact rules compare trimmed values", () => {
  it("the rename rule and both categorization-rule paths trim the merchant and the pattern", () => {
    const rename = require("../teller/routes/merchant-rename");
    assert.equal(rename.ruleCondition("exact"), "TRIM(LOWER(COALESCE(t.merchant_name, t.name, ''))) = LOWER(TRIM($1))");
    const cat = read("teller", "routes", "categorize.js");
    assert.match(cat, /\? "TRIM\(LOWER\(COALESCE\(user_merchant_name, merchant_name, name, ''\)\)\) = LOWER\(TRIM\(\$2\)\)"/);
    assert.match(cat, /condition = "TRIM\(LOWER\(COALESCE\(t\.user_merchant_name, t\.merchant_name, t\.name, ''\)\)\) = LOWER\(TRIM\(\$1\)\)";/);
    assert.doesNotMatch(cat, /name, ''\)\) = LOWER\(\$[12]\)/, "no untrimmed exact compare is left");
    assert.doesNotMatch(read("teller", "routes", "merchant-rename.js"), /\$\{RAW_MERCHANT\} = LOWER\(\$1\)/);
  });

  it("contains / starts_with are unchanged", () => {
    const rename = require("../teller/routes/merchant-rename");
    assert.match(rename.ruleCondition("starts_with"), /^LOWER\(COALESCE\(t\.merchant_name, t\.name, ''\)\) LIKE /);
    assert.match(rename.ruleCondition("contains"), /^LOWER\(COALESCE\(t\.merchant_name, t\.name, ''\)\) LIKE '%' \|\| /);
  });
});

// ---------------------------------------------------------------------------
describe("F28 — today's unlanded payday is carried to the first projected day", () => {
  const TOMORROW = day(1);
  const base = (streams, extra = {}) => ({ today: TODAY, incomeStreams: streams, bills: [], left_out: [], startingBalance: 300, avgDailySpend: 50, dowSpend: {}, ...extra });
  const biweekly = (lastAgo) => ({ source: "Acme Payroll", amount: 2000, cadence: "biweekly", days: null, anchor: day(-lastAgo), last: day(-lastAgo), count: 6 });

  it("paydayLanded: a deposit within five days before the expected date is that payday", () => {
    assert.equal(cf.paydayLanded({ last: TODAY }, TODAY), true);
    assert.equal(cf.paydayLanded({ last: day(-1) }, TODAY), true, "paid a day early");
    assert.equal(cf.paydayLanded({ last: day(-5) }, TODAY), true);
    assert.equal(cf.paydayLanded({ last: day(-7) }, TODAY), false, "last week's deposit isn't today's");
    assert.equal(cf.paydayLanded({ last: day(-14) }, TODAY), false);
    assert.equal(cf.paydayLanded({ last: null }, TODAY), false);
    assert.equal(cf.PAYDAY_LANDED_DAYS, 5);
  });

  it("a paycheck expected today that hasn't synced is counted tomorrow — it used to be in neither the balance nor the projection", () => {
    const out = cf.projectCashFlow(base([biweekly(14)]), { days: 30 });
    assert.deepEqual(out.carried_income, [{ source: "Acme Payroll", amount: 2000, expected_date: TODAY, projected_date: TOMORROW }]);
    assert.equal(out.projection[0].date, TOMORROW);
    assert.equal(out.projection[0].income, 2000);
    assert.equal(out.projection[0].balance, 300 + 2000 - 50);
    // today (carried) + 14 + 28 days on
    assert.equal(out.total_projected_income, 6000);
    assert.equal(cf.firstBelow(out.projection, 200), null, "no false \"Low cash ahead\" on payday morning");
  });

  it("without the carry the same morning breaches the floor (what the alert saw)", () => {
    // The same forecast with the paycheck landed-but-unbalanced is the old
    // arithmetic: 300 − 50 a day.
    const out = cf.projectCashFlow(base([{ ...biweekly(14), last: TODAY }]), { days: 30 });
    assert.deepEqual(out.carried_income, []);
    assert.deepEqual(cf.firstBelow(out.projection, 200), { date: day(3), balance: 150 });
  });

  it("a paycheck that landed today is in the balance, not carried", () => {
    const out = cf.projectCashFlow(base([biweekly(0)], { startingBalance: 2300 }), { days: 30 });
    assert.deepEqual(out.carried_income, []);
    assert.equal(out.projection[0].income, 0);
    assert.equal(out.total_projected_income, 4000, "the next two paydays only");
  });

  it("semimonthly: paid a day early isn't counted twice; not yet paid is carried", () => {
    const dom = Number(TODAY.slice(8, 10));
    const other = dom > 15 ? dom - 14 : dom + 14;
    const days = [Math.min(dom, other), Math.max(dom, other)];
    const stream = (lastAgo) => ({ source: "Uni Payroll", amount: 1500, cadence: "semimonthly", days, anchor: day(-lastAgo), last: day(-lastAgo), count: 8 });
    const early = cf.projectCashFlow(base([stream(1)]), { days: 30 });
    assert.deepEqual(early.carried_income, []);
    assert.equal(early.projection[0].income, 0);
    const waiting = cf.projectCashFlow(base([stream(15)]), { days: 30 });
    assert.equal(waiting.carried_income.length, 1);
    assert.equal(waiting.projection[0].income, 1500);
  });

  it("a payday tomorrow and a bill tomorrow are projected as before; a carried payday adds to a payday already there", () => {
    const plain = cf.projectCashFlow(base([biweekly(13)]), { days: 30 });
    assert.deepEqual(plain.carried_income, []);
    assert.equal(plain.projection[0].income, 2000);
    const two = cf.projectCashFlow(base([biweekly(14), { ...biweekly(13), source: "Side Job", amount: 400 }]), { days: 30 });
    assert.equal(two.projection[0].income, 2400);
    assert.equal(two.carried_income.length, 1);
  });

  it("GET /api/cash-flow returns the carried list", () => {
    const src = read("teller", "services", "cash-flow.js");
    assert.match(src, /carried_income: carriedIncome,/);
    assert.match(src, /if \(paydayLanded\(stream, today\)\) continue;/);
  });
});

// ---------------------------------------------------------------------------
describe("F28 — a Teller per-enrollment sync refreshes that enrollment's balances", () => {
  const tellerApi = require("../teller/services/teller-api");
  const originalTellerRequest = tellerApi.tellerRequest;
  let enr, S;
  before(() => {
    tellerApi.tellerRequest = (endpoint, token, opts) => S.teller(endpoint, token, opts);
    delete require.cache[require.resolve("../teller/routes/enrollments")];
    enr = require("../teller/routes/enrollments");
  });
  after(() => {
    tellerApi.tellerRequest = originalTellerRequest;
    dbModule.pool.query = originalQuery;
    delete require.cache[require.resolve("../teller/routes/enrollments")];
  });
  afterEach(() => { dbModule.pool.query = originalQuery; });

  const ENR = { id: 7, enrollment_id: "enr_7", institution_name: "Chase", access_token: "tok_7", last_synced_txn_date: null, status: "GOOD" };
  const paycheck = { id: "t_pay", account_id: "acc_1", amount: "2000.00", date: TODAY, description: "ACME PAYROLL", status: "posted", details: {} };
  function setup({ teller } = {}) {
    S = { log: [], order: [] };
    S.teller = teller || (async (endpoint) => {
      S.order.push("teller " + endpoint.replace(/\?.*$/, ""));
      if (endpoint === "/accounts") return [{ id: "acc_1", name: "Checking", type: "depository", subtype: "checking", last_four: "1234" }];
      if (/\/balances$/.test(endpoint)) return { available: "2300.00", ledger: "2300.00" };
      if (/from_id/.test(endpoint)) return [];
      if (/\/transactions/.test(endpoint)) return [paycheck];
      return [];
    });
    dbModule.pool.query = async (sql, params = []) => {
      S.log.push({ sql, params });
      if (sql.includes("FROM teller_enrollments te") && sql.includes("AND te.id = $2")) return { rows: params[1] === 7 ? [ENR] : [] };
      if (sql.includes("FROM linked_accounts WHERE teller_enrollment_id")) return { rows: [{ account_id: "acc_1" }] };
      if (sql.includes("INSERT INTO transactions") && sql.includes("RETURNING (xmax = 0)")) { S.order.push("insert txn"); return { rows: [{ inserted: true }] }; }
      if (/UPDATE linked_accounts la\s+SET available_balance/.test(sql)) { S.order.push("update balance"); return { rows: [{ id: 11, changed: true }] }; }
      return { rows: [], rowCount: 0 };
    };
  }
  const ran = (re) => S.log.filter((q) => re.test(q.sql));

  it("the paycheck's row and the balance it moved arrive in the same run, transactions first", async () => {
    setup();
    const r = await quiet(() => enr.syncTellerEnrollment(7));
    assert.equal(r.ok, true);
    assert.equal(r.added, 1);
    assert.equal(r.failed, false);
    assert.equal(r.balances_updated, 1);
    assert.ok(S.order.indexOf("insert txn") < S.order.indexOf("teller /accounts"), "balances after the transaction sync");
    assert.ok(S.order.includes("teller /accounts/acc_1/balances"));
    const bal = ran(/UPDATE linked_accounts la\s+SET available_balance = \$1, current_balance = \$2, balance_updated_at = now\(\)/);
    assert.equal(bal.length, 1);
    assert.deepEqual(bal[0].params, [2300, 2300, "acc_1"]);
    assert.equal(ran(/INSERT INTO account_balance_snapshots/).length, 1);
    assert.equal(ran(/last_txn_sync_at|last_sync_result|last_balance_sync_at|net_worth_snapshots/).length, 0, "nothing global");
  });

  it("a balance refresh that fails is logged and never fails the transaction sync", async () => {
    setup({ teller: async (endpoint) => {
      if (endpoint === "/accounts") throw Object.assign(new Error("teller 502"), { status: 502 });
      if (/from_id/.test(endpoint)) return [];
      return /\/transactions/.test(endpoint) ? [paycheck] : [];
    } });
    const r = await quiet(() => enr.syncTellerEnrollment(7));
    assert.equal(r.ok, true);
    assert.equal(r.failed, false);
    assert.equal(r.added, 1);
    assert.equal(r.balances_updated, 0);
    assert.deepEqual(r.errors, [], "the event doesn't fail");
  });

  it("a sync that failed outright doesn't call for balances", async () => {
    const seen = [];
    setup({ teller: async (endpoint) => { seen.push(endpoint); throw Object.assign(new Error("unauthorized"), { status: 401 }); } });
    const r = await quiet(() => enr.syncTellerEnrollment(7));
    assert.equal(r.failed, true);
    assert.ok(!seen.includes("/accounts"));
  });

  it("syncAllBalances runs the same per-enrollment refresh", async () => {
    setup();
    dbModule.pool.query = ((inner) => async (sql, params = []) => {
      if (/FROM teller_enrollments WHERE status = 'GOOD'/.test(sql)) { S.log.push({ sql, params }); return { rows: [ENR, { ...ENR, id: 9, institution_name: "Locked", access_token: null }] }; }
      return inner(sql, params);
    })(dbModule.pool.query);
    const r = await quiet(() => enr.syncAllBalances());
    assert.equal(r.accounts_updated, 1);
    assert.equal(r.accounts_changed, 1);
    assert.deepEqual(r.errors, [{ institution: "Locked", error: "decryption_failed" }]);
    const src = read("teller", "routes", "enrollments.js");
    assert.match(src, /const r = await refreshTellerEnrollmentBalances\(enrollment\);/);
    assert.match(src, /const bal = await refreshTellerEnrollmentBalances\(rows\[0\]\);/);
  });
});
