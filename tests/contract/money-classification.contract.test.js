// Real-Postgres contract tests for the cycle-7 Batch 5 money-accuracy and
// classification fixes: the NOT_TRANSFER brand words (F32) and Transfer /
// Investment categories (F51), detectors reading the raw description (F49),
// Plaid legacy categories (F50), cash-flow income streams (F34), joint-account
// income + reimbursement credits (F37), the 0% Settle Up split (F31), removed
// housing placeholders (F33), budget snapshots outside a budget's life (F38),
// whole-month Spending Summary windows (F41) and the Sheets Watchlist (F42).
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

describe("money accuracy + classification on real Postgres", { skip: SKIP }, () => {
  let pool, fq, app, cm, pm;
  const q = (s, p) => pool.query(s, p);
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

  before(async () => {
    pool = await perfinDb("moneycls");
    fq = require("../../teller/services/financial-queries");
    app = perfinApp();
    cm = fq.currentMonth(); pm = fq.previousMonthKey(cm);
    const acct = (id, type, extra = {}) => q(
      `INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual, is_shared, spending_split_pct, current_balance)
       VALUES ($1,$1,$2,$3,true,$4,$5,$6)`,
      [id, type, type === "credit" ? "credit card" : "checking", !!extra.shared, extra.pct ?? 100, extra.balance ?? 0]);
    await acct("chk", "depository", { balance: 5000 });
    await acct("card", "credit");
    await acct("joint_chk", "depository", { shared: true, pct: 50 });
    await acct("partner_card", "credit", { shared: true, pct: 0 });
  });
  after(async () => { if (pool) await pool.end(); });

  const tx = (id, acctId, amt, merchant, name, extra = {}) => q(
    `INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, category,
                               personal_finance_category, user_category, user_merchant_name, is_reimbursed, personal_for, pending)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false)`,
    [acctId, id, amt, extra.date || cm + "-01", merchant, name, extra.category || null,
     extra.pfc ? JSON.stringify(extra.pfc) : null, extra.user_category || null, extra.user_merchant_name || null,
     !!extra.reimbursed, extra.personal_for || null]);

  // ---------------------------------------------------------------- F32 / F51
  it("F32/F51: brand words read the cleaned merchant; Transfer/Investment categories are excluded", async () => {
    await tx("ns_pp_plaid", "card", 15.49, "Netflix", "PAYPAL *NETFLIX", { pfc: { primary: "ENTERTAINMENT" } });
    await tx("ns_pp_csv", "card", 11.99, "PAYPAL *SPOTIFY", "PAYPAL *SPOTIFY");
    await tx("ns_bike", "card", 19.0, "Citi Bike", "CITI BIKE 123");
    await tx("ns_center", "card", 140.0, "Chase Center", "CHASE CENTER TICKETS");
    await tx("ns_deposit", "chk", 1200.0, "SECURITY DEPOSIT", "SECURITY DEPOSIT - 12 MAIN ST");
    await tx("x_autopay", "chk", 900.0, "Chase", "CHASE CREDIT CRD AUTOPAY PPD");
    await tx("x_plaid_pay", "chk", 400.0, null, "Payment to Chase card ending in 1234");
    await tx("x_zelle", "chk", 1500.0, "John Smith", "ZELLE TO JOHN SMITH");
    await tx("x_paypal_xfer", "chk", 50.0, "PayPal", "PAYPAL INST XFER");
    await tx("x_teller_invest", "chk", 500.0, "Robinhood", "ROBINHOOD DEPOSIT", { category: ["investment"] });
    await tx("x_user_transfer", "chk", 75.0, "Mom", "MOM", { user_category: "Transfer" });
    await tx("ns_plaid_legacy", "card", 30.0, "Uber", "UBER TRIP", { category: ["Transfer"], pfc: { primary: "TRANSPORTATION" } });
    const r = await q(`SELECT t.transaction_id FROM transactions t WHERE t.transaction_id ~ '^(ns|x)_' AND ${fq.NOT_TRANSFER} ORDER BY 1`);
    assert.deepEqual(r.rows.map((x) => x.transaction_id),
      ["ns_bike", "ns_center", "ns_deposit", "ns_plaid_legacy", "ns_pp_csv", "ns_pp_plaid"]);
  });

  // ---------------------------------------------------------------- F37
  it("F37: income on a joint account counts at the account's share; a reimbursement credit is not income", async () => {
    await tx("inc_pay", "chk", -3000, "ACME", "ACME PAYROLL", { date: cm + "-02" });
    await tx("inc_joint", "joint_chk", -2000, "GLOBEX", "GLOBEX PAYROLL", { date: cm + "-02" });
    await tx("inc_reimb", "chk", -250, "ACME", "ACME EXPENSE REIMBURSEMENT DIRECT DEP", { date: cm + "-03" });
    const inc = await fq.getMonthlyIncome(pool, 1);
    assert.equal(parseFloat(inc.find((r) => r.month === cm).total_income), 4000, "3000 + 50% × 2000; the reimbursement is out");
    const res = await supertest(app).get("/api/income-summary?months=1").expect(200);
    assert.equal(res.body.total_income, 4000);
    const joint = res.body.by_account.find((a) => a.account_name === "joint_chk");
    assert.equal(parseFloat(joint.total_income), 1000);
  });

  // ---------------------------------------------------------------- F31
  it("F31: a 0% split puts every shared charge on the partner (it read 50/50)", async () => {
    await tx("sh_charge", "partner_card", 100, "Costco", "COSTCO", { date: cm + "-05" });
    await tx("sh_mine", "partner_card", 20, "Pharmacy", "PHARMACY", { date: cm + "-05", personal_for: "self" });
    const res = await supertest(app).get("/api/shared-settlement?month=" + cm).expect(200);
    const a = res.body.accounts.find((x) => x.account_key === "partner_card");
    assert.equal(a.split_pct, 0);
    assert.equal(a.your_share, 20);
    assert.equal(a.partner_share, 100);
  });

  // ---------------------------------------------------------------- F50
  it("F50: a Plaid row whose legacy category matches ours still counts as uncategorized", async () => {
    const before_ = (await supertest(app).get("/api/categorize/status").expect(200)).body.uncategorized;
    await tx("cat_plaid_travel", "card", 45, "Shell", "SHELL OIL", { category: ["Travel"], pfc: { primary: "TRANSPORTATION", detailed: "TRANSPORTATION_GAS" } });
    await tx("cat_csv_travel", "card", 45, "Delta", "DELTA AIR", { category: ["Travel"] });
    const after_ = (await supertest(app).get("/api/categorize/status").expect(200)).body.uncategorized;
    assert.equal(after_ - before_, 1, "the Plaid row is queued; the CSV row's category is ours and stands");
    const { mapCategoryFor } = require("../../teller/routes/categorize-helpers");
    assert.equal(mapCategoryFor({ category: ["Service"], personal_finance_category: { primary: "GENERAL_SERVICES", detailed: "GENERAL_SERVICES_OTHER_GENERAL_SERVICES" } }), null,
      "a Plaid legacy name never hits the Teller map");
  });

  // ---------------------------------------------------------------- F33
  it("F33: a removed placeholder stays removed; adding it back by hand clears the removal", async () => {
    const housing = require("../../teller/routes/housing");
    await q(`UPDATE user_settings SET housing_config = $1 WHERE id = 1`, [JSON.stringify({
      enabled: true, payee_name: "Landlord", rent_amount: 1000, rent_due_day: 1, start_month: cm,
      utilities: [{ label: "Electricity", cadence_months: 1, due_day: 10, anchor: cm }],
    })]);
    await housing.generateHousingObligations(pool);
    const elec = (await q("SELECT id FROM payee_obligations WHERE label = 'Electricity' AND period = $1", [cm])).rows[0];
    await supertest(app).delete("/api/housing/obligations/" + elec.id).expect(200);
    const r = await housing.generateHousingObligations(pool);
    assert.equal(r.generated, 0);
    assert.equal((await q("SELECT 1 FROM payee_obligations WHERE label = 'Electricity' AND period = $1", [cm])).rows.length, 0);
    await supertest(app).post("/api/housing/obligations").send({ label: "Electricity", period: cm, category: "utility" }).expect(200);
    assert.equal((await q("SELECT 1 FROM payee_obligation_skips WHERE label = 'Electricity'")).rows.length, 0);
  });

  // ---------------------------------------------------------------- F43
  it("F43: next month's rent is reminded inside a lead window that starts this month", async () => {
    const housing = require("../../teller/routes/housing");
    const notifications = require("../../teller/routes/notifications");
    const sent = [];
    const origSend = notifications.sendToAll, origRecent = notifications.sentRecently;
    notifications.sendToAll = async (p) => { sent.push(p); return { logged: true }; };
    notifications.sentRecently = async () => false;
    try {
      await q(`UPDATE payee_obligations SET status = 'paid' WHERE category = 'rent'`);
      await q(`UPDATE user_settings SET housing_config = housing_config || '{"rent_due_day": 2, "reminder_lead_days": 5}'::jsonb WHERE id = 1`);
      const [y, m] = cm.split("-").map(Number);
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      await housing.runHousingReminders(pool, `${cm}-${String(last - 1).padStart(2, "0")}`);
      const due = sent.find((p) => /^housing-due-/.test(p.tag));
      assert.ok(due, JSON.stringify(sent));
      assert.equal(due.tag, "housing-due-" + housing.addMonths(cm, 1));
      assert.match(due.body, /^\$1000\.00 owed across 1 item\(s\) — .* rent is due /);
    } finally { notifications.sendToAll = origSend; notifications.sentRecently = origRecent; }
  });

  // ---------------------------------------------------------------- F41
  it("F41: Spending Summary's category total covers the same whole months as the trend", async () => {
    const [y, m] = pm.split("-").map(Number);
    const lastPrev = `${pm}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
    await tx("win_prev", "card", 333, "Bookstore", "BOOKSTORE", { category: ["Shopping"], date: lastPrev });
    const res = await supertest(app).get("/api/spending-summary?months=1").expect(200);
    const trendTotal = res.body.monthly_trend.reduce((s, r) => s + parseFloat(r.total_spend), 0);
    const catTotal = res.body.by_category.reduce((s, r) => s + parseFloat(r.total), 0);
    assert.ok(Math.abs(trendTotal - catTotal) < 0.01, `trend ${trendTotal} vs categories ${catTotal}`);
    assert.ok(!res.body.top_merchants.some((r) => r.merchant === "Bookstore"), "last month's charge is outside months=1");
  });

  // ---------------------------------------------------------------- F38
  it("F38: no snapshot for a month before the budget existed or outside a one-time budget's month", async () => {
    const { runBudgetSnapshot } = require("../../teller/routes/budgets");
    await q("INSERT INTO budgets (category, monthly_limit, rollover_enabled) VALUES ('Dining', 500, true)");
    await q("INSERT INTO budgets (category, monthly_limit, rollover_enabled, created_at) VALUES ('Old', 200, true, now() - interval '400 days')");
    await q("INSERT INTO budgets (category, monthly_limit, budget_type, effective_month, created_at) VALUES ('Trip', 900, 'one_time', $1, now() - interval '400 days')", [cm]);
    await runBudgetSnapshot(pool, cm + "-03");
    const snaps = (await q("SELECT b.category FROM budget_snapshots s JOIN budgets b ON b.id = s.budget_id WHERE s.month = $1 ORDER BY 1", [pm])).rows;
    assert.deepEqual(snaps.map((r) => r.category), ["Old"]);
  });

  // ---------------------------------------------------------------- F49
  it("F49: monthly Zelle rent is a peer transfer, not a 'John Smith' subscription", async () => {
    for (const [i, d] of [95, 65, 35, 5].entries()) {
      await tx("rent_" + i, "chk", 1500, "Jane Roe", "ZELLE TO JANE ROE ON " + daysAgo(d), { date: daysAgo(d) });
    }
    const { detectSubscriptions } = require("../../scripts/detect-subscriptions");
    const { detectRecurringTransfers } = require("../../scripts/detect-transfers");
    const subs = await detectSubscriptions(pool);
    assert.ok(!subs.some((s) => s.merchant_key === "Jane Roe"), JSON.stringify(subs.map((s) => s.merchant_key)));
    const transfers = await detectRecurringTransfers(pool);
    const rent = transfers.find((t) => t.merchant_key === "Jane Roe");
    assert.ok(rent, JSON.stringify(transfers.map((t) => t.merchant_key)));
    assert.equal(rent.transfer_type, "peer_transfer");
  });

  // ---------------------------------------------------------------- F34
  it("F34: cash-flow income uses the calendar's streams (semimonthly, rename honored)", async () => {
    let n = 0;
    // Paydays on the 1st and 15th of the last three complete months, plus this
    // month's 1st (so the stream is live whatever today's date is).
    let ym = cm;
    const months = [];
    for (let k = 0; k < 3; k++) { ym = fq.previousMonthKey(ym); months.push(ym); }
    await tx("semi_now", "chk", -2100, "INITECH", "INITECH PAYROLL", { date: cm + "-01", user_merchant_name: "Initech" });
    for (const mo of months) {
      for (const day of ["01", "15"]) {
        await tx("semi_" + (n++), "chk", -2100, "INITECH", "INITECH PAYROLL", { date: `${mo}-${day}`, user_merchant_name: "Initech" });
      }
    }
    const res = await supertest(app).get("/api/cash-flow?days=60").expect(200);
    const s = res.body.recurring_income.find((x) => x.source === "Initech");
    assert.ok(s, JSON.stringify(res.body.recurring_income));
    assert.equal(s.cadence, "semimonthly");
    assert.deepEqual(s.days_of_month, [1, 15]);
    assert.ok(res.body.total_projected_income >= 2100 * 3, "≈ 4 paydays in 60 days");
  });

  // ---------------------------------------------------------------- F42
  it("F42: the Sheets Watchlist treats % literally and totals your share of spending", async () => {
    process.env.GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID || "sheet";
    await q("INSERT INTO watchlist_items (type, value) VALUES ('merchant', '50% Off'), ('merchant', 'Costco')");
    await tx("w_pct", "card", 30, "50% Off Store", "50% OFF STORE", { date: daysAgo(3) });
    await tx("w_other", "card", 99, "5000 Off Outlet", "5000 OFF OUTLET", { date: daysAgo(3) });
    await tx("w_refund", "partner_card", -40, "Costco", "COSTCO REFUND", { date: daysAgo(2) });
    const updates = [];
    const sheetsMeta = [];
    const fake = { spreadsheets: {
      get: async () => ({ data: { sheets: sheetsMeta } }),
      batchUpdate: async (p) => ({ data: { replies: p.requestBody.requests.map((r) => {
        if (!r.addSheet) return {};
        sheetsMeta.push({ properties: { title: r.addSheet.properties.title, sheetId: 1 } });
        return { addSheet: { properties: { sheetId: 1, title: r.addSheet.properties.title } } };
      }) } }),
      values: { update: async (p) => { updates.push(p); return {}; }, clear: async () => ({}), append: async () => ({}) },
    } };
    await require("../../scripts/sheets-sync")._internals.syncWatchlist(fake, pool);
    const rows = updates[0].requestBody.values;
    const pct = rows.find((r) => r[0] === "50% Off");
    assert.equal(pct[2], 1, "only the '50% Off' merchant matched — not '5000 Off'");
    const costco = rows.find((r) => r[0] === "Costco");
    // COSTCO on partner_card (0% yours) — 100 charge (F31 test) → $0 your share; the refund isn't spend.
    assert.match(String(costco[3]), /^\$?0(\.00)?$/);
  });
});
