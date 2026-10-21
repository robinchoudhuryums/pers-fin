// Real-Postgres contract tests for cycle-7 Batch 14 (F35 / G4): refunds net
// against their category in the month they POST, floored at $0 per (month,
// category), on every spending surface — the helpers, budgets, the dashboard
// summary and year-over-year. Transfers, card payments, income, reimbursed and
// pending credits are never refunds; an uncategorized refund takes the
// merchant's latest earlier charge category; a shared-card refund counts at the
// account's share.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("Refund-aware spending on real Postgres", { skip: SKIP }, () => {
  let pool, fq, app, cm, pm;
  const q = (s, p) => pool.query(s, p);

  before(async () => {
    pool = await perfinDb("refunds");
    fq = require("../../teller/services/financial-queries");
    app = perfinApp();
    cm = fq.currentMonth();
    pm = fq.previousMonthKey(cm);
    await q("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status) VALUES ('i1','Bank','x','GOOD')");
    const item = (await q("SELECT id FROM plaid_items")).rows[0].id;
    await q(`INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype, current_balance, is_shared, spending_split_pct)
             VALUES ($1,'card','card','credit','credit card',0,false,100),
                    ($1,'chk','chk','depository','checking',0,false,100),
                    ($1,'joint','joint','credit','credit card',0,true,50)`, [item]);
    // Every row on the 1st so the year-over-year month-to-date cap never cuts one.
    const d = cm + "-01";
    const tx = (id, acct, amt, merchant, category, extra = {}) => q(
      `INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, category, is_reimbursed, pending)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [acct, id, amt, extra.date || d, merchant, extra.name || merchant, category ? [category] : null, !!extra.reimbursed, !!extra.pending]);
    // Charges.
    await tx("target", "card", 200, "Target", "Shopping");
    await tx("cafe", "card", 30, "Cafe", "Dining");
    await tx("costco", "joint", 100, "Costco", "Groceries");          // 50% → 50
    await tx("bestbuy_old", "card", 40, "BestBuy", "Electronics", { date: pm + "-10" });
    // Refunds (uncategorized, like real credits).
    await tx("target_ref", "card", -50, "Target", null);              // → Shopping 150
    await tx("cafe_ref", "card", -45, "Cafe", null);                  // → Dining 30 − 45 → floored 0
    await tx("costco_ref", "joint", -40, "Costco", null);             // 50% → Groceries 50 − 20 = 30
    await tx("bestbuy_ref", "card", -100, "BestBuy", null);           // refund-only category this month → not listed
    await tx("mystery_ref", "card", -25, "Mystery Credit", null);     // no prior charge → Uncategorized, refund-only
    // Never refunds.
    await tx("payroll", "chk", -3000, "ACME", null, { name: "ACME PAYROLL PPD" });
    await tx("card_pmt", "card", -500, "Payment Thank You", null);
    await tx("zelle_in", "chk", -100, "John Smith", null, { name: "ZELLE FROM JOHN SMITH" });
    await tx("reimb_ref", "card", -60, "Target", null, { reimbursed: true });
    await tx("pending_ref", "card", -20, "Target", null, { pending: true });
    await q("INSERT INTO budgets (category, monthly_limit) VALUES ('Shopping', 300), ('Dining', 100)");
  });
  after(async () => { if (pool) await pool.end(); });

  it("categories net their refunds, inherit the merchant's category, floor at $0 and skip refund-only categories", async () => {
    const rows = await fq.getCategorySpendingForMonth(pool, cm);
    const m = Object.fromEntries(rows.map((r) => [r.category, Number(r.spent)]));
    assert.deepEqual(m, { Shopping: 150, Dining: 0, Groceries: 30 });
  });

  it("the month total is the sum of the floored categories; txn_count counts charges", async () => {
    const row = (await fq.getMonthlySpending(pool, 2)).find((r) => r.month === cm);
    assert.equal(Number(row.total_spend), 180);
    assert.equal(Number(row.txn_count), 3);
  });

  it("budgets and the dashboard summary agree with the helper", async () => {
    const budgets = (await supertest(app).get("/api/budgets").expect(200)).body;
    const list = budgets.budgets || budgets;
    const spent = Object.fromEntries(list.map((b) => [b.category, Number(b.spent)]));
    assert.equal(spent.Shopping, 150);
    assert.equal(spent.Dining, 0);

    const s = (await supertest(app).get("/api/spending-summary?months=2").expect(200)).body;
    const month = s.monthly_trend.find((r) => r.month === cm);
    assert.equal(Number(month.total_spend), 180);
    assert.equal(Number(month.txn_count), 3);
    const cats = Object.fromEntries(s.by_category.map((r) => [r.category, Number(r.total)]));
    assert.equal(cats.Shopping, 150);
    assert.equal(cats.Groceries, 30);
    const merchants = Object.fromEntries(s.top_merchants.map((r) => [r.merchant, Number(r.total_spent)]));
    assert.equal(merchants.Target, 150);
    assert.equal(merchants.Cafe, 0);
    assert.equal(merchants["Mystery Credit"], undefined, "a refund-only merchant isn't a top merchant");
  });

  it("year-over-year nets refunds the same way", async () => {
    const [y, mo] = cm.split("-").map(Number);
    const r = (await supertest(app).get(`/api/spending-yoy?month=${mo}&year=${y}`).expect(200)).body;
    assert.equal(Math.round(r.by_year[String(y)].total * 100) / 100, 180);
  });

  it("transfers, card payments, income, reimbursed and pending credits are never refunds", async () => {
    const ids = (await q(`SELECT t.transaction_id FROM transactions t WHERE ${fq.REFUND_PREDICATE} ORDER BY 1`)).rows.map((r) => r.transaction_id);
    assert.deepEqual(ids, ["bestbuy_ref", "cafe_ref", "costco_ref", "mystery_ref", "target_ref"]);
  });
});
