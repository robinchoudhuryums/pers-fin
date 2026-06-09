// ============================================================================
// Audit regression tests — guards against re-introducing fixed findings
// ============================================================================
// These tests pin specific behaviors enforced by the C1-C4 + N1-N4 fix cycle:
//   C3  Login reads session_timeout_minutes from user_settings
//   C4  SSO uses SSO_SECRET (not SESSION_SECRET + AUTH_SECRET)
//   N1  Templates do not embed ?api_key= in any anchor href
//   N2  foot.ejs does not inject window.PERFIN_API_KEY
//   N4  isExcludedMerchant uses word boundaries (covered in detect-subscriptions.test.js)
// ============================================================================

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const supertest = require("supertest");

// Minimal in-memory session middleware for tests — express-session lives in
// teller/node_modules, not at the repo root, so we stub the surface area
// (req.session getter, regenerate/save callbacks aren't needed by these routes).
function memorySessionMiddleware() {
  const store = new Map();
  return (req, res, next) => {
    let sid = (req.headers.cookie || "").match(/sid=([^;]+)/)?.[1];
    if (!sid || !store.has(sid)) {
      sid = crypto.randomBytes(8).toString("hex");
      store.set(sid, {});
      res.setHeader("Set-Cookie", "sid=" + sid + "; Path=/; HttpOnly");
    }
    req.session = store.get(sid);
    req.session.destroy = (cb) => { store.delete(sid); cb && cb(); };
    next();
  };
}

// ---------------------------------------------------------------------------
// N1 + N2 — template smoke tests
// ---------------------------------------------------------------------------
describe("N1/N2 — API key not leaked into views", () => {
  const viewsDir = path.join(__dirname, "..", "teller", "views");

  function readAllEjs(dir) {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...readAllEjs(full));
      else if (entry.name.endsWith(".ejs")) files.push(full);
    }
    return files;
  }

  const ejsFiles = readAllEjs(viewsDir);

  it("no template embeds ?api_key= in an href or fetch URL", () => {
    const offenders = [];
    for (const f of ejsFiles) {
      const text = fs.readFileSync(f, "utf-8");
      if (/api_key=/.test(text)) offenders.push(path.relative(viewsDir, f));
    }
    assert.deepEqual(offenders, [], `Templates still embed api_key= in URLs: ${offenders.join(", ")}`);
  });

  it("foot.ejs does not inject window.PERFIN_API_KEY", () => {
    const foot = fs.readFileSync(path.join(viewsDir, "partials", "foot.ejs"), "utf-8");
    assert.ok(!/window\.PERFIN_API_KEY/.test(foot),
      "foot.ejs must not write the API key into a JS global");
  });
});

// ---------------------------------------------------------------------------
// C4 — SSO uses SSO_SECRET (HMAC verifies with the documented env var)
// ---------------------------------------------------------------------------
// Source-level smoke test: persistent.js depends on express-rate-limit,
// which is only installed under teller/node_modules. Rather than couple
// this test to that install layout, we pin the SSO behavior at the source.
describe("C4 — persistent.js SSO uses SSO_SECRET", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "teller", "routes", "persistent.js"),
    "utf-8"
  );

  it("references process.env.SSO_SECRET", () => {
    assert.ok(/process\.env\.SSO_SECRET/.test(src),
      "persistent.js must read process.env.SSO_SECRET");
  });

  it("does NOT derive its HMAC key from SESSION_SECRET + AUTH_SECRET", () => {
    assert.ok(!/SESSION_SECRET\s*\+\s*AUTH_SECRET/.test(src),
      "legacy secret concatenation must not return");
  });

  it("guards SSO routes with a missing-SSO_SECRET check", () => {
    // At least one explicit guard should exist (returns 500 when SSO_SECRET is unset).
    assert.ok(/!SSO_SECRET/.test(src) || /SSO_SECRET\s*===?\s*null/.test(src),
      "persistent.js must guard against missing SSO_SECRET");
    // Both routes are still defined
    assert.ok(/\/api\/sso\/generate/.test(src), "missing /api/sso/generate route");
    assert.ok(/\/api\/sso\/validate/.test(src), "missing /api/sso/validate route");
  });
});

// ---------------------------------------------------------------------------
// C3 — Login applies the configured session_timeout_minutes
// ---------------------------------------------------------------------------
describe("C3 — login honors user_settings.session_timeout_minutes", () => {
  let app, originalPin;
  const FAKE_TIMEOUT = 47;

  before(() => {
    originalPin = process.env.SESSION_PIN;
    process.env.SESSION_PIN = "9876";

    // Mock pool: settings query returns FAKE_TIMEOUT
    const dbModule = require("../teller/services/database");
    dbModule.pool.query = async (sql) => {
      if (/session_timeout_minutes/i.test(sql)) {
        return { rows: [{ session_timeout_minutes: FAKE_TIMEOUT }] };
      }
      // Login.js GET /login also queries webauthn_credentials
      return { rows: [{ cnt: 0 }] };
    };
    dbModule.pool.connect = async () => ({ query: dbModule.pool.query, release: () => {} });

    const loginPath = require.resolve("../teller/pages/login");
    delete require.cache[loginPath];
    const loginFactory = require("../teller/pages/login");
    const router = loginFactory({
      AUTH_MODE: "pin",
      AUTH_SECRET: "9876",
      SESSION_PASSWORD: null,
      SESSION_PIN: "9876",
    });

    app = express();
    app.use(express.json());
    app.use(memorySessionMiddleware());
    app.use(router);
  });

  it("POST /api/login sets req.session.timeoutMinutes from settings, not the hardcoded 15", async () => {
    const agent = supertest.agent(app);
    await agent.post("/api/login").send({ password: "9876" }).expect(200);

    // Add a probe route that reports the session value
    app.get("/__probe", (req, res) => res.json({ timeout: req.session.timeoutMinutes }));
    const res = await agent.get("/__probe").expect(200);
    assert.equal(res.body.timeout, FAKE_TIMEOUT,
      `login should set timeoutMinutes from user_settings (got ${res.body.timeout}, expected ${FAKE_TIMEOUT})`);
  });

  process.on("exit", () => {
    if (originalPin === undefined) delete process.env.SESSION_PIN;
    else process.env.SESSION_PIN = originalPin;
  });
});

// ---------------------------------------------------------------------------
// F4 — Recurring transfer detection preserves is_dismissed on re-detection
// ---------------------------------------------------------------------------
describe("F4 — detect-transfers.js preserves is_dismissed state", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "detect-transfers.js"),
    "utf-8"
  );

  it("ON CONFLICT UPDATE checks is_dismissed before setting is_active", () => {
    assert.ok(/is_dismissed\s*=\s*true\s+THEN\s+false/i.test(src),
      "detect-transfers.js must keep is_active=false when is_dismissed=true on re-detection");
  });

  it("does NOT unconditionally set is_active = true in the upsert", () => {
    // The old code had a bare `is_active = true` without a CASE.
    // After F4, it should be wrapped in a CASE ... WHEN ... END.
    const upsertSection = src.slice(src.indexOf("ON CONFLICT"));
    assert.ok(!/is_active\s*=\s*true\s*[,\n]/.test(upsertSection),
      "is_active should be set via CASE, not unconditionally to true");
  });
});

// ---------------------------------------------------------------------------
// F10 — Subscription detection preserves is_dismissed on re-detection
// ---------------------------------------------------------------------------
describe("F10 — detect-subscriptions.js preserves is_dismissed state", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "detect-subscriptions.js"),
    "utf-8"
  );

  it("ON CONFLICT UPDATE checks is_dismissed before setting is_active", () => {
    assert.ok(/is_dismissed\s*=\s*true\s+THEN\s+false/i.test(src),
      "detect-subscriptions.js must keep is_active=false when is_dismissed=true on re-detection");
  });

  it("also checks cancelled_at", () => {
    assert.ok(/cancelled_at\s+IS\s+NOT\s+NULL\s+THEN\s+false/i.test(src),
      "detect-subscriptions.js must keep is_active=false when cancelled_at IS NOT NULL");
  });
});

// ---------------------------------------------------------------------------
// F6 — Budget enforcement does NOT silently bypass on DB error
// ---------------------------------------------------------------------------
describe("F6 — insights.js budget enforcement does not swallow DB errors", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "teller", "routes", "insights.js"),
    "utf-8"
  );

  it("budget usage query does NOT have .catch(() => ({ rows: [] }))", () => {
    // The dangerous pattern: .catch(() => ({ rows: [] })) on the budget check query
    // would allow unlimited AI spend on transient DB failures.
    const budgetQueryRegion = src.slice(
      src.indexOf("INSIGHTS_MONTHLY_BUDGET_CENTS"),
      src.indexOf("INSIGHTS_MONTHLY_BUDGET_CENTS") + 2000
    );
    assert.ok(!budgetQueryRegion.includes('.catch(() => ({ rows: [] }))'),
      "POST /api/insights budget query must not swallow errors with empty-rows fallback");
  });
});

// ---------------------------------------------------------------------------
// F24 — AI prompt sanitizes user-controlled strings
// ---------------------------------------------------------------------------
describe("F24 — insights.js sanitizes user data in AI prompt", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "teller", "routes", "insights.js"),
    "utf-8"
  );

  it("defines sanitizeForPrompt function", () => {
    assert.ok(/function\s+sanitizeForPrompt/.test(src),
      "insights.js must define sanitizeForPrompt()");
  });

  it("sanitizeForPrompt strips RUNNING_SUMMARY delimiter pattern", () => {
    assert.ok(/RUNNING_SUMMARY/i.test(src.slice(src.indexOf("sanitizeForPrompt"), src.indexOf("sanitizeForPrompt") + 300)),
      "sanitizeForPrompt should handle RUNNING_SUMMARY patterns");
  });

  it("uses sanitizeForPrompt on merchant/goal/transfer names", () => {
    // Count usages of sanitizeForPrompt( in the dynamic data section
    const matches = src.match(/sanitizeForPrompt\(/g) || [];
    assert.ok(matches.length >= 5,
      `sanitizeForPrompt should be called 5+ times on user data (found ${matches.length})`);
  });
});

// ---------------------------------------------------------------------------
// S1 / S3 / S4 — Trust loop, whats-new watermark, performance endpoint
// ---------------------------------------------------------------------------
describe("S1 — insight feedback loop", () => {
  const insightsSrc = fs.readFileSync(
    path.join(__dirname, "..", "teller", "routes", "insights.js"),
    "utf-8"
  );
  const dbSrc = fs.readFileSync(
    path.join(__dirname, "..", "teller", "services", "database.js"),
    "utf-8"
  );

  it("defines PATCH /api/insights/:id/feedback endpoint", () => {
    assert.ok(/router\.patch\(\s*["']\/api\/insights\/:id\/feedback["']/.test(insightsSrc),
      "PATCH /api/insights/:id/feedback must be defined");
  });

  it("defines GET /api/insights/feedback-summary endpoint", () => {
    assert.ok(/router\.get\(\s*["']\/api\/insights\/feedback-summary["']/.test(insightsSrc),
      "GET /api/insights/feedback-summary must be defined");
  });

  it("feedback enum is enforced at the DB CHECK constraint", () => {
    assert.ok(/CHECK\s*\([^)]*user_feedback[^)]*'positive'[^)]*'negative'[^)]*'mixed'/.test(dbSrc),
      "user_feedback column must be CHECK-constrained to positive/negative/mixed/NULL");
  });

  it("generateInsights renders feedback into the next prompt", () => {
    assert.ok(/=== USER FEEDBACK ON RECENT INSIGHTS ===/.test(insightsSrc),
      "Prompt must include a USER FEEDBACK section header");
  });

  it("prompt instructs Claude to drop retracted items from the summary", () => {
    assert.ok(/(?:DROP|retract)/i.test(
        insightsSrc.slice(
          insightsSrc.indexOf("=== USER FEEDBACK ON RECENT INSIGHTS ==="),
          insightsSrc.indexOf("=== USER FEEDBACK ON RECENT INSIGHTS ===") + 600
        )),
      "Prompt should explicitly allow Claude to drop or retract previous-summary items");
  });
});

describe("S3 — whats-new watermark + endpoint shape", () => {
  const whatsNewSrc = fs.readFileSync(
    path.join(__dirname, "..", "teller", "routes", "whats-new.js"),
    "utf-8"
  );
  const dbSrc = fs.readFileSync(
    path.join(__dirname, "..", "teller", "services", "database.js"),
    "utf-8"
  );

  it("defines GET /api/whats-new and POST /api/whats-new/seen", () => {
    assert.ok(/router\.get\(\s*["']\/api\/whats-new["']/.test(whatsNewSrc),
      "GET /api/whats-new must be defined");
    assert.ok(/router\.post\(\s*["']\/api\/whats-new\/seen["']/.test(whatsNewSrc),
      "POST /api/whats-new/seen must be defined");
  });

  it("scopes queries with last_dashboard_view_at watermark", () => {
    assert.ok(/last_dashboard_view_at/.test(whatsNewSrc),
      "whats-new must read last_dashboard_view_at from user_settings");
    assert.ok(/last_dashboard_view_at/.test(dbSrc),
      "database.js must declare user_settings.last_dashboard_view_at");
  });

  it("drops near-zero balance deltas to avoid float noise", () => {
    assert.ok(/ABS\([^)]*balance[^)]*\)\s*>=\s*0\.01/i.test(whatsNewSrc),
      "balance delta query must threshold |delta| >= 0.01 so float noise doesn't surface");
  });
});

describe("S4 — investment performance endpoint shape", () => {
  const invSrc = fs.readFileSync(
    path.join(__dirname, "..", "teller", "routes", "investments.js"),
    "utf-8"
  );

  it("defines GET /api/investments/performance", () => {
    assert.ok(/router\.get\(\s*["']\/api\/investments\/performance["']/.test(invSrc),
      "GET /api/investments/performance must be defined");
  });

  it("response includes asset-class breakdown + winners + losers", () => {
    // Source-pin the response field names so a refactor that renames them
    // forces a deliberate test update.
    const perfBlock = invSrc.slice(invSrc.indexOf("/api/investments/performance"));
    for (const field of ["total_return", "total_return_pct", "by_asset_class", "top_winners", "top_losers"]) {
      assert.ok(perfBlock.includes(field),
        `performance response must include ${field}`);
    }
  });

  it("guards against division by zero when cost_basis is 0", () => {
    const perfBlock = invSrc.slice(invSrc.indexOf("/api/investments/performance"));
    assert.ok(/cost\s*>\s*0\s*\?[^:]*:\s*null/i.test(perfBlock) ||
              /cost_basis\s*>\s*0\s*\?[^:]*:\s*null/i.test(perfBlock),
      "return_pct should fall back to null when cost basis is 0");
  });
});

describe("S2 — weekly digest scheduler + dispatch", () => {
  const insightsSrc = fs.readFileSync(
    path.join(__dirname, "..", "teller", "routes", "insights.js"),
    "utf-8"
  );
  const startupSrc = fs.readFileSync(
    path.join(__dirname, "..", "teller", "startup.js"),
    "utf-8"
  );
  const perfinReceiverSrc = fs.readFileSync(
    path.join(__dirname, "..", "apps", "per-sistant", "routes", "perfin.js"),
    "utf-8"
  );

  it("exports runWeeklyDigest + renderWeeklyDigestEmail", () => {
    assert.ok(/module\.exports\.runWeeklyDigest/.test(insightsSrc),
      "runWeeklyDigest must be exported for the scheduler");
    assert.ok(/module\.exports\.renderWeeklyDigestEmail/.test(insightsSrc),
      "renderWeeklyDigestEmail must be exported");
  });

  it("runWeeklyDigest gates with a 6-day window", () => {
    const fnBlock = insightsSrc.slice(insightsSrc.indexOf("async function runWeeklyDigest"));
    assert.ok(/ageDays\s*<\s*6|6\s*days?/i.test(fnBlock),
      "runWeeklyDigest must dedupe with a 6-day window from last_weekly_digest_at");
  });

  it("startup.js wires the weekly digest interval", () => {
    assert.ok(/runWeeklyDigest/.test(startupSrc),
      "startup.js must invoke runWeeklyDigest from a scheduled interval");
  });

  it("Per-sistant webhook receiver handles weekly_summary alongside insights_generated", () => {
    assert.ok(/weekly_summary/.test(perfinReceiverSrc),
      "apps/per-sistant/routes/perfin.js must route the weekly_summary event " +
      "(otherwise the digest gets ignored at the receiver)");
  });
});

// ---------------------------------------------------------------------------
// F17 / #4 — Budget month validators reject impossible months
// ---------------------------------------------------------------------------
describe("Budget month validators", () => {
  const budgetsSrc = fs.readFileSync(
    path.join(__dirname, "..", "teller", "routes", "budgets.js"),
    "utf-8"
  );
  const financialQueriesSrc = fs.readFileSync(
    path.join(__dirname, "..", "teller", "services", "financial-queries.js"),
    "utf-8"
  );

  it("GET /api/budgets validates ?month against 01-12", () => {
    // The regex landed in two places (GET + POST/snapshot) — both should
    // use the same strict pattern.
    const strict = /\\d\{4\}-\(0\[1-9\]\|1\[0-2\]\)/;
    const matches = budgetsSrc.match(/\\d\{4\}-\(0\[1-9\]\|1\[0-2\]\)/g) || [];
    assert.ok(matches.length >= 2,
      `Both GET /api/budgets and POST /api/budgets/snapshot must use the 01-12 regex (found ${matches.length})`);
  });

  it("getCategorySpendingForMonth defends against impossible months too", () => {
    assert.ok(/\\d\{4\}-\(0\[1-9\]\|1\[0-2\]\)/.test(financialQueriesSrc),
      "getCategorySpendingForMonth must validate its month arg with the same regex");
  });
});

// SX3 — the SPLIT_AMOUNT / NOT_TRANSFER / INCOME_PREDICATE fragments are inlined
// into scripts/sheets-sync.js (it can't require the services layer). They MUST
// stay byte-identical to teller/services/financial-queries.js or the Sheets
// export silently drifts from the in-app numbers. Pin that equality.
describe("SX3 — sheets-sync inlined SQL fragments match financial-queries canonical", () => {
  const fqSrc = fs.readFileSync(path.join(__dirname, "..", "teller", "services", "financial-queries.js"), "utf-8");
  const ssSrc = fs.readFileSync(path.join(__dirname, "..", "scripts", "sheets-sync.js"), "utf-8");
  const norm = (s) => s.replace(/\s+/g, " ");

  function pin(name, re, normalize) {
    it(`${name} body matches canonical`, () => {
      const a = (normalize ? norm(fqSrc) : fqSrc).match(re);
      const b = (normalize ? norm(ssSrc) : ssSrc).match(re);
      assert.ok(a, `${name} not found in financial-queries.js — update the test regex`);
      assert.ok(b, `${name} not found in sheets-sync.js — copy missing/renamed`);
      assert.equal(b[0], a[0], `sheets-sync ${name} must byte-match financial-queries (drift detected)`);
    });
  }

  pin("NOT_TRANSFER keyword list", /payment thank\|[^']*withdrawal/);
  pin("INCOME include keywords", /payroll\|direct dep[^']*ach credit/);
  pin("INCOME exclude keywords", /payment\|transfer\|pymt[^']*bill pay/);
  // SPLIT_AMOUNT CASE — multi-line in sheets-sync, single-line in canonical, so
  // compare whitespace-normalized.
  pin("SPLIT_AMOUNT CASE",
    /personal_for = 'self' THEN t\.amount WHEN la\.is_shared AND t\.personal_for = 'partner' THEN 0 ELSE t\.amount \* COALESCE\(la\.spending_split_pct, 100\) \/ 100\.0/,
    true);
});
