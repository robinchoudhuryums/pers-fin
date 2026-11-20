// Real-Postgres contract tests for cycle 9 Batch 10 (F61 — test honesty).
//
// tests/api.test.js used to "test" these routes by re-typing their logic inside
// the test, and the Sheets Transactions / Tax / Income tabs were covered only by
// text pins on SQL fragments, so a change to those queries passed every test.
// Here the REAL routes and tab functions run against a real database:
//
//   - the Sheets Transactions tab (display merchant + category, splits under
//     their parent, pending left out, reimbursed, the institution fallback)
//   - the Sheets Tax Deductions tab (equal to the app's own tax report, to the
//     cent) and the Income tab (equal to getMonthlyIncome)
//   - a full Sheets run: every tab's SQL is valid on the real schema, and a
//     failing tab is named in errors[] while the others are still written
//   - POST / GET /api/subscriptions (the filters and the monthly-cost summary),
//     POST /api/cleanup (the retention windows), POST /api/investment-accounts
//
// The Google Sheets API is a recording fake; everything else is real.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, perfinDb, perfinApp } = require("./_setup");

// A recording fake of the Sheets API. `failOn` (a tab title) makes every write
// to that tab throw — a tab that fails mid-run.
function fakeSheets({ failOn = null } = {}) {
  const meta = [];
  let nextId = 700;
  const updates = [];
  return {
    updates,
    spreadsheets: {
      get: async () => ({ data: { sheets: meta } }),
      batchUpdate: async (p) => ({ data: { replies: p.requestBody.requests.map((r) => {
        if (!r.addSheet) return {};
        const sheetId = nextId++;
        meta.push({ properties: { title: r.addSheet.properties.title, sheetId } });
        return { addSheet: { properties: { sheetId, title: r.addSheet.properties.title } } };
      }) } }),
      values: {
        update: async (p) => {
          if (failOn && p.range.startsWith(failOn + "!")) throw new Error("quota exceeded for " + failOn);
          updates.push(p);
          return {};
        },
        append: async () => ({}),
        clear: async () => ({}),
      },
    },
  };
}
const valuesFor = (api, sheet) => {
  const u = api.updates.filter((p) => p.range.startsWith(sheet + "!"));
  return u.length ? u[u.length - 1].requestBody.values : null;
};
const tabsWritten = (api) => [...new Set(api.updates.map((p) => p.range.split("!")[0]))];

// 'YYYY-MM' shifted by n months.
function shiftMonth(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

describe("cycle 9 Batch 10 on real Postgres", { skip: SKIP }, () => {
  let pool, app, I, fq, cm, pm, year;
  const q = (s, p) => pool.query(s, p);
  const tx = (id, acct, amount, date, o = {}) => q(
    `INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, category,
                               user_merchant_name, user_category, is_reimbursed, reimbursed_at, personal_for,
                               pending, personal_finance_category)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [acct, id, amount, date, o.merchant || "Shop " + id, o.name || o.merchant || "Shop " + id,
     o.category ? [o.category] : null, o.rename || null, o.userCategory || null, !!o.reimbursed,
     o.reimbursedAt || null, o.personalFor || null, !!o.pending, o.pfc ? JSON.stringify(o.pfc) : null]);

  before(async () => {
    process.env.GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID || "contract-sheet";
    pool = await perfinDb("c9b10");
    app = perfinApp();
    fq = require("../../teller/services/financial-queries");
    I = require("../../scripts/sheets-sync")._internals;
    cm = fq.currentMonth(); pm = fq.previousMonthKey(cm);
    year = Number(cm.slice(0, 4));

    await q("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status) VALUES ('i1','First Bank','x','GOOD')");
    const item = (await q("SELECT id FROM plaid_items")).rows[0].id;
    await q(`INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype, current_balance, is_shared, spending_split_pct)
             VALUES ($1,'chk','Checking','depository','checking',1000,false,100),
                    ($1,'jchk','Joint Checking','depository','checking',1000,true,50),
                    ($1,'card','Visa','credit','credit card',0,false,100),
                    ($1,'jcard','Joint Visa','credit','credit card',0,true,50)`, [item]);
    await q(`INSERT INTO linked_accounts (account_id, name, type, subtype, current_balance, is_manual)
             VALUES ('cash','Wallet','depository','cash',50,true)`);
  });
  after(async () => { if (pool) await pool.end(); });

  // ── Sheets tabs ──────────────────────────────────────────────────────────
  it("Transactions tab: display names, splits under their parent, pending left out", async () => {
    // Dated in a month of its own (two months back) so the other tests' rows
    // don't interleave with these.
    const m = shiftMonth(cm, -2);
    await tx("t-rename", "card", 45.67, m + "-20", { merchant: "SQ *COFFEE BAR 0042", rename: "Blue Bottle", category: "Dining", userCategory: "Coffee" });
    await tx("t-split", "card", 120, m + "-18", { merchant: "BigStore", category: "Shopping" });
    await q(`INSERT INTO transaction_splits (parent_transaction_id, amount, category, merchant_name)
             VALUES ('t-split', 70, 'Groceries', 'BigStore Grocery'), ('t-split', 50, 'Household', NULL)`);
    await tx("t-reimb", "card", 300, m + "-15", { merchant: "Hotel Work Trip", category: "Travel", reimbursed: true, reimbursedAt: m + "-25T12:00:00Z" });
    await tx("t-pfc", "card", 6.5, m + "-12", { merchant: "Corner Cafe", pfc: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_COFFEE" } });
    await tx("t-cash", "cash", 12, m + "-10", { merchant: "Farmers Market", category: "Groceries" });
    await tx("t-pending", "card", 99.99, m + "-21", { merchant: "Pending Charge", category: "Shopping", pending: true });

    const api = fakeSheets();
    const count = await I.syncTransactions(api, pool);
    const all = valuesFor(api, "Transactions");
    assert.deepEqual(all[0], ["Date", "Merchant", "Amount", "Account", "Account Type", "Institution",
      "Category", "Category (Detailed)", "Source", "Reimbursed", "Reimbursed At", "Month"]);
    const rows = all.slice(1).filter((r) => r[11] === m);
    assert.deepEqual(rows, [
      // the user's rename and category win; "user" marks a category the user set
      [m + "-20", "Blue Bottle", 45.67, "Visa", "credit", "First Bank", "Coffee", "", "user", "", "", m],
      // a split parent, then its split lines directly under it, in split order
      [m + "-18", "BigStore", 120, "Visa", "credit", "First Bank", "Shopping", "", "auto", "", "", m],
      [m + "-18", "  ↳ BigStore Grocery", 70, "", "", "", "Groceries", "", "split", "", "", m],
      [m + "-18", "  ↳ BigStore", 50, "", "", "", "Household", "", "split", "", "", m],
      [m + "-15", "Hotel Work Trip", 300, "Visa", "credit", "First Bank", "Travel", "", "auto", "Yes", m + "-25", m],
      [m + "-12", "Corner Cafe", 6.5, "Visa", "credit", "First Bank", "", "FOOD_AND_DRINK_COFFEE", "auto", "", "", m],
      // an account with no bank connection reads "CSV Import"
      [m + "-10", "Farmers Market", 12, "Wallet", "depository", "CSV Import", "Groceries", "", "auto", "", "", m],
    ]);
    assert.ok(!all.some((r) => r[1] === "Pending Charge"), "a pending charge is never exported");
    assert.equal(typeof count, "number");
  });

  it("Tax Deductions tab equals the app's own tax report, to the cent", async () => {
    const d = (day) => `${year}-01-${day}`; // January of this year: always inside the tax year
    await tx("x-cvs", "card", 30, d("05"), { merchant: "CVS Pharmacy" });
    await tx("x-joint", "jcard", 80, d("06"), { merchant: "Walgreens Pharmacy" });             // 50% → 40.00
    await tx("x-partner", "jcard", 60, d("07"), { merchant: "City Hospital", personalFor: "partner" }); // the partner's → not listed
    await tx("x-rename", "card", 150, d("08"), { merchant: "SQ *XYZ 1182", rename: "Dr. Smith Dental" }); // matched on the display name
    await tx("x-charity", "card", 25, d("09"), { merchant: "Red Cross" });
    await tx("x-reimb", "card", 500, d("10"), { merchant: "State University Tuition", reimbursed: true });
    await tx("x-pending", "card", 70, d("11"), { merchant: "Downtown Medical", pending: true });
    await tx("x-lastyear", "card", 45, `${year - 1}-12-30`, { merchant: "CVS Pharmacy" });
    await tx("x-office", "card", 19.99, d("12"), { merchant: "Box Office Tickets" });          // "office" alone is not a keyword
    await q(`INSERT INTO tax_deductions (merchant, amount, category, deduction_type, tax_year, is_confirmed, notes)
             VALUES ('CVS Pharmacy', 0, 'medical', 'ai_detected', $1, true, 'HSA eligible'),
                    ('Red Cross', 0, 'business', 'ai_detected', $1, false, NULL)`, [year]);

    const api = fakeSheets();
    await I.syncTaxDeductionsYear(api, pool, year);
    const all = valuesFor(api, "Tax Deductions " + year);
    assert.deepEqual(all[0], ["Merchant", "Amount", "Category", "Type", "Confirmed", "Notes", "Date"]);
    const blank = all.findIndex((r, i) => i > 0 && r.length === 0);
    const rows = all.slice(1, blank);
    assert.deepEqual(rows, [
      ["CVS Pharmacy", 30, "medical", "keyword_match", "Yes", "HSA eligible", d("05")],
      ["Walgreens Pharmacy", 40, "medical", "keyword_match", "No", "", d("06")],
      ["Dr. Smith Dental", 150, "medical", "keyword_match", "No", "", d("08")],
      // the user's category on the merchant note wins over the keyword's group
      ["Red Cross", 25, "business", "keyword_match", "No", "", d("09")],
    ]);
    assert.deepEqual(all[blank + 1].slice(0, 2), ["TOTAL (all flagged)", 245]);
    assert.deepEqual([all[blank + 2][0], all[blank + 2][1], all[blank + 2][4]], ["TOTAL (confirmed)", 30, "1 items"]);

    // Parity with the app: the same rows /api/export/tax-report and the tax
    // package read (getTaxDeductionReport), whatever their order.
    const key = (m, a, c, conf, notes, date) => [date, m, Number(a).toFixed(2), c, conf, notes || ""].join("|");
    const app = (await fq.getTaxDeductionReport(pool, year)).map((r) => key(r.merchant, r.amount, r.category, r.is_confirmed, r.notes, r.txn_date)).sort();
    const sheet = rows.map((r) => key(r[0], r[1], r[2], r[4] === "Yes", r[5], r[6])).sort();
    assert.deepEqual(sheet, app);
  });

  it("Income tab: monthly totals equal getMonthlyIncome; sources cover 12 months and follow a rename", async () => {
    const m13 = shiftMonth(cm, -13), m25 = shiftMonth(cm, -25);
    await tx("i-pay1", "chk", -2000, cm + "-01", { merchant: "ACME PAYROLL DIRECT DEP", rename: "Acme Corp" });
    await tx("i-pay2", "chk", -2000, pm + "-01", { merchant: "ACME PAYROLL DIRECT DEP", rename: "Acme Corp" });
    await tx("i-joint", "jchk", -1000, pm + "-03", { merchant: "PARTNER CO PAYROLL" });               // 50% → 500
    await tx("i-side", "chk", -150, pm + "-05", { merchant: "Jane Doe", userCategory: "Income" });     // income by the user's category
    await tx("i-xfer", "chk", -300, pm + "-06", { merchant: "Online Transfer from Savings" });        // a transfer, not income
    await tx("i-refund", "chk", -20, pm + "-07", { merchant: "Amazon" });                             // a refund, not income
    await tx("i-pending", "chk", -2000, pm + "-08", { merchant: "ACME PAYROLL DIRECT DEP", pending: true });
    await tx("i-old13", "chk", -1800, m13 + "-10", { merchant: "OLDJOB PAYROLL" });                   // in the 24 months, not the 12
    await tx("i-old25", "chk", -1700, m25 + "-10", { merchant: "ANCIENT PAYROLL" });                  // in neither

    const api = fakeSheets();
    await I.syncIncome(api, pool);
    const all = valuesFor(api, "Income");
    assert.deepEqual(all[0], ["Month", "Total Income", "# Deposits"]);
    const sep = all.findIndex((r) => r[0] === "TOP SOURCES (LAST 12 MONTHS)");
    const monthly = all.slice(1, sep - 1);
    assert.deepEqual(monthly, [
      [cm, 2000, 1],
      [pm, 2650, 3],   // 2000 + 500 (the joint account's share) + 150
      [m13, 1800, 1],
    ]);
    // The app's own monthly income for the same window (savings rate, insights,
    // FIRE and Ask read it) — month for month.
    const app = Object.fromEntries((await fq.getMonthlyIncome(pool, 24)).map((r) => [r.month, Number(r.total_income)]));
    assert.deepEqual(Object.fromEntries(monthly.map((r) => [r[0], r[1]])), app);

    assert.deepEqual(all[sep + 1], ["Source", "Total", "# Deposits"]);
    const sources = all.slice(sep + 2).filter((r) => r[0]);
    assert.deepEqual(sources, [
      ["Acme Corp", 4000, 2],            // both deposits under the renamed source
      ["PARTNER CO PAYROLL", 500, 1],
      ["Jane Doe", 150, 1],
    ]);
  });

  it("a full run writes every tab on the real schema, and a failing tab is named while the rest still sync", async () => {
    const api = fakeSheets();
    const ok = await I.runSyncAll({ sheets: api, pool });
    assert.deepEqual(ok.errors, [], "every tab's SQL runs on the real schema: " + JSON.stringify(ok.errors));
    for (const tab of ["Transactions", "Subscriptions", "Utilities", "Income", "Dashboard", "Watchlist", "Tax Deductions " + year]) {
      assert.ok(tabsWritten(api).includes(tab), tab + " written");
    }
    assert.ok(ok.transactions_synced > 0);

    const bad = fakeSheets({ failOn: "Income" });
    const res = await I.runSyncAll({ sheets: bad, pool });
    assert.deepEqual(res.errors.map((e) => e.step), ["income"], "only the failing tab is reported");
    assert.match(res.errors[0].error, /quota exceeded for Income/);
    assert.equal(res.income_rows_synced, 0, "the failed tab's count falls back to 0");
    assert.equal(valuesFor(bad, "Income"), null);
    // Tabs before AND after Income in the run order were still written.
    for (const tab of ["Transactions", "Net Worth History", "AI Trust", "Watchlist", "Dashboard"]) {
      assert.ok(tabsWritten(bad).includes(tab), tab + " still written after Income failed");
    }
    // An injected pool is the caller's: the run did not close it.
    assert.equal((await q("SELECT 1 AS one")).rows[0].one, 1);
  });

  // ── The routes tests/api.test.js only imitated ───────────────────────────
  it("POST /api/subscriptions stores a manual subscription; GET sums the monthly cost by cadence", async () => {
    const add = (body) => supertest(app).post("/api/subscriptions").send(body);
    const hbo = (await add({ name: "HBO Max Streaming!", amount: "15.99", cadence_days: 30, notes: "shared" }).expect(200)).body;
    assert.equal(hbo.merchant_key, "manual_hbo_max_streaming_");
    assert.equal(hbo.source, "manual");
    assert.equal(hbo.notes, "shared");
    await add({ name: "Quarterly Box", amount: 49.99, cadence_days: 90 }).expect(200);
    await add({ name: "Annual Club", amount: 99.99, cadence_days: 365 }).expect(200);
    await add({ name: "Water Co", amount: 60, cadence_days: 30 }).expect(200);
    await q("UPDATE detected_subscriptions SET category = 'utility' WHERE display_name = 'Water Co'");
    // Adding the same name + cadence again updates the row instead of adding one.
    await add({ name: "HBO Max Streaming!", amount: 16.99, cadence_days: 30 }).expect(200);
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM detected_subscriptions")).rows[0].n, 4);

    const active = (await supertest(app).get("/api/subscriptions").expect(200)).body;
    assert.equal(active.subscriptions.length, 4);
    // 16.99 + 49.99 × 30/90 (16.66) + 99.99 × 30/365 (8.22) = 41.87 of
    // subscriptions, plus the $60 utility.
    assert.deepEqual(active.summary, {
      total_active: 4, monthly_cost: 101.87, yearly_cost: 1222.44,
      subscriptions_monthly: 41.87, utilities_monthly: 60,
      subscription_count: 3, utility_count: 1,
    });
    const byName = Object.fromEntries(active.subscriptions.map((s) => [s.display_name, s]));
    assert.equal(Number(byName["Quarterly Box"].monthly_cost), 16.66);
    assert.equal(Number(byName["Annual Club"].monthly_cost), 8.22);
  });

  it("GET /api/subscriptions filters: active, dismissed, cancelled, all", async () => {
    await q("UPDATE detected_subscriptions SET is_dismissed = true WHERE display_name = 'Quarterly Box'");
    await q("UPDATE detected_subscriptions SET cancelled_at = now(), is_active = false WHERE display_name = 'Annual Club'");
    const names = async (filter) => (await supertest(app).get("/api/subscriptions" + (filter ? "?filter=" + filter : "")).expect(200))
      .body.subscriptions.map((s) => s.display_name).sort();
    assert.deepEqual(await names(), ["HBO Max Streaming!", "Water Co"]);
    assert.deepEqual(await names("active"), ["HBO Max Streaming!", "Water Co"]);
    assert.deepEqual(await names("dismissed"), ["Quarterly Box"]);
    assert.deepEqual(await names("cancelled"), ["Annual Club"]);
    assert.deepEqual(await names("all"), ["Annual Club", "HBO Max Streaming!", "Quarterly Box", "Water Co"]);
    // The summary counts only what is neither dismissed nor cancelled, whatever the filter.
    const all = (await supertest(app).get("/api/subscriptions?filter=all").expect(200)).body;
    assert.equal(all.summary.total_active, 2);
    assert.equal(all.summary.monthly_cost, 76.99);
  });

  it("POST /api/cleanup prunes transactions past 36 months and inactive subscriptions idle for 6", async () => {
    await q(`INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending) VALUES
             ('cash','old-37', 5, CURRENT_DATE - INTERVAL '37 months', 'Old', 'Old', false),
             ('cash','old-35', 5, CURRENT_DATE - INTERVAL '35 months', 'Kept', 'Kept', false),
             ('cash','recent', 5, CURRENT_DATE - 3, 'Recent', 'Recent', false)`);
    const sub = (key, active, age) => q(
      `INSERT INTO detected_subscriptions (merchant_key, display_name, amount, cadence_days, first_seen, last_charged, next_expected, is_active, updated_at)
       VALUES ($1, $1, 9, 30, CURRENT_DATE - 400, CURRENT_DATE - 300, CURRENT_DATE - 270, $2, now() - $3::interval)`, [key, active, age]);
    await sub("stale-inactive", false, "7 months");
    await sub("recent-inactive", false, "5 months");
    await sub("stale-but-active", true, "7 months");

    const res = (await supertest(app).post("/api/cleanup").send({}).expect(200)).body;
    assert.deepEqual(res, { transactions_pruned: 1, subscriptions_pruned: 1 });
    assert.deepEqual((await q("SELECT transaction_id FROM transactions WHERE transaction_id IN ('old-37','old-35','recent') ORDER BY 1")).rows.map((r) => r.transaction_id),
      ["old-35", "recent"]);
    const keys = (await q("SELECT merchant_key FROM detected_subscriptions WHERE merchant_key LIKE '%active' ORDER BY 1")).rows.map((r) => r.merchant_key);
    assert.deepEqual(keys, ["recent-inactive", "stale-but-active"]);
  });

  it("POST /api/investment-accounts: a name is required, an unknown type is stored as brokerage", async () => {
    const add = (body) => supertest(app).post("/api/investment-accounts").send(body);
    assert.equal((await add({ balance: 50000, account_type: "401k" })).status, 400);
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM investment_accounts")).rows[0].n, 0, "nothing stored without a name");
    const bad = (await add({ name: "Mystery", account_type: "invalid_type", balance: "1250.50" }).expect(200)).body;
    assert.equal(bad.account_type, "brokerage");
    assert.equal(Number(bad.balance), 1250.5);
    for (const type of ["brokerage", "retirement", "401k", "ira", "roth_ira", "529", "hsa", "crypto", "other"]) {
      const row = (await add({ name: "Acct " + type, account_type: type }).expect(200)).body;
      assert.equal(row.account_type, type, type + " is accepted by the route AND the table");
      assert.equal(Number(row.balance), 0);
    }
  });
});
