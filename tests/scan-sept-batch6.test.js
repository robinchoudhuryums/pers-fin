// ============================================================================
// Broad-scan (Sept 2026) Batch 6 regression tests — dates, months & budgets
// (Perfin side; Per-sistant pins live in apps/per-sistant/tests/scan-sept-batch6.test.js;
//  the APP_TIMEZONE-sensitive pins live in tests/scan-sept-batch6-tz.test.js)
// ============================================================================
// FAN-7  the scheduled prior-month budget snapshot is RE-TAKEN on days 1-5
//        (late-posting month-end charges) and only created-if-missing after
// AIN-6 / SXE-4 / WUI-5  one getBudgetStatus helper (effective limit = base +
//        prior-month rollover; one-time budgets only in their month) shared by
//        GET /api/budgets, alerts, the insights prompt, Ask and the Budgets page
// FAN-8  budget suggestions average the 3 most recent COMPLETE months
// FAN-14 PATCH /api/budgets/:id validates like POST
// FAN-13 / SXE-12 / AIN-15  remaining UTC anchors → todayStr()/currentMonth();
//        the daily digest lands once per LOCAL date at/after 07:00 and covers
//        everything since the previous send; the ICS feed keeps overdue rent
// WUI-2  calendar dates parse as LOCAL dates; "today" defaults are local
// FAN-15 month-end-safe month addition for payoff / goal / FIRE dates
// DD-11  YoY compares the same days of each year, consecutive years only
// ============================================================================

delete process.env.APP_TIMEZONE; // this file asserts UTC-anchored behavior
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
afterEach(() => { dbModule.pool.query = originalQuery; });

const fq = require("../teller/services/financial-queries");
const projections = require("../teller/services/projections");

function mountApp(mod) {
  const app = express();
  app.use(express.json());
  app.use(require(mod));
  return app;
}

// A pool double that dispatches on the SQL text.
function budgetPool({ budgets = [], spending = [], snapshots = [], onSnapshot } = {}) {
  return {
    query: async (sql, params) => {
      if (/FROM budget_snapshots WHERE month = \$1/.test(sql) && /rollover_amount/.test(sql)) {
        if (onSnapshot) onSnapshot(params);
        return { rows: snapshots };
      }
      if (/FROM budgets/.test(sql)) return { rows: budgets };
      if (/month_start/.test(sql)) return { rows: spending };
      return { rows: [] };
    },
  };
}

// ---------------------------------------------------------------------------
// AIN-6 / SXE-4 / WUI-5 — one budget-status helper
// ---------------------------------------------------------------------------
describe("AIN-6 — getBudgetStatus is the one budget-status definition", () => {
  const BUDGETS = [
    { id: 1, category: "Dining", monthly_limit: "500", rollover_enabled: true, budget_type: "recurring" },
    { id: 2, category: "Travel", monthly_limit: "2000", rollover_enabled: false, budget_type: "one_time", effective_month: "2026-06" },
    { id: 3, category: "Groceries", monthly_limit: "400", rollover_enabled: false, budget_type: "recurring" },
  ];

  it("effective_limit = base + the PRIOR month's rollover; one-time budgets only in their month", async () => {
    let snapMonth;
    const pool = budgetPool({
      budgets: BUDGETS,
      spending: [{ category: "Dining", spent: "540" }, { category: "Groceries", spent: "100" }],
      snapshots: [{ budget_id: 1, rollover_amount: "80" }, { budget_id: 3, rollover_amount: "300" }],
      onSnapshot: (p) => { snapMonth = p[0]; },
    });
    const rows = await fq.getBudgetStatus(pool, "2026-09");
    assert.equal(snapMonth, "2026-08", "rollover comes from the prior month's snapshot (FA-1)");
    assert.deepEqual(rows.map((r) => r.category), ["Dining", "Groceries"], "June one-time budget hidden in September");
    const dining = rows[0];
    assert.equal(dining.effective_limit, 580);
    assert.equal(dining.rollover_amount, 80);
    assert.equal(dining.spent, 540);
    assert.equal(dining.remaining, 40, "a rolled-over budget is NOT overspent");
    assert.equal(dining.percent_used, 93);
    const groc = rows[1];
    assert.equal(groc.effective_limit, 400, "rollover ignored when rollover_enabled is false");
    assert.equal(groc.rollover_amount, 0);
  });

  it("the one-time budget appears in its own month", async () => {
    const rows = await fq.getBudgetStatus(budgetPool({ budgets: BUDGETS }), "2026-06");
    assert.ok(rows.some((r) => r.category === "Travel"));
  });

  it("previousMonthKey wraps the year (string math)", () => {
    assert.equal(fq.previousMonthKey("2026-01"), "2025-12");
    assert.equal(fq.previousMonthKey("2026-10"), "2026-09");
  });

  it("GET /api/budgets, alerts, the insights prompt and Ask all route through getBudgetStatus", () => {
    const budgets = read("teller/routes/budgets.js");
    assert.match(budgets, /const result = await getBudgetStatus\(pool, queryMonth\)/);
    assert.match(budgets, /const budgets = await getBudgetStatus\(pool, month\)/);
    assert.match(read("teller/routes/insights.js"), /await getBudgetStatus\(pool\)/);
    assert.match(read("teller/routes/ask.js"), /await getBudgetStatus\(pool, month\)/);
  });

  it("the Ask tool reports the effective limit and rollover", async () => {
    const ask = read("teller/routes/ask.js");
    const body = ask.slice(ask.indexOf("async function toolBudgetStatus"), ask.indexOf("async function toolFireProjection"));
    assert.match(body, /effective_limit: b\.effective_limit/);
    assert.match(body, /rollover_amount: b\.rollover_amount/);
  });

  it("the Budgets page renders effective_limit, not the bare monthly_limit (WUI-5)", () => {
    const view = read("teller/views/budgets.ejs");
    assert.match(view, /effective_limit/);
    assert.match(view, /rolled over/);
  });

  it("GET /api/budgets returns the shared shape", async () => {
    dbModule.pool.query = budgetPool({
      budgets: [BUDGETS[0]],
      spending: [{ category: "Dining", spent: "100" }],
      snapshots: [{ budget_id: 1, rollover_amount: "50" }],
    }).query;
    const res = await supertest(mountApp("../teller/routes/budgets")).get("/api/budgets?month=2026-09");
    assert.equal(res.status, 200);
    assert.equal(res.body[0].effective_limit, 550);
    assert.equal(res.body[0].remaining, 450);
  });
});

// ---------------------------------------------------------------------------
// FAN-7 — snapshot refresh window
// ---------------------------------------------------------------------------
describe("FAN-7 — the prior-month snapshot is refreshed on days 1-5", () => {
  const { runBudgetSnapshot, SNAPSHOT_REFRESH_DAYS } = require("../teller/routes/budgets");
  function snapDb({ existing = false } = {}) {
    const inserts = [];
    return {
      inserts,
      query: async (sql, params) => {
        if (/SELECT 1 FROM budget_snapshots/.test(sql)) return { rows: existing ? [{ "?column?": 1 }] : [] };
        if (/INSERT INTO budget_snapshots/.test(sql)) { inserts.push({ sql, params }); return { rowCount: 1, rows: [] }; }
        if (/SELECT \* FROM budgets/.test(sql)) return { rows: [{ id: 1, category: "Dining", monthly_limit: "500", rollover_enabled: true }] };
        if (/month_start/.test(sql)) return { rows: [{ category: "Dining", spent: "480" }] };
        return { rows: [] };
      },
    };
  }

  it("day 3: re-takes the prior month with DO UPDATE even though a snapshot exists", async () => {
    assert.equal(SNAPSHOT_REFRESH_DAYS, 5);
    const db = snapDb({ existing: true });
    const r = await runBudgetSnapshot(db, "2026-10-03");
    assert.equal(r.month, "2026-09");
    assert.equal(r.mode, "refresh");
    assert.equal(db.inserts.length, 1);
    assert.match(db.inserts[0].sql, /DO UPDATE/);
    assert.deepEqual(db.inserts[0].params, [1, "2026-09", 500, 480, 20], "rollover reflects the late $60 of spend");
  });

  it("day 12 with a snapshot already present: leaves it alone", async () => {
    const db = snapDb({ existing: true });
    const r = await runBudgetSnapshot(db, "2026-10-12");
    assert.equal(r.mode, "exists");
    assert.equal(db.inserts.length, 0);
  });

  it("day 12 with no snapshot: catch-up create-if-missing (M5)", async () => {
    const db = snapDb({ existing: false });
    const r = await runBudgetSnapshot(db, "2026-10-12");
    assert.equal(r.mode, "catch_up");
    assert.match(db.inserts[0].sql, /DO NOTHING/);
  });

  it("January rolls back to December of the prior year", async () => {
    const r = await runBudgetSnapshot(snapDb(), "2027-01-02");
    assert.equal(r.month, "2026-12");
  });

  it("startup.js delegates the scheduled snapshot to runBudgetSnapshot", () => {
    assert.match(read("teller/startup.js"), /runBudgetSnapshot\(pool\)/);
  });
});

// ---------------------------------------------------------------------------
// FAN-14 — PATCH validation; FAN-8 — complete months for suggestions
// ---------------------------------------------------------------------------
describe("FAN-14 — PATCH /api/budgets/:id validates its input", () => {
  const app = () => mountApp("../teller/routes/budgets");
  const cases = [
    [{ monthly_limit: "abc" }, /monthly_limit/],
    [{ monthly_limit: -5 }, /monthly_limit/],
    [{ budget_type: "weekly" }, /budget_type/],
    [{ effective_month: "2026-9" }, /effective_month/],
    [{ effective_month: "2026-13" }, /effective_month/],
  ];
  for (const [body, re] of cases) {
    it(`400s ${JSON.stringify(body)}`, async () => {
      dbModule.pool.query = async () => { throw new Error("must not reach the DB"); };
      const res = await supertest(app()).patch("/api/budgets/1").send(body);
      assert.equal(res.status, 400);
      assert.match(res.body.error, re);
    });
  }
  it("accepts a valid update", async () => {
    let captured;
    dbModule.pool.query = async (sql, params) => { captured = { sql, params }; return { rows: [{ id: 1 }] }; };
    const res = await supertest(app()).patch("/api/budgets/1").send({ monthly_limit: "250", effective_month: "2026-09" });
    assert.equal(res.status, 200);
    assert.ok(captured.params.includes(250));
  });
});

describe("FAN-8 — suggestions average the last 3 COMPLETE months", () => {
  it("month keys start at the previous month (the partial current month is excluded)", () => {
    const src = read("teller/routes/budgets.js");
    const body = src.slice(src.indexOf('router.post("/api/budgets/suggest"'), src.indexOf('router.post("/api/budgets/accept"'));
    assert.match(body, /let mk = currentMonthKey\(\);\s*for \(let i = 0; i < 3; i\+\+\) \{ mk = previousMonthKey\(mk\); monthKeys\.push\(mk\); \}/);
    assert.match(body, /last 3 complete months/);
    assert.ok(!/\[0, 1, 2\]\.map/.test(body), "the old [0,1,2] (incl. current month) is gone");
  });
});

// ---------------------------------------------------------------------------
// FAN-15 — month-end-safe month addition
// ---------------------------------------------------------------------------
describe("FAN-15 — month-end-safe month addition", () => {
  const { addMonthsYm, addMonthsYmd, computeLoanPayoff } = projections;
  it("addMonthsYm never skips a month from the 29th-31st", () => {
    assert.equal(addMonthsYm("2026-10-31", 1), "2026-11", "setMonth overflowed Oct 31 → Dec");
    assert.equal(addMonthsYm("2027-01-31", 1), "2027-02");
    assert.equal(addMonthsYm("2026-12-15", 1), "2027-01");
    assert.equal(addMonthsYm("2026-01-15", 24), "2028-01");
  });
  it("addMonthsYmd clamps the day to the target month", () => {
    assert.equal(addMonthsYmd("2026-01-31", 1), "2026-02-28");
    assert.equal(addMonthsYmd("2024-02-29", 12), "2025-02-28");
    assert.equal(addMonthsYmd("2026-10-31", -1), "2026-09-30");
    assert.equal(addMonthsYmd("2026-03-15", 2), "2026-05-15");
  });
  it("computeLoanPayoff's payoff month is anchored on `today`, month-end safe", () => {
    const r = computeLoanPayoff({ balance: 100, aprPct: 0, monthlyPayment: 100, today: "2027-01-31" });
    assert.equal(r.months_to_payoff, 1);
    assert.equal(r.payoff_date, "2027-02");
  });
  it("goals + FIRE use the safe helpers on the tz today", () => {
    const goals = read("teller/routes/goals.js");
    assert.match(goals, /estimated_date = addMonthsYmd\(todayStr\(\), months_to_goal\)/);
    assert.match(goals, /fireDate = addMonthsYm\(todayStr\(\), proj\.months_to_fire\)/);
  });
  it("the dashboard's loanPayoff mirror labels the month via Date.UTC(y, m + n, 1)", () => {
    const dash = read("teller/views/dashboard.ejs");
    assert.match(dash, /new Date\(Date\.UTC\(now0\.getFullYear\(\), now0\.getMonth\(\) \+ m, 1\)\)/);
  });
});

// ---------------------------------------------------------------------------
// AIN-15 — daily digest: once per local date, at/after 07:00, no overlap
// ---------------------------------------------------------------------------
describe("AIN-15 — runDailyDigest is wall-clock anchored", () => {
  const insights = require("../teller/routes/insights");
  const whatsNew = require("../teller/routes/whats-new");
  const persistent = require("../teller/routes/persistent");
  const origGather = whatsNew.gatherWhatsNew;
  const origSend = persistent.sendPerSistantWebhook;
  afterEach(() => { whatsNew.gatherWhatsNew = origGather; persistent.sendPerSistantWebhook = origSend; });

  function setup(last) {
    const calls = { since: null, updates: [] };
    dbModule.pool.query = async (sql, params) => {
      if (/SELECT daily_digest_enabled/.test(sql)) return { rows: [{ daily_digest_enabled: true, last_daily_digest_at: last }] };
      if (/UPDATE user_settings SET last_daily_digest_at/.test(sql)) { calls.updates.push(params); return { rows: [] }; }
      return { rows: [] };
    };
    whatsNew.gatherWhatsNew = async (since) => {
      calls.since = since;
      return { counts: { transactions: 2, balance_changes: 0, subscriptions: 0, notifications: 0 }, transactions: [], balance_changes: [], subscriptions: [], notifications: [] };
    };
    persistent.sendPerSistantWebhook = async () => ({ sent: true });
    return calls;
  }

  it("before 07:00 local → too_early", async () => {
    setup(null);
    const r = await insights.runDailyDigest(new Date("2026-10-08T05:00:00Z"));
    assert.equal(r.reason, "too_early");
  });

  it("a second tick on the same local date → already_sent_today", async () => {
    setup(new Date("2026-10-08T07:30:00Z"));
    const r = await insights.runDailyDigest(new Date("2026-10-08T15:00:00Z"));
    assert.equal(r.reason, "already_sent_today");
  });

  it("covers exactly the time since the previous send and stamps `now`", async () => {
    const last = new Date("2026-10-07T07:02:00Z");
    const now = new Date("2026-10-08T07:05:00Z");
    const calls = setup(last);
    const r = await insights.runDailyDigest(now);
    assert.equal(r.sent, true);
    assert.equal(calls.since.toISOString(), last.toISOString(), "no overlap with the previous digest");
    assert.equal(calls.updates[0][0].toISOString(), now.toISOString());
  });

  it("a long-idle feature looks back at most 72h; a first send looks back 24h", async () => {
    const now = new Date("2026-10-08T08:00:00Z");
    let calls = setup(new Date("2026-09-20T07:00:00Z"));
    await insights.runDailyDigest(now);
    assert.equal(now - calls.since, 72 * 3600 * 1000);
    calls = setup(null);
    await insights.runDailyDigest(now);
    assert.equal(now - calls.since, 24 * 3600 * 1000);
  });
});

// ---------------------------------------------------------------------------
// SXE-12 — Sheets tz anchors + ICS overdue housing
// ---------------------------------------------------------------------------
describe("SXE-12 — Sheets windows / timestamps anchored on APP_TIMEZONE", () => {
  const src = read("scripts/sheets-sync.js");
  it("the dashboard timestamp is no longer hard-wired to America/New_York", () => {
    assert.ok(!/America\/New_York/.test(src));
    assert.match(src, /const SHEETS_TZ = process\.env\.APP_TIMEZONE \|\| "UTC"/);
  });
  it("6-month + this-month windows are whole tz months (validated literals)", () => {
    assert.match(src, /const WINDOW_6MO = `t\.date >= \$\{sqlDate\(WINDOW_6MO_START\)\}`/);
    assert.match(src, /WINDOW_THIS_MONTH = `t\.date >= \$\{sqlDate\(sheetsMonth\(0\) \+ "-01"\)\} AND t\.date < \$\{sqlDate\(sheetsMonth\(1\) \+ "-01"\)\}`/);
  });
  it("the monthly archive's 'current month' and the tax year come from the tz date", () => {
    assert.match(src, /< \$\{sqlMonth\(sheetsMonth\(0\)\)\}/);
    assert.ok(!/new Date\(\)\.getFullYear\(\)/.test(src), "tax year no longer read from the server's Date");
  });
  it("Budget Status compares against the effective limit (SXE-4)", () => {
    assert.match(src, /budget_snapshots bs/);
    assert.match(src, /effective_limit/);
  });
});

describe("SXE-12 — the ICS feed keeps an overdue unpaid rent obligation on today", () => {
  it("an obligation two months past due is listed on TODAY, flagged OVERDUE", async () => {
    const today = fq.todayStr();
    const [y, m] = today.split("-").map(Number);
    const t = y * 12 + (m - 1) - 2;
    const period = `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
    dbModule.pool.query = async (sql) => {
      if (/FROM payee_obligations/.test(sql)) return { rows: [{ id: 9, label: "Rent", amount: "1500", period, due_day: 1 }] };
      return { rows: [] };
    };
    const ics = await require("../teller/routes/subscriptions").buildBillCalendarIcs(90);
    assert.match(ics, /UID:housing-9@perfin/);
    assert.match(ics, new RegExp("DTSTART;VALUE=DATE:" + today.replace(/-/g, "")));
    assert.match(ics, /OVERDUE/);
  });
});

// ---------------------------------------------------------------------------
// FAN-13 — income-summary average + window anchor; DD-11 — YoY
// ---------------------------------------------------------------------------
describe("FAN-13 — /api/income-summary averages completed months on the tz month", () => {
  it("excludes the partial current month from avg_monthly_income; window anchored on $2::date", async () => {
    const cm = fq.currentMonth();
    const prev = fq.previousMonthKey(cm);
    const seen = [];
    dbModule.pool.query = async (sql, params) => {
      seen.push({ sql, params });
      if (/AS month,/.test(sql)) return { rows: [{ month: prev, total_income: "3000" }, { month: cm, total_income: "300" }] };
      return { rows: [] };
    };
    const res = await supertest(mountApp("../teller/routes/spending-analytics")).get("/api/income-summary?months=6");
    assert.equal(res.status, 200);
    assert.equal(res.body.avg_monthly_income, 3000, "the $300 month-to-date no longer halves the average");
    assert.equal(res.body.total_income, 3300);
    for (const q of seen) {
      assert.ok(!/date_trunc\('month', CURRENT_DATE\)/.test(q.sql));
      assert.deepEqual(q.params, [6, cm + "-01"]);
    }
  });
});

describe("DD-11 — YoY compares the same days, consecutive years only", () => {
  it("a past month is uncapped; a gap year is not presented as year-over-year", async () => {
    let params;
    dbModule.pool.query = async (sql, p) => {
      params = p;
      assert.match(sql, /EXTRACT\(YEAR FROM t\.date\) BETWEEN \$2 - 2 AND \$2/);
      assert.match(sql, /EXTRACT\(DAY FROM t\.date\) <= \$3/);
      return { rows: [
        { year: "2025", month: "03", category: "Dining", total: "400", txn_count: "8" },
        { year: "2023", month: "03", category: "Dining", total: "350", txn_count: "7" },
      ] };
    };
    const res = await supertest(mountApp("../teller/routes/spending-analytics")).get("/api/spending-yoy?month=3&year=2025");
    assert.equal(res.status, 200);
    assert.deepEqual(params, [3, 2025, 31]);
    assert.equal(res.body.through_day, null);
    assert.deepEqual(res.body.comparisons, [], "2025 vs 2023 is not year-over-year");
  });

  it("the CURRENT month caps every year at today's day-of-month", async () => {
    const today = fq.todayStr();
    const [y, m, d] = today.split("-").map(Number);
    let params;
    dbModule.pool.query = async (_sql, p) => {
      params = p;
      return { rows: [
        { year: String(y), month: "x", category: "Dining", total: "50", txn_count: "1" },
        { year: String(y - 1), month: "x", category: "Dining", total: "100", txn_count: "2" },
      ] };
    };
    const res = await supertest(mountApp("../teller/routes/spending-analytics")).get("/api/spending-yoy");
    assert.deepEqual(params, [m, y, d]);
    assert.equal(res.body.through_day, d);
    assert.equal(res.body.comparisons.length, 1);
    assert.equal(res.body.comparisons[0].previous_year, String(y - 1));
  });

  it("the dashboard labels a capped comparison", () => {
    assert.match(read("teller/views/dashboard.ejs"), /through_day/);
  });
});

// ---------------------------------------------------------------------------
// WUI-2 — calendar dates are local dates
// ---------------------------------------------------------------------------
describe("WUI-2 — parseCalDate / fmtDate / localTodayStr", () => {
  const src = read("teller/public/perfin-shared.js");
  const start = src.indexOf("var DATE_ONLY_RE");
  const end = src.indexOf("function fmtMonth");
  assert.ok(start > 0 && end > start, "date helpers present in perfin-shared.js");
  // eslint-disable-next-line no-new-func
  const mk = new Function(src.slice(start, end) + "\nreturn { parseCalDate, fmtDate, localTodayStr, localDateStr };");

  it("a DATE column renders as its own calendar day west of UTC", () => {
    const prevTz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const h = mk();
      assert.equal(h.fmtDate("2026-09-27"), "Sep 27");
      assert.equal(h.fmtDate("2026-09-27T00:00:00.000Z"), "Sep 27", "node-pg's UTC-midnight DATE serialization");
      const d = h.parseCalDate("2026-03-01");
      assert.equal(d.getDate(), 1);
      assert.equal(d.getMonth(), 2);
      // A real instant is left alone.
      assert.equal(h.parseCalDate("2026-09-27T18:30:00.000Z").toISOString(), "2026-09-27T18:30:00.000Z");
      assert.equal(h.fmtDate(null), "—");
    } finally {
      if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
    }
  });

  it("localTodayStr / localDateStr use local getters", () => {
    const h = mk();
    const n = new Date();
    const exp = n.getFullYear() + "-" + String(n.getMonth() + 1).padStart(2, "0") + "-" + String(n.getDate()).padStart(2, "0");
    assert.equal(h.localTodayStr(), exp);
    assert.equal(h.localDateStr(new Date(2026, 0, 5)), "2026-01-05");
  });

  it("the helpers are exported and used by the pages that defaulted to the UTC date", () => {
    assert.match(src, /win\.parseCalDate = parseCalDate/);
    assert.match(src, /win\.localTodayStr = localTodayStr/);
    assert.match(read("teller/views/calendar.ejs"), /var todayStr = localTodayStr\(\)/);
    assert.match(read("teller/public/transactions.js"), /localTodayStr\(\)/);
    assert.match(read("teller/views/subscriptions.ejs"), /parseCalDate/);
    assert.match(read("teller/views/dashboard.ejs"), /localTodayStr\(\)/);
  });
});

// ---------------------------------------------------------------------------
// FAN-13 / SXE-12 — the remaining server "today" defaults
// ---------------------------------------------------------------------------
describe("FAN-13 — server defaults route through todayStr()", () => {
  it("credit-score checked_at, housing reminder/export/payment dates, weekly digest day", () => {
    assert.match(read("teller/routes/credit-scores.js"), /todayStr\(\)/);
    const housing = read("teller/routes/housing.js");
    assert.ok((housing.match(/todayStr\(\)/g) || []).length >= 3);
    assert.match(read("teller/startup.js"), /new Date\(todayStr\(\) \+ "T00:00:00Z"\)\.getUTCDay\(\)/);
  });
});

// ---------------------------------------------------------------------------
// Follow-on (found during Batch 6 real-PG verification): the Sheets Utilities
// tab's UNION query ordered by an expression, which Postgres rejects on a
// UNION — the tab failed on every sync.
// ---------------------------------------------------------------------------
describe("Sheets Utilities — UNION wrapped before the expression ORDER BY", () => {
  it("the query selects from a subquery and orders on its output columns", () => {
    const src = read("scripts/sheets-sync.js");
    const body = src.slice(src.indexOf("async function syncUtilities"), src.indexOf('const SHEET_UTILITIES = "Utilities"'));
    const sql = body.slice(body.indexOf("pool.query(`") + 12, body.indexOf("`);"));
    assert.match(sql, /^\s*SELECT \* FROM \(\s*SELECT/);
    assert.match(sql, /UNION ALL/);
    const tail = sql.slice(sql.lastIndexOf(") u"));
    assert.match(tail, /^\) u\s+ORDER BY\s+CASE WHEN u\.status = 'Active' THEN 0 ELSE 1 END,\s+u\.next_due NULLS LAST\s*$/);
    // No ORDER BY inside the UNION body itself.
    assert.ok(!/ORDER BY/.test(sql.slice(0, sql.lastIndexOf(") u"))));
  });
});
