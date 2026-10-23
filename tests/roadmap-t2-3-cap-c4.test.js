// ============================================================================
// Roadmap T2.3 C4 — Perfin's side of the side-by-side AI spend
// ============================================================================
// persistentAiSpend reads Per-sistant's month spend + cap through the wired
// persistentPool with Per-sistant's own ai.js (one definition of that spend),
// null standalone and null on a failure; GET /api/insights/status carries it
// as persistent_ai; the Settings AI card renders it as one read-only line.
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
const quiet = async (fn) => { const o = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = o; } };

// A Per-sistant pool: its budget setting and this month's ai_usage SUM.
function persistentPool({ budget = 300, spent = "87.654", throws = false } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (throws) throw new Error("persistent db down");
      if (/ai_monthly_budget_cents FROM user_settings/.test(sql)) return { rows: [{ ai_monthly_budget_cents: budget }] };
      if (/FROM ai_usage/.test(sql)) return { rows: [{ c: spent }] };
      return { rows: [] };
    },
  };
}

describe("persistentAiSpend", () => {
  let insights;
  before(() => { insights = require("../teller/routes/insights"); });

  it("null standalone (no persistentPool)", async () => {
    assert.equal(await insights.persistentAiSpend(null), null);
    assert.equal(await insights.persistentAiSpend(undefined), null);
  });

  it("Per-sistant's own spend + cap, both read through the pool it is given", async () => {
    const p = persistentPool();
    assert.deepEqual(await insights.persistentAiSpend(p), { spent_cents: 87.65, budget_cents: 300 });
    const usage = p.calls.find((c) => /FROM ai_usage/.test(c.sql));
    assert.match(usage.sql, /SUM\(cost_cents\).*created_at >= \(\$1::date::timestamp AT TIME ZONE \$2\)/);
    assert.ok(p.calls.some((c) => /ai_monthly_budget_cents FROM user_settings/.test(c.sql)), "the budget comes from Per-sistant's settings, not Perfin's");
  });

  it("an unreadable Per-sistant ledger → null (the Perfin card is unaffected)", async () => {
    assert.equal(await quiet(() => insights.persistentAiSpend(persistentPool({ throws: true }))), null);
  });
});

describe("GET /api/insights/status carries persistent_ai", () => {
  let dbModule, originalQuery, insights;
  before(() => {
    dbModule = require("../teller/services/database");
    originalQuery = dbModule.pool.query;
    insights = require("../teller/routes/insights");
  });
  afterEach(() => { dbModule.pool.query = originalQuery; });

  function app(psPool) {
    dbModule.pool.query = async () => ({ rows: [] });
    const a = express();
    if (psPool) a.set("persistentPool", psPool);
    a.use(insights);
    return a;
  }

  it("embedded: the Per-sistant figures; standalone: null", async () => {
    const r = await quiet(() => supertest(app(persistentPool({ budget: 500, spent: "12" }))).get("/api/insights/status").expect(200));
    assert.deepEqual(r.body.persistent_ai, { spent_cents: 12, budget_cents: 500 });
    const r2 = await quiet(() => supertest(app(null)).get("/api/insights/status").expect(200));
    assert.equal(r2.body.persistent_ai, null);
    assert.equal(typeof r2.body.budget_cents, "number", "Perfin's own fields unchanged");
  });
});

describe("Perfin Settings → the Per-sistant line", () => {
  const ejs = fs.readFileSync(path.join(ROOT, "teller/views/settings.ejs"), "utf8");
  it("a hidden line under the budget cap, filled only when persistent_ai is present", () => {
    assert.ok(ejs.includes('<div class="desc" id="persistent-ai-spend" hidden></div>'));
    assert.match(ejs, /if \(psEl && st\.persistent_ai\) \{\s*psEl\.textContent = 'Per-sistant \(its own cap, set in Per-sistant \\u2192 Settings\): \$' \+ \(st\.persistent_ai\.spent_cents \/ 100\)\.toFixed\(2\) \+ ' of \$' \+ \(st\.persistent_ai\.budget_cents \/ 100\)\.toFixed\(2\) \+ ' this month\.';\s*psEl\.hidden = false;/);
  });
});
