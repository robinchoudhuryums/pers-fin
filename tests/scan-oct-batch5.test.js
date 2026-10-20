// ============================================================================
// Broad-scan (Oct 2026, cycle 7) Batch 5 — money accuracy and classification
// ============================================================================
// The SQL-level behaviour (NOT_TRANSFER, income split, settlement, categorize
// queue, housing skips, summary windows, snapshots, detectors, cash-flow
// income, Sheets Watchlist) is pinned against real Postgres in
// tests/contract/money-classification.contract.test.js. This file covers what
// needs no database:
// F40   the budget push uses getBudgetStatus and unrounded thresholds
// F36   the context export reports an unknown card limit as unknown
// F43   nextRentInLeadWindow
// F49   the detectors' raw-description helpers
// F50   mapCategoryFor ignores a Plaid row's legacy category
// F31   the dashboard shows a 0% split as 0%
// F32/F37  the Sheets mirrors (NOT_TRANSFER via SX3; INCOME_AMOUNT here)
// F33   the Rent page's Remove button + reset-fresh classification
// ============================================================================

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
afterEach(() => { dbModule.pool.query = originalQuery; });

// ---------------------------------------------------------------------------
describe("F40 — the budget push", () => {
  const notifications = require("../teller/routes/notifications");
  const startup = require("../teller/startup");

  async function runWith(spent, limit, rollover = null) {
    const sent = [];
    const origSend = notifications.sendToAll, origRecent = notifications.sentRecently;
    notifications.sendToAll = async (p) => { sent.push(p); return { logged: true }; };
    notifications.sentRecently = async () => false;
    dbModule.pool.query = async (sql) => {
      if (/SELECT \* FROM budgets/.test(sql)) return { rows: [{ id: 1, category: "Dining", monthly_limit: String(limit), rollover_enabled: rollover != null }] };
      if (/month_start/.test(sql)) return { rows: [{ category: "Dining", spent: String(spent) }] };
      if (/FROM budget_snapshots/.test(sql)) return { rows: rollover != null ? [{ budget_id: 1, rollover_amount: String(rollover) }] : [] };
      return { rows: [] };
    };
    try { await startup._awayJobs.runBudgetAlertTick(); }
    finally { notifications.sendToAll = origSend; notifications.sentRecently = origRecent; }
    return sent;
  }

  it("99.6% is a warning that says 99%, not 'Budget exceeded (100%)'", async () => {
    const sent = await runWith(99.6, 100);
    assert.equal(sent.length, 1);
    assert.match(sent[0].title, /^Budget warning/);
    assert.match(sent[0].body, /\(99% — approaching limit\)/);
  });

  it("compares against the effective limit (prior-month rollover) via getBudgetStatus", async () => {
    const sent = await runWith(120, 100, 50); // 120 of 150 → 80%
    assert.match(sent[0].title, /^Budget warning/);
    assert.match(read("teller", "startup.js"), /const budgets = await getBudgetStatus\(pool, currentMonth\(\)\);/);
  });

  it("100% exactly is exceeded", async () => {
    const sent = await runWith(100, 100);
    assert.match(sent[0].title, /^Budget exceeded/);
  });
});

// ---------------------------------------------------------------------------
describe("F36 — context export with an unknown card limit", () => {
  it("shows the limit and utilization as unknown, not 100%", async () => {
    dbModule.pool.query = async (sql) => {
      if (/FROM linked_accounts WHERE type = 'credit'/.test(sql)) return { rows: [
        { name: "Discover", mask: "1234", current_balance: "500", available_balance: null, credit_limit: null },
        { name: "Visa", mask: "9999", current_balance: "250", available_balance: "750", credit_limit: null },
      ] };
      return { rows: [] };
    };
    const app = express(); app.use(require("../teller/routes/goals"));
    const md = (await supertest(app).get("/api/context-export").expect(200)).text;
    assert.match(md, /\*\*Discover\*\* \(\*\*\*\*1234\): \$500\.00 owed \/ limit unknown \(utilization unknown\)/);
    assert.match(md, /\*\*Visa\*\* \(\*\*\*\*9999\): \$250\.00 owed \/ \$1000\.00 limit \(25% utilization\)/);
    const json = (await supertest(app).get("/api/context-export?format=json").expect(200)).body;
    const d = json.credit_cards.find((c) => c.name === "Discover");
    assert.equal(d.credit_limit, null);
    assert.equal(d.utilization_pct, null);
  });
});

// ---------------------------------------------------------------------------
describe("F43 — next month's rent inside the lead window", () => {
  const { nextRentInLeadWindow } = require("../teller/routes/housing");
  it("a window that opens in the previous month is seen", () => {
    assert.deepEqual(nextRentInLeadWindow({ rent_due_day: 2, reminder_lead_days: 5 }, "2026-10-28"),
      { period: "2026-11", due_date: "2026-11-02", days_until: 5 });
    assert.equal(nextRentInLeadWindow({ rent_due_day: 2, reminder_lead_days: 5 }, "2026-10-26"), null, "6 days out");
  });
  it("the due day is clamped to next month's length; no lead → never", () => {
    assert.deepEqual(nextRentInLeadWindow({ rent_due_day: 31, reminder_lead_days: 31 }, "2026-01-31"),
      { period: "2026-02", due_date: "2026-02-28", days_until: 28 });
    assert.equal(nextRentInLeadWindow({ rent_due_day: 1, reminder_lead_days: 0 }, "2026-01-31"), null);
  });
});

// ---------------------------------------------------------------------------
describe("F49 — detectors read the raw description", () => {
  const subs = require("../scripts/detect-subscriptions");
  const transfers = require("../scripts/detect-transfers");
  it("a payment/transfer description is never a subscription charge", () => {
    assert.equal(subs.isExcludedDescription("ZELLE TO JOHN SMITH ON 10/01"), true);
    assert.equal(subs.isExcludedDescription("CHASE CREDIT CRD AUTOPAY"), true);
    assert.equal(subs.isExcludedDescription("NETFLIX.COM"), false);
    assert.equal(subs.isExcludedDescription("SHELL OIL 57444"), false, "retail words stay merchant-only");
    assert.equal(subs.isExcludedDescription(null), false);
  });
  it("transfer type: merchant key first, then phrase-like description types (no PayPal purchases)", () => {
    assert.equal(transfers.classifyTransferTxn("John Smith", "ZELLE TO JOHN SMITH"), "peer_transfer");
    assert.equal(transfers.classifyTransferTxn("Netflix", "PAYPAL *NETFLIX"), null);
    assert.equal(transfers.classifyTransferTxn("Vanguard", null), "investment");
    assert.equal(transfers.classifyTransferDescription("SCHWAB BROKERAGE"), null, "brand words stay merchant-only");
  });
  it("a rename skips the raw description (SQL reads it only when user_merchant_name is NULL)", () => {
    for (const f of ["detect-subscriptions.js", "detect-transfers.js"]) {
      assert.match(read("scripts", f), /CASE WHEN user_merchant_name IS NULL THEN name END AS raw_description/);
    }
  });
});

// ---------------------------------------------------------------------------
describe("F50 — Plaid legacy categories", () => {
  const { mapCategoryFor } = require("../teller/routes/categorize-helpers");
  it("a Plaid row maps from its PFC only; a Teller row still uses the Teller map", () => {
    assert.equal(mapCategoryFor({ category: ["Travel"], personal_finance_category: { primary: "TRANSPORTATION", detailed: "TRANSPORTATION_GAS" } }),
      mapCategoryFor({ personal_finance_category: { primary: "TRANSPORTATION", detailed: "TRANSPORTATION_GAS" } }));
    assert.equal(mapCategoryFor({ category: ["Tax"], personal_finance_category: { primary: "GENERAL_SERVICES" } }), null);
    assert.equal(mapCategoryFor({ category: ["dining"] }), "Food & Drink");
  });
  it("every uncategorized predicate treats a PFC row as uncategorized; the Teller map skips Plaid rows", () => {
    const src = read("teller", "routes", "categorize.js");
    assert.equal((src.match(/personal_finance_category IS NOT NULL\s+OR category IS NULL/g) || []).length, 4);
    assert.match(src, /LOWER\(category\[1\]\) = \$2\s+AND personal_finance_category IS NULL/);
  });
});

// ---------------------------------------------------------------------------
describe("F31 / F32 / F37 / F33 — mirrors and UI", () => {
  it("the dashboard shows a 0% split as 0% (|| 100 turned it into 100%)", () => {
    const dash = read("teller", "views", "dashboard.ejs");
    assert.match(dash, /\(a\.spending_split_pct == null \? 100 : a\.spending_split_pct\) \+ '%<\/div>'/);
    assert.doesNotMatch(read("teller", "routes", "subscriptions.js"), /\|\| 50\) \/ 100|spending_split_pct, 50\)/);
  });

  it("NOT_TRANSFER reads brand words on the cleaned merchant only, with the exemptions", () => {
    const { NOT_TRANSFER } = require("../teller/services/financial-queries");
    assert.match(NOT_TRANSFER, /COALESCE\(t\.user_merchant_name, t\.merchant_name, t\.name\) !~\*\s+'\\y\(interest\|paypal\|/);
    assert.match(NOT_TRANSFER, /citi \?bike\|citi field\|chase \(center\|field\)\|security deposit\)\\y\|\\ypaypal \?\\\*'/);
    assert.match(NOT_TRANSFER, /NOT IN \('transfer', 'investment'\)/);
    const phrases = NOT_TRANSFER.match(/!~\*\s*'([^']+)'/)[1];
    assert.doesNotMatch(phrases, /\|(paypal|chase|citi|deposit|interest)\|/, "brand words are not matched on the raw description");
  });

  it("the Sheets Income tab mirrors INCOME_AMOUNT (the negated SPLIT_AMOUNT CASE)", () => {
    const { INCOME_AMOUNT } = require("../teller/services/financial-queries");
    const norm = (s) => s.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();
    const m = read("scripts", "sheets-sync.js").match(/const INCOME_AMOUNT = `([\s\S]*?)`;/);
    assert.ok(m, "Sheets INCOME_AMOUNT not found");
    assert.equal(norm(m[1]), norm(INCOME_AMOUNT));
    assert.match(read("teller", "services", "financial-queries.js"), /\|refund\|reversal\|reimbursement\|reimburse\|reimb\|expense report\|atm\|/);
  });

  it("awaiting-bill rows have a labelled Remove button; the skip table is reset-classified", () => {
    const ejs = read("teller", "views", "housing.ejs");
    assert.match(ejs, /class="btn-sm hz-remove" data-id="'\+o\.id\+'"[^>]*aria-label="Remove /);
    assert.match(ejs, /apiFetch\('\/api\/housing\/obligations\/'\+id, \{ method:'DELETE' \}\)/);
    assert.ok(require("../scripts/reset-fresh").WIPE_TABLES.includes("payee_obligation_skips"));
  });
});
