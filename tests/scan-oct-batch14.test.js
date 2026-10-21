// ============================================================================
// Oct 2026 broad scan (cycle 7) — Batch 14: refund-aware spending (F35 / G4)
// ============================================================================
// Wiring pins that need no database: every spending surface reads the ONE
// spend_lines builder (charges + split lines + refund lines) and floors each
// (month, category) at $0; charge-level surfaces stay gross on purpose. The
// numbers are checked on real Postgres in tests/contract/refunds.contract.test.js
// and tests/contract/budget-parity.contract.test.js (Sheets = getBudgetStatus).
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

process.env.NEON_DATABASE_URL = process.env.NEON_DATABASE_URL || "postgres://test:test@127.0.0.1:1/test";
process.env.TOKEN_ENCRYPTION_PASSPHRASE = process.env.TOKEN_ENCRYPTION_PASSPHRASE || "test-passphrase";

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const fq = require("../teller/services/financial-queries");

// The text of one route handler, from its router.get line to the next one.
function routeBody(src, route) {
  const start = src.indexOf(`router.get("${route}"`);
  assert.ok(start >= 0, route + " not found");
  const next = src.indexOf("\nrouter.", start + 1);
  return src.slice(start, next < 0 ? undefined : next);
}

describe("F35: the refund definition", () => {
  it("a refund is a settled, non-reimbursed credit that passes NOT_TRANSFER and is not income", () => {
    const p = fq.REFUND_PREDICATE;
    assert.match(p, /t\.amount < 0 AND t\.pending = false/);
    assert.match(p, /COALESCE\(t\.is_reimbursed, false\) = false/);
    assert.ok(p.includes(fq.NOT_TRANSFER), "NOT_TRANSFER keeps card payments and transfers out");
    // NULL-safe: the income predicate is NULL for a row with no Plaid category.
    assert.match(p, /AND NOT COALESCE\(\s*\(/);
    assert.match(p, /, false\)\s*\)$/);
  });

  it("spend_lines unions charges, split lines and refund lines; refunds inherit the merchant's prior category", () => {
    const cte = fq.spendLinesCTE("t.date >= $1");
    assert.equal((cte.match(/UNION ALL/g) || []).length, 2);
    assert.match(cte, /true AS is_refund/);
    assert.match(cte, /COALESCE\(t\.user_category, prior\.category, t\.category\[1\], 'Uncategorized'\)/);
    assert.match(cte, /c\.date >= t\.date - 180/);
    assert.equal((cte.match(/AND t\.date >= \$1/g) || []).length, 3, "the window applies to all three legs (posting month)");
  });

  it("NET_CATEGORY_MONTHS floors each (month, category) at $0 and lists only categories with a charge", () => {
    assert.match(fq.NET_CATEGORY_MONTHS, /GREATEST\(SUM\(amount\), 0\) AS spent/);
    assert.match(fq.NET_CATEGORY_MONTHS, /GROUP BY month, category/);
    assert.match(fq.NET_CATEGORY_MONTHS, /HAVING COUNT\(\*\) FILTER \(WHERE NOT is_refund\) > 0/);
  });
});

describe("F35: every spending surface reads spend_lines", () => {
  const fqSrc = read("teller/services/financial-queries.js");
  const sa = read("teller/routes/spending-analytics.js");

  it("getMonthlySpending and getCategorySpendingForMonth", () => {
    for (const fn of ["getMonthlySpending", "getCategorySpendingForMonth"]) {
      const body = fqSrc.slice(fqSrc.indexOf(`async function ${fn}(`), fqSrc.indexOf("\n}\n", fqSrc.indexOf(`async function ${fn}(`)));
      assert.match(body, /spendLinesCTE\(/, fn);
      assert.match(body, /NET_CATEGORY_MONTHS/, fn);
    }
  });

  it("/api/spending-summary (trend, categories, merchants) and /api/spending-yoy", () => {
    const summary = routeBody(sa, "/api/spending-summary");
    assert.equal((summary.match(/spendLinesCTE\(SUMMARY_WINDOW\)/g) || []).length, 3);
    assert.doesNotMatch(summary, /\$\{SPLIT_AMOUNT\}/, "no gross charge sum left in the summary");
    assert.match(routeBody(sa, "/api/spending-yoy"), /spendLinesCTE\(/);
  });

  it("the insights seasonal block", () => {
    const ins = read("teller/routes/insights.js");
    const block = ins.slice(ins.indexOf("const seasonalData = await pool.query("), ins.indexOf("if (seasonalData.rows.length >= 6)"));
    assert.match(block, /spendLinesCTE\(/);
    assert.match(block, /FROM net_category_months/);
  });

  it("Ask's search total nets matching refunds (floored at $0)", () => {
    const ask = read("teller/routes/ask.js");
    assert.match(ask, /OR \$\{REFUND_PREDICATE\}/);
    assert.match(ask, /ROUND\(GREATEST\(COALESCE\(SUM\(CASE/);
  });

  it("the cash-flow forecast stays charge-level on purpose", () => {
    const cf = routeBody(sa, "/api/cash-flow");
    assert.doesNotMatch(cf, /spendLinesCTE|REFUND_PREDICATE/);
  });

  it("the Sheets Dashboard reads net_cat_months for totals, categories, merchants, KPIs and budgets", () => {
    const ss = read("scripts/sheets-sync.js");
    const dash = ss.slice(ss.indexOf("async function buildDashboard("), ss.indexOf("// Financial goals. A funding-linked goal"));
    assert.match(dash, /refund_lines AS \(/);
    assert.match(dash, /net_cat_months AS \(/);
    assert.equal((dash.match(/FROM net_cat_months/g) || []).length, 6);
    assert.doesNotMatch(dash, /SUM\(\$\{SPLIT_AMT\}\)/, "no gross dashboard sum left");
  });
});

describe("F35: the refund definition lives in one place (canonical-helper policy)", () => {
  it("only financial-queries.js and its SX3-pinned Sheets mirror define refund lines", () => {
    const dirs = ["teller/routes", "teller/services", "scripts"];
    const hits = [];
    for (const dir of dirs) {
      for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((n) => n.endsWith(".js"))) {
        if (/const REFUND_PREDICATE = `|\) prior ON true/.test(read(path.join(dir, f)))) hits.push(`${dir}/${f}`);
      }
    }
    assert.deepEqual(hits.sort(), ["scripts/sheets-sync.js", "teller/services/financial-queries.js"]);
  });
});
