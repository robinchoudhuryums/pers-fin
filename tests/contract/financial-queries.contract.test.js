// Real-Postgres contract tests (TQ-2): services/financial-queries.js and the
// spending-analytics / budgets routes against a real schema. Regression class:
// FAN-2 (the income double-count guard compared a row to itself because an
// unqualified column bound to the subquery's table — invisible to a mock pool)
// and the /api/income-summary "column reference is ambiguous" 500.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("financial-queries + analytics routes on real Postgres", { skip: SKIP }, () => {
  let pool, fq, app, cm, pm;
  const q = (s, p) => pool.query(s, p);

  before(async () => {
    pool = await perfinDb("fq");
    fq = require("../../teller/services/financial-queries");
    app = perfinApp();
    cm = fq.currentMonth(); pm = fq.previousMonthKey(cm);
    await q("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status) VALUES ('i1','Bank','x','GOOD')");
    const item = (await q("SELECT id FROM plaid_items")).rows[0].id;
    const acct = (id, type, subtype, bal, extra = "") => q(
      `INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype, current_balance, available_balance${extra ? ", is_shared, spending_split_pct" : ""})
       VALUES ($1,$2,$2,$3,$4,$5,$5${extra ? ", true, 50" : ""})`, [item, id, type, subtype, bal]);
    await acct("brk", "investment", "brokerage", 50000);
    await acct("chk", "depository", "checking", 4000);
    await acct("card", "credit", "credit card", 900);
    await acct("joint", "credit", "credit card", 300, "shared");
    await acct("loan", "loan", "auto", 18000);
    // Plaid brokerage phantom: the same account in investment_accounts (authoritative).
    await q("INSERT INTO investment_accounts (name, account_type, balance, plaid_account_id, is_active) VALUES ('Schwab','brokerage',52000,'brk',true)");
    const tx = (id, acctId, amt, merchant, name, extra = {}) => q(
      `INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, category, personal_finance_category,
                                 user_category, is_reimbursed, personal_for, pending)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,false)`,
      [acctId, id, amt, extra.date || cm + "-01", merchant, name, extra.category || null,
       extra.pfc ? JSON.stringify(extra.pfc) : null, extra.user_category || null, !!extra.reimbursed, extra.personal_for || null]);
    // FAN-2: paycheck into the brokerage + the brokerage→checking transfer pair.
    await tx("pay", "brk", -3000, "ACME", "ACME PAYROLL");
    await tx("xfer_out", "brk", 3000, "Funds transfer", "FUNDS TRANSFER TO CHECKING");
    await tx("xfer_in", "chk", -3000, "Funds transfer from brokerage", "FUNDS TRANSFER FROM BROKERAGE");
    // DD-2: payroll keyword only in the raw description; DD-3: Plaid PFC income.
    await tx("pay2", "chk", -1500, "GLOBEX CORP", "GLOBEX CORP PAYROLL PPD");
    await tx("pfc_inc", "chk", -700, "Side Gig LLC", "SIDE GIG LLC", { pfc: { primary: "INCOME" } });
    await tx("prev_pay", "chk", -2000, "ACME", "ACME PAYROLL", { date: pm + "-15" });
    // Spending: a transfer, a reimbursed charge, a shared-card charge and a split parent.
    await tx("zelle", "chk", 200, "John Smith", "ZELLE TO JOHN SMITH");
    await tx("groc", "card", 80, "Safeway", "SAFEWAY", { category: ["Groceries"] });
    await tx("reimb", "card", 400, "Hotel", "HOTEL", { category: ["Travel"], reimbursed: true });
    await tx("shared", "joint", 100, "Costco", "COSTCO", { category: ["Groceries"] });
    await tx("mine", "joint", 60, "Pharmacy", "PHARMACY", { category: ["Health"], personal_for: "self" });
    await tx("theirs", "joint", 90, "Salon", "SALON", { category: ["Personal"], personal_for: "partner" });
    await tx("parent", "card", 120, "Target", "TARGET", { category: ["Shopping"] });
    await q("INSERT INTO transaction_splits (parent_transaction_id, amount, category) VALUES ('parent',70,'Groceries'),('parent',50,'Household')");
    await tx("prev_dining", "card", 480, "Cafe", "CAFE", { category: ["Dining"], date: pm + "-20" });
  });
  after(async () => { if (pool) await pool.end(); });

  it("income: the brokerage transfer is not counted twice (FAN-2); raw-description + PFC income counts (DD-2/DD-3)", async () => {
    const inc = await fq.getMonthlyIncome(pool, 2);
    const byMonth = Object.fromEntries(inc.map((r) => [r.month, parseFloat(r.total_income)]));
    assert.equal(byMonth[cm], 3000 + 1500 + 700);
    assert.equal(byMonth[pm], 2000);
    const ids = (await q(`SELECT t.transaction_id FROM transactions t JOIN linked_accounts la ON la.account_id = t.account_id
                          WHERE t.amount < 0 AND ${fq.incomePredicate("t")} ORDER BY 1`)).rows.map((r) => r.transaction_id);
    assert.deepEqual(ids, ["pay", "pay2", "pfc_inc", "prev_pay"], "the aliased predicate executes inside a JOIN");
  });

  it("per-category spending: splits replace the parent, reimbursed + transfers excluded, shared split + personal_for applied", async () => {
    const rows = await fq.getCategorySpendingForMonth(pool, cm);
    const by = Object.fromEntries(rows.map((r) => [r.category, parseFloat(r.spent)]));
    assert.equal(by.Groceries, 80 + 50 + 70, "Safeway + half of Costco + the split's grocery line");
    assert.equal(by.Household, 50);
    assert.equal(by.Health, 60, "personal_for=self → 100%");
    assert.equal(by.Personal || 0, 0, "personal_for=partner → 0");
    assert.equal(by.Shopping || 0, 0, "the split parent is replaced");
    assert.equal(by.Travel || 0, 0, "reimbursed excluded");
  });

  it("monthly spending total (split-adjusted, transfers + reimbursed excluded)", async () => {
    const rows = await fq.getMonthlySpending(pool, 2);
    const by = Object.fromEntries(rows.map((r) => [r.month, parseFloat(r.total_spend)]));
    // 80 + 50 (costco half) + 60 + 0 + 120 = 310; xfer_out/zelle are transfers
    assert.equal(by[cm], 310);
    assert.equal(by[pm], 480);
  });

  it("net worth: loans + cards are liabilities, the Plaid brokerage phantom is dropped (investment_accounts wins)", async () => {
    const nw = await fq.getNetWorth(pool);
    assert.equal(nw.total_assets, 4000 + 52000);
    assert.equal(nw.total_liabilities, 900 + 300 + 18000);
    assert.equal(nw.net_worth, 56000 - 19200);
    assert.ok(!nw.breakdown.accounts.some((a) => a.name === "brk"), "no $50k linked_accounts twin");
  });

  it("budget status: prior-month rollover in effective_limit; one-time budget only in its month", async () => {
    const b = (await q("INSERT INTO budgets (category, monthly_limit, rollover_enabled, budget_type) VALUES ('Groceries',150,true,'recurring') RETURNING id")).rows[0].id;
    await q("INSERT INTO budgets (category, monthly_limit, budget_type, effective_month) VALUES ('Travel',2000,'one_time','2001-06')");
    await q("INSERT INTO budget_snapshots (budget_id, month, monthly_limit, spent, rollover_amount) VALUES ($1,$2,150,100,50)", [b, pm]);
    const st = await fq.getBudgetStatus(pool, cm);
    assert.deepEqual(st.map((r) => r.category), ["Groceries"]);
    assert.equal(st[0].effective_limit, 200);
    assert.equal(st[0].spent, 200);
    const api = (await supertest(app).get("/api/budgets").expect(200)).body;
    const g = (api.budgets || api).find((x) => x.category === "Groceries");
    assert.equal(parseFloat(g.effective_limit), 200, "GET /api/budgets reads the same helper");
    await supertest(app).get("/api/budgets/alerts").expect(200);
    await supertest(app).patch("/api/budgets/" + b).send({ monthly_limit: "abc" }).expect(400);
  });

  it("analytics routes execute on the real schema (the income-summary JOIN used to 500 on an ambiguous column)", async () => {
    const inc = (await supertest(app).get("/api/income-summary?months=3").expect(200)).body;
    assert.ok(Array.isArray(inc.monthly_trend));
    const sr = (await supertest(app).get("/api/savings-rate?months=3").expect(200)).body;
    assert.ok(sr && typeof sr === "object");
    const cf = (await supertest(app).get("/api/cash-flow?days=30").expect(200)).body;
    assert.equal(cf.starting_balance, 4000, "depository, non-investment cash only (FAN-5)");
    const ss = (await supertest(app).get("/api/spending-summary?months=3").expect(200)).body;
    assert.ok(ss.monthly_trend.some((m) => (m.month || "").startsWith(cm)));
    const sc = (await supertest(app).get("/api/spending-categories?month=" + cm).expect(200)).body;
    assert.ok(JSON.stringify(sc).includes("Groceries"));
    await supertest(app).get("/api/spending-yoy").expect(200);
  });

  it("tax candidates: display merchant, user's share, reimbursed + partner rows excluded, ISO dates", async () => {
    const year = parseInt(cm.slice(0, 4), 10);
    await q(`INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending, user_merchant_name, is_reimbursed)
             VALUES ('chk','tax1',40,$1,'CVS #1','CVS #1',false,'CVS Pharmacy',false),
                    ('joint','tax2',100,$1,'RED CROSS','RED CROSS',false,NULL,false),
                    ('chk','tax3',200,$1,'DR SMITH DOCTOR','DR SMITH DOCTOR',false,NULL,true),
                    ('chk','tax4',30,$1,'AMC BOX OFFICE','AMC BOX OFFICE',false,NULL,false)`, [`${year}-01-15`]);
    const rows = await fq.getTaxDeductionTransactions(pool, year);
    const byId = Object.fromEntries(rows.map((r) => [r.transaction_id, r]));
    assert.ok(byId.tax1 && byId.tax2 && !byId.tax3 && !byId.tax4);
    assert.equal(byId.tax1.merchant, "CVS Pharmacy");
    assert.equal(byId.tax2.amount, "50.00", "shared card at 50%");
    assert.equal(byId.tax1.date, `${year}-01-15`);
    assert.equal(byId.tax2.category, "charity");
  });
});
