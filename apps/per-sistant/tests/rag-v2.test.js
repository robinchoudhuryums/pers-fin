// ============================================================================
// RAG v2 — hybrid retrieval (RRF) + semantic answer cache
// ============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { fuseRetrieval, semanticCacheGet } = require("../routes/rag");

describe("RAG v2 — fuseRetrieval (Reciprocal Rank Fusion)", () => {
  const row = (kind, id) => ({ kind, id: String(id), title: kind + id, content: "c" });

  it("items found by BOTH legs outrank single-leg items", () => {
    const vec = [row("document", 1), row("document", 2)];
    const kw = [row("note", 9), row("document", 2)];
    const fused = fuseRetrieval(vec, kw, 10);
    assert.equal(fused[0].id, "2", "double-leg hit ranks first despite lower per-leg ranks");
    assert.equal(fused.length, 3);
  });

  it("dedupes by kind:id (multiple chunks of one document collapse)", () => {
    const vec = [row("document", 5), row("document", 5), row("document", 5)];
    const fused = fuseRetrieval(vec, [], 10);
    assert.equal(fused.length, 1);
  });

  it("same numeric id across kinds does NOT collide", () => {
    const fused = fuseRetrieval([row("document", 3)], [row("note", 3)], 10);
    assert.equal(fused.length, 2);
  });

  it("respects the limit and tolerates empty/null legs", () => {
    const many = Array.from({ length: 20 }, (_, i) => row("note", i));
    assert.equal(fuseRetrieval(many, [], 8).length, 8);
    assert.deepEqual(fuseRetrieval([], [], 5), []);
    assert.deepEqual(fuseRetrieval(null, null, 5), []);
  });

  it("retrieve() runs both legs — no early return on vector results", () => {
    const src = fs.readFileSync(path.join(ROOT, "routes", "rag.js"), "utf8");
    const ret = src.slice(src.indexOf("async function retrieve"), src.indexOf("async function embedQuerySafe"));
    assert.ok(!/if \(r\.rows\.length\) return r\.rows/.test(ret), "old vector-first early return removed");
    assert.match(ret, /fuseRetrieval\(vecRows, kwRows, limit\)/);
  });
});

describe("RAG v2 — semantic answer cache", () => {
  function pool(rows) { return { query: async () => ({ rows }) }; }

  it("hits when similarity >= 0.97 and fresh", async () => {
    const r = await semanticCacheGet(
      pool([{ answer: "a", sources: [], created_at: new Date().toISOString(), sim: "0.984" }]),
      "[0.1]", "sonnet", "v1"
    );
    assert.equal(r.answer, "a");
  });

  it("misses below the similarity floor", async () => {
    const r = await semanticCacheGet(
      pool([{ answer: "a", sources: [], created_at: new Date().toISOString(), sim: "0.95" }]),
      "[0.1]", "sonnet", "v1"
    );
    assert.equal(r, null);
  });

  it("misses when the cached row is older than the TTL", async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const r = await semanticCacheGet(
      pool([{ answer: "a", sources: [], created_at: old, sim: "0.99" }]),
      "[0.1]", "sonnet", "v1"
    );
    assert.equal(r, null);
  });

  it("swallows errors (pre-019 schema / no pgvector → exact-match only)", async () => {
    const r = await semanticCacheGet({ query: async () => { throw new Error("no column"); } }, "[0.1]", "s", "v");
    assert.equal(r, null);
  });

  it("query handler embeds once and shares it (retrieval + cache + write)", () => {
    const src = fs.readFileSync(path.join(ROOT, "routes", "rag.js"), "utf8");
    assert.match(src, /const qvec = await embedQuerySafe\(query\);/);
    assert.match(src, /retrieve\(query, MAX_SOURCES, qvec\)/);
    assert.match(src, /semanticCacheGet\(pool, embeddings\.toVectorLiteral\(qvec\), model, ver\)/);
    assert.match(src, /cacheSet\(pool, qn, model, ver, answer, finalSources, qvec \? embeddings\.toVectorLiteral\(qvec\) : null\)/);
  });

  it("migration 019 adds the embedding column defensively (INV-28 posture)", () => {
    const sql = fs.readFileSync(path.join(ROOT, "db", "019_semantic_cache.sql"), "utf8");
    assert.match(sql, /IF EXISTS \(SELECT 1 FROM pg_available_extensions WHERE name = 'vector'\)/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS query_embedding vector\(1024\)/);
  });
});
