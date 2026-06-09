// ============================================================================
// Per-sistant — Structured facts (Phase 2c) tests
// ============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supertest = require("supertest");

const vault = require("../services/vault-sync");
const rag = require("../routes/rag");
const { buildFactsQuery, factsToDocument } = require("../routes/rag");

describe("Facts — vault helpers", () => {
  it("isFactFile detects type fact/facts only", () => {
    assert.ok(vault.isFactFile({ type: "fact" }));
    assert.ok(vault.isFactFile({ type: "Facts" }));
    assert.ok(!vault.isFactFile({ type: "note" }));
    assert.ok(!vault.isFactFile({}));
  });

  it("normalizeDate accepts YYYY-MM-DD, rejects junk", () => {
    assert.equal(vault.normalizeDate("2026-09-01"), "2026-09-01");
    assert.equal(vault.normalizeDate("Sept 2026"), null);
    assert.equal(vault.normalizeDate(""), null);
  });

  it("extractFacts turns non-reserved keys into rows", () => {
    const meta = {
      type: "fact",
      entity: "Car Insurance",
      valid_from: "2025-09-01",
      valid_to: "bogus",
      sensitivity: "normal",
      tags: ["insurance"],
      provider: "Geico",
      deductible: "$1000",
      policy_number: "ABC123",
      empty: "",
    };
    const rows = vault.extractFacts(meta, "policies/car.md");
    const attrs = rows.map((r) => r.attribute).sort();
    assert.deepEqual(attrs, ["deductible", "policy_number", "provider"]); // reserved + empty excluded
    assert.equal(rows[0].entity, "Car Insurance");
    assert.equal(rows[0].valid_from, "2025-09-01");
    assert.equal(rows[0].valid_to, null); // "bogus" normalized away
    assert.equal(rows[0].source_ref, "policies/car.md");
  });

  it("extractFacts falls back to the file name for entity", () => {
    const rows = vault.extractFacts({ type: "fact", color: "blue" }, "misc/passport.md");
    assert.equal(rows[0].entity, "passport");
  });
});

describe("Facts — buildFactsQuery", () => {
  it("filters to current, normal-sensitivity facts and parameterizes terms", () => {
    const { sql, params } = buildFactsQuery("car deductible", 12);
    assert.match(sql, /FROM facts/);
    assert.match(sql, /sensitivity = 'normal'/);
    assert.match(sql, /valid_to IS NULL OR valid_to >= CURRENT_DATE/);
    assert.match(sql, /valid_from IS NULL OR valid_from <= CURRENT_DATE/);
    assert.deepEqual(params, ["%car%", "%deductible%", 12]);
  });
});

describe("Facts — factsToDocument", () => {
  it("returns null when empty", () => {
    assert.equal(factsToDocument([]), null);
    assert.equal(factsToDocument(null), null);
  });
  it("groups rows by entity into one authoritative doc", () => {
    const doc = factsToDocument([
      { entity: "Car Insurance", attribute: "deductible", value: "$1000", valid_to: null },
      { entity: "Car Insurance", attribute: "provider", value: "Geico", valid_to: "2026-09-01" },
    ]);
    assert.equal(doc.title, "Known facts (current)");
    assert.match(doc.content, /Car Insurance:/);
    assert.match(doc.content, /deductible: \$1000/);
    assert.match(doc.content, /provider: Geico \(valid until 2026-09-01\)/);
  });
});

describe("Facts — GET /api/rag/facts", () => {
  function makeApp(mockPool) {
    const app = express();
    app.use(express.json());
    app.use(rag({ pool: mockPool }));
    return app;
  }

  it("returns facts and excludes expired by default", async () => {
    let captured;
    const mockPool = {
      query: async (sql, params) => {
        captured = { sql, params };
        return { rows: [{ id: 1, entity: "Car Insurance", attribute: "deductible", value: "$1000" }] };
      },
    };
    const res = await supertest(makeApp(mockPool)).get("/api/rag/facts").expect(200);
    assert.equal(res.body.facts.length, 1);
    assert.match(captured.sql, /valid_to >= CURRENT_DATE/); // current-only by default
  });

  it("?all=1 includes expired (no validity filter)", async () => {
    let captured;
    const mockPool = { query: async (sql) => { captured = sql; return { rows: [] }; } };
    await supertest(makeApp(mockPool)).get("/api/rag/facts?all=1").expect(200);
    assert.ok(!/CURRENT_DATE/.test(captured), "all=1 should drop the validity filter");
  });

  it("degrades to empty when the facts table is missing", async () => {
    const mockPool = { query: async () => { throw new Error("no table"); } };
    const res = await supertest(makeApp(mockPool)).get("/api/rag/facts").expect(200);
    assert.deepEqual(res.body.facts, []);
  });
});

describe("Facts — verification (Phase 4)", () => {
  function makeApp(mockPool) {
    const app = express();
    app.use(express.json());
    app.use(rag({ pool: mockPool }));
    return app;
  }

  it("buildFactsQuery joins verification via an EXISTS subquery", () => {
    const { sql } = buildFactsQuery("x", 5);
    assert.match(sql, /fact_verifications/);
    assert.match(sql, /AS verified/);
  });

  it("factsToDocument annotates verified facts", () => {
    const doc = factsToDocument([{ entity: "Car", attribute: "deductible", value: "$1000", valid_to: null, verified: true }]);
    assert.match(doc.content, /deductible: \$1000 \[verified\]/);
  });

  it("POST /api/rag/facts/verify requires entity+attribute+value", async () => {
    await supertest(makeApp({ query: async () => ({ rows: [] }) }))
      .post("/api/rag/facts/verify").send({ entity: "Car" }).expect(400);
  });

  it("upserts when verified (default true)", async () => {
    let captured;
    const res = await supertest(makeApp({ query: async (sql, p) => { captured = { sql, p }; return { rows: [] }; } }))
      .post("/api/rag/facts/verify").send({ entity: "Car", attribute: "deductible", value: "$1000" }).expect(200);
    assert.equal(res.body.verified, true);
    assert.match(captured.sql, /INSERT INTO fact_verifications/);
    assert.deepEqual(captured.p, ["Car", "deductible", "$1000"]);
  });

  it("deletes when verified:false", async () => {
    let captured;
    const res = await supertest(makeApp({ query: async (sql, p) => { captured = { sql, p }; return { rows: [] }; } }))
      .post("/api/rag/facts/verify").send({ entity: "Car", attribute: "deductible", value: "$1000", verified: false }).expect(200);
    assert.equal(res.body.verified, false);
    assert.match(captured.sql, /DELETE FROM fact_verifications/);
  });
});
