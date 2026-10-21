// Real-Postgres contract parity (cycle-7 Batch 13 policy response —
// Parallel Source-of-Truth Drift): the Google Sheets Dashboard's BUDGET STATUS
// rows are an inlined SQL mirror of getBudgetStatus (scripts/sheets-sync.js
// can't require the services layer). SX3 pins the mirrored fragments' TEXT;
// this pins their RESULT — for a budget set that exercises every rule (prior-
// month rollover, rollover off, a one-time budget in and out of its month, a
// split parent, a reimbursed charge, a shared card at 50% and personal_for)
// the Sheets rows must equal getBudgetStatus row-for-row to the cent.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { SKIP, perfinDb } = require("./_setup");

function fakeSheets() {
  const meta = [];
  let nextId = 900;
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
      values: { update: async (p) => { updates.push(p); return {}; }, append: async () => ({}), clear: async () => ({}) },
    },
  };
}

describe("Sheets Budget Status = getBudgetStatus on real Postgres", { skip: SKIP }, () => {
  let pool, fq, cm, pm;
  const q = (s, p) => pool.query(s, p);

  before(async () => {
    process.env.GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID || "contract-sheet";
    pool = await perfinDb("budgetparity");
    fq = require("../../teller/services/financial-queries");
    cm = fq.currentMonth(); pm = fq.previousMonthKey(cm);
    await q("INSERT INTO plaid_items (item_id, institution_name, access_token_enc, status) VALUES ('i1','Bank','x','GOOD')");
    const item = (await q("SELECT id FROM plaid_items")).rows[0].id;
    await q(`INSERT INTO linked_accounts (plaid_item_id, account_id, name, type, subtype, current_balance, is_shared, spending_split_pct)
             VALUES ($1,'card','card','credit','credit card',0,false,100), ($1,'joint','joint','credit','credit card',0,true,50)`, [item]);
    const tx = (id, acct, amt, cat, extra = {}) => q(
      `INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, category, is_reimbursed, personal_for, pending)
       VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,false)`,
      [acct, id, amt, extra.date || cm + "-02", extra.merchant || "Shop " + id, [cat], !!extra.reimbursed, extra.personal_for || null]);
    await tx("g1", "card", 80.25, "Groceries");
    await tx("g2", "joint", 100, "Groceries");                        // 50% → 50
    await tx("g3", "joint", 33.33, "Groceries", { personal_for: "self" });
    await tx("g4", "joint", 40, "Groceries", { personal_for: "partner" });
    await tx("parent", "card", 120, "Shopping");
    await q("INSERT INTO transaction_splits (parent_transaction_id, amount, category) VALUES ('parent',70,'Groceries'),('parent',50,'Household')");
    await tx("hotel", "card", 400, "Travel", { reimbursed: true });
    await tx("trip", "card", 210.5, "Travel");
    await tx("dine", "card", 64.1, "Dining");
    await tx("old", "card", 999, "Dining", { date: pm + "-15" });     // last month — not counted
    await tx("zelle", "card", 300, "Dining", { merchant: "ZELLE TO JOHN SMITH" }); // a transfer
    const g = (await q("INSERT INTO budgets (category, monthly_limit, rollover_enabled) VALUES ('Groceries', 250, true) RETURNING id")).rows[0].id;
    const d = (await q("INSERT INTO budgets (category, monthly_limit, rollover_enabled) VALUES ('Dining', 150, false) RETURNING id")).rows[0].id;
    await q("INSERT INTO budgets (category, monthly_limit, budget_type, effective_month) VALUES ('Travel', 600, 'one_time', $1)", [cm]);
    await q("INSERT INTO budgets (category, monthly_limit, budget_type, effective_month) VALUES ('Gifts', 500, 'one_time', '2001-12')");
    await q("INSERT INTO budgets (category, monthly_limit) VALUES ('Household', 40)");
    await q("INSERT INTO budget_snapshots (budget_id, month, monthly_limit, spent, rollover_amount) VALUES ($1,$2,250,190,60), ($3,$2,150,100,50)", [g, pm, d]);
  });
  after(async () => { if (pool) await pool.end(); });

  it("every Sheets Budget Status row matches getBudgetStatus (spent and effective limit, to the cent)", async () => {
    const api = fakeSheets();
    await require("../../scripts/sheets-sync")._internals.buildDashboard(api, pool);
    const dash = api.updates.filter((u) => u.range.startsWith("Dashboard!")).pop().requestBody.values;
    const head = dash.findIndex((r) => r[0] === "BUDGET STATUS (Current Month)");
    assert.ok(head >= 0, "budget section written");
    const sheetRows = [];
    for (let i = head + 2; i < dash.length && dash[i] && dash[i].length && dash[i][0]; i++) sheetRows.push(dash[i]);
    const sheet = Object.fromEntries(sheetRows.map((r) => [r[0], { spent: Number(r[1]).toFixed(2), limit: Number(r[2]).toFixed(2) }]));
    const app = Object.fromEntries((await fq.getBudgetStatus(pool, cm)).map((b) => [b.category, { spent: b.spent.toFixed(2), limit: b.effective_limit.toFixed(2) }]));
    assert.deepEqual(sheet, app);
    // The fixture really exercises the rules (so parity isn't vacuous):
    assert.deepEqual(app.Groceries, { spent: "233.58", limit: "310.00" }); // 80.25 + 50 + 33.33 + 0 + 70 split; 250 + 60 rollover
    assert.deepEqual(app.Dining, { spent: "64.10", limit: "150.00" });     // rollover off; old month + transfer excluded
    assert.deepEqual(app.Travel, { spent: "210.50", limit: "600.00" });    // reimbursed excluded; one-time in its month
    assert.equal(app.Gifts, undefined);                                     // one-time outside its month
    assert.deepEqual(app.Household, { spent: "50.00", limit: "40.00" });
  });
});
