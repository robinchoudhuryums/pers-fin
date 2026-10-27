// Real-Postgres contract tests for cycle-7 Batch 16 (Per-sistant side):
//  F134 / ST5 — the notes privacy tier. db/028 adds notes.sensitivity; a
//  private or secret note never reaches Knowledge retrieval, a note flipped to
//  private loses its chunks / embed_state, a secret note's text is masked in
//  search, and the tier is validated by the database CHECK as well as the route.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const supertest = require("supertest");
const { SKIP, persistentDb, persistentApp } = require("./_setup");

describe("Notes privacy tier on real Postgres", { skip: SKIP }, () => {
  let pool, app, rag, vault;
  const q = (s, p) => pool.query(s, p);
  let normalId, privateId, secretId;

  before(async () => {
    delete process.env.VOYAGE_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    pool = await persistentDb("batch16");
    app = persistentApp(pool);
    rag = require("../../apps/per-sistant/routes/rag");
    vault = require("../../apps/per-sistant/services/vault-sync");
    await q("INSERT INTO user_settings (id) VALUES (1) ON CONFLICT DO NOTHING");
    normalId = (await supertest(app).post("/api/notes").send({ title: "Garden", content: "Zucchini needs watering" }).expect(200)).body.id;
    privateId = (await supertest(app).post("/api/notes").send({ title: "Clinic", content: "Zucchini allergy test results", sensitivity: "private" }).expect(200)).body.id;
    secretId = (await supertest(app).post("/api/notes").send({ content: "Zucchini vault code 4417", sensitivity: "secret" }).expect(200)).body.id;
  });
  after(async () => { if (pool) await pool.end(); });

  it("the column defaults to normal and the CHECK refuses an unknown tier", async () => {
    const rows = Object.fromEntries((await q("SELECT id, sensitivity FROM notes")).rows.map((r) => [r.id, r.sensitivity]));
    assert.deepEqual([rows[normalId], rows[privateId], rows[secretId]], ["normal", "private", "secret"]);
    await assert.rejects(q("UPDATE notes SET sensitivity = 'public' WHERE id = $1", [normalId]), /chk_notes_sensitivity/);
    await supertest(app).patch("/api/notes/" + normalId).send({ sensitivity: "public" }).expect(400);
  });

  it("keyword retrieval returns the normal note only", async () => {
    const { sql, params } = rag.buildRetrievalQuery("zucchini", 10);
    const hits = (await q(sql, params)).rows.filter((r) => r.kind === "note").map((r) => Number(r.id));
    assert.deepEqual(hits, [normalId]);
    const res = await supertest(app).get("/api/rag/search").query({ q: "zucchini" }).expect(200);
    const text = JSON.stringify(res.body);
    assert.ok(text.includes("Zucchini needs watering"));
    assert.ok(!text.includes("allergy") && !text.includes("4417"), "no private or secret note text in Knowledge results");
  });

  it("global search masks a secret note's text and doesn't match on it", async () => {
    const byCode = (await supertest(app).get("/api/search").query({ q: "4417" }).expect(200)).body;
    assert.deepEqual(byCode.filter((r) => r.type === "note"), [], "a secret note doesn't match on its text");
    const all = (await supertest(app).get("/api/search").query({ q: "zucchini" }).expect(200)).body;
    const notes = all.filter((r) => r.type === "note");
    assert.deepEqual(notes.map((r) => r.id).sort(), [normalId, privateId].sort(),
      "a private note is still the user's — search shows it; the secret one doesn't match");
    assert.ok(!JSON.stringify(all).includes("vault code"));
  });

  it("a note made private loses its chunks and embed_state", async () => {
    await q(`INSERT INTO embed_state (source_kind, source_id, content_sha, chunk_count, embedded_at)
             VALUES ('note', $1, 'x', 1, now())`, [normalId]);
    const hasChunks = (await q("SELECT to_regclass('public.chunks') AS t")).rows[0].t;
    if (hasChunks) {
      await q(`INSERT INTO chunks (source_kind, source_id, chunk_index, content) VALUES ('note', $1, 0, 'Zucchini needs watering')`, [normalId]);
    }
    await supertest(app).patch("/api/notes/" + normalId).send({ sensitivity: "private" }).expect(200);
    assert.equal((await q("SELECT count(*)::int AS n FROM embed_state WHERE source_kind = 'note' AND source_id = $1", [normalId])).rows[0].n, 0);
    if (hasChunks) {
      assert.equal((await q("SELECT count(*)::int AS n FROM chunks WHERE source_kind = 'note' AND source_id = $1", [normalId])).rows[0].n, 0);
    }
    // syncNotes prunes too (e.g. a row flipped by hand) — it only runs with embeddings configured.
    const r = await vault.syncNotes(pool);
    assert.equal(r.reason || "ok", r.ok ? "ok" : "not_ready");
  });
});
