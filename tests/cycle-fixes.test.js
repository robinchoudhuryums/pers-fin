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
