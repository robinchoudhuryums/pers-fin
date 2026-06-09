// ============================================================================
// Per-sistant — Cross-app finance grounding (Phase 3) tests
// ============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supertest = require("supertest");

const rag = require("../routes/rag");
const { looksFinancial, perfinFinanceSnapshot } = require("../routes/rag");

describe("Cross-app — looksFinancial", () => {
  it("matches finance-flavored queries", () => {
    assert.ok(looksFinancial("can I afford my insurance renewal?"));
    assert.ok(looksFinancial("what's my credit card balance"));
    assert.ok(looksFinancial("how much do I spend on subscriptions"));
    assert.ok(looksFinancial("is $500 too much"));
  });
  it("ignores non-finance queries", () => {
    assert.ok(!looksFinancial("what's my passport number"));
    assert.ok(!looksFinancial("when is my dentist appointment"));
  });
});

describe("Cross-app — perfinFinanceSnapshot", () => {
  it("returns null without a pool", async () => {
    assert.equal(await perfinFinanceSnapshot(null), null);
  });
  it("summarizes accounts + subscriptions", async () => {
    const perfinPool = {
      query: async (sql) => {
        if (/FROM linked_accounts/.test(sql)) {
          return { rows: [{ name: "Checking", type: "depository", current_balance: 2345.1, credit_limit: null }, { name: "Visa", type: "credit", current_balance: -540, credit_limit: 5000 }] };
        }
        if (/FROM detected_subscriptions/.test(sql)) {
          return { rows: [{ display_name: "Netflix", amount: 15.99, cadence_days: 30, next_expected: new Date(Date.now() + 3 * 86400000) }] };
        }
        return { rows: [] };
      },
    };
    const doc = await perfinFinanceSnapshot(perfinPool);
    assert.equal(doc.title, "Finances (from Perfin)");
    assert.match(doc.content, /Checking \(depository\): \$2,345.10/);
    assert.match(doc.content, /Visa \(credit\): -\$540.00, credit limit \$5,000.00/);
    assert.match(doc.content, /Active subscriptions: 1/);
    assert.match(doc.content, /Upcoming charges/);
  });
  it("returns null on DB error (schema-drift safe)", async () => {
    const perfinPool = { query: async () => { throw new Error("no such table"); } };
    assert.equal(await perfinFinanceSnapshot(perfinPool), null);
  });
});

describe("Cross-app — query injects a finance source", () => {
  function makeApp(mockPool, perfinPool) {
    const app = express();
    app.use(express.json());
    if (perfinPool) app.set("perfinPool", perfinPool);
    app.use(rag({ pool: mockPool }));
    return app;
  }

  it("adds a kind:finance source for finance queries when perfinPool is present", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY; // sources-only path (no AI call)
    try {
      const mockPool = {
        query: async (sql) => {
          if (/ai_model_rag as model/.test(sql)) return { rows: [{ model: "sonnet" }] };
          return { rows: [] }; // no corpus, no facts
        },
      };
      const perfinPool = {
        query: async (sql) => {
          if (/FROM linked_accounts/.test(sql)) return { rows: [{ name: "Checking", type: "depository", current_balance: 100, credit_limit: null }] };
          return { rows: [] };
        },
      };
      const res = await supertest(makeApp(mockPool, perfinPool)).post("/api/rag/query").send({ query: "can I afford this" }).expect(200);
      assert.ok(res.body.sources.some((s) => s.kind === "finance"), "expected a finance source");
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("does NOT add finance context for non-finance queries", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      let perfinQueried = false;
      const mockPool = {
        query: async (sql) => {
          if (/WITH corpus AS/.test(sql)) return { rows: [{ id: "1", title: "Trip notes", content: "Visit Rome.", kind: "note", updated_at: new Date(), score: 1 }] };
          if (/ai_model_rag as model/.test(sql)) return { rows: [{ model: "sonnet" }] };
          return { rows: [] };
        },
      };
      const perfinPool = { query: async () => { perfinQueried = true; return { rows: [] }; } };
      const res = await supertest(makeApp(mockPool, perfinPool)).post("/api/rag/query").send({ query: "where should I visit in Rome" }).expect(200);
      assert.ok(!res.body.sources.some((s) => s.kind === "finance"));
      assert.equal(perfinQueried, false, "perfinPool must not be touched for non-finance queries");
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
