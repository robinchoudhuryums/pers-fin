// ============================================================================
// Per-sistant — Knowledge answer cache (Phase 2) tests
// ============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { normalizeQuery, corpusVersion, cacheGet, cacheSet } = require("../routes/rag");

describe("Cache — normalizeQuery", () => {
  it("trims, lowercases, and collapses whitespace", () => {
    assert.equal(normalizeQuery("  Hello   World \n"), "hello world");
    assert.equal(normalizeQuery("SAME query"), normalizeQuery("same    query"));
  });
});

describe("Cache — corpusVersion", () => {
  it("combines max(updated_at) and active row count", async () => {
    const pool = { query: async () => ({ rows: [{ v: "20260101120000", n: "7" }] }) };
    assert.equal(await corpusVersion(pool), "20260101120000:7");
  });
  it("returns '0' on error", async () => {
    const pool = { query: async () => { throw new Error("boom"); } };
    assert.equal(await corpusVersion(pool), "0");
  });
});

describe("Cache — cacheGet", () => {
  it("returns null when there is no row", async () => {
    const pool = { query: async () => ({ rows: [] }) };
    assert.equal(await cacheGet(pool, "q", "sonnet", "v"), null);
  });
  it("returns the row when fresh", async () => {
    const pool = { query: async () => ({ rows: [{ answer: "A", sources: [{ n: 1 }], created_at: new Date() }] }) };
    const r = await cacheGet(pool, "q", "sonnet", "v");
    assert.equal(r.answer, "A");
    assert.deepEqual(r.sources, [{ n: 1 }]);
  });
  it("returns null when older than the TTL", async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const pool = { query: async () => ({ rows: [{ answer: "A", sources: [], created_at: old }] }) };
    assert.equal(await cacheGet(pool, "q", "sonnet", "v"), null);
  });
  it("returns null (no throw) on DB error", async () => {
    const pool = { query: async () => { throw new Error("no table"); } };
    assert.equal(await cacheGet(pool, "q", "sonnet", "v"), null);
  });
});

describe("Cache — cacheSet", () => {
  it("upserts on (query_norm, model, corpus_version)", async () => {
    let captured;
    const pool = { query: async (sql, params) => { captured = { sql, params }; return {}; } };
    await cacheSet(pool, "q", "sonnet", "v", "the answer", [{ n: 1, cited: true }]);
    assert.match(captured.sql, /INSERT INTO rag_answer_cache/);
    assert.match(captured.sql, /ON CONFLICT \(query_norm, model, corpus_version\)/);
    assert.equal(captured.params[0], "q");
    assert.equal(captured.params[3], "the answer");
    assert.equal(captured.params[4], JSON.stringify([{ n: 1, cited: true }]));
  });
  it("swallows write errors", async () => {
    const pool = { query: async () => { throw new Error("nope"); } };
    await cacheSet(pool, "q", "sonnet", "v", "a", []); // must not throw
  });
});
