// ============================================================================
// Per-sistant — Knowledge / RAG (Phase 0) tests
// ============================================================================
// Covers the pure retrieval-query builder and the two endpoints via a mock
// pool + supertest. No DB or API key required.
// ============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supertest = require("supertest");

const ragFactory = require("../routes/rag");
const { buildRetrievalQuery } = require("../routes/rag");

describe("Knowledge — buildRetrievalQuery", () => {
  it("parameterizes terms and unions notes + documents", () => {
    const { sql, params } = buildRetrievalQuery("car insurance", 8);
    assert.match(sql, /WITH corpus AS/);
    assert.match(sql, /FROM notes WHERE deleted_at IS NULL/);
    assert.match(sql, /FROM documents WHERE deleted_at IS NULL/);
    assert.match(sql, /UNION ALL/);
    assert.deepEqual(params, ["%car%", "%insurance%", 8]);
  });

  it("excludes secret-sensitivity documents from the corpus", () => {
    const { sql } = buildRetrievalQuery("anything", 5);
    assert.match(sql, /sensitivity <> 'secret'/);
  });

  it("drops sub-3-char tokens, falling back to the whole query", () => {
    const { params } = buildRetrievalQuery("a to be", 5);
    assert.deepEqual(params, ["%a to be%", 5]);
  });

  it("caps at 8 search terms", () => {
    const q = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
    const { params } = buildRetrievalQuery(q, 8);
    // 8 term placeholders + 1 limit placeholder
    assert.equal(params.length, 9);
  });
});

function makeApp(mockPool) {
  const app = express();
  app.use(express.json());
  app.use(ragFactory({ pool: mockPool }));
  return app;
}

describe("Knowledge — GET /api/rag/search", () => {
  it("requires a query", async () => {
    await supertest(makeApp({ query: async () => ({ rows: [] }) }))
      .get("/api/rag/search")
      .expect(400);
  });

  it("returns mapped results from the corpus", async () => {
    const mockPool = {
      query: async (sql) => {
        if (/WITH corpus AS/.test(sql)) {
          return { rows: [{ id: "3", title: "Auto policy", content: "Deductible is $1000.", kind: "note", updated_at: new Date(), score: 3 }] };
        }
        return { rows: [] };
      },
    };
    const res = await supertest(makeApp(mockPool)).get("/api/rag/search?q=deductible").expect(200);
    assert.equal(res.body.results.length, 1);
    assert.equal(res.body.results[0].kind, "note");
    assert.equal(res.body.results[0].title, "Auto policy");
  });
});

describe("Knowledge — POST /api/rag/query", () => {
  it("requires a query", async () => {
    await supertest(makeApp({ query: async () => ({ rows: [] }) }))
      .post("/api/rag/query").send({}).expect(400);
  });

  it("returns a no-match note (no answer, no sources) when nothing matches", async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const res = await supertest(makeApp(mockPool)).post("/api/rag/query").send({ query: "nonexistent" }).expect(200);
    assert.equal(res.body.answer, null);
    assert.deepEqual(res.body.sources, []);
    assert.ok(res.body.note);
  });

  it("returns sources without an answer when AI is unavailable", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY; // force isAIAvailable() false
    try {
      const mockPool = {
        query: async (sql) => {
          if (/WITH corpus AS/.test(sql)) {
            return { rows: [{ id: "3", title: "Auto policy", content: "Deductible is $1000.", kind: "note", updated_at: new Date(), score: 3 }] };
          }
          if (/ai_model_rag as model/.test(sql)) return { rows: [{ model: "sonnet" }] };
          return { rows: [] };
        },
      };
      const res = await supertest(makeApp(mockPool)).post("/api/rag/query").send({ query: "deductible" }).expect(200);
      assert.equal(res.body.answer, null);
      assert.equal(res.body.sources.length, 1);
      assert.equal(res.body.sources[0].n, 1);
      assert.ok(res.body.note);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
