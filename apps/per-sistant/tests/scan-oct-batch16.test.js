// ============================================================================
// Oct 2026 broad scan (cycle 7) — Batch 16: the notes privacy tier (F134 / ST5)
// ============================================================================
// notes.sensitivity (normal | private | secret, db/028). Only 'normal' notes
// are embedded, keyword- or vector-retrieved for Knowledge, or put in the Ask
// context; AI tagging refuses the others; a note leaving 'normal' loses its
// chunks at once; a secret note's text is masked in lists and labels; an
// outside webhook never gets a private note's text. The database-backed half
// lives in the root tests/contract/batch16.contract.test.js.
// ============================================================================

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

const config = require("../config");
const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

function appWith(router) {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}
const notesRouter = (pool) => require("../routes/notes")({ pool, config, helpers: { runAutomations: async () => {} } });

describe("F134 — the notes privacy tier", () => {
  it("the migration adds notes.sensitivity with a CHECK; config lists the tiers", () => {
    const sql = read("db", "028_note_sensitivity.sql");
    assert.match(sql, /ADD COLUMN IF NOT EXISTS sensitivity TEXT NOT NULL DEFAULT 'normal'/);
    assert.match(sql, /CHECK \(sensitivity IN \('normal', 'private', 'secret'\)\)/);
    assert.match(sql, /IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'chk_notes_sensitivity'\)/);
    assert.deepEqual(config.VALID_NOTE_SENSITIVITIES, ["normal", "private", "secret"]);
  });

  it("POST / PATCH validate sensitivity and store it", async () => {
    const calls = [];
    const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: 7, sensitivity: params && params[params.length - 2] === "private" ? "private" : "normal" }] }; } };
    const app = appWith(notesRouter(pool));
    await supertest(app).post("/api/notes").send({ content: "x", sensitivity: "hidden" }).expect(400);
    await supertest(app).patch("/api/notes/7").send({ sensitivity: "PRIVATE" }).expect(400);
    assert.equal(calls.length, 0);
    await supertest(app).post("/api/notes").send({ content: "acct 1234", sensitivity: "secret" }).expect(200);
    assert.match(calls[0].sql, /INSERT INTO notes \(title, content, pinned, color, reminder_at, tags, format, sensitivity\)/);
    assert.equal(calls[0].params[7], "secret");
    calls.length = 0;
    await supertest(app).post("/api/notes").send({ content: "plain" }).expect(200);
    assert.equal(calls[0].params[7], "normal", "the default tier");
  });

  it("a note made private loses its Knowledge chunks immediately; a normal edit doesn't touch them", async () => {
    const calls = [];
    const make = (tier) => ({ query: async (sql, params) => {
      calls.push(sql);
      if (/^UPDATE notes SET/.test(sql)) return { rows: [{ id: 7, sensitivity: tier }] };
      if (/DELETE FROM chunks/.test(sql)) { const e = new Error("relation \"chunks\" does not exist"); e.code = "42P01"; throw e; }
      return { rows: [], rowCount: 0 };
    } });
    await supertest(appWith(notesRouter(make("private")))).patch("/api/notes/7").send({ sensitivity: "private" }).expect(200);
    assert.ok(calls.some((s) => /DELETE FROM embed_state WHERE source_kind = 'note' AND source_id = \$1/.test(s)));
    assert.ok(calls.some((s) => /DELETE FROM chunks WHERE source_kind = 'note' AND source_id = \$1/.test(s)),
      "no chunks table (no pgvector) is not an error");
    calls.length = 0;
    await supertest(appWith(notesRouter(make("normal")))).patch("/api/notes/7").send({ title: "t" }).expect(200);
    assert.ok(!calls.some((s) => /DELETE FROM/.test(s)));
  });

  it("only normal notes are embedded, and the rest are pruned like deleted ones", async () => {
    const embeddings = require("../services/embeddings");
    const vault = require("../services/vault-sync");
    const orig = embeddings.isConfigured;
    embeddings.isConfigured = () => true;
    const seen = [];
    const pool = { query: async (sql) => {
      seen.push(sql);
      if (/to_regclass/.test(sql)) return { rows: [{ t: "chunks" }] };
      return { rows: [], rowCount: 0 };
    } };
    try {
      const r = await vault.syncNotes(pool);
      assert.equal(r.ok, true);
    } finally { embeddings.isConfigured = orig; }
    assert.ok(seen.includes("SELECT id, title, content FROM notes WHERE deleted_at IS NULL AND sensitivity = 'normal'"));
    for (const t of ["chunks", "embed_state"]) {
      assert.ok(seen.includes(`DELETE FROM ${t} WHERE source_kind = 'note' AND source_id NOT IN (SELECT id FROM notes WHERE deleted_at IS NULL AND sensitivity = 'normal')`), t);
    }
  });

  it("Knowledge retrieval (keyword + vector) reads normal notes only", () => {
    const rag = require("../routes/rag");
    const { sql } = rag.buildRetrievalQuery("insurance policy", 5);
    assert.match(sql, /FROM notes WHERE deleted_at IS NULL AND sensitivity = 'normal'/);
    assert.match(read("routes", "rag.js"), /c\.source_kind = 'note' AND n\.id IS NOT NULL AND n\.deleted_at IS NULL AND n\.sensitivity = 'normal'/);
  });

  it("Ask's context lists normal notes only, and AI tagging refuses private / secret", async () => {
    assert.match(read("routes", "ai.js"),
      /FROM notes WHERE deleted_at IS NULL AND sensitivity = 'normal' ORDER BY updated_at DESC LIMIT 20/);
    const ai = require("../ai");
    const orig = { model: ai.getAIModelForFeature, call: ai.cappedAI };
    let called = false;
    ai.getAIModelForFeature = async () => "haiku";
    ai.cappedAI = async () => { called = true; return { text: "[\"x\"]" }; };
    try {
      const router = require("../routes/ai")({ pool: { query: async () => ({ rows: [] }) }, config, helpers: {} });
      const app = appWith(router);
      const r = await supertest(app).post("/api/ai/suggest-tags").send({ content: "acct 1234", sensitivity: "secret" });
      assert.equal(r.status, 400);
      assert.equal(called, false, "the private text never reached the model");
    } finally { ai.getAIModelForFeature = orig.model; ai.cappedAI = orig.call; }
    assert.match(read("pages", "notes.js"), /if \(sensitivity !== 'normal'\) return alert\('AI tagging is off for private and secret notes\.'\);/);
  });

  it("a secret note's text is masked in search, labels and the list; a webhook never gets a private note's text", async () => {
    assert.match(read("routes", "search.js"), /CASE WHEN sensitivity = 'secret' THEN NULL ELSE LEFT\(content, 100\) END as description/);
    assert.match(read("routes", "search.js"), /\(title ILIKE \$1 OR \(sensitivity <> 'secret' AND content ILIKE \$1\)\)/);
    for (const f of ["links.js", "calendar.js", "notifications.js", "trash.js"]) {
      const src = read("routes", f);
      assert.match(src, /CASE WHEN sensitivity = 'secret' THEN 'Secret note' ELSE LEFT\(content, \d+\) END/, f);
      assert.doesNotMatch(src, /COALESCE\(title, LEFT\(content/, f);
    }
    assert.match(read("helpers.js"), /COALESCE\(title, CASE WHEN sensitivity = 'normal' THEN LEFT\(content, 50\) ELSE 'Private note' END\) AS title/);
    let page = "";
    await supertest(appWith(express.Router().get("/notes", require("../pages/notes")()))).get("/notes")
      .expect(200).then((r) => { page = r.text; });
    assert.match(page, /<select id="n-sensitivity">/);
    assert.match(page, /Hidden — open the note to view it\./);
    assert.match(page, /sensitivity: document\.getElementById\('n-sensitivity'\)\.value/);
  });
});
