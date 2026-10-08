// ============================================================================
// Broad-scan (Sept 2026) Batch 4 regression tests — detection, calendar
// projections, CSV / bill bookkeeping (Perfin)
// ============================================================================
// DC-2   a subscription / transfer series that stopped is not re-detected (so
//        the upsert can't re-activate what the stale sweep retired)
// DC-8   the LATEST gap must match, a true (ceil) majority of gaps must match,
//        and 2-charge detection needs a near-exact repeat amount
// DC-7   the amount anchors on the most recent price cluster
// DC-9   month-scale cadences step by calendar month (services/cadence.js)
// DC-10  bill-calendar income is projected per stream cadence
// DC-4   a user-set transfer_type survives re-detection
// DC-5   csv-overlap identifies CSV accounts by plaid_items.status = 'CSV'
// DC-6   CSV import rolls a manual balance forward instead of overwriting it
// SXE-11 a bill marked paid without an amount defaults to the bill's amount
// DC-15  manual-bill PATCH validation, manual cash needs a manual account,
//        rows_skipped excludes duplicates, one manual-bill placement rule for
//        the calendar AND the ICS feed, AI categorize reads user_merchant_name
// (The new SQL is also exercised against real Postgres — see the Batch 4
//  summary block.)
// ============================================================================

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
const originalConnect = dbModule.pool.connect;
afterEach(() => { dbModule.pool.query = originalQuery; dbModule.pool.connect = originalConnect; });

const cadence = require("../teller/services/cadence");
const { detectSubscriptions } = require("../scripts/detect-subscriptions");
const { detectRecurringTransfers } = require("../scripts/detect-transfers");

function mountApp(mod) {
  const app = express();
  app.use(express.json());
  app.use(require(mod));
  return app;
}

const DAY = 86400000;
function utcToday() {
  const n = new Date();
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
}
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
// Series of charges ending `endDaysAgo` days before today at the given gaps.
function series(amounts, gaps, endDaysAgo, key = "streamco") {
  const end = utcToday() - endDaysAgo * DAY;
  const offsets = [0];
  for (const g of gaps) offsets.push(offsets[offsets.length - 1] + g);
  const total = offsets[offsets.length - 1];
  return offsets.map((o, i) => ({
    transaction_id: key + i,
    merchant_key: key,
    display_name: key,
    amount: amounts[i] ?? amounts[amounts.length - 1],
    date: ymd(end - (total - o) * DAY),
  }));
}
function detectPool(rows, log = []) {
  return {
    query: async (sql, params) => {
      log.push({ sql, params });
      if (/FROM transactions/.test(sql)) return { rows };
      return { rows: [] };
    },
  };
}

// ---------------------------------------------------------------------------
// DC-2 — stopped series are not re-detected
// ---------------------------------------------------------------------------
describe("DC-2 — a series that stopped is not re-detected", () => {
  it("subscriptions: a monthly series whose last charge was 200 days ago yields nothing and upserts nothing", async () => {
    const log = [];
    const detected = await detectSubscriptions(detectPool(series([9.99], [30, 30, 30, 30], 200), log));
    assert.equal(detected.length, 0);
    assert.ok(!log.some(q => /INSERT INTO detected_subscriptions/.test(q.sql)), "no upsert may re-activate it");
  });
  it("subscriptions: the same series ending 5 days ago IS detected", async () => {
    const detected = await detectSubscriptions(detectPool(series([9.99], [30, 30, 30, 30], 5)));
    assert.equal(detected.length, 1);
    assert.equal(detected[0].cadence_days, 30);
  });
  it("transfers: a stopped monthly transfer yields nothing", async () => {
    const rows = series([500], [30, 30, 30, 30], 200, "zelle to landlord");
    const log = [];
    const detected = await detectRecurringTransfers(detectPool(rows, log));
    assert.equal(detected.length, 0);
    assert.ok(!log.some(q => /INSERT INTO recurring_transfers/.test(q.sql)));
  });
});

// ---------------------------------------------------------------------------
// DC-8 — stricter matching
// ---------------------------------------------------------------------------
describe("DC-8 — coincidental gaps are not a subscription", () => {
  it("two similar-but-different purchases 55 days apart are not a 60-day subscription", async () => {
    const detected = await detectSubscriptions(detectPool(series([45.0, 48.1], [55], 3, "bistro")));
    assert.equal(detected.length, 0);
  });
  it("an exact repeat 60 days apart still is (the F2 2-charge allowance)", async () => {
    const detected = await detectSubscriptions(detectPool(series([30.0, 30.0], [60], 3, "boxco")));
    assert.equal(detected.length, 1);
    assert.equal(detected[0].cadence_days, 60);
  });
  it("1 matching gap out of 3 is not a majority (ceil, not floor)", async () => {
    // gaps 10, 10, 60 → old floor(1.5)=1 accepted a 60-day subscription
    const detected = await detectSubscriptions(detectPool(series([20], [10, 10, 60], 3, "shopco")));
    assert.equal(detected.length, 0);
  });
  it("the latest gap must match — an old monthly run followed by an irregular gap is not live", async () => {
    // 3 clean monthly gaps, then a 70-day gap → majority matches 30 but the latest doesn't
    const detected = await detectSubscriptions(detectPool(series([12], [30, 30, 30, 70], 3, "gymco")));
    assert.ok(!detected.some(d => d.cadence_days === 30));
  });
});

// ---------------------------------------------------------------------------
// DC-7 — anchor on the recent price
// ---------------------------------------------------------------------------
describe("DC-7 — a price increase is reported at the new price", () => {
  it("18 × $15.49 then 6 × $17.99 → detected at 17.99 (the old global mode reported 15.49)", async () => {
    const amounts = [...Array(18).fill(15.49), ...Array(6).fill(17.99)];
    const log = [];
    const detected = await detectSubscriptions(detectPool(series(amounts, Array(23).fill(30), 4, "streamflix"), log));
    assert.equal(detected.length, 1);
    assert.equal(detected[0].amount, 17.99);
    // The persisted row flags the change against its STORED amount (the
    // upsert compares EXCLUDED.amount to the previous run's 15.49).
    const upsert = log.find(q => /INSERT INTO detected_subscriptions/.test(q.sql));
    assert.equal(upsert.params[2], 17.99);
    assert.match(upsert.sql, /amount_changed = \(EXCLUDED\.amount != detected_subscriptions\.amount\)/);
  });
  it("at the transition charge the in-memory row reports the old price as prior", async () => {
    const amounts = [...Array(18).fill(15.49), ...Array(3).fill(17.99)];
    const detected = await detectSubscriptions(detectPool(series(amounts, Array(20).fill(30), 4, "streamflix")));
    assert.equal(detected[0].amount, 17.99);
    const one = [...Array(18).fill(15.49), 17.99];
    const d1 = await detectSubscriptions(detectPool(series(one, Array(18).fill(30), 4, "streamflix")));
    // A single charge at a new price could be a one-off: not yet re-anchored.
    assert.ok(!d1.length || d1[0].amount === 15.49);
  });
});

// ---------------------------------------------------------------------------
// DC-9 — calendar-month stepping
// ---------------------------------------------------------------------------
describe("DC-9 — month-scale cadences step by calendar month", () => {
  it("stepDate keeps the anchor day, clamped to the month length", () => {
    assert.equal(cadence.stepDate("2026-01-31", 30, 1), "2026-02-28");
    assert.equal(cadence.stepDate("2026-01-31", 30, 2), "2026-03-31");
    assert.equal(cadence.stepDate("2026-01-31", 30, -1), "2025-12-31");
    assert.equal(cadence.stepDate("2026-01-15", 90, 1), "2026-04-15");
    assert.equal(cadence.stepDate("2026-01-15", 365, 1), "2027-01-15");
    assert.equal(cadence.stepDate("2026-01-15", 14, 1), "2026-01-29"); // week-scale stays in days
  });
  it("a Sep-1 monthly bill lands ONCE in October (not Oct 1 and Oct 31)", () => {
    assert.deepEqual(cadence.occurrencesBetween("2026-09-01", 30, "2026-10-01", "2026-10-31"), ["2026-10-01"]);
  });
  it("a sub billed on the 31st keeps the 31st (anchored on last_charged, not the clamped next_expected)", () => {
    assert.deepEqual(
      cadence.seriesOccurrences("2026-08-31", "2026-09-30", 30, "2026-09-01", "2026-12-31"),
      ["2026-09-30", "2026-10-31", "2026-11-30", "2026-12-31"]);
    // nothing before next_expected, even when the anchor series has earlier dates
    assert.deepEqual(cadence.seriesOccurrences("2026-08-31", "2026-10-31", 30, "2026-09-01", "2026-10-31"), ["2026-10-31"]);
  });
  it("bill-calendar places a monthly subscription once per month", async () => {
    dbModule.pool.query = async (sql) => {
      if (/FROM detected_subscriptions/.test(sql)) {
        return { rows: [{ id: 1, display_name: "Netflix", amount: "15.49", cadence_days: 30, next_expected: "2026-09-01", category: "streaming" }] };
      }
      return { rows: [] };
    };
    const res = await supertest(mountApp("../teller/routes/subscriptions"))
      .get("/api/bill-calendar?year=2026&month=10").expect(200);
    const events = res.body.days.flatMap(d => d.events.map(e => ({ day: d.day, ...e }))).filter(e => e.name === "Netflix");
    assert.deepEqual(events.map(e => e.day), [1]);
  });
  it("detection's next_expected uses calendar months", async () => {
    // Last charge on the 15th of the most recent 31-day month: +30 days would
    // give the NEXT month's 14th; calendar stepping gives the 15th.
    const t = new Date(utcToday());
    let y = t.getUTCFullYear(), m = t.getUTCMonth();
    if (t.getUTCDate() < 15) m -= 1;
    while (cadence.daysInMonth(y + Math.floor(m / 12), ((m % 12) + 12) % 12) !== 31) m -= 1;
    const last = new Date(Date.UTC(y, m, 15));
    const lastStr = ymd(last.getTime());
    const rows = [3, 2, 1, 0].map((k, i) => ({
      transaction_id: "c" + i, merchant_key: "cloudco", display_name: "cloudco", amount: 5,
      date: cadence.stepDate(lastStr, 30, -k),
    }));
    const detected = await detectSubscriptions(detectPool(rows));
    assert.equal(detected.length, 1);
    const n = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 15));
    assert.equal(detected[0].next_expected, ymd(n.getTime()));
  });
  it("POST /api/subscriptions and the cash-flow schedule use the cadence helper (no fixed-day stepping)", () => {
    const subs = read("teller", "routes", "subscriptions.js");
    assert.match(subs, /nextExpected = nextOccurrence\(today, parsedCadence\)/);
    assert.doesNotMatch(subs, /cadence(_days)? \* 86400000/);
    const sa = read("teller", "routes", "spending-analytics.js");
    assert.match(sa, /seriesOccurrences\(sub\.last_date, sub\.next_expected, sub\.cadence_days, todayUtc, endUtc\)/);
    assert.doesNotMatch(sa, /cadence \* 86400000/);
  });
});

// ---------------------------------------------------------------------------
// DC-10 — cadence-based income projection
// ---------------------------------------------------------------------------
describe("DC-10 — bill-calendar income follows the pay cadence", () => {
  it("classifies weekly / biweekly / semimonthly / monthly streams", () => {
    const rows = [];
    for (const d of ["2026-06-05", "2026-06-19", "2026-07-03", "2026-07-17", "2026-07-31", "2026-08-14"]) rows.push({ source: "ACME", date: d, amount: 2100 + Math.round(Math.random() * 30) });
    for (const d of ["2026-06-15", "2026-06-30", "2026-07-15", "2026-07-31", "2026-08-14", "2026-08-31"]) rows.push({ source: "AGENCY", date: d, amount: 1500 });
    for (const d of ["2026-06-03", "2026-07-03", "2026-08-03"]) rows.push({ source: "SIDE GIG", date: d, amount: 400 });
    for (const d of ["2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24"]) rows.push({ source: "TIPS", date: d, amount: 90 });
    const byName = Object.fromEntries(cadence.buildIncomeStreams(rows).map(s => [s.source, s]));
    assert.equal(byName.ACME.cadence, "biweekly", "cents-varying paychecks stay one stream");
    assert.equal(byName.AGENCY.cadence, "semimonthly");
    assert.deepEqual(byName.AGENCY.days, [15, 31]);
    assert.equal(byName["SIDE GIG"].cadence, "monthly");
    assert.equal(byName.TIPS.cadence, "weekly");
    assert.deepEqual(cadence.incomeEventsBetween(byName.ACME, "2026-09-01", "2026-09-30"), ["2026-09-11", "2026-09-25"]);
    assert.deepEqual(cadence.incomeEventsBetween(byName.AGENCY, "2026-09-01", "2026-09-30"), ["2026-09-15", "2026-09-30"]);
  });
  it("bill-calendar shows every biweekly paycheck in the month, not one averaged event", async () => {
    const today = utcToday();
    const deposits = [0, 14, 28, 42, 56, 70].map((back, i) => ({ source: "ACME PAYROLL", date: ymd(today - back * DAY), amount: String(2000 + i) }));
    let incomeSql = "";
    dbModule.pool.query = async (sql) => {
      if (/INCOME|income/.test(sql) && /FROM transactions/.test(sql)) { incomeSql = sql; return { rows: deposits.slice().reverse() }; }
      return { rows: [] };
    };
    const now = new Date(today);
    const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1;
    const res = await supertest(mountApp("../teller/routes/subscriptions"))
      .get(`/api/bill-calendar?year=${y}&month=${m}`).expect(200);
    const incomeDays = res.body.days.filter(d => d.events.some(e => e.is_income)).map(d => d.date);
    const monthStart = `${y}-${String(m).padStart(2, "0")}-01`;
    const monthEnd = `${y}-${String(m).padStart(2, "0")}-${String(res.body.days_in_month).padStart(2, "0")}`;
    const expected = cadence.occurrencesBetween(ymd(today), 14, monthStart, monthEnd);
    assert.ok(expected.length >= 2);
    assert.deepEqual(incomeDays, expected);
    assert.match(incomeSql, /COALESCE\(user_merchant_name, merchant_name, name\) AS source/);
    assert.doesNotMatch(incomeSql, /GROUP BY/);
  });
  it("a stream whose last deposit is months old is not projected", () => {
    const s = cadence.buildIncomeStreams([
      { source: "OLD JOB", date: "2026-03-01", amount: 3000 },
      { source: "OLD JOB", date: "2026-04-01", amount: 3000 },
    ])[0];
    assert.equal(cadence.isIncomeStreamLive(s, "2026-09-27"), false);
    assert.equal(cadence.isIncomeStreamLive(s, "2026-05-01"), true);
  });
});

// ---------------------------------------------------------------------------
// DC-4 — user-set transfer_type survives re-detection
// ---------------------------------------------------------------------------
describe("DC-4 — a user's transfer-type reclassification sticks", () => {
  it("PATCH type sets transfer_type_user_set; the detector's upsert keeps a user-set type", async () => {
    let patchSql = "";
    dbModule.pool.query = async (sql) => { patchSql = sql; return { rows: [{ id: 3 }] }; };
    await supertest(mountApp("../teller/routes/subscriptions"))
      .patch("/api/recurring-transfers/3/type").send({ transfer_type: "savings" }).expect(200);
    assert.match(patchSql, /transfer_type_user_set = true/);

    const log = [];
    await detectRecurringTransfers(detectPool(series([250], [30, 30, 30], 3, "zelle to jo"), log));
    const upsert = log.find(q => /INSERT INTO recurring_transfers/.test(q.sql));
    assert.ok(upsert);
    assert.match(upsert.sql, /WHEN recurring_transfers\.transfer_type_user_set THEN recurring_transfers\.transfer_type/);
    assert.match(read("teller", "services", "database.js"), /ADD COLUMN IF NOT EXISTS transfer_type_user_set BOOLEAN NOT NULL DEFAULT false/);
  });
});

// ---------------------------------------------------------------------------
// DC-5 — csv-overlap targets CSV-import accounts, never manual cash accounts
// ---------------------------------------------------------------------------
describe("DC-5 — csv-overlap identifies CSV accounts by their virtual item", () => {
  const app = () => mountApp("../teller/routes/transactions");
  it("GET joins plaid_items status = 'CSV' (not is_manual) and counts DISTINCT CSV rows", async () => {
    let sql = "";
    dbModule.pool.query = async (s) => { sql = s; return { rows: [] }; };
    await supertest(app()).get("/api/transactions/csv-overlap").expect(200);
    assert.match(sql, /pi_csv\.status = 'CSV'/);
    assert.match(sql, /SELECT DISTINCT/);
    assert.match(sql, /pi_s\.status <> 'CSV'/);
    assert.doesNotMatch(sql, /is_manual = true/);
  });
  it("resolve refuses a manual (cash) account as the CSV side — it would delete hand entries", async () => {
    let deleted = false;
    dbModule.pool.query = async (s) => {
      if (/FROM linked_accounts la/.test(s)) {
        return { rows: [
          { id: 1, account_id: "manual_cash", plaid_item_id: null, teller_enrollment_id: null, plaid_status: null },
          { id: 2, account_id: "chk", plaid_item_id: 9, teller_enrollment_id: null, plaid_status: "GOOD" },
        ] };
      }
      if (/DELETE FROM transactions/.test(s)) deleted = true;
      return { rows: [] };
    };
    const res = await supertest(app()).post("/api/transactions/csv-overlap/resolve").send({ csv_account_id: 1, synced_account_id: 2 });
    assert.equal(res.status, 400);
    assert.equal(deleted, false);
  });
  it("resolve accepts a real CSV account and refuses a CSV account as the synced side", async () => {
    const rows = [
      { id: 1, account_id: "csv_chase", plaid_item_id: 7, teller_enrollment_id: null, plaid_status: "CSV" },
      { id: 2, account_id: "chk", plaid_item_id: 9, teller_enrollment_id: null, plaid_status: "GOOD" },
      { id: 3, account_id: "csv_other", plaid_item_id: 8, teller_enrollment_id: null, plaid_status: "CSV" },
    ];
    dbModule.pool.query = async (s, p) => {
      if (/FROM linked_accounts la/.test(s)) return { rows: rows.filter(r => p[0].includes(r.id)) };
      if (/SELECT t_csv\.transaction_id/.test(s)) return { rows: [{ transaction_id: "x1" }, { transaction_id: "x2" }] };
      return { rows: [] };
    };
    const ok = await supertest(app()).post("/api/transactions/csv-overlap/resolve").send({ csv_account_id: 1, synced_account_id: 2, dry_run: true });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.would_delete, 2);
    const bad = await supertest(app()).post("/api/transactions/csv-overlap/resolve").send({ csv_account_id: 1, synced_account_id: 3, dry_run: true });
    assert.equal(bad.status, 400);
  });
});

// ---------------------------------------------------------------------------
// DC-6 / DC-15 — CSV import balance + counts
// ---------------------------------------------------------------------------
describe("DC-6 / DC-15 — CSV import", () => {
  const CSV = [
    "Transaction Date,Post Date,Description,Category,Type,Amount",
    "08/15/2026,08/16/2026,Grocer,Groceries,Sale,-50.00",   // before the known balance date
    "09/10/2026,09/11/2026,Cafe,Food & Drink,Sale,-20.00",  // after → moves the balance
    "09/12/2026,09/13/2026,Dup,Misc,Sale,-7.00",            // already present → duplicate
    "09/13/2026,09/14/2026,BadRow,Misc,Sale,",              // unparseable → skipped
  ].join("\n");
  function fakeClient(state) {
    return {
      query: async (sql, params) => {
        state.log.push({ sql, params });
        if (/INSERT INTO transactions/.test(sql)) return { rowCount: params[4] === "Dup" ? 0 : 1 };
        if (/SELECT id FROM plaid_items/.test(sql)) return { rows: [{ id: 1 }] };
        if (/FROM linked_accounts\s+WHERE is_manual = true/.test(sql)) {
          return { rows: [{ id: 42, type: "depository", current_balance: "1000.00", balance_as_of: "2026-09-01" }] };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    };
  }
  it("rolls the known balance forward by only the new rows after it (not the all-time CSV net)", async () => {
    const state = { log: [] };
    dbModule.pool.connect = async () => fakeClient(state);
    dbModule.pool.query = async () => ({ rows: [] });
    const res = await supertest(mountApp("../teller/routes/subscriptions"))
      .post("/api/import-csv").attach("file", Buffer.from(CSV), "chase.csv").expect(200);
    assert.equal(res.body.rows_imported, 2);
    assert.equal(res.body.rows_duplicate, 1);
    assert.equal(res.body.rows_skipped, 1, "rows_skipped no longer double-counts duplicates (matches the preview)");
    const upd = state.log.find(q => /UPDATE linked_accounts SET current_balance/.test(q.sql));
    assert.ok(upd, "balance update issued");
    assert.deepEqual(upd.params, [980, 42], "1000 − 20 (only the Sep-10 row post-dates the balance)");
    assert.ok(!state.log.some(q => /SELECT SUM\(amount\) AS net FROM transactions/.test(q.sql)));
    const hist = state.log.find(q => /INSERT INTO csv_imports/.test(q.sql));
    assert.equal(hist.params[4], 2, "history keeps 'not imported' = skipped + duplicates");
  });
  it("leaves an account with no known balance untouched", async () => {
    const state = { log: [] };
    const client = fakeClient(state);
    const q = client.query;
    client.query = async (sql, params) => {
      if (/FROM linked_accounts\s+WHERE is_manual = true/.test(sql)) return { rows: [{ id: 42, type: "depository", current_balance: null, balance_as_of: null }] };
      return q(sql, params);
    };
    dbModule.pool.connect = async () => client;
    await supertest(mountApp("../teller/routes/subscriptions"))
      .post("/api/import-csv").attach("file", Buffer.from(CSV), "chase.csv").expect(200);
    assert.ok(!state.log.some(x => /UPDATE linked_accounts SET current_balance/.test(x.sql)));
  });
});

// ---------------------------------------------------------------------------
// SXE-11 — default paid_amount
// ---------------------------------------------------------------------------
describe("SXE-11 — a bill marked paid without an amount records the bill's amount", () => {
  it("looks up the manual bill / subscription amount when paid_amount is omitted", async () => {
    const inserts = [];
    dbModule.pool.query = async (sql, p) => {
      if (/SELECT amount FROM manual_bills/.test(sql)) return { rows: [{ amount: "82.40" }] };
      if (/SELECT amount FROM detected_subscriptions/.test(sql)) return { rows: [{ amount: "15.49" }] };
      if (/INSERT INTO bill_payments/.test(sql)) { inserts.push(p); return { rows: [{ id: 1 }] }; }
      return { rows: [] };
    };
    const app = mountApp("../teller/routes/subscriptions");
    await supertest(app).post("/api/bill-payments").send({ bill_source: "manual", bill_id: 4, paid_date: "2026-09-05" }).expect(200);
    await supertest(app).post("/api/bill-payments").send({ bill_source: "subscription", bill_id: 9, paid_date: "2026-09-05" }).expect(200);
    await supertest(app).post("/api/bill-payments").send({ bill_source: "manual", bill_id: 4, paid_date: "2026-09-06", paid_amount: 90 }).expect(200);
    assert.equal(inserts[0][3], 82.4);
    assert.equal(inserts[1][3], 15.49);
    assert.equal(inserts[2][3], 90, "an explicit amount wins");
  });
  it("the Sheets Payments Log blanks the variance when no amount was recorded", () => {
    const src = read("scripts", "sheets-sync.js");
    assert.match(src, /expected > 0 && hasPaid \? fmtCurrency\(paid - expected\) : ""/);
  });
});

// ---------------------------------------------------------------------------
// DC-15 — validation + consistency nits
// ---------------------------------------------------------------------------
describe("DC-15 — manual bills, manual cash, categorize", () => {
  it("PATCH /api/manual-bills rejects a non-numeric / non-positive amount and a bad due_day", async () => {
    let wrote = false;
    dbModule.pool.query = async () => { wrote = true; return { rows: [{ id: 1 }] }; };
    const app = mountApp("../teller/routes/subscriptions");
    assert.equal((await supertest(app).patch("/api/manual-bills/1").send({ amount: "abc" })).status, 400);
    assert.equal((await supertest(app).patch("/api/manual-bills/1").send({ amount: -3 })).status, 400);
    assert.equal((await supertest(app).patch("/api/manual-bills/1").send({ due_day: 40 })).status, 400);
    assert.equal(wrote, false);
    assert.equal((await supertest(app).patch("/api/manual-bills/1").send({ amount: "12.50" })).status, 200);
  });
  it("manual cash entry refuses a synced (non-manual) account", async () => {
    let inserted = false;
    dbModule.pool.query = async (sql) => {
      if (/FROM linked_accounts WHERE account_id/.test(sql)) return { rows: [{ account_id: "plaid_chk", is_manual: false }] };
      if (/INSERT INTO transactions/.test(sql)) inserted = true;
      return { rows: [{}] };
    };
    const res = await supertest(mountApp("../teller/routes/transactions")).post("/api/transactions/manual")
      .send({ account_id: "plaid_chk", amount: 5, date: "2026-09-01" });
    assert.equal(res.status, 400);
    assert.equal(inserted, false);
  });
  it("the calendar and the ICS feed place a quarterly manual bill in the same months", async () => {
    const bill = { id: 5, name: "Water", amount: "60.00", due_day: 31, cadence: "quarterly", category: "utility", created_at: new Date(2026, 0, 10), is_active: true };
    dbModule.pool.query = async (sql) => {
      if (/FROM manual_bills/.test(sql)) return { rows: [bill] };
      return { rows: [] };
    };
    const app = mountApp("../teller/routes/subscriptions");
    const calMonths = [];
    for (const [y, m] of [[2026, 10], [2026, 11], [2026, 12], [2027, 1], [2027, 2], [2027, 3], [2027, 4]]) {
      const res = await supertest(app).get(`/api/bill-calendar?year=${y}&month=${m}`).expect(200);
      for (const d of res.body.days) if (d.events.some(e => e.name === "Water")) calMonths.push(d.date);
    }
    const icsFn = require("../teller/routes/subscriptions").buildBillCalendarIcs;
    const expectedIcs = cadence.manualBillOccurrences(bill, ymd(utcToday()), ymd(utcToday() + 365 * DAY));
    // Both surfaces use the same rule: Jan anchor, day 31 clamped → Apr 30, Jul 31, Oct 31, Jan 31 …
    assert.ok(calMonths.includes("2026-10-31"));
    assert.ok(calMonths.includes("2027-01-31"));
    assert.ok(calMonths.includes("2027-04-30"));
    assert.equal(calMonths.length, 3);
    for (const d of expectedIcs) assert.equal(["01", "04", "07", "10"].includes(d.slice(5, 7)), true);
    const ics = await icsFn(365);
    assert.ok(expectedIcs.length >= 4);
    for (const d of expectedIcs) assert.ok(ics.includes("DTSTART;VALUE=DATE:" + d.replace(/-/g, "")), "ICS has " + d);
  });
  it("the AI categorize batch sends the user's merchant rename to Claude", () => {
    const src = read("teller", "routes", "categorize.js");
    assert.match(src, /SELECT transaction_id, COALESCE\(user_merchant_name, merchant_name, name\) AS merchant, amount, date, category/);
  });
});
