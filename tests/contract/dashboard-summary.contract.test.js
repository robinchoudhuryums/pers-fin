// Real-Postgres contract test for design pass D3 — GET /api/dashboard/summary
// (`.cycle/plan-design-ux.md`, decision 5; INV-147), the production routers
// mounted in server.js order. On real rows every summary figure equals the one
// its own screen shows, to the cent:
//  - spending = the sum of GET /api/budgets' spent / effective_limit;
//  - cash = GET /api/cash-flow?days=30's lowest projected day;
//  - net worth = the latest net_worth_snapshots row, change since the month's first;
//  - bills due in 7 days = GET /api/forecast?days=7 + the bill calendar's unpaid
//    manual bills in the window;
//  - rent owed = GET /api/housing/ledger's balance (payee-scoped);
//  - uncategorized = GET /api/categorize/status; Sync Health = GET /api/data-health's warnings.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("Dashboard summary (design D3) on real Postgres", { skip: SKIP }, () => {
  let pool, app, today, cm, add;
  const q = (s, p) => pool.query(s, p);

  before(async () => {
    pool = await perfinDb("dash_summary");
    app = perfinApp();
    const fq = require("../../teller/services/financial-queries");
    today = fq.todayStr();
    cm = fq.currentMonth();
    add = (n) => require("../../teller/services/cadence").addDaysStr(today, n);

    await q(`INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual, current_balance)
             VALUES ('chk','Checking','depository','checking',true,2500), ('card','Card','credit','credit card',true,300)`);
    const tx = (id, amt, cat, merchant) => q(
      `INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, category, pending)
       VALUES ('card',$1,$2,$3,$4,$4,$5,false)`, [id, amt, cm + "-01", merchant || "Shop " + id, cat ? [cat] : null]);
    await tx("g1", 120.4, "Groceries");
    await tx("g2", 33.35, "Groceries");
    await tx("d1", 210, "Food & Drink");
    await tx("u1", 12.5, null, "MYSTERY CHARGE");
    await tx("u2", 8, null, "ANOTHER ONE");
    await q("INSERT INTO budgets (category, monthly_limit) VALUES ('Groceries', 200), ('Food & Drink', 150)");

    // Last month, the month's first day (unless that's today) and today.
    const snap = (v, d) => q("INSERT INTO net_worth_snapshots (net_worth, snapshot_date) VALUES ($1,$2) ON CONFLICT (snapshot_date) DO NOTHING", [v, d]);
    await snap(40000, add(-40));
    if (today !== cm + "-01") await snap(41000.55, cm + "-01");
    await snap(42500.10, today);

    // A weekly subscription due in 4 days; manual bills due in 2 and 3 days
    // (the latter marked paid) and one past the window.
    await q(`INSERT INTO detected_subscriptions (merchant_key, display_name, amount, cadence_days, first_seen, last_charged, next_expected, is_active)
             VALUES ('gym','Gym',25.5,7,$1,$2,$3,true)`, [add(-60), add(-3), add(4)]);
    const day = (ymd) => Number(ymd.slice(8, 10));
    const bill = async (name, amount, ymd) => (await q(
      "INSERT INTO manual_bills (name, amount, due_day, cadence, category, created_at) VALUES ($1,$2,$3,'monthly','utility',$4) RETURNING id",
      [name, amount, day(ymd), ymd + "T12:00:00Z"])).rows[0].id;
    await bill("Water", 60.25, add(2));
    const paidId = await bill("Internet", 70, add(3));
    await bill("Far off", 999, add(12));
    await q("INSERT INTO bill_payments (bill_source, bill_id, paid_date, paid_amount) VALUES ('manual',$1,$2,70)", [paidId, add(3)]);

    // Rent & Utilities: two unpaid items for the configured payee, one awaiting
    // its bill, and an old payee's unpaid row that mustn't count.
    await q("UPDATE user_settings SET housing_config = $1 WHERE id = 1",
      [JSON.stringify({ enabled: true, payee_name: "Sam Lee", rent_amount: 1500, rent_due_day: 1, start_month: cm })]);
    await q(`INSERT INTO payee_obligations (payee, category, label, period, amount, due_day, status) VALUES
             ('Sam Lee','rent','Rent',$1,1500,1,'unpaid'),
             ('Sam Lee','utility','Electricity',$1,82.17,1,'unpaid'),
             ('Sam Lee','utility','Water',$1,NULL,1,'pending_amount'),
             ('Old Landlord','rent','Rent',$1,900,1,'unpaid')`, [cm]);
  });
  after(async () => { if (pool) await pool.end(); });

  it("every figure equals its own screen's", async () => {
    const s = (await supertest(app).get("/api/dashboard/summary").expect(200)).body;
    assert.equal(s.today, today);

    // Spending = GET /api/budgets.
    const budgets = (await supertest(app).get("/api/budgets").expect(200)).body;
    const list = Array.isArray(budgets) ? budgets : budgets.budgets;
    const sum = (k) => Math.round(list.reduce((t, b) => t + Number(b[k]), 0) * 100) / 100;
    assert.equal(s.spending.ok, true);
    assert.equal(s.spending.spent, sum("spent"));
    assert.equal(s.spending.budget, sum("effective_limit"));
    assert.equal(s.spending.spent, 363.75, "the fixture's charges in budgeted categories");
    assert.equal(s.spending.budget, 350);
    assert.equal(s.spending.over_count, 1, "Food & Drink is over");

    // Cash = GET /api/cash-flow?days=30.
    const cf = (await supertest(app).get("/api/cash-flow?days=30").expect(200)).body;
    assert.equal(s.cash.lowest_balance, cf.lowest_balance);
    assert.equal(s.cash.lowest_date, cf.lowest_balance_date);
    assert.equal(s.cash.starting_balance, cf.starting_balance);

    // Net worth = the latest snapshot; change since the month's first.
    const latest = (await q("SELECT net_worth::float AS v FROM net_worth_snapshots ORDER BY snapshot_date DESC LIMIT 1")).rows[0].v;
    assert.equal(s.net_worth.value, latest);
    assert.equal(s.net_worth.as_of, today);
    const first = (await q("SELECT net_worth::float AS v, snapshot_date::text AS d FROM net_worth_snapshots WHERE snapshot_date >= $1 ORDER BY snapshot_date LIMIT 1", [cm + "-01"])).rows[0];
    if (first.d < today) {
      assert.equal(s.net_worth.change, Math.round((latest - first.v) * 100) / 100);
      assert.equal(s.net_worth.change_since, first.d);
    } else {
      assert.equal(s.net_worth.change, null);
    }
  });

  it("bills due in 7 days = /api/forecast + the calendar's unpaid manual bills", async () => {
    const s = (await supertest(app).get("/api/dashboard/summary").expect(200)).body;
    const forecast = (await supertest(app).get("/api/forecast?days=7").expect(200)).body.charges;
    const end = add(7);
    const months = [...new Set([today.slice(0, 7), end.slice(0, 7)])];
    const manual = [];
    for (const m of months) {
      const cal = (await supertest(app).get(`/api/bill-calendar?year=${+m.slice(0, 4)}&month=${+m.slice(5, 7)}`).expect(200)).body;
      for (const d of cal.days) {
        if (d.date < today || d.date > end) continue;
        for (const ev of d.events) if (ev.bill_source === "manual" && !ev.is_paid) manual.push({ name: ev.name, amount: ev.amount, date: d.date });
      }
    }
    const expected = forecast.map((f) => ({ name: f.name, amount: f.amount, date: f.date })).concat(manual);
    const bills = s.attention.items.find((i) => i.kind === "bills");
    assert.ok(bills, "a bills item");
    assert.equal(bills.count, expected.length);
    assert.equal(bills.amount, Math.round(expected.reduce((t, b) => t + b.amount, 0) * 100) / 100);
    assert.equal(bills.count, 2, "the gym + water; internet is paid, the far-off bill is outside the window");
    assert.equal(bills.amount, 85.75);
    assert.equal(bills.href, "/calendar");
  });

  it("rent owed = the ledger balance; uncategorized = categorize status; Sync Health = data-health warnings", async () => {
    const s = (await supertest(app).get("/api/dashboard/summary").expect(200)).body;
    const ledger = (await supertest(app).get("/api/housing/ledger").expect(200)).body;
    const rent = s.attention.items.find((i) => i.kind === "rent");
    assert.equal(rent.amount, ledger.balance);
    assert.equal(rent.amount, 1582.17, "the old payee's row doesn't count");
    assert.equal(rent.text, "Owed to Sam Lee");

    const status = (await supertest(app).get("/api/categorize/status").expect(200)).body;
    const uncat = s.attention.items.find((i) => i.kind === "uncategorized");
    assert.equal(uncat.count, status.uncategorized);
    assert.equal(uncat.count, 2);

    const health = (await supertest(app).get("/api/data-health").expect(200)).body;
    const warnings = health.issues.filter((i) => i.severity === "warning").length;
    const sync = s.attention.items.find((i) => i.kind === "sync_health");
    assert.equal(sync ? sync.count : 0, warnings);
    assert.deepEqual(s.attention.errors, []);
  });

  it("with the ledger off and nothing else due, the list is empty — and the figures still answer", async () => {
    await q("UPDATE user_settings SET housing_config = '{}' WHERE id = 1");
    await q("UPDATE transactions SET user_category = 'Shopping' WHERE user_category IS NULL AND category IS NULL");
    await q("INSERT INTO bill_payments (bill_source, bill_id, paid_date, paid_amount) SELECT 'manual', id, $1, amount FROM manual_bills WHERE name = 'Water'", [add(2)]);
    await q("UPDATE detected_subscriptions SET is_active = false");
    const s = (await supertest(app).get("/api/dashboard/summary").expect(200)).body;
    const kinds = s.attention.items.map((i) => i.kind);
    assert.ok(!kinds.includes("rent") && !kinds.includes("bills") && !kinds.includes("uncategorized"), kinds.join(","));
    assert.equal(s.spending.ok && s.cash.ok && s.net_worth.ok, true);
  });
});
