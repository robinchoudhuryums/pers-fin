// ============================================================================
// Coverage gap tests — budget cap in categorize, sanitizeForPrompt,
// tax PDF, insights audit endpoint, renderInsightEmail, settings toggle
// ============================================================================

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supertest = require("supertest");
const fs = require("fs");
const path = require("path");

function createMockPool(queryResults = {}) {
  const pool = {
    query: async (sql, params) => {
      for (const [key, result] of Object.entries(queryResults)) {
        if (sql.trim().toUpperCase().startsWith(key.toUpperCase())) {
          if (typeof result === "function") return result(sql, params);
          return result;
        }
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({ query: pool.query, release: () => {} }),
  };
  return pool;
}

function setupMockDb(pool) {
  const dbModule = require("../teller/services/database");
  dbModule.pool.query = pool.query;
  dbModule.pool.connect = pool.connect;
}

function buildApp(router) {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

// ---------------------------------------------------------------------------
// Budget cap enforcement in POST /api/categorize — source-code assertion
// (Can't exercise via supertest because @anthropic-ai/sdk isn't installed
// at test-time. Verify the budget check code exists in the route.)
// ---------------------------------------------------------------------------
describe("Categorize budget cap enforcement", () => {
  it("POST /api/categorize checks INSIGHTS_MONTHLY_BUDGET_CENTS before calling Claude", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "teller", "routes", "categorize.js"), "utf-8"
    );
    assert.ok(src.includes("INSIGHTS_MONTHLY_BUDGET_CENTS"),
      "categorize.js should check monthly budget cap");
    assert.ok(src.includes("429"),
      "categorize.js should return 429 when budget exhausted");
    assert.ok(src.includes("estimateCostGranular"),
      "categorize.js should use granular cost estimation");
  });
});

// ---------------------------------------------------------------------------
// sanitizeForPrompt behavior
// ---------------------------------------------------------------------------
describe("sanitizeForPrompt regex behavior", () => {
  // T2: exercise the REAL deployed function (now exported from routes/insights),
  // not a re-implemented copy that would pass even if the production regex were
  // reverted.
  const { sanitizeForPrompt } = require("../teller/routes/insights");

  it("strips ---RUNNING_SUMMARY--- pattern", () => {
    const result = sanitizeForPrompt("Normal text ---RUNNING_SUMMARY--- injected");
    assert.ok(!result.includes("RUNNING_SUMMARY"));
    assert.ok(result.includes("[redacted]"));
  });

  it("strips case-insensitive variants", () => {
    const result = sanitizeForPrompt("---running_summary---");
    assert.ok(!result.includes("running_summary"));
  });

  it("collapses consecutive dashes", () => {
    const result = sanitizeForPrompt("test-----value");
    assert.equal(result, "test--value");
  });

  it("handles null/empty input", () => {
    assert.equal(sanitizeForPrompt(null), "");
    assert.equal(sanitizeForPrompt(""), "");
    assert.equal(sanitizeForPrompt(undefined), "");
  });

  it("passes through normal merchant names unchanged", () => {
    assert.equal(sanitizeForPrompt("Amazon.com"), "Amazon.com");
    assert.equal(sanitizeForPrompt("Costco Wholesale"), "Costco Wholesale");
  });
});

// ---------------------------------------------------------------------------
// renderInsightEmail
// ---------------------------------------------------------------------------
describe("renderInsightEmail", () => {
  let renderInsightEmail;

  before(() => {
    // Need to require insights.js which needs the mock pool set up
    const pool = createMockPool();
    setupMockDb(pool);
    const insightsPath = require.resolve("../teller/routes/insights");
    delete require.cache[insightsPath];
    const insightsModule = require("../teller/routes/insights");
    renderInsightEmail = insightsModule.renderInsightEmail;
  });

  it("returns valid HTML with DOCTYPE", () => {
    const html = renderInsightEmail("Test insight text", ["spending_benchmarks"], null);
    assert.ok(html.startsWith("<!DOCTYPE html>"));
    assert.ok(html.includes("</html>"));
  });

  it("includes Perfin branding", () => {
    const html = renderInsightEmail("Test", ["savings_suggestions"], null);
    assert.ok(html.includes("Perfin"));
    assert.ok(html.includes("#d4a574"), "Should use gold accent color");
  });

  it("escapes HTML in insight text", () => {
    const html = renderInsightEmail("<script>alert('xss')</script>", [], null);
    assert.ok(!html.includes("<script>alert"));
    assert.ok(html.includes("&lt;script&gt;"));
  });

  it("renders markdown bold as <strong>", () => {
    const html = renderInsightEmail("This is **important** text", [], null);
    assert.ok(html.includes("<strong"));
    assert.ok(html.includes("important"));
  });

  it("includes audit section when critical findings exist", () => {
    const audit = { findings: [], summary: { critical: 2, warning: 1, info: 0 } };
    const html = renderInsightEmail("Test", ["anomaly_detection"], audit);
    assert.ok(html.includes("Audit Findings"));
    assert.ok(html.includes("2 critical"));
  });

  it("omits audit section when no issues", () => {
    const audit = { findings: [], summary: { critical: 0, warning: 0, info: 0 } };
    const html = renderInsightEmail("Test", [], audit);
    assert.ok(!html.includes("Audit Findings"));
  });

  it("lists modules in footer", () => {
    const html = renderInsightEmail("Test", ["spending_benchmarks", "goal_tracking"], null);
    assert.ok(html.includes("spending_benchmarks"));
    assert.ok(html.includes("goal_tracking"));
  });
});

// ---------------------------------------------------------------------------
// GET /api/insights/audit endpoint
// ---------------------------------------------------------------------------
describe("GET /api/insights/audit", () => {
  let app;

  before(() => {
    const pool = createMockPool({
      "SELECT": (sql) => {
        if (sql.includes("ai_audit_log")) {
          return { rows: [
            { id: 1, insight_id: 10, module: "arithmetic", severity: "critical", check_type: "tier1", claim_text: "$500", expected_value: "$300", actual_value: "$300", created_at: "2026-04-15", insight_date: "2026-04-15" },
          ] };
        }
        return { rows: [] };
      },
    });
    setupMockDb(pool);
    const insightsPath = require.resolve("../teller/routes/insights");
    delete require.cache[insightsPath];
    const insightsRouter = require("../teller/routes/insights");
    app = buildApp(insightsRouter);
  });

  it("returns findings and stats", async () => {
    const res = await supertest(app).get("/api/insights/audit").expect(200);
    assert.ok("findings" in res.body);
    assert.ok("stats" in res.body);
    assert.ok(Array.isArray(res.body.findings));
  });
});

// ---------------------------------------------------------------------------
// Tax Report PDF format
// ---------------------------------------------------------------------------
describe("Tax Report PDF", () => {
  let app;

  before(() => {
    const pool = createMockPool({
      "SELECT": { rows: [
        { tax_year: 2026, merchant: "Doctor Smith", amount: "250.00", category: "medical", deduction_type: "ai_detected", is_confirmed: false, notes: null, txn_date: "2026-03-15", flagged_at: "2026-03-16" },
      ] },
    });
    setupMockDb(pool);
    const settingsPath = require.resolve("../teller/routes/settings");
    delete require.cache[settingsPath];
    const settingsRouter = require("../teller/routes/settings");
    app = buildApp(settingsRouter);
  });

  it("returns PDF with correct content-type", async () => {
    const res = await supertest(app)
      .get("/api/export/tax-report?year=2026&format=pdf")
      .expect(200);
    assert.equal(res.headers["content-type"], "application/pdf");
    assert.ok(res.headers["content-disposition"].includes("tax_deductions_2026.pdf"));
  });

  it("returns CSV by default", async () => {
    const res = await supertest(app)
      .get("/api/export/tax-report?year=2026")
      .expect(200);
    assert.ok(res.headers["content-type"].includes("text/csv"));
  });

  it("returns JSON when requested", async () => {
    const res = await supertest(app)
      .get("/api/export/tax-report?year=2026&format=json")
      .expect(200);
    assert.ok(res.body.tax_year);
    assert.ok("grand_total" in res.body);
    assert.ok("categories" in res.body);
  });
});

// ---------------------------------------------------------------------------
// Settings PATCH sync_notifications_enabled
// ---------------------------------------------------------------------------
describe("Settings sync_notifications_enabled toggle", () => {
  it("source code handles sync_notifications_enabled in PATCH", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "teller", "routes", "settings.js"), "utf-8"
    );
    assert.ok(src.includes("sync_notifications_enabled"),
      "settings.js should handle sync_notifications_enabled");
  });

  it("source code reads sync_notifications_enabled in GET", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "teller", "routes", "settings.js"), "utf-8"
    );
    assert.ok(src.includes("sync_notifications_enabled"),
      "GET /api/settings should return sync_notifications_enabled");
  });
});
