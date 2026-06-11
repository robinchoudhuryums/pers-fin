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
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

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
  // Routes linked_accounts vs investment_accounts queries to the right rowset.
  // The linked query references investment_accounts in a NOT EXISTS subquery, so
  // route on "FROM linked_accounts" (only the linked query has it); everything
  // else is the investment query. Records both for assertions.
  function mockPool(linkedRows, invRows, captured) {
    return {
      query: async (sql) => {
        if (/FROM linked_accounts/i.test(sql)) {
          captured.linkedSql = sql;
          return { rows: linkedRows };
        }
        captured.invSql = sql;
        return { rows: invRows };
      },
    };
  }

  it("dedupes by dropping the linked_accounts phantom, keeping investment_accounts (H1)", async () => {
    const captured = {};
    await getNetWorth(mockPool([], [], captured));
    // H1: the dedup must live on the LINKED query (drop the $0 Plaid phantom
    // when an active investment_accounts row exists), NOT on the investment
    // query (which would drop the real holdings-sum value and zero out the
    // brokerage). investment_accounts is authoritative for Plaid brokerages —
    // matching GET /api/investments + the dashboard accounts grid.
    assert.match(captured.linkedSql, /NOT EXISTS/i,
      "linked_accounts query must drop rows that have an investment_accounts row");
    assert.match(captured.linkedSql, /plaid_account_id\s*=\s*la\.account_id/i,
      "dedupe must key on investment_accounts.plaid_account_id = linked_accounts.account_id");
    assert.doesNotMatch(captured.invSql, /NOT EXISTS/i,
      "investment_accounts is authoritative — it must NOT be filtered against linked_accounts");
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
    const usageIdx = cat.indexOf("AI returned ${catCount}");
    const applyIdx = cat.indexOf("for (const cat of toolBlock.input.categories)");
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
    assert.match(cat, /UPDATE transactions SET user_category = \$3, user_category_source = 'rule',[\s\S]*?WHERE \$\{uncatPredicate\} AND \$\{cond\}/);
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

// ===========================================================================
// In-process digest delivery (unified shell) — no webhook config required
// ===========================================================================
describe("Per-sistant digest: embedded delivery writes directly to the emails table", () => {
  const persistent = require("../teller/routes/persistent");

  it("sendPerSistantWebhook inserts a scheduled email via the wired pool (no HTTP)", async () => {
    const queries = [];
    const mockPersistentPool = {
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (/perfin_webhook_recipient/.test(sql)) {
          return { rows: [{ perfin_webhook_recipient: "me@example.com" }] };
        }
        return { rows: [] };
      },
    };
    persistent.setEmbeddedPersistentPool(mockPersistentPool);
    try {
      const res = await persistent.sendPerSistantWebhook("weekly_summary", {
        subject: "Weekly", html_body: "<b>hi</b>", plain_text: "hi",
      });
      assert.equal(res.sent, true);
      assert.equal(res.delivery, "in_process");
      assert.equal(res.stored, "scheduled");
      assert.equal(res.recipient, "me@example.com");
      const insert = queries.find(q => /INSERT INTO emails/.test(q.sql) && /scheduled/.test(q.sql));
      assert.ok(insert, "must insert a scheduled email row");
      assert.equal(insert.params[1], "me@example.com");
    } finally {
      persistent.setEmbeddedPersistentPool(null); // don't leak into other tests
    }
  });

  it("falls back to a draft when no recipient is configured", async () => {
    const origFrom = process.env.SMTP_FROM, origUser = process.env.SMTP_USER;
    delete process.env.SMTP_FROM; delete process.env.SMTP_USER;
    const queries = [];
    persistent.setEmbeddedPersistentPool({
      query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; },
    });
    try {
      const res = await persistent.sendPerSistantWebhook("daily_summary", { subject: "D", plain_text: "x" });
      assert.equal(res.stored, "draft");
      assert.ok(queries.find(q => /INSERT INTO emails/.test(q.sql) && /'draft'/.test(q.sql)));
    } finally {
      persistent.setEmbeddedPersistentPool(null);
      if (origFrom) process.env.SMTP_FROM = origFrom;
      if (origUser) process.env.SMTP_USER = origUser;
    }
  });
});

// ===========================================================================
// Background reconcile — opt-in async run + status endpoint
// ===========================================================================
describe("Reconcile: background mode is opt-in; synchronous stays the default", () => {
  it("background:true returns 202 {started} and exposes a status endpoint", async () => {
    dbModule.pool.query = async () => ({ rows: [] });
    const app = express();
    app.use(express.json());
    app.use(require("../teller/routes/enrollments"));
    const res = await supertest(app)
      .post("/api/sync/reconcile")
      .send({ provider: "teller", background: true });
    assert.equal(res.status, 202);
    assert.equal(res.body.started, true);
    assert.equal(res.body.provider, "teller");
    const st = await supertest(app).get("/api/sync/reconcile/status").expect(200);
    assert.ok("running" in st.body, "status endpoint reports a running flag");
    assert.equal(st.body.provider, "teller");
  });

  it("without background flag it still returns the inline per-provider result", async () => {
    dbModule.pool.query = async () => ({ rows: [] });
    const app = express();
    app.use(express.json());
    app.use(require("../teller/routes/enrollments"));
    const res = await supertest(app).post("/api/sync/reconcile").send({ provider: "teller" });
    assert.equal(res.status, 200);
    assert.ok(res.body.teller, "synchronous path returns the teller summary inline");
  });

  it("source: background is opt-in (req.body.background === true)", () => {
    const src = fs.readFileSync(path.join(__dirname, "../teller/routes/enrollments.js"), "utf8");
    assert.match(src, /if \(req\.body\.background === true\)/);
    assert.match(src, /GET \/api\/sync\/reconcile\/status/);
  });
});

// ===========================================================================
// ML Categorization accuracy sampler
// ===========================================================================
describe("Categorize accuracy: provenance stamping + sampler endpoints", () => {
  const cat = fs.readFileSync(path.join(__dirname, "../teller/routes/categorize.js"), "utf8");

  it("AI/rule/teller-map writes stamp user_category_source", () => {
    assert.match(cat, /user_category_source = 'ai'/);
    assert.match(cat, /user_category_source = 'rule'/);
    assert.match(cat, /user_category_source = 'teller_map'/);
  });

  it("GET /api/categorize/accuracy computes a % over verified AI rows", async () => {
    dbModule.pool.query = async () => ({ rows: [{ ai_total: "10", verified: "4", correct: "3" }] });
    const app = express();
    app.use(express.json());
    app.use(require("../teller/routes/categorize"));
    const res = await supertest(app).get("/api/categorize/accuracy").expect(200);
    assert.equal(res.body.ai_total, 10);
    assert.equal(res.body.verified, 4);
    assert.equal(res.body.correct, 3);
    assert.equal(res.body.unverified, 6);
    assert.equal(res.body.accuracy_pct, 75); // 3/4
  });

  it("accuracy-review requires a corrected_category when marking wrong", async () => {
    dbModule.pool.query = async () => ({ rows: [] });
    const app = express();
    app.use(express.json());
    app.use(require("../teller/routes/categorize"));
    await supertest(app)
      .post("/api/categorize/accuracy-review")
      .send({ transaction_id: "t1", correct: false })
      .expect(400);
  });

  it("accuracy-review marks a row correct and stamps the verdict", async () => {
    const seen = [];
    dbModule.pool.query = async (sql, params) => {
      seen.push({ sql, params });
      if (/UPDATE transactions/.test(sql)) return { rows: [{ merchant: "Starbucks" }] };
      return { rows: [] };
    };
    const app = express();
    app.use(express.json());
    app.use(require("../teller/routes/categorize"));
    const res = await supertest(app)
      .post("/api/categorize/accuracy-review")
      .send({ transaction_id: "t1", correct: true })
      .expect(200);
    assert.equal(res.body.ok, true);
    const upd = seen.find(q => /category_was_correct = true/.test(q.sql) && /user_category_source = 'ai'/.test(q.sql));
    assert.ok(upd, "correct verdict updates only AI-sourced rows and records was_correct=true");
  });
});

// ===========================================================================
// UX round: login→dashboard, categorize loop + progress, account dedupe
// ===========================================================================
describe("Root path redirects to the dashboard (login no longer lands on Accounts)", () => {
  const acct = fs.readFileSync(path.join(__dirname, "../teller/pages/accounts.js"), "utf8");
  it("serves Accounts at /accounts and redirects / to /dashboard (basePath-aware)", () => {
    assert.match(acct, /router\.get\("\/accounts", renderAccounts\)/);
    assert.match(acct, /router\.get\("\/", \(req, res\) => res\.redirect\(\(req\.baseUrl \|\| ""\) \+ "\/dashboard"\)\)/);
  });

  it("behaviorally redirects / → <baseUrl>/dashboard", async () => {
    const app = express();
    app.use(require("../teller/pages/accounts")({ TELLER_APP_ID: "x", TELLER_ENV: "sandbox" }));
    const res = await supertest(app).get("/").expect(302);
    assert.equal(res.headers.location, "/dashboard");
  });
});

describe("Categorize: AI step loops up to a per-run cap + exposes live progress", () => {
  const cat = fs.readFileSync(path.join(__dirname, "../teller/routes/categorize.js"), "utf8");
  it("loops batches with a re-checked budget gate, bounded by AI_MAX_PER_RUN", () => {
    assert.match(cat, /const AI_MAX_PER_RUN = \d+;/);
    assert.match(cat, /while \(aiProcessed < AI_MAX_PER_RUN\)/);
    assert.match(cat, /if \(\(await monthSpendCents\(\)\) >= budgetCents\) \{ budgetHit = true; break; \}/);
  });
  it("GET /api/categorize/progress reports the live tracker", async () => {
    dbModule.pool.query = async () => ({ rows: [] });
    const app = express();
    app.use(express.json());
    app.use(require("../teller/routes/categorize"));
    const res = await supertest(app).get("/api/categorize/progress").expect(200);
    assert.ok("running" in res.body && "by_ai" in res.body);
  });
});

describe("Dashboard dedupes the Plaid brokerage twin from the accounts grid", () => {
  const ejs = fs.readFileSync(path.join(__dirname, "../teller/views/dashboard.ejs"), "utf8");
  it("filters linked_accounts rows whose account_id matches an investment plaid_account_id", () => {
    assert.match(ejs, /invPlaidIds = new Set\(investments\.filter/);
    assert.match(ejs, /accounts = accounts\.filter\(function\(a\)\{ return !\(a\.account_id && invPlaidIds\.has\(String\(a\.account_id\)\)\); \}\)/);
  });
  it("offers a manual credit-limit input wired to PATCH /:id/balance", () => {
    assert.match(ejs, /data-limit-account/);
    assert.match(ejs, /\/balance', \{\s*method: 'PATCH'[\s\S]*credit_limit: lim/);
  });
});

// ===========================================================================
// Mobile UX round — number formatting, hamburger+bottom-nav, tables→cards
// ===========================================================================
describe("Mobile UX: number formatting", () => {
  const sharedJs = fs.readFileSync(path.join(__dirname, "../teller/public/perfin-shared.js"), "utf8");
  const sharedCss = fs.readFileSync(path.join(__dirname, "../teller/public/perfin-shared.css"), "utf8");
  it("fmt() uses thousands separators (toLocaleString), not bare toFixed", () => {
    assert.match(sharedJs, /function fmt\(n\) \{ return '\$' \+ parseFloat\(n \|\| 0\)\.toLocaleString\('en-US'/);
  });
  it("stat-card .value font is responsive (clamp + overflow-wrap)", () => {
    assert.match(sharedCss, /\.card \.value \{ font-size: clamp\([^)]*\);[\s\S]*overflow-wrap: anywhere/);
  });
});

describe("Mobile UX: hamburger drawer + bottom tab bar", () => {
  const navTpl = fs.readFileSync(path.join(__dirname, "../teller/views/partials/nav.ejs"), "utf8");
  const sharedCss = fs.readFileSync(path.join(__dirname, "../teller/public/perfin-shared.css"), "utf8");
  it("nav markup has the hamburger button + bottom-nav tabs", () => {
    assert.match(navTpl, /id="nav-hamburger"/);
    assert.match(navTpl, /class="bottom-nav"/);
    assert.match(navTpl, /class="bottom-nav-item/);
  });
  it("nav renders with an active bottom tab and a hamburger", () => {
    const ejs = require("ejs");
    const html = ejs.render(navTpl, { basePath: "/perfin", embedded: false, activePage: "transactions", nonce: "n" });
    assert.ok(html.includes("nav-hamburger"));
    assert.ok(/bottom-nav-item active/.test(html), "active page marks its bottom tab");
  });
  it("CSS hides the mobile controls on desktop and shows them ≤640px", () => {
    assert.match(sharedCss, /\.nav-hamburger \{ display: none;/);
    assert.match(sharedCss, /\.bottom-nav \{ display: none; \}/);
    assert.match(sharedCss, /\.bottom-nav \{ display: flex; position: fixed/);
  });
});

describe("Mobile UX: tables reflow to cards (responsive-cards)", () => {
  const sharedCss = fs.readFileSync(path.join(__dirname, "../teller/public/perfin-shared.css"), "utf8");
  const subs = fs.readFileSync(path.join(__dirname, "../teller/views/subscriptions.ejs"), "utf8");
  const txnTpl = fs.readFileSync(path.join(__dirname, "../teller/views/transactions.ejs"), "utf8");
  const txnJs = fs.readFileSync(path.join(__dirname, "../teller/public/transactions.js"), "utf8");
  it("shared CSS defines the responsive-cards pattern", () => {
    assert.match(sharedCss, /table\.responsive-cards thead \{ position: absolute/);
    assert.match(sharedCss, /td::before \{ content: attr\(data-label\)/);
    assert.match(sharedCss, /td\.cell-actions .* min-height: 40px|min-height: 40px/);
  });
  it("subscriptions table opts in and labels its cells", () => {
    assert.match(subs, /<table class="responsive-cards">/);
    assert.match(subs, /class="cell-primary"/);
    assert.match(subs, /class="cell-actions"/);
    assert.match(subs, /data-label="Amount"/);
  });
  it("transactions table uses the compact mobile layout and labels its cells", () => {
    // Switched from generic responsive-cards to the dense txn-compact grid
    // (UI polish round 2) — data-labels still drive the CSS grid areas.
    assert.match(txnTpl, /class="txn-table txn-compact"/);
    assert.match(txnJs, /class="cell-primary"/);
    assert.match(txnJs, /class="row-actions cell-actions"/);
    assert.match(txnJs, /data-label="Amount"/);
  });
  it("all four dashboard mini-tables opt in and label their cells", () => {
    const dash = fs.readFileSync(path.join(__dirname, "../teller/views/dashboard.ejs"), "utf8");
    // 4 tables: monthly, category, merchants, upcoming. (Recent Transactions
    // moved to the Activity page — UI polish round 2.)
    assert.equal((dash.match(/responsive-cards/g) || []).length, 4);
    assert.match(dash, /data-label="Total"/);
    assert.match(dash, /data-label="Share"/);
    assert.match(dash, /data-label="Next"/);
    assert.match(dash, /class="cell-primary"/);
  });
  it("empty-msg cells render full-width in card mode", () => {
    assert.match(sharedCss, /td\.empty-msg \{ display: block; text-align: center;/);
  });
});

// ===========================================================================
// Bank Sync & Ingestion audit — BS-1..BS-8 (broad-implement)
// Behavioral where the unit is a pure function (csv parsers); source-pinned
// for the route-level sync logic (mirrors the "Source-pinned regression tests"
// design decision — avoids standing up a live Plaid client / DB).
// ===========================================================================
describe("BS-2 — Schwab Amount+Type variant preserves sign (no Math.abs)", () => {
  const { CSV_FORMATS } = require("../teller/data/csv-formats");
  it("imports a signed-negative Amount (withdrawal) as a positive debit", () => {
    const row = { "Date": "03/10/2026", "Type": "ACH", "Description": "ELECTRIC CO", "Amount": "-50.00" };
    assert.equal(CSV_FORMATS.schwab.parse(row).amount, 50);
  });
  it("imports a signed-positive Amount (deposit) as a negative credit, not a debit", () => {
    const row = { "Date": "03/11/2026", "Type": "ACH", "Description": "PAYROLL", "Amount": "1200.00" };
    assert.equal(CSV_FORMATS.schwab.parse(row).amount, -1200);
  });
  it("still prefers Withdrawal/Deposit columns when present", () => {
    const row = { "Date": "03/12/2026", "Type": "VISA", "Description": "STORE", "Withdrawal": "42.99", "Deposit": "" };
    assert.equal(CSV_FORMATS.schwab.parse(row).amount, 42.99);
  });
});

describe("BS-3 — Wells Fargo detection no longer matches any 5-column CSV", () => {
  const { detectCsvFormat } = require("../teller/data/csv-formats");
  it("detects a genuine WF headerless row (date + money in first two fields)", () => {
    assert.equal(detectCsvFormat(["01/15/2025", "-50.00", "*", "*", "COFFEE SHOP"]), "wellsfargo");
  });
  it("does NOT misclassify an unrelated 5-column CSV as Wells Fargo", () => {
    assert.equal(detectCsvFormat(["Account", "Type", "Memo", "Ref", "Note"]), "generic");
  });
});

describe("BS-1 — Teller pagination is page-size-independent", () => {
  const src = fs.readFileSync(path.join(__dirname, "../teller/routes/enrollments.js"), "utf8");
  it("requests an explicit count and pages via from_id", () => {
    assert.match(src, /transactions\?count=\$\{PAGE\}/);
    assert.match(src, /from_id=\$\{oldestInBatch\.id\}/);
  });
  it("no longer stops on the hard-coded `txns.length < 500` page-size assumption", () => {
    // Target the code construct, not the explanatory comment that names the old bug.
    assert.doesNotMatch(src, /else if \(txns\.length < 500\)/);
    assert.match(src, /while \(pages < MAX_PAGES\)/);
  });
});

describe("BS-4 / INV-01 — sync 'added' counts only genuine inserts (xmax=0)", () => {
  const enroll = fs.readFileSync(path.join(__dirname, "../teller/routes/enrollments.js"), "utf8");
  const inv = fs.readFileSync(path.join(__dirname, "../teller/routes/investments.js"), "utf8");
  it("Teller upsert returns (xmax = 0) and increments only on a real insert", () => {
    assert.match(enroll, /RETURNING \(xmax = 0\) AS inserted/);
    assert.match(enroll, /if \(result\.rows\[0\]\?\.inserted\)/);
    assert.doesNotMatch(enroll, /if \(result\.rowCount > 0\) added\+\+/);
  });
  it("Plaid upsert returns (xmax = 0) and increments only on a real insert", () => {
    assert.match(inv, /RETURNING \(xmax = 0\) AS inserted/);
    assert.match(inv, /if \(r\.rows\[0\]\?\.inserted\) totalAdded\+\+/);
  });
});

describe("BS-4 / INV-04 — Plaid cursor advances only after a clean page", () => {
  const inv = fs.readFileSync(path.join(__dirname, "../teller/routes/investments.js"), "utf8");
  it("halts on a page row-failure before advancing the cursor", () => {
    // The pageFailed break must appear before `cursor = data.next_cursor`.
    const failIdx = inv.indexOf("if (pageFailed)");
    const advIdx = inv.indexOf("cursor = data.next_cursor");
    assert.ok(failIdx > 0 && advIdx > 0 && failIdx < advIdx,
      "pageFailed halt must precede the cursor advance");
  });
  it("persists the cursor progressively inside the page loop", () => {
    assert.match(inv, /UPDATE sync_cursors SET cursor = \$1, last_synced_at = now\(\)/);
  });
});

describe("BS-5/6/7/8 — sync-helper correctness (source-pinned)", () => {
  const enroll = fs.readFileSync(path.join(__dirname, "../teller/routes/enrollments.js"), "utf8");
  const inv = fs.readFileSync(path.join(__dirname, "../teller/routes/investments.js"), "utf8");
  it("BS-5: items_synced counts failed items, not the (nag-inflated) errors array", () => {
    assert.match(inv, /items_synced: items\.rows\.length - itemsFailed/);
  });
  it("BS-6: a wholesale Plaid throw is recorded in last_sync_result", () => {
    assert.match(enroll, /plaidThrew/);
    assert.match(enroll, /plaidThrew \? \[\{ provider: "plaid", result: \{ errors:/);
  });
  it("BS-7: monthly income projection clamps the pay-day to the month length", () => {
    // cash-flow moved to routes/spending-analytics.js in the route-file split
    const analytics = fs.readFileSync(path.join(__dirname, "../teller/routes/spending-analytics.js"), "utf8");
    assert.match(analytics, /const payDay = Math\.min\(inc\.typical_day, daysInMonth\)/);
  });
  it("BS-8: holdings sync skips items lacking the Investments product", () => {
    assert.match(inv, /PRODUCTS_NOT_SUPPORTED" \|\| code === "PRODUCT_NOT_READY"\) continue/);
  });
});

// ===========================================================================
// Financial Analytics audit — A1/F1 (loan liability) + A5/F5 (goal funding)
// ===========================================================================
describe("F1 — getNetWorth classifies loans as liabilities", () => {
  function mockPool(linkedRows, invRows) {
    return {
      query: async (sql) => {
        // The linked query references investment_accounts in a NOT EXISTS
        // subquery (H1 dedup), so route on "FROM linked_accounts" (only the
        // linked query has it); everything else is the investment query.
        if (/FROM linked_accounts/i.test(sql)) return { rows: linkedRows };
        return { rows: invRows };
      },
    };
  }
  it("a loan account's balance is a liability, not an asset", async () => {
    const linked = [
      { name: "Checking", type: "depository", available_balance: "2000", current_balance: "2000" },
      { name: "Mortgage", type: "loan", available_balance: null, current_balance: "300000" },
      { name: "Card", type: "credit", available_balance: null, current_balance: "500" },
    ];
    const nw = await getNetWorth(mockPool(linked, []));
    assert.equal(nw.total_assets, 2000, "only the checking account is an asset");
    assert.equal(nw.total_liabilities, 300500, "mortgage + card");
    assert.equal(nw.net_worth, 2000 - 300500);
    const mortgage = nw.breakdown.accounts.find(a => a.type === "loan");
    assert.equal(mortgage.amount, -300000, "loan shows as a negative line in the breakdown");
  });
});

describe("INV-11 / F5 — goal current_amount derived from funding account", () => {
  function goalsApp() {
    const app = express();
    app.use(express.json());
    app.use(require("../teller/routes/goals"));
    return app;
  }
  it("derives current = max(0, balance − baseline) and marks the goal linked", async () => {
    dbModule.pool.query = async (sql) => {
      if (/recurring_transfers/i.test(sql)) return { rows: [] };
      return { rows: [{
        id: 1, name: "House", type: "savings", target_amount: "4000", current_amount: "3000",
        monthly_contribution: "0", interest_rate: "0", target_date: null,
        funding_account_id: 9, funding_account_balance: "5500", funding_account_name: "Savings",
        funding_investment_id: null, funding_investment_balance: null, goal_baseline_amount: "2000",
      }] };
    };
    const res = await supertest(goalsApp()).get("/api/goals").expect(200);
    const g = res.body[0];
    assert.equal(g.current_amount, 3500, "5500 balance − 2000 baseline");
    assert.equal(g.current_amount_manual, 3000, "stored value preserved separately");
    assert.equal(g.funding_status, "linked");
    assert.equal(g.percent_complete, 88); // 3500/4000
  });
  it("falls back to stored current_amount and marks orphaned when the funding balance is missing", async () => {
    dbModule.pool.query = async (sql) => {
      if (/recurring_transfers/i.test(sql)) return { rows: [] };
      return { rows: [{
        id: 2, name: "Car", type: "savings", target_amount: "10000", current_amount: "3000",
        monthly_contribution: "0", interest_rate: "0", target_date: null,
        funding_account_id: 9, funding_account_balance: null, funding_account_name: null,
        funding_investment_id: null, funding_investment_balance: null, goal_baseline_amount: "1000",
      }] };
    };
    const res = await supertest(goalsApp()).get("/api/goals").expect(200);
    const g = res.body[0];
    assert.equal(g.current_amount, 3000, "orphaned link falls back to stored current_amount");
    assert.equal(g.funding_status, "orphaned");
  });
});
