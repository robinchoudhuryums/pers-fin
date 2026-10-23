// ============================================================================
// Oct 2026 broad scan (cycle 7) — Batch 15: subscription watchdog (F53 / G5)
// and merchant rename rules (F55 / ST2)
// ============================================================================
// Pins that need no database; the real-Postgres half lives in
// tests/contract/watchdog-rename.contract.test.js.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

process.env.NEON_DATABASE_URL = process.env.NEON_DATABASE_URL || "postgres://test:test@127.0.0.1:1/test";
process.env.TOKEN_ENCRYPTION_PASSPHRASE = process.env.TOKEN_ENCRYPTION_PASSPHRASE || "test-passphrase";

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const dbModule = require("../teller/services/database");

describe("G5: the subscription watchdog", () => {
  const src = read("teller/routes/subscriptions.js");

  it("runs after every detection, fail-soft, and is exported", () => {
    const run = src.slice(src.indexOf("async function runSubscriptionDetection()"), src.indexOf("// Subscription watchdog (cycle-7 F53"));
    assert.match(run, /try \{ watchdog = await runSubscriptionWatchdog\(\); \}\s*catch \(err\) \{ console\.error/);
    assert.match(src, /module\.exports\.runSubscriptionWatchdog = runSubscriptionWatchdog;/);
  });

  it("uses the detector's merchant key, a 7-day grace, ±25% amounts and one alert per charge / price", () => {
    assert.match(src, /const STILL_CHARGING_GRACE_DAYS = 7;/);
    assert.match(src, /const PRICE_RISE_PCT = 0\.05;/);
    assert.match(src, /const PRICE_RISE_ABS = 1;/);
    assert.ok(src.includes("TRIM(COALESCE(t.user_merchant_name, t.merchant_name, LOWER(REGEXP_REPLACE(t.name, '[^a-zA-Z0-9 ]', '', 'g'))))"));
    assert.ok(read("scripts/detect-subscriptions.js").includes("COALESCE(user_merchant_name, merchant_name, LOWER(REGEXP_REPLACE(name, '[^a-zA-Z0-9 ]', '', 'g')))"),
      "the watchdog key mirrors the detector's");
    assert.match(src, /t\.amount BETWEEN ds\.amount \* 0\.75 AND ds\.amount \* 1\.25/);
    assert.match(src, /c\.transaction_id IS DISTINCT FROM ds\.still_charging_txn/);
    assert.match(src, /price_alerted_amount IS DISTINCT FROM amount/);
    assert.match(src, /if \(!sent\.logged\) continue;/, "a notification that wasn't recorded is retried, not marked sent");
  });

  it("the Subscriptions page shows STILL CHARGING and PRICE UP badges", () => {
    const ejs = read("teller/views/subscriptions.ejs");
    assert.match(ejs, /STILL CHARGING<\/span>/);
    assert.match(ejs, /PRICE UP ' \+ fmt\(rise\)/);
  });

  it("the watchdog columns are migrated", () => {
    const db = read("teller/services/database.js");
    for (const c of ["still_charging_txn TEXT", "still_charging_at DATE", "still_charging_amount NUMERIC(12,2)", "price_alerted_amount NUMERIC(12,2)"]) {
      assert.ok(db.includes("ADD COLUMN IF NOT EXISTS " + c), c);
    }
  });
});

describe("ST2: merchant rename rules", () => {
  const rename = require("../teller/routes/merchant-rename");

  it("a rule matches the RAW merchant (never the override), with LIKE metacharacters escaped", () => {
    assert.match(rename.ruleCondition("exact"), /^LOWER\(COALESCE\(t\.merchant_name, t\.name, ''\)\) = LOWER\(\$1\)$/);
    assert.match(rename.ruleCondition("starts_with"), /ESCAPE '\\'$/);
    assert.match(rename.ruleCondition("contains"), /LIKE '%' \|\| REPLACE\(REPLACE\(REPLACE/);
    assert.doesNotMatch(rename.ruleCondition("contains"), /user_merchant_name/);
  });

  it("applyRenameRules runs rules most-specific first, skips a too-short stored rule and only fills a NULL user name", async () => {
    const calls = [];
    const db = {
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (/FROM merchant_rename_rules WHERE is_active/.test(sql)) {
          return { rows: [
            { id: 1, merchant_pattern: "AMZN Mktp US", match_type: "exact", rename_to: "Amazon" },
            { id: 2, merchant_pattern: "am", match_type: "contains", rename_to: "Bad" },
          ] };
        }
        if (/^\s*UPDATE transactions t SET user_merchant_name/.test(sql)) return { rowCount: 3 };
        return { rows: [], rowCount: 0 };
      },
    };
    assert.equal(await rename.applyRenameRules(db), 3);
    assert.match(calls[0].sql, /ORDER BY CASE match_type WHEN 'exact' THEN 0/);
    const updates = calls.filter((c) => /UPDATE transactions t SET user_merchant_name/.test(c.sql));
    assert.equal(updates.length, 1, "the 2-character contains rule is skipped");
    assert.match(updates[0].sql, /WHERE t\.user_merchant_name IS NULL AND/);
    assert.deepEqual(updates[0].params, ["AMZN Mktp US", "Amazon", 1]);
    assert.ok(calls.some((c) => /times_applied = times_applied \+ \$2/.test(c.sql)));
  });

  it("is applied after a sync (before the anomaly check), inside the CSV import transaction and after a manual entry", () => {
    const enr = read("teller/routes/enrollments.js");
    // The post-sync steps live in runPostSyncSteps since roadmap T2.1 W3 (the
    // Plaid webhook's per-item sync shares them); syncAllTransactions calls it.
    assert.match(enr.slice(enr.indexOf("async function syncAllTransactionsOnce()")), /await runPostSyncSteps\(tellerAdded \+ plaidAdded\)/);
    const post = enr.slice(enr.indexOf("function runPostSyncSteps("));
    assert.ok(post.indexOf('require("./merchant-rename").applyRenameRules()') > 0);
    assert.ok(post.indexOf('require("./merchant-rename").applyRenameRules()') < post.indexOf("await runAnomalyCheck()"));
    const subs = read("teller/routes/subscriptions.js");
    assert.match(subs, /SAVEPOINT csv_rename"\);\s*await require\("\.\/merchant-rename"\)\.applyRenameRules\(client\);/);
    assert.match(subs, /ROLLBACK TO SAVEPOINT csv_rename/);
    assert.match(read("teller/routes/transactions.js"), /require\("\.\/merchant-rename"\)\.applyRenameRules\(\)/);
  });

  it("the router is mounted and the table is wiped by reset-fresh", () => {
    assert.match(read("teller/server.js"), /app\.use\(require\("\.\/routes\/merchant-rename"\)\);/);
    assert.ok(require("../scripts/reset-fresh").WIPE_TABLES.includes("merchant_rename_rules"));
  });

  it("a hand rename clears the rule link; apply_to_all needs a name", async () => {
    const seen = [];
    const orig = dbModule.pool.query;
    dbModule.pool.query = async (sql, params) => {
      seen.push(sql);
      return { rows: [{ transaction_id: "t1", user_merchant_name: params[0] }] };
    };
    try {
      const app = express();
      app.use(express.json());
      app.use(require("../teller/routes/transactions"));
      await supertest(app).patch("/api/transactions/t1").send({ merchant_name: "Mine" }).expect(200);
      assert.match(seen.find((s) => /^UPDATE transactions SET/.test(s)), /user_merchant_rule_id = NULL/);
      const bad = await supertest(app).patch("/api/transactions/t1").send({ notes: "x", apply_to_all: true });
      assert.equal(bad.status, 400);
    } finally {
      dbModule.pool.query = orig;
    }
  });

  it("the Edit dialog offers 'Apply to all past and future' and Settings lists the rules", () => {
    const tjs = read("teller/public/transactions.js");
    assert.match(tjs, /id="edit-rename-all"/);
    assert.match(tjs, /for="edit-rename-all">Apply to all past and future/);
    assert.match(tjs, /body\.apply_to_all = true/);
    const sr = read("teller/public/settings-rules.js");
    assert.match(sr, /apiFetch\("\/api\/merchant-rename-rules"\)/);
    assert.match(sr, /await writeOk\(res, "Couldn't delete the rename rule"\)/);
  });
});
