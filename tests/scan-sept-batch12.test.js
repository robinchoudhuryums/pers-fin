// ============================================================================
// Broad-scan (Sept 2026) Batch 12 — Investments
// ============================================================================
// BSI-4   holdings Plaid no longer returns (sold positions) are pruned
// BSI-5   an unknown cost basis is stored NULL and kept out of the return
//         (coverage reported), not counted as a $0 basis
// BSI-6   an account that joins mid-window enters TWR/XIRR as an inflow
// WD-2    dashboard sparkline uses the account's real history source
// WD-10   goal funding-options drop the Plaid brokerage phantom; an orphaned
//         funding link is shown as such on the Goals page
// WD-17   top_losers only lists losses (winners only gains); the history
//         chart clears on a range with no data; reconcile reports leg errors
// BSI-16  parseMoney trailing minus + CR/DR; Chase checking format
// ============================================================================

const { describe, it, before, afterEach } = require("node:test");
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
const inv = require("../teller/routes/investments");
const benchmarks = require("../teller/services/benchmarks");
const csv = require("../teller/data/csv-formats");

const originalPoolQuery = dbModule.pool.query;
afterEach(() => { dbModule.pool.query = originalPoolQuery; });

function recordingDb(handler) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return handler ? handler(sql, params) : { rows: [], rowCount: 0 };
    },
  };
}

// ---------------------------------------------------------------------------
describe("BSI-4 — holdings sync prunes positions Plaid no longer returns", () => {
  it("deletes this item's accounts' holdings that are absent from the response", async () => {
    const db = recordingDb((sql) => (/DELETE FROM investment_holdings/.test(sql) ? { rows: [], rowCount: 1 } : { rows: [], rowCount: 1 }));
    const r = await inv.writePlaidHoldings(db, {
      accounts: [{ account_id: "acc1" }, { account_id: "acc2" }],
      holdings: [{ account_id: "acc1", security_id: "sec-vti", quantity: 10, cost_basis: 1000, institution_value: 2500 }],
      securities: [{ security_id: "sec-vti", ticker_symbol: "VTI", name: "Vanguard Total", type: "etf" }],
    });
    const del = db.calls.find((c) => /DELETE FROM investment_holdings/.test(c.sql));
    assert.ok(del, "a prune DELETE runs");
    assert.deepEqual(del.params[0], ["acc1", "acc2"], "scoped to the accounts in this response (acc2 now holds nothing)");
    assert.deepEqual(del.params[1], ["acc1"]);
    assert.deepEqual(del.params[2], ["sec-vti"], "the still-held pair is kept");
    assert.match(del.sql, /NOT IN \(\s*SELECT \* FROM unnest\(\$2::text\[\], \$3::text\[\]\)/);
    assert.equal(r.upserted, 1);
    assert.equal(r.pruned, 1);
  });

  it("no accounts in the response → nothing is pruned (other items untouched)", async () => {
    const db = recordingDb();
    await inv.writePlaidHoldings(db, { accounts: [], holdings: [], securities: [] });
    assert.ok(!db.calls.some((c) => /DELETE/.test(c.sql)));
  });

  it("every holdings writer goes through writePlaidHoldings (sync + both exchange paths)", () => {
    const src = read("teller", "routes", "investments.js");
    const uses = src.match(/await writePlaidHoldings\(pool, /g) || [];
    assert.ok(uses.length >= 3, `expected the sync + 2 exchange paths, saw ${uses.length}`);
    assert.equal((src.match(/INSERT INTO investment_holdings/g) || []).length, 1, "one holdings INSERT (in the helper)");
    assert.match(src, /holdings_removed: totalPruned/);
  });
});

// ---------------------------------------------------------------------------
describe("BSI-5 — unknown cost basis is NULL, not $0", () => {
  it("holdingCostBasis maps missing/blank to null and keeps real numbers (incl. 0)", () => {
    assert.equal(inv.holdingCostBasis({ cost_basis: null }), null);
    assert.equal(inv.holdingCostBasis({}), null);
    assert.equal(inv.holdingCostBasis({ cost_basis: "" }), null);
    assert.equal(inv.holdingCostBasis({ cost_basis: 0 }), 0);
    assert.equal(inv.holdingCostBasis({ cost_basis: "123.45" }), 123.45);
  });

  it("the writer stores NULL for a holding without a basis", async () => {
    const db = recordingDb();
    await inv.writePlaidHoldings(db, {
      accounts: [{ account_id: "a" }],
      holdings: [{ account_id: "a", security_id: "s", quantity: 1, cost_basis: null, institution_value: 50 }],
      securities: [],
    });
    const ins = db.calls.find((c) => /INSERT INTO investment_holdings/.test(c.sql));
    assert.equal(ins.params[5], null);
  });

  it("migration drops NOT NULL / DEFAULT on investment_holdings.cost_basis", () => {
    const src = read("teller", "services", "database.js");
    assert.match(src, /ALTER TABLE investment_holdings ALTER COLUMN cost_basis DROP NOT NULL/);
    assert.match(src, /ALTER TABLE investment_holdings ALTER COLUMN cost_basis DROP DEFAULT/);
  });

  it("performance return covers only known-basis holdings and reports coverage", async () => {
    dbModule.pool.query = async (sql) => {
      if (/FROM investment_holdings h/.test(sql)) return { rows: [
        { name: "Known", ticker: "KNW", quantity: 1, cost_basis: "1000", current_value: "1200", security_type: "etf", plaid_account_id: "a", account_name: "Brokerage" },
        { name: "Transferred-in", ticker: "TIN", quantity: 1, cost_basis: null, current_value: "5000", security_type: "equity", plaid_account_id: "a", account_name: "Brokerage" },
      ]};
      if (/target_allocation_pct/.test(sql)) return { rows: [{ target_allocation_pct: {} }] };
      return { rows: [] };
    };
    const app = express(); app.use(inv);
    const res = await supertest(app).get("/api/investments/performance").expect(200);
    assert.equal(res.body.total_value, 6200, "value still includes every holding");
    assert.equal(res.body.total_cost_basis, 1000);
    assert.equal(res.body.total_return, 200, "return over the known-basis holding only — not 5,200");
    assert.ok(Math.abs(res.body.total_return_pct - 20) < 1e-9);
    assert.equal(res.body.cost_basis_coverage.holdings_with_basis, 1);
    assert.equal(res.body.cost_basis_coverage.holdings_total, 2);
    assert.equal(res.body.cost_basis_coverage.value_with_basis, 1200);
    const all = [...(res.body.top_winners || []), ...(res.body.top_losers || [])];
    assert.ok(!all.some((h) => h.ticker === "TIN"), "an unknown-basis holding has no return to rank");
  });

  it("Sheets Investments tab leaves unknown basis blank and totals the known-basis return", () => {
    const src = read("scripts", "sheets-sync.js");
    assert.match(src, /valueWithBasis - totalCost/);
  });
});

// ---------------------------------------------------------------------------
describe("WD-17 — winners are gains, losers are losses", () => {
  it("an all-gain portfolio has no 'losers'", async () => {
    dbModule.pool.query = async (sql) => {
      if (/FROM investment_holdings h/.test(sql)) return { rows: [1, 2, 3, 4, 5, 6, 7].map((i) => ({
        name: "H" + i, ticker: "H" + i, quantity: 1, cost_basis: "100", current_value: String(100 + i * 10),
        security_type: "etf", plaid_account_id: "a", account_name: "B",
      })) };
      if (/target_allocation_pct/.test(sql)) return { rows: [{ target_allocation_pct: {} }] };
      return { rows: [] };
    };
    const app = express(); app.use(inv);
    const res = await supertest(app).get("/api/investments/performance").expect(200);
    assert.equal(res.body.top_losers.length, 0, "the smallest gains used to be listed as losers");
    assert.ok(res.body.top_winners.every((h) => h.return_pct > 0));
  });
});

// ---------------------------------------------------------------------------
describe("BSI-6 — an account joining mid-window is an inflow, not a return", () => {
  it("accountEntryFlows lists accounts whose first snapshot is after the series start", () => {
    const { entries, firstSeen } = inv.accountEntryFlows([
      { snapshot_date: "2026-06-01", source: "investment", source_id: 1, balance: "50000" },
      { snapshot_date: "2026-06-10", source: "investment", source_id: 1, balance: "50000" },
      { snapshot_date: "2026-06-10", source: "investment", source_id: 2, balance: "50000" },
      { snapshot_date: "2026-06-12", source: "investment", source_id: 3, balance: "0" },
    ]);
    assert.deepEqual(entries, [{ key: "investment:2", date: "2026-06-10", amount: 50000 }], "acct 1 is the start; a $0 entry is no flow");
    assert.equal(firstSeen["investment:2"], "2026-06-10");
  });

  it("performance-history TWR is 0% when a flat second account is linked mid-window", async () => {
    dbModule.pool.query = async (sql) => {
      if (/FROM account_balance_snapshots/i.test(sql)) return { rows: [
        { snapshot_date: "2026-06-01", source: "investment", source_id: 1, balance: "50000" },
        { snapshot_date: "2026-06-10", source: "investment", source_id: 1, balance: "50000" },
        { snapshot_date: "2026-06-10", source: "investment", source_id: 2, balance: "50000" },
        { snapshot_date: "2026-06-20", source: "investment", source_id: 1, balance: "50000" },
        { snapshot_date: "2026-06-20", source: "investment", source_id: 2, balance: "50000" },
      ]};
      if (/plaid_account_id IS NOT NULL AND is_active = true/i.test(sql)) return { rows: [{ id: 1 }, { id: 2 }] };
      if (/SELECT DISTINCT source, source_id FROM investment_flows/i.test(sql)) return { rows: [] };
      // Plaid syncs ~24 months of history: acct 2's opening deposit predates
      // its first snapshot and must not be counted on top of the entry flow.
      if (/FROM investment_flows/i.test(sql)) return { rows: [
        { source: "investment", source_id: 2, flow_date: "2026-06-05", amount: "50000" },
      ]};
      return { rows: [] };
    };
    const origEnsure = benchmarks.ensureBenchmark, origSeries = benchmarks.getBenchmarkSeries;
    benchmarks.ensureBenchmark = async () => false;
    benchmarks.getBenchmarkSeries = async () => [];
    try {
      const app = express(); app.use(inv);
      const res = await supertest(app).get("/api/investments/performance-history").expect(200);
      assert.ok(Math.abs(res.body.twr_pct) < 1e-9, `TWR should be 0 (was +100%), got ${res.body.twr_pct}`);
      assert.ok(Math.abs(res.body.xirr_pct) < 0.5, `XIRR ~0, got ${res.body.xirr_pct}`);
      assert.equal(res.body.flow_coverage.accounts_added, 1);
      assert.equal(res.body.flow_coverage.flows_count, 0, "the pre-entry flow is part of the opening balance");
    } finally {
      benchmarks.ensureBenchmark = origEnsure;
      benchmarks.getBenchmarkSeries = origSeries;
    }
  });
});

// ---------------------------------------------------------------------------
describe("WD-2 — investment sparklines read the account's own history", () => {
  it("Teller-linked accounts use source=linked, others source=investment", () => {
    const src = read("teller", "views", "dashboard.ejs");
    assert.match(src, /var invHistSource = function\(a\) \{ return a\.source === 'teller' \? 'linked' : 'investment'; \};/);
    assert.match(src, /'\/balance-history\?source=' \+ invHistSource\(a\) \+ '&months=6'/);
    assert.doesNotMatch(src, /balance-history\?source=investment&months=6/);
  });
});

// ---------------------------------------------------------------------------
describe("WD-10 — goal funding options + orphaned links", () => {
  it("funding-options leaves out a linked_accounts row that is an active investment_accounts brokerage", async () => {
    const seen = [];
    dbModule.pool.query = async (sql) => { seen.push(sql); return { rows: [] }; };
    const goals = require("../teller/routes/goals");
    const app = express(); app.use(goals);
    await supertest(app).get("/api/goals/funding-options").expect(200);
    const tellerInv = seen.find((s) => /FROM linked_accounts la/.test(s) && /NOT EXISTS/.test(s));
    assert.ok(tellerInv, "the investment linked_accounts query dedupes the phantom");
    assert.match(tellerInv, /ia\.plaid_account_id = la\.account_id AND ia\.is_active = true/);
  });

  it("the Goals page renders funding_status 'orphaned' as a warning, not 'Auto-tracked'", () => {
    const src = read("teller", "views", "goals.ejs");
    assert.match(src, /g\.funding_status === 'orphaned'/);
    assert.match(src, /linked account is no longer available/);
  });
});

// ---------------------------------------------------------------------------
describe("WD-17 — stale history chart + reconcile message", () => {
  it("the history chart clears to an empty state when a range has < 2 points", () => {
    const src = read("teller", "views", "dashboard.ejs");
    assert.match(src, /if \(!data\.portfolio \|\| data\.portfolio\.length < 2\) \{ showEmptyRange\(months\); return; \}/);
    assert.match(src, /var seq = \+\+loadSeq;/, "a slower superseded response is dropped");
    assert.doesNotMatch(src, /data\.portfolio\.length < 2\) return;/);
  });

  it("reconcileErrors flattens per-leg and per-item errors; 'Plaid not configured' is not one", () => {
    const enr = require("../teller/routes/enrollments");
    assert.deepEqual(enr.reconcileErrors({ teller: { transactions_added: 0, errors: [] }, plaid: { error: "Plaid not configured" } }), []);
    const errs = enr.reconcileErrors({
      teller: { transactions_added: 0, errors: [{ institution: "Chase", error: "decryption_failed" }] },
      plaid: { error: "boom" },
    });
    assert.equal(errs.length, 2);
    assert.equal(errs[0].institution, "Chase");
    assert.match(enr.summarizeReconcile({ teller: { transactions_added: 3, errors: [{ error: "x" }] } }), /3 recovered \(1 error\)/);
  });

  it("the background job folds leg errors into reconcileJob.error and Settings checks the legs", () => {
    const src = read("teller", "routes", "enrollments.js");
    assert.match(src, /const errs = reconcileErrors\(out\);/);
    assert.match(src, /title: reconcileJob\.error \? "Reconcile finished with errors" : "Reconcile complete"/);
    const ui = read("teller", "views", "settings.ejs");
    assert.match(ui, /else if \(legErrs\) showMsg\('Reconcile finished with ' \+ legErrs/);
  });
});

// ---------------------------------------------------------------------------
describe("BSI-16 — CSV amounts and the Chase checking format", () => {
  it("parseMoney handles trailing minus and CR/DR suffixes", () => {
    assert.equal(csv.parseMoney("45.00-"), -45);
    assert.equal(csv.parseMoney("1,234.56-"), -1234.56);
    assert.equal(csv.parseMoney("45.00 CR"), -45);
    assert.equal(csv.parseMoney("45.00CR"), -45);
    assert.equal(csv.parseMoney("45.00 cr"), -45);
    assert.equal(csv.parseMoney("45.00 DR"), 45);
    // unchanged behaviour
    assert.equal(csv.parseMoney("(45.00)"), -45);
    assert.equal(csv.parseMoney("$1,234.56"), 1234.56);
    assert.equal(csv.parseMoney("-$45"), -45);
    assert.ok(Number.isNaN(csv.parseMoney("")));
    assert.ok(Number.isNaN(csv.parseMoney("CR")));
  });

  const CHASE_CHECKING =
    "Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\n" +
    "DEBIT,09/15/2026,\"STARBUCKS STORE 123\",-5.75,DEBIT_CARD,1234.56,,\n" +
    "CREDIT,09/14/2026,\"PAYROLL ACME\",2000.00,ACH_CREDIT,1240.31,,\n";

  it("detects Chase checking and parses debit-positive amounts with the posting date", () => {
    assert.equal(csv.detectCsvFormat(["Details", "Posting Date", "Description", "Amount", "Type", "Balance", "Check or Slip #"]), "chase_checking");
    assert.equal(csv.INSTITUTION_LABELS.chase_checking, "Chase Checking");
    const fmt = csv.CSV_FORMATS.chase_checking;
    const a = fmt.parse({ Details: "DEBIT", "Posting Date": "09/15/2026", Description: "STARBUCKS", Amount: "-5.75", Type: "DEBIT_CARD" });
    assert.equal(a.date, "09/15/2026");
    assert.equal(a.amount, 5.75, "money out → positive spending");
    assert.equal(a.category, "", "Type (DEBIT_CARD) is not a spending category");
    assert.equal(fmt.parse({ "Posting Date": "09/14/2026", Description: "PAYROLL", Amount: "2000.00" }).amount, -2000);
    // the Chase CARD export is still its own format
    assert.equal(csv.detectCsvFormat(["Transaction Date", "Post Date", "Description", "Category", "Type", "Amount", "Memo"]), "chase");
  });

  it("the import preview accepts a real Chase checking file (trailing comma on every row)", async () => {
    dbModule.pool.query = async () => ({ rows: [] });
    const subs = require("../teller/routes/subscriptions");
    const app = express(); app.use(express.json()); app.use(subs);
    const res = await supertest(app)
      .post("/api/import-csv/preview")
      .attach("file", Buffer.from(CHASE_CHECKING), "chase.csv")
      .expect(200);
    assert.equal(res.body.format_detected, "chase_checking");
    assert.equal(res.body.rows_parseable, 2);
    assert.equal(res.body.rows_skipped, 0);
  });

  it("the CLI parses with the same tolerance", () => {
    assert.match(read("scripts", "import-csv-cli.js"), /relax_column_count: true/);
    assert.match(read("teller", "routes", "subscriptions.js"), /relax_column_count: true/);
  });
});
