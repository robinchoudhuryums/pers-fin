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
const { buildRetrievalQuery, stripMermaidFences } = require("../routes/rag");
const { answerWithCitations } = require("../ai");

describe("Knowledge — buildRetrievalQuery", () => {
  it("parameterizes terms and unions notes + documents", () => {
    const { sql, params } = buildRetrievalQuery("car insurance", 8);
    assert.match(sql, /WITH corpus AS/);
    assert.match(sql, /FROM notes WHERE deleted_at IS NULL/);
    assert.match(sql, /FROM documents WHERE deleted_at IS NULL/);
    assert.match(sql, /UNION ALL/);
    assert.deepEqual(params, ["%car%", "%insurance%", 8]);
  });

  it("only retrieves normal-sensitivity documents (private/secret excluded)", () => {
    const { sql } = buildRetrievalQuery("anything", 5);
    assert.match(sql, /sensitivity = 'normal'/);
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

describe("Citations — answerWithCitations", () => {
  it("assembles text, collects cited indexes, and sends citation-enabled docs", async () => {
    let captured;
    const client = {
      messages: {
        create: async (p) => {
          captured = p;
          return {
            content: [
              { type: "text", text: "Grass is green " },
              { type: "text", text: "and the sky is blue", citations: [{ type: "char_location", cited_text: "The sky is blue.", document_index: 1, start_char_index: 0, end_char_index: 16 }] },
              { type: "text", text: " per the first source", citations: [{ type: "char_location", cited_text: "green", document_index: 0 }] },
            ],
          };
        },
      },
    };
    const out = await answerWithCitations({
      model: "sonnet",
      system: "sys",
      query: "colors?",
      documents: [{ title: "A", content: "The grass is green." }, { title: "B", content: "The sky is blue." }],
      client,
    });
    assert.equal(out.text, "Grass is green and the sky is blue per the first source");
    assert.deepEqual(out.citedIndexes, [0, 1]);
    // request shape: 2 document blocks + 1 question text block
    const content = captured.messages[0].content;
    assert.equal(content.length, 3);
    assert.equal(content[0].type, "document");
    assert.equal(content[0].source.type, "text");
    assert.equal(content[0].source.media_type, "text/plain");
    assert.equal(content[0].citations.enabled, true);
    assert.equal(content[2].type, "text");
    assert.equal(content[2].text, "colors?");
    assert.equal(captured.system, "sys");
  });

  it("rejects an unknown model", async () => {
    await assert.rejects(() =>
      answerWithCitations({ model: "bogus", query: "x", documents: [], client: { messages: { create: async () => ({ content: [] }) } } })
    );
  });
});

describe("Diagram — stripMermaidFences", () => {
  it("removes ```mermaid fences", () => {
    assert.equal(stripMermaidFences("```mermaid\nflowchart TD\nA-->B\n```"), "flowchart TD\nA-->B");
  });
  it("removes bare ``` fences", () => {
    assert.equal(stripMermaidFences("```\ngraph LR\n```"), "graph LR");
  });
  it("leaves unfenced content alone", () => {
    assert.equal(stripMermaidFences("flowchart TD"), "flowchart TD");
  });
});

describe("Secret tier — GET /api/rag/secret-lookup", () => {
  it("requires a query", async () => {
    await supertest(makeApp({ query: async () => ({ rows: [] }) }))
      .get("/api/rag/secret-lookup").expect(400);
  });

  it("returns secret docs + facts verbatim, filtered to sensitivity='secret'", async () => {
    const seen = [];
    const mockPool = {
      query: async (sql) => {
        seen.push(sql);
        if (/FROM documents/.test(sql)) return { rows: [{ title: "Bank", content: "acct 12345678" }] };
        if (/FROM facts/.test(sql)) return { rows: [{ entity: "Wifi", attribute: "password", value: "hunter2" }] };
        return { rows: [] };
      },
    };
    const res = await supertest(makeApp(mockPool)).get("/api/rag/secret-lookup?q=acct").expect(200);
    assert.equal(res.body.results.length, 2);
    assert.ok(res.body.results.some((r) => r.kind === "document" && /12345678/.test(r.content)));
    assert.ok(res.body.results.some((r) => r.kind === "fact" && r.content === "hunter2"));
    assert.ok(seen.every((s) => /sensitivity = 'secret'/.test(s)), "both lookups must filter to secret");
  });

  it("guards the AI path: retrieval builders never include secret/private", () => {
    // The only path that surfaces secret content is secret-lookup (no model
    // call). The AI retrieval builders require sensitivity = 'normal'.
    assert.match(buildRetrievalQuery("x", 5).sql, /sensitivity = 'normal'/);
  });
});

describe("Diagram — POST /api/rag/diagram", () => {
  it("requires a query", async () => {
    await supertest(makeApp({ query: async () => ({ rows: [] }) }))
      .post("/api/rag/diagram").send({}).expect(400);
  });

  it("returns mermaid:null with sources when AI is unavailable", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const mockPool = {
        query: async (sql) => {
          if (/WITH corpus AS/.test(sql)) return { rows: [{ id: "1", title: "Accounts", content: "Checking, Savings, Visa.", kind: "note", updated_at: new Date(), score: 1 }] };
          if (/ai_model_rag as model/.test(sql)) return { rows: [{ model: "sonnet" }] };
          return { rows: [] };
        },
      };
      const res = await supertest(makeApp(mockPool)).post("/api/rag/diagram").send({ query: "map my accounts" }).expect(200);
      assert.equal(res.body.mermaid, null);
      assert.ok(res.body.sources.length >= 1);
      assert.ok(res.body.note);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
