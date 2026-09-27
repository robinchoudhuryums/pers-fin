// ============================================================================
// Broad-scan (Sept 2026) Batch 1 regression tests — Perfin side
// ============================================================================
// Pins the Perfin fixes from the Sept 2026 broad-scan Batch 1:
//   DC-1  — PATCH /api/transactions/bulk-category is reachable in the REAL
//           server.js mount order (not shadowed by PATCH /api/transactions/:id)
//   DC-3  — bill-calendar paid-state keys match whether pg returns paid_date
//           as a Date or a string
//   WD-1  — tax-report download links are basePath-aware
//   WUI-1 / WD-14 — no un-nonced <style> reaches the CSP (styleSrcElem is
//           nonce-only): no bare <style> in views, no runtime style injection
// (FAN-1 is pinned next to the other housing endpoint tests in housing.test.js.)
// ============================================================================

if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

const ROOT = path.join(__dirname, "..");
const dbModule = require("../teller/services/database");
const originalQuery = dbModule.pool.query;
afterEach(() => { dbModule.pool.query = originalQuery; });

// ---------------------------------------------------------------------------
// DC-1 — bulk-category not shadowed by /api/transactions/:id
// ---------------------------------------------------------------------------
describe("DC-1 — bulk-category route reachable in server.js mount order", () => {
  // Mount the two route modules that collide IN THE ORDER server.js mounts
  // them, so a future reorder that re-introduces the shadowing fails here.
  const serverSrc = fs.readFileSync(path.join(ROOT, "teller/server.js"), "utf8");
  const mountOrder = [...serverSrc.matchAll(/app\.use\(require\("\.\/routes\/([\w-]+)"\)\)/g)].map((m) => m[1]);

  it("server.js mounts categorize before subscriptions (which mounts transactions.js)", () => {
    const c = mountOrder.indexOf("categorize");
    const s = mountOrder.indexOf("subscriptions");
    assert.ok(c !== -1 && s !== -1, "both route modules are mounted");
    assert.ok(c < s, `categorize (${c}) must mount before subscriptions (${s})`);
  });

  it("PATCH /api/transactions/bulk-category reaches the bulk handler, not PATCH /:id", async () => {
    const app = express();
    app.use(express.json());
    for (const name of mountOrder.filter((n) => n === "categorize" || n === "subscriptions")) {
      app.use(require(`../teller/routes/${name}`));
    }
    let captured;
    dbModule.pool.query = async (sql, params) => {
      captured = { sql, params };
      return { rowCount: 2, rows: [{ transaction_id: "a" }, { transaction_id: "b" }] };
    };
    const res = await supertest(app)
      .patch("/api/transactions/bulk-category")
      .send({ transaction_ids: ["a", "b"], category: "Shopping" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { updated: 2 });
    assert.match(captured.sql, /SET user_category = \$1/);
    assert.deepEqual(captured.params, ["Shopping", ["a", "b"]]);
  });
});

// ---------------------------------------------------------------------------
// DC-3 — bill-calendar paid state
// ---------------------------------------------------------------------------
describe("DC-3 — bill-calendar paid-state key", () => {
  const { paidKey } = require("../teller/routes/subscriptions");

  it("normalizes a pg DATE (node-pg builds it as a JS Date at LOCAL midnight) to YYYY-MM-DD", () => {
    assert.equal(paidKey("subscription", 5, new Date(2026, 8, 1)), "subscription:5:2026-09-01");
    // The pre-fix key stringified the Date — prove the two forms now agree.
    assert.equal(paidKey("subscription", 5, new Date(2026, 8, 1)), paidKey("subscription", 5, "2026-09-01"));
  });

  it("passes a YYYY-MM-DD string through unchanged", () => {
    assert.equal(paidKey("manual", 3, "2026-09-15"), "manual:3:2026-09-15");
  });

  it("the calendar builds BOTH sides of the lookup with the same helper", () => {
    const src = fs.readFileSync(path.join(ROOT, "teller/routes/subscriptions.js"), "utf8");
    assert.match(src, /paidSet\.add\(paidKey\(/);
    assert.match(src, /paidSet\.has\(paidKey\(/);
  });
});

// ---------------------------------------------------------------------------
// WD-1 — tax-report links basePath-aware
// ---------------------------------------------------------------------------
describe("WD-1 — tax-report export links honor the basePath", () => {
  it("settings.ejs prefixes BASE_PATH on the tax-report href", () => {
    const src = fs.readFileSync(path.join(ROOT, "teller/views/settings.ejs"), "utf8");
    assert.doesNotMatch(src, /var base = '\/api\/export\/tax-report/);
    assert.match(src, /\(window\.BASE_PATH \|\| ''\) \+ '\/api\/export\/tax-report\?year='/);
  });
});

// ---------------------------------------------------------------------------
// WUI-1 / WD-14 — every <style> must carry the CSP nonce
// ---------------------------------------------------------------------------
describe("WUI-1 / WD-14 — no un-nonced <style> under the nonce-only styleSrcElem", () => {
  const viewsDir = path.join(ROOT, "teller/views");
  const files = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(".ejs")) files.push(p);
    }
  })(viewsDir);

  it("every <style> tag in teller/views carries nonce=\"<%= nonce %>\"", () => {
    const offenders = [];
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      // Treat EJS tags (`<%= … %>`) as opaque so their `%>` doesn't end the match.
      for (const m of src.matchAll(/<style\b(?:<%[\s\S]*?%>|[^>])*>/g)) {
        if (!/nonce="<%= nonce %>"/.test(m[0])) offenders.push(`${path.relative(ROOT, f)}: ${m[0]}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("public JS never injects a <style> element at runtime (it would be CSP-blocked)", () => {
    const pubDir = path.join(ROOT, "teller/public");
    const offenders = fs.readdirSync(pubDir)
      .filter((f) => f.endsWith(".js"))
      .filter((f) => /createElement\(\s*['"]style['"]\s*\)/.test(fs.readFileSync(path.join(pubDir, f), "utf8")));
    assert.deepEqual(offenders, []);
  });
});
