// ============================================================================
// Regression tests for the broad-implement cycle: F1, FA-1, PS-1, PS-2, AI-5/6
// ============================================================================
// These pin the behavior the cycle fixed so a future regression FAILS here.
//   - F1     getNetWorth: investment dedupe + inclusion (behavioral, mock pool)
//   - FA-1   budget rollover reads the PRIOR month's snapshot (behavioral + unit)
//   - AI-5   auditInsight marks a run incomplete when a tier throws (mock pool)
//   - AI-6   getAuditAccuracy counts only genuinely-audited runs (SQL capture)
//   - PS-1   Per-sistant migrations transactional + fatal (source-pinned)
//   - PS-2   scheduled-email atomic claim (source-pinned)
//
// Mock-pool + supertest pattern mirrors new-endpoints.integration.test.js;
// source-pinned reads mirror audit-regressions.test.js.

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";

const { describe, it, before, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

const { getNetWorth } = require("../teller/services/financial-queries");

let dbModule;
let originalPoolQuery;

before(() => {
  dbModule = require("../teller/services/database");
  originalPoolQuery = dbModule.pool.query;
});

afterEach(() => {
  if (dbModule && originalPoolQuery) dbModule.pool.query = originalPoolQuery;
});

// ---------------------------------------------------------------------------
// F1 — getNetWorth single source of truth
// ---------------------------------------------------------------------------
describe("F1 — getNetWorth", () => {
  // Routes linked_accounts vs investment_accounts queries to the right rowset
  // by inspecting the SQL, and records the investment query for assertions.
  function mockPool(linkedRows, invRows, captured) {
    return {
      query: async (sql) => {
        if (/investment_accounts/i.test(sql)) {
          captured.invSql = sql;
          return { rows: invRows };
        }
        captured.linkedSql = sql;
        return { rows: linkedRows };
      },
    };
  }

  it("dedupes Plaid investment accounts present in both tables (the F1 fix)", async () => {
    const captured = {};
    await getNetWorth(mockPool([], [], captured));
    assert.match(captured.invSql, /NOT EXISTS/i,
      "investment_accounts query must exclude rows already in linked_accounts");
    assert.match(captured.invSql, /plaid_account_id/,
      "dedupe must key on plaid_account_id = linked_accounts.account_id");
  });

  it("includes investments, treats credit as a liability, sums correctly", async () => {
    const linked = [
      { name: "Checking", type: "depository", available_balance: "1000", current_balance: "1000" },
      { name: "Card", type: "credit", available_balance: null, current_balance: "250" },
      { name: "Brokerage (Teller)", type: "investment", available_balance: null, current_balance: "5000" },
    ];
    const inv = [{ name: "Manual IRA", account_type: "ira", balance: "3000" }];
    const nw = await getNetWorth(mockPool(linked, inv, {}));
    // assets = 1000 (checking) + 5000 (teller brokerage) + 3000 (manual IRA)
    assert.equal(nw.total_assets, 9000);
    assert.equal(nw.total_liabilities, 250);
    assert.equal(nw.net_worth, 8750);
    assert.equal(nw.breakdown.investments.length, 1);
    assert.equal(nw.breakdown.accounts.length, 3);
  });

  it("falls back to current_balance when available_balance is null", async () => {
    const nw = await getNetWorth(mockPool(
      [{ name: "Savings", type: "depository", available_balance: null, current_balance: "2000" }],
      [], {}
    ));
    assert.equal(nw.total_assets, 2000);
    assert.equal(nw.net_worth, 2000);
  });
});

// ---------------------------------------------------------------------------
// FA-1 — budget rollover reads the PRIOR month's snapshot
// ---------------------------------------------------------------------------
describe("FA-1 — previousMonthKey (rollover month-keying)", () => {
  const { previousMonthKey } = require("../teller/routes/budgets");

  it("returns the prior month", () => {
    assert.equal(previousMonthKey("2026-06"), "2026-05");
  });
  it("handles the January → prior-year-December boundary", () => {
    assert.equal(previousMonthKey("2026-01"), "2025-12");
  });
});

describe("FA-1 — GET /api/budgets queries the prior month's snapshot", () => {
  it("reads budget_snapshots for the month BEFORE the queried month", async () => {
    const captured = {};
    dbModule.pool.query = async (sql, params) => {
      if (/budget_snapshots/i.test(sql)) {
        captured.snapshotMonth = params && params[0];
        return { rows: [] };
      }
      return { rows: [] }; // budgets list + category-spending → empty
    };
    const app = express();
    app.use(express.json());
    app.use(require("../teller/routes/budgets"));
    await supertest(app).get("/api/budgets?month=2026-06").expect(200);
    assert.equal(captured.snapshotMonth, "2026-05",
      "rollover for June must come from May's snapshot, not June's");
  });
});

// ---------------------------------------------------------------------------
// AI-5 / AI-6 — audit completion marker + honest accuracy denominator
// ---------------------------------------------------------------------------
describe("AI-5 — auditInsight marks a run incomplete when a tier throws", () => {
  const { auditInsight } = require("../teller/services/ai-audit");

  it("sets audit_incomplete=true and stamps the marker when a tier query fails", async () => {
    let marker = null;
    dbModule.pool.query = async (sql, params) => {
      if (/UPDATE financial_insights SET audited_at/i.test(sql)) {
        marker = { sql, params };
        return { rows: [] };
      }
      throw new Error("simulated DB failure"); // every tier query fails
    };
    const res = await auditInsight("Spending $500 on Food is up.", 123);
    assert.equal(res.incomplete, true, "a thrown tier marks the run incomplete");
    assert.ok(marker, "audit must stamp the completion marker on financial_insights");
    assert.equal(marker.params[0], true, "audit_incomplete must be true when a tier failed");
    assert.equal(marker.params[1], 123, "marker must be keyed on the insightId");
  });

  it("sets audit_incomplete=false when all tiers complete", async () => {
    let marker = null;
    dbModule.pool.query = async (sql, params) => {
      if (/UPDATE financial_insights SET audited_at/i.test(sql)) {
        marker = { params };
        return { rows: [] };
      }
      // Tier 1 reads rows[0].cnt off the subscription aggregate — give it a row.
      if (/detected_subscriptions/i.test(sql)) return { rows: [{ cnt: 0, monthly: 0 }] };
      return { rows: [] }; // all other tier queries + log inserts succeed (no data)
    };
    const res = await auditInsight("Nothing notable to report.", 456);
    assert.equal(res.incomplete, false);
    assert.ok(marker, "marker still stamped on a clean run");
    assert.equal(marker.params[0], false, "audit_incomplete=false on a complete run");
  });
});

describe("AI-6 — getAuditAccuracy counts only genuinely-audited runs", () => {
  const aiAudit = require("../teller/services/ai-audit");

  it("filters on audited_at + audit_incomplete and surfaces incomplete_runs", async () => {
    const seen = [];
    dbModule.pool.query = async (sql) => {
      seen.push(sql);
      if (/audited_runs/i.test(sql)) {
        return { rows: [{ total_runs: 2, clean_runs: 2, incomplete_runs: 3 }] };
      }
      return { rows: [] };
    };
    const result = await aiAudit.getAuditAccuracy(90);
    const runsSql = seen.find(s => /audited_runs/i.test(s));
    assert.ok(runsSql, "should run the audited-runs aggregate query");
    assert.match(runsSql, /audited_at IS NOT NULL/i,
      "denominator must require the run was actually audited");
    assert.match(runsSql, /audit_incomplete/i,
      "incomplete (swallowed-tier) runs must be excluded from the denominator");
    assert.match(runsSql, /incomplete_runs/i, "must compute incomplete_runs");
    assert.equal(result.total_audited_runs, 2);
    assert.equal(result.clean_runs, 2);
    assert.equal(result.incomplete_runs, 3, "incomplete_runs surfaced to callers");
    assert.equal(result.accuracy_pct, 100);
  });
});

// ---------------------------------------------------------------------------
// PS-1 / PS-2 — source-pinned (DB/SMTP-bound; guard against reversion)
// ---------------------------------------------------------------------------
describe("PS-1 — Per-sistant migrations transactional + fatal", () => {
  const src = fs.readFileSync(path.join(__dirname, "../apps/per-sistant/db.js"), "utf8");
  it("wraps all migrations in one transaction", () => {
    assert.match(src, /BEGIN/);
    assert.match(src, /COMMIT/);
    assert.match(src, /ROLLBACK/);
  });
  it("rethrows on migration failure so startup fails fast", () => {
    assert.match(src, /throw err/);
  });
});

describe("PS-2 — scheduled email atomic claim", () => {
  const src = fs.readFileSync(path.join(__dirname, "../apps/per-sistant/server.js"), "utf8");
  it("claims due rows with FOR UPDATE SKIP LOCKED before sending", () => {
    assert.match(src, /FOR UPDATE SKIP LOCKED/);
  });
  it("claims via UPDATE ... RETURNING rather than a bare SELECT-then-send", () => {
    assert.match(src, /UPDATE emails SET status = 'sent'[\s\S]*RETURNING/);
  });
});

// ===========================================================================
// Tier 1 + Tier 2 broad-scan fixes
// ===========================================================================

// --- F2: shared INSTITUTION_LABELS + deterministic CSV dedup IDs ----------
describe("F2 — shared INSTITUTION_LABELS + deterministic csv IDs", () => {
  const { INSTITUTION_LABELS, csvTransactionId } = require("../teller/data/csv-formats");

  it("exports the institution label map (shared by CLI and route)", () => {
    assert.equal(INSTITUTION_LABELS.chase, "Chase");
    assert.equal(INSTITUTION_LABELS.capitalone, "Capital One");
    assert.equal(INSTITUTION_LABELS.generic, "CSV Import");
  });

  it("csvTransactionId is deterministic for the same (label,row) so CLI and route dedup", () => {
    const label = INSTITUTION_LABELS.chase + " Account";
    const a = csvTransactionId(label, "2026-01-02", 12.34, "Starbucks");
    const b = csvTransactionId(label, "2026-01-02", 12.34, "Starbucks");
    assert.equal(a, b);
    assert.ok(a.startsWith("csv_"));
    // A different account label is a distinct account → distinct id.
    assert.notEqual(a, csvTransactionId("Other Account", "2026-01-02", 12.34, "Starbucks"));
  });
});

// --- SN-3: sendPerSistantWebhook surfaces decryption_failed ----------------
describe("SN-3 — sendPerSistantWebhook distinguishes failure modes", () => {
  const persistent = require("../teller/routes/persistent");

  it("returns reason 'decryption_failed' when the webhook secret won't decrypt", async () => {
    dbModule.pool.query = async (sql) => {
      if (/has_secret/i.test(sql)) {
        return { rows: [{ persistent_url: "http://x.test", persistent_webhook_enabled: true, has_secret: true }] };
      }
      if (/pgp_sym_decrypt/i.test(sql)) throw new Error("Wrong key or corrupt data");
      return { rows: [] };
    };
    const r = await persistent.sendPerSistantWebhook("test", {});
    assert.equal(r.sent, false);
    assert.equal(r.reason, "decryption_failed");
  });

  it("returns 'not_configured' when persistent_url is unset", async () => {
    dbModule.pool.query = async () => ({ rows: [{ persistent_url: null }] });
    const r = await persistent.sendPerSistantWebhook("test", {});
    assert.equal(r.reason, "not_configured");
  });

  it("returns 'missing_secret' when enabled but no secret stored", async () => {
    dbModule.pool.query = async (sql) => {
      if (/has_secret/i.test(sql)) {
        return { rows: [{ persistent_url: "http://x.test", persistent_webhook_enabled: true, has_secret: false }] };
      }
      return { rows: [] };
    };
    const r = await persistent.sendPerSistantWebhook("test", {});
    assert.equal(r.reason, "missing_secret");
  });
});

// --- Source-pinned: F3, DC-2, AI-7 (DB/AI-bound — guard against reversion) -
describe("F3 / DC-2 / AI-7 — source-pinned", () => {
  const inv = fs.readFileSync(path.join(__dirname, "../teller/routes/investments.js"), "utf8");
  const cat = fs.readFileSync(path.join(__dirname, "../teller/routes/categorize.js"), "utf8");
  const ins = fs.readFileSync(path.join(__dirname, "../teller/routes/insights.js"), "utf8");

  it("F3: syncAllPlaidBalances filters plaid_items to status='GOOD'", () => {
    assert.match(inv, /FROM plaid_items\s+WHERE status = 'GOOD'/);
  });
  it("DC-2: categorize records the usage row BEFORE the apply loop", () => {
    const usageIdx = cat.indexOf("AI returned ${categories.length}");
    const applyIdx = cat.indexOf("Apply AI-assigned categories to the rows");
    assert.ok(usageIdx > 0, "usage-row text present");
    assert.ok(applyIdx > usageIdx, "usage INSERT must precede the apply loop");
  });
  it("AI-7: tax-deduction query groups by COALESCE(user_merchant_name, merchant_name, name)", () => {
    assert.match(ins, /GROUP BY COALESCE\(user_merchant_name, merchant_name, name\)/);
  });
});

// ===========================================================================
// Tier 3 — AI-audit matcher helpers (behavioral)
// ===========================================================================
describe("Tier 3 — wordMatch (AI-2/AI-3)", () => {
  const { wordMatch } = require("../teller/services/ai-audit");
  it("does NOT substring-match short tokens (car != carmax)", () => {
    assert.equal(wordMatch("carmax purchase", "car"), false);
    assert.equal(wordMatch("box office tickets", "office"), true); // whole word
  });
  it("matches whole-word category names", () => {
    assert.equal(wordMatch("food costs were high", "food"), true);
    assert.equal(wordMatch("dining out", "din"), false);
  });
});

describe("Tier 3 — entityKnown (AI-4)", () => {
  const { entityKnown } = require("../teller/services/ai-audit");
  it("a tiny known entity can't wildcard-match every claimed name", () => {
    assert.equal(entityKnown("starbucks", new Set(["car"])), false);
    assert.equal(entityKnown("hallucinomart", new Set(["starbucks", "target"])), false);
  });
  it("matches exact and whole-word containment for substantial tokens", () => {
    assert.equal(entityKnown("ira", new Set(["ira"])), true);             // exact
    assert.equal(entityKnown("netflix", new Set(["netflix.com"])), true); // whole-word
    assert.equal(entityKnown("amazon", new Set(["amazon mktp 1234"])), true);
  });
});

// ===========================================================================
// Tier 4 — behavioral + source-pinned
// ===========================================================================
describe("F6 — schwab/generic CSV parsers use parseMoney", () => {
  const { CSV_FORMATS } = require("../teller/data/csv-formats");
  it("generic parses parenthesized negatives instead of NaN", () => {
    const r = CSV_FORMATS.generic.parse({ Date: "2026-01-02", Description: "X", Amount: "(45.00)" });
    assert.equal(r.amount, -45);
  });
  it("schwab handles $ + thousands separators on a withdrawal", () => {
    const r = CSV_FORMATS.schwab.parse({ Date: "2026-01-02", Description: "Y", Withdrawal: "$1,234.56", Deposit: "", Amount: "" });
    assert.equal(r.amount, 1234.56);
  });
});

describe("SN-5 — sanitizeBoolMap", () => {
  const { sanitizeBoolMap } = require("../teller/routes/settings");
  it("rejects arrays and non-objects", () => {
    assert.equal(sanitizeBoolMap([1, 2, 3]), null);
    assert.equal(sanitizeBoolMap("nope"), null);
    assert.equal(sanitizeBoolMap(null), null);
  });
  it("coerces values to booleans and drops over-long keys", () => {
    const out = sanitizeBoolMap({ pyramid: 1, accounts: 0, nested: { x: 1 } });
    assert.equal(out.pyramid, true);
    assert.equal(out.accounts, false);
    assert.equal(out.nested, true); // !!{} — coerced, not stored verbatim
    assert.equal(sanitizeBoolMap({ ["k".repeat(80)]: true })["k".repeat(80)], undefined);
  });
});

describe("FA-4 — getMonthlySpending uses a whole-month window", () => {
  const { getMonthlySpending, getMonthlyIncome } = require("../teller/services/financial-queries");
  it("spending SQL floors to the 1st via date_trunc('month', ...)", async () => {
    let sql = "";
    await getMonthlySpending({ query: async (s) => { sql = s; return { rows: [] }; } }, 6);
    assert.match(sql, /date_trunc\('month', CURRENT_DATE\)/);
    assert.match(sql, /make_interval\(months => \$1 - 1\)/);
  });
  it("income SQL floors to the 1st too", async () => {
    let sql = "";
    await getMonthlyIncome({ query: async (s) => { sql = s; return { rows: [] }; } }, 3);
    assert.match(sql, /date_trunc\('month', CURRENT_DATE\)/);
  });
});

describe("Tier 4 — source-pinned (DC-1/DC-5/DC-7/F7)", () => {
  const enr = fs.readFileSync(path.join(__dirname, "../teller/routes/enrollments.js"), "utf8");
  const cat = fs.readFileSync(path.join(__dirname, "../teller/routes/categorize.js"), "utf8");
  const subs = fs.readFileSync(path.join(__dirname, "../teller/routes/subscriptions.js"), "utf8");

  it("DC-1: leftover uncategorized count excludes user_category-set rows", () => {
    assert.match(cat, /WHERE user_category IS NULL/);
  });
  it("DC-5: manual-sub re-add clears is_dismissed", () => {
    assert.match(subs, /is_active = true,\s*\n\s*is_dismissed = false/);
  });
  it("DC-7: recurring-transfer monthly_equivalent guards divide-by-zero", () => {
    assert.match(subs, /30\.0 \/ NULLIF\(rt\.cadence_days, 0\)/);
  });
  it("F7: anomaly candidate window is 7 days", () => {
    assert.match(enr, /t\.date >= CURRENT_DATE - INTERVAL '7 days'/);
  });
});

// ===========================================================================
// Addition D — structured sync-result surfaced in Sync Health
// ===========================================================================
describe("Addition D — recordSyncResult + data-health surfacing", () => {
  const enr = require("../teller/routes/enrollments");

  it("recordSyncResult flattens per-provider errors and persists them", async () => {
    let written = null;
    dbModule.pool.query = async (sql, params) => {
      if (/last_sync_result/.test(sql)) written = JSON.parse(params[0]);
      return { rows: [] };
    };
    const out = await enr.recordSyncResult([
      { provider: "teller_txn", result: { errors: [{ institution: "Chase", error: "decryption_failed" }] } },
      { provider: "plaid_balance", result: { accounts_updated: 3 } }, // no errors
    ]);
    assert.equal(out.errors.length, 1);
    assert.equal(out.errors[0].provider, "teller_txn");
    assert.equal(out.errors[0].error, "decryption_failed");
    assert.ok(written, "must persist to last_sync_result");
  });

  it("data-health surfaces a persisted decryption_failed as an issue", async () => {
    dbModule.pool.query = async (sql) => {
      if (/FROM user_settings/.test(sql)) {
        return { rows: [{ last_sync_result: { at: new Date().toISOString(), errors: [{ provider: "plaid_txn", institution: "Schwab", error: "decryption_failed" }] } }] };
      }
      if (/teller_enrollments/.test(sql)) return { rows: [{ total: 1, disconnected: 0 }] };
      if (/plaid_items/.test(sql)) return { rows: [{ total: 1, not_good: 0 }] };
      return { rows: [] }; // notification_log
    };
    const app = express();
    app.use(express.json());
    app.use(require("../teller/routes/settings"));
    const res = await supertest(app).get("/api/data-health").expect(200);
    const msg = res.body.issues.map(i => i.message).join(" | ");
    assert.match(msg, /Schwab: decryption_failed/);
    assert.ok(res.body.last_sync_result, "response includes last_sync_result");
    assert.equal(res.body.ok, false, "a sync error makes the surface not-ok");
  });
});

describe("FA-3 — credit-score 6-month delta picks the entry closest to 180 days", () => {
  it("chooses the ~180-day entry, not the first >=150-day one", async () => {
    const day = (n) => new Date(Date.now() - n * 86400000).toISOString().split("T")[0];
    const rows = [
      { id: 5, score: 700, checked_at: day(0),   score_type: "fico" }, // latest
      { id: 4, score: 695, checked_at: day(30),  score_type: "fico" }, // prior
      { id: 3, score: 680, checked_at: day(150), score_type: "fico" }, // old code picked this
      { id: 2, score: 670, checked_at: day(180), score_type: "fico" }, // FA-3 should pick this
      { id: 1, score: 660, checked_at: day(210), score_type: "fico" },
    ];
    dbModule.pool.query = async () => ({ rows });
    const app = express();
    app.use(express.json());
    app.use(require("../teller/routes/credit-scores"));
    const res = await supertest(app).get("/api/credit-scores").expect(200);
    assert.equal(res.body.trend.delta_vs_prior, 5);          // 700 - 695
    assert.equal(res.body.trend.six_month_ago, 670);         // the ~180d entry
    assert.equal(res.body.trend.delta_vs_6mo, 30);           // 700 - 670
  });
});

// ===========================================================================
// Plaid sync bugfixes — Discover credit-limit/APR + Schwab investment $0
// ===========================================================================
describe("Plaid: Schwab investment $0 — holdings-sum fallback on a reported 0", () => {
  const inv = fs.readFileSync(path.join(__dirname, "../teller/routes/investments.js"), "utf8");
  const { sumHoldingsByAccount } = require("../teller/routes/investments");

  it("sumHoldingsByAccount totals institution_value (and close_price fallback) per account", () => {
    const holdings = [
      { account_id: "A", security_id: "s1", quantity: 10, institution_value: 1500 },
      { account_id: "A", security_id: "s2", quantity: 5, institution_value: null }, // falls back to qty*close_price
      { account_id: "B", security_id: "s1", quantity: 1, institution_value: 99 },
    ];
    const secMap = { s1: { close_price: 100 }, s2: { close_price: 20 } };
    const m = sumHoldingsByAccount(holdings, secMap);
    assert.equal(m.A, 1500 + (5 * 20)); // 1600
    assert.equal(m.B, 99);
  });

  it("holdings balance uses `|| acctValue` so a reported 0 falls through (not ??)", () => {
    // Both holdings-balance sites must use || (else a Schwab balances.current===0
    // skips the holdings-sum fallback and persists $0).
    assert.match(inv, /balances\?\.current \|\| acctValue\[acct\.account_id\] \|\| 0/);
    assert.doesNotMatch(inv, /balances\?\.current \?\? acctValue/);
  });
});

describe("Plaid: Discover credit-limit sourced from the liabilities accounts", () => {
  const inv = fs.readFileSync(path.join(__dirname, "../teller/routes/investments.js"), "utf8");
  it("syncPlaidLiabilities reads balances.limit from libRes.data.accounts", () => {
    assert.match(inv, /for \(const acct of \(libRes\.data\.accounts \|\| \[\]\)\)/);
    assert.match(inv, /const lim = acct\.balances\?\.limit/);
  });
  it("no longer reads the non-existent cc.credit_limit field", () => {
    assert.doesNotMatch(inv, /cc\.credit_limit/);
  });
});

describe("Dashboard: credit utilization doesn't show a false 100% when limit unknown", () => {
  const ejs = fs.readFileSync(path.join(__dirname, "../teller/views/dashboard.ejs"), "utf8");
  it("only derives the limit from owed+avail when avail > 0, else shows it as unreported", () => {
    assert.match(ejs, /avail > 0 \? owed \+ avail : null/);
    assert.match(ejs, /credit limit not reported by bank/);
  });
});

// ===========================================================================
// Plaid sync bugfixes (round 2) — Schwab holdings never synced + error visibility
// ===========================================================================
describe("Plaid: holdings sync covers unregistered investment items (Schwab brokerage)", () => {
  const inv = fs.readFileSync(path.join(__dirname, "../teller/routes/investments.js"), "utf8");
  it("syncAllPlaidHoldings UNIONs plaid_items having an investment-type linked_account", () => {
    // The dedicated plaid_investment_items registry misses brokerages Plaid
    // didn't surface as investment accounts at link time, so their holdings
    // never sync and the account persists at $0. The items query must also pull
    // status='GOOD' plaid_items that have an INVESTMENT_ACCOUNT_TYPES account.
    assert.match(inv, /FROM plaid_investment_items\s+UNION ALL/);
    assert.match(inv, /FROM plaid_items pi\s+WHERE pi\.status = 'GOOD' AND EXISTS/);
    assert.match(inv, /\$\{INVESTMENT_ACCOUNT_TYPES\}/);
    assert.match(inv, /SELECT DISTINCT ON \(item_id\)/);
  });
});

describe("Plaid: balance sync surfaces a genuine liabilities failure", () => {
  const inv = fs.readFileSync(path.join(__dirname, "../teller/routes/investments.js"), "utf8");
  it("pushes a 'liabilities:' error when syncPlaidLiabilities returns .error (not the not_supported skip)", () => {
    // A card whose APR/limit won't load (e.g. an item that needs a Liabilities
    // re-auth) must show up in errors[] instead of being swallowed.
    assert.match(inv, /if \(lib && lib\.error\)/);
    assert.match(inv, /"liabilities: " \+ \(lib\.error_code \|\| lib\.error\)/);
  });
  it("surfaces an actionable re-link hint for a credit card whose item lacks Liabilities", () => {
    // not_supported is only actionable when the item actually has a credit
    // account (Discover) — brokerage/depository-only items stay quiet.
    assert.match(inv, /const hasCreditAccount = \(balRes\.data\.accounts \|\| \[\]\)\.some\(a => a\.type === "credit"\)/);
    assert.match(inv, /lib\.skipped === "not_supported" && hasCreditAccount/);
    assert.match(inv, /re-link this card to enable Plaid Liabilities/);
  });
});

describe("Dashboard: investment cards expose a Remove control for non-Teller rows", () => {
  const ejs = fs.readFileSync(path.join(__dirname, "../teller/views/dashboard.ejs"), "utf8");
  it("renders a remove button only for plaid/manual rows and wires it via addEventListener (CSP-safe)", () => {
    assert.match(ejs, /a\.source === 'teller'\s*\?\s*''/);
    assert.match(ejs, /class="inv-remove"/);
    assert.match(ejs, /querySelectorAll\('\.inv-remove'\)/);
    assert.match(ejs, /\/api\/investment-accounts\/' \+ id, \{ method: 'DELETE' \}/);
  });
});

describe("sync-balances response + dashboard toast expose Plaid + holdings results", () => {
  const enr = fs.readFileSync(path.join(__dirname, "../teller/routes/enrollments.js"), "utf8");
  const ejs = fs.readFileSync(path.join(__dirname, "../teller/views/dashboard.ejs"), "utf8");
  it("/api/sync-balances returns holdings_accounts_updated + holdings_errors", () => {
    assert.match(enr, /holdings_accounts_updated: holdingsResult\?\.accounts_updated/);
    assert.match(enr, /holdings_errors: holdingsResult\?\.errors\?\.length/);
  });
  it("dashboard toast reports Teller/Plaid/investment counts and concatenates both error arrays", () => {
    assert.match(ejs, /Teller, '.*Plaid, '.*investment account/);
    assert.match(ejs, /\[\]\.concat\(data\.plaid_errors \|\| \[\], data\.holdings_errors \|\| \[\]\)/);
  });
});

// ===========================================================================
// Categorize efficiency — free paths sweep the whole backlog, only AI bounded
// ===========================================================================
describe("Categorize: free rule + Teller-map sweep is unbounded; only AI is capped", () => {
  const cat = fs.readFileSync(path.join(__dirname, "../teller/routes/categorize.js"), "utf8");
  it("applies rules in bulk via UPDATE ... RETURNING over the uncategorized predicate", () => {
    assert.match(cat, /FREE PATH 1 — user-defined rules, bulk-applied/);
    assert.match(cat, /UPDATE transactions SET user_category = \$3\s*\n\s*WHERE \$\{uncatPredicate\} AND \$\{cond\}/);
  });
  it("applies the Teller/Plaid category map in bulk (one UPDATE per source category)", () => {
    assert.match(cat, /for \(const \[tellerCat, ourCat\] of Object\.entries\(TELLER_CATEGORY_MAP\)\)/);
    assert.match(cat, /WHERE \$\{uncatPredicate\} AND LOWER\(category\[1\]\) = \$2/);
  });
  it("bounds ONLY the paid AI batch with AI_BATCH (not the whole sweep)", () => {
    assert.match(cat, /const AI_BATCH = \d+;/);
    assert.match(cat, /LIMIT \$\{AI_BATCH\}/);
    // The old whole-batch LIMIT 50 SELECT must be gone.
    assert.doesNotMatch(cat, /ORDER BY date DESC\s*\n\s*LIMIT 50/);
  });
});

describe("Auto-sync runs a categorization sweep after syncing", () => {
  const startup = fs.readFileSync(path.join(__dirname, "../teller/startup.js"), "utf8");
  it("the bank auto-sync chain invokes runCategorize in-process", () => {
    assert.match(startup, /Auto-categorize freshly-synced transactions/);
    assert.match(startup, /const \{ runCategorize \} = require\("\.\/routes\/categorize"\)/);
    assert.match(startup, /const catRes = await runCategorize\(\)/);
  });
});
