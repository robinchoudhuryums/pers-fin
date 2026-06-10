// ============================================================================
// Per-sistant — regression tests for the June 2026 broad-scan fixes
// ============================================================================
//   - F7  CSP nonce migration: no 'unsafe-inline' in script-src; per-request
//          nonce generated in basePathMiddleware; every inline <script>
//          carries nonceAttr() (behavioral + source-scan)
//   - F9  recurrence_interval >= 1: route validation, DB CHECK migration,
//          advanceRecurrence floor (behavioral)

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// ---------------------------------------------------------------------------
// F7 — CSP nonces replace 'unsafe-inline'
// ---------------------------------------------------------------------------
describe("F7 — nonce-based script-src CSP", () => {
  it("helmet scriptSrc has a nonce directive and no 'unsafe-inline'", () => {
    const src = fs.readFileSync(path.join(ROOT, "middleware.js"), "utf8");
    const block = src.match(/scriptSrc: \[[\s\S]*?\]/);
    assert.ok(block, "scriptSrc directive must exist");
    assert.match(block[0], /nonce-\$\{res\.locals\.cspNonce\}/, "per-request nonce directive");
    assert.ok(!block[0].includes("'unsafe-inline'"), "script-src must not allow unsafe-inline");
  });

  it("basePathMiddleware generates the nonce and pageHead/themeScript emit it", () => {
    const views = require("../views");
    const req = { baseUrl: "/per-sistant", app: { get: () => true } };
    const res = { locals: {} };
    views.basePathMiddleware(req, res, () => {
      assert.ok(res.locals.cspNonce && res.locals.cspNonce.length >= 16, "nonce set on res.locals");
      const head = views.pageHead("Test");
      const theme = views.themeScript();
      const attr = `nonce="${res.locals.cspNonce}"`;
      // 4 inline scripts in pageHead + 1 in themeScript, all nonced
      assert.equal(head.split(attr).length - 1, 4, "all pageHead inline scripts carry the nonce");
      assert.ok(theme.includes(attr), "themeScript carries the nonce");
      assert.ok(!/<script>/.test(head) && !/<script>/.test(theme), "no bare inline <script> remains");
    });
  });

  it("nonces are unique per request", () => {
    const views = require("../views");
    const seen = new Set();
    for (let i = 0; i < 3; i++) {
      const res = { locals: {} };
      views.basePathMiddleware({ baseUrl: "", app: { get: () => false } }, res, () => {});
      seen.add(res.locals.cspNonce);
    }
    assert.equal(seen.size, 3);
  });

  it("no page or the login route emits a bare inline <script>", () => {
    // Only scan files that render pages (import/define pageHead) — the
    // client-script modules (dashboard-script.js etc.) are script BODIES and
    // may mention "<script>" in comments without emitting one.
    const files = fs.readdirSync(path.join(ROOT, "pages")).filter(f => f.endsWith(".js"))
      .map(f => path.join(ROOT, "pages", f));
    files.push(path.join(ROOT, "views.js"), path.join(ROOT, "routes", "auth.js"));
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      if (!src.includes("pageHead")) continue;
      // Strip // comment lines so prose mentioning "<script>" doesn't trip the scan.
      const code = src.split("\n").filter(l => !l.trim().startsWith("//")).join("\n");
      assert.ok(!code.includes("<script>"),
        path.basename(f) + " must use <script${nonceAttr()}> for inline scripts");
    }
  });
});

// ---------------------------------------------------------------------------
// F9 — recurrence_interval >= 1
// ---------------------------------------------------------------------------
describe("F9 — recurrence interval guards", () => {
  it("advanceRecurrence floors zero/negative intervals (date always advances)", () => {
    const { advanceRecurrence } = require("../helpers");
    const start = new Date("2026-06-01T00:00:00Z");
    assert.ok(advanceRecurrence(start, "daily", -5) > start, "negative interval must still advance");
    assert.ok(advanceRecurrence(start, "weekdays", 0) > start, "zero interval must still advance");
    assert.ok(advanceRecurrence(start, "weekly", null) > start, "null interval defaults to 1");
    // Sane positive interval unchanged
    const plus3 = advanceRecurrence(start, "daily", 3);
    assert.equal(Math.round((plus3 - start) / 86400000), 3);
  });

  it("todos POST and PATCH validate recurrence_interval (1-365 integer)", () => {
    const src = fs.readFileSync(path.join(ROOT, "routes", "todos.js"), "utf8");
    const hits = src.match(/Invalid recurrence interval\. Must be an integer between 1 and 365\./g) || [];
    assert.equal(hits.length, 2, "both POST and PATCH must validate the interval");
  });

  it("migration 018 clamps existing rows then adds idempotent CHECKs", () => {
    const sql = fs.readFileSync(path.join(ROOT, "db", "018_recurrence_interval_check.sql"), "utf8");
    assert.match(sql, /UPDATE todos SET recurrence_interval = 1[\s\S]*?< 1/, "clamp precedes the constraint");
    assert.match(sql, /chk_todos_recurrence_interval/);
    assert.match(sql, /chk_todo_templates_recurrence_interval/);
    assert.match(sql, /IF NOT EXISTS \(SELECT 1 FROM pg_constraint/, "constraint adds must be idempotent (fatal-migration rule)");
  });
});
