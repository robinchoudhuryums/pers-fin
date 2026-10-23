// ============================================================================
// Roadmap T2.3 C3 — Knowledge's answer, diagram and capture on the capped wrappers
// ============================================================================
// /api/rag/query: under the cap one rag_query row; a refused Citations call
// charged and its prompt-cite fallback charged as a second row (decision 6);
// over the cap (before either call, or before the fallback) the matching
// sources with ai_cap and a note — no model call, nothing cached; an unreadable
// spend the same with ai_cap_check_failed; a cached answer free even over the cap.
// /api/rag/diagram: rag_diagram charged; over the cap 429 { ai_cap }, an
// unreadable spend 503. /api/rag/capture: rag_capture charged; over the cap the
// raw note is committed with ai_cap + a note; a secret capture never reads the cap.
// ============================================================================
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supertest = require("supertest");

delete process.env.VOYAGE_API_KEY; // keyword retrieval only — no embedding call

// Stub the AI module BEFORE routes/rag.js captures its exports.
const ai = require("../ai");
ai.getAIModelForFeature = async () => "sonnet";
ai.isAIAvailable = () => true;
let state;
function reset() {
  state = { budget: 100, spent: [0], spentThrows: false, reads: 0, charged: [], calls: [], citations: null, reply: "{}" };
}
reset();
ai.getAiBudgetCents = async () => state.budget;
ai.monthlyAiSpendCents = async () => {
  state.reads++;
  if (state.spentThrows) throw new Error("db down");
  return state.spent.length > 1 ? state.spent.shift() : state.spent[0];
};
ai.recordAiUsage = async (_p, row) => { state.charged.push(row); return 0; };
ai.answerWithCitations = async () => {
  state.calls.push("citations");
  const c = state.citations || { text: "It is red [1].", citedIndexes: [0], stop_reason: "end_turn", usage: { input_tokens: 300, output_tokens: 20 } };
  if (c.throw) { const e = new Error(c.throw); if (c.usage) e.usage = c.usage; throw e; }
  return c;
};
ai.callAIWithUsage = async (model, prompt, maxTokens, system, _client, opts = {}) => {
  state.calls.push("callAI");
  if (opts.meta) opts.meta.stop_reason = "end_turn";
  return { text: state.reply, usage: { input_tokens: 50, output_tokens: 10 }, stop_reason: "end_turn" };
};

const vault = require("../services/vault-sync");
const rag = require("../routes/rag");

function app(extra = () => null) {
  const calls = [];
  const pool = {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      const hit = extra(sql, params);
      if (hit) return hit;
      if (/WITH corpus AS/.test(sql)) return { rows: [{ kind: "note", id: "1", title: "Bike", content: "my bike is red" }] };
      if (/AS v, count\(\*\) AS n/.test(sql)) return { rows: [{ v: "1", n: 1 }] };
      if (/vault_enabled, vault_repo/.test(sql)) return { rows: [{ vault_repo: "me/vault", vault_branch: "main" }] };
      return { rows: [] };
    },
  };
  const a = express();
  a.use(express.json());
  a.use(rag({ pool }));
  return { app: a, pool };
}
const cacheWrites = (pool) => pool.calls.filter((c) => /INSERT INTO rag_answer_cache/.test(c.sql));
const quiet = async (fn) => { const o = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = o; } };

describe("POST /api/rag/query on the cap", () => {
  beforeEach(reset);

  it("under the cap: one Citations call, one rag_query row, the answer cached", async () => {
    const { app: a, pool } = app();
    const r = await supertest(a).post("/api/rag/query").send({ query: "what colour is my bike" }).expect(200);
    assert.equal(r.body.answer, "It is red [1].");
    assert.deepEqual(state.calls, ["citations"]);
    assert.deepEqual(state.charged.map((c) => [c.entry_type, c.model, c.usage.input_tokens]), [["rag_query", "sonnet", 300]]);
    assert.equal(cacheWrites(pool).length, 1);
  });

  it("a refused Citations call is charged, and its prompt-cite fallback is a second rag_query row", async () => {
    state.citations = { throw: "refused", usage: { input_tokens: 200, output_tokens: 2 } };
    state.reply = "It is red [1].";
    const { app: a } = app();
    const r = await supertest(a).post("/api/rag/query").send({ query: "what colour is my bike" }).expect(200);
    assert.equal(r.body.answer, "It is red [1].");
    assert.equal(r.body.grounded, true);
    assert.deepEqual(state.calls, ["citations", "callAI"]);
    assert.deepEqual(state.charged.map((c) => [c.entry_type, c.usage.input_tokens]), [["rag_query", 200], ["rag_query", 50]]);
  });

  it("over the cap: the matching sources with ai_cap and a note — no model call, nothing charged or cached", async () => {
    state.spent = [100];
    const { app: a, pool } = app();
    const r = await supertest(a).post("/api/rag/query").send({ query: "what colour is my bike" }).expect(200);
    assert.equal(r.body.answer, null);
    assert.equal(r.body.ai_cap, true);
    assert.equal(r.body.sources.length, 1);
    assert.equal(r.body.note, "Monthly AI budget reached ($1.00 of $1.00) — raise it in Settings → AI. Showing matching sources.");
    assert.deepEqual(state.calls, []);
    assert.equal(state.reads, 1, "the prompt-cite fallback is not attempted over the cap");
    assert.equal(state.charged.length, 0);
    assert.equal(cacheWrites(pool).length, 0);
  });

  it("the cap reached by the Citations call stops the fallback too", async () => {
    state.citations = { throw: "overloaded" }; // no usage → not charged
    state.spent = [0, 100];
    const { app: a } = app();
    const r = await supertest(a).post("/api/rag/query").send({ query: "what colour is my bike" }).expect(200);
    assert.equal(r.body.ai_cap, true);
    assert.equal(r.body.answer, null);
    assert.deepEqual(state.calls, ["citations"]);
  });

  it("an unreadable spend: sources only with ai_cap_check_failed, no model call", async () => {
    state.spentThrows = true;
    const { app: a } = app();
    const r = await quiet(() => supertest(a).post("/api/rag/query").send({ query: "what colour is my bike" }).expect(200));
    assert.equal(r.body.answer, null);
    assert.equal(r.body.ai_cap_check_failed, true);
    assert.match(r.body.note, /couldn't be checked/);
    assert.deepEqual(state.calls, []);
  });

  it("a cached answer is free even over the cap: no cap read, no call", async () => {
    state.spent = [999];
    const { app: a } = app((sql) => (/FROM rag_answer_cache WHERE query_norm/.test(sql)
      ? { rows: [{ answer: "Cached: red.", sources: [{ n: 1, cited: true }], created_at: new Date() }] } : null));
    const r = await supertest(a).post("/api/rag/query").send({ query: "what colour is my bike" }).expect(200);
    assert.equal(r.body.answer, "Cached: red.");
    assert.equal(r.body.cached, true);
    assert.equal(state.reads, 0);
    assert.deepEqual(state.calls, []);
  });
});

describe("POST /api/rag/diagram on the cap", () => {
  beforeEach(reset);

  it("under the cap: rag_diagram charged", async () => {
    state.reply = "flowchart TD\n  A-->B";
    const { app: a } = app();
    const r = await supertest(a).post("/api/rag/diagram").send({ query: "my bike" }).expect(200);
    assert.match(r.body.mermaid, /^flowchart TD/);
    assert.deepEqual(state.charged.map((c) => c.entry_type), ["rag_diagram"]);
  });

  it("over the cap: 429 ai_cap; an unreadable spend: 503 — no model call", async () => {
    state.spent = [100];
    const { app: a } = app();
    const r = await supertest(a).post("/api/rag/diagram").send({ query: "my bike" }).expect(429);
    assert.equal(r.body.ai_cap, true);
    assert.match(r.body.error, /^Monthly AI budget reached/);
    state.spentThrows = true;
    const r2 = await quiet(() => supertest(a).post("/api/rag/diagram").send({ query: "my bike" }).expect(503));
    assert.equal(r2.body.ai_cap_check_failed, true);
    assert.deepEqual(state.calls, []);
    // The 400s still come first.
    await supertest(a).post("/api/rag/diagram").send({}).expect(400);
  });
});

describe("POST /api/rag/capture on the cap", () => {
  beforeEach(reset);
  async function capture(body) {
    const saved = { t: process.env.VAULT_GITHUB_WRITE_TOKEN, c: vault.commitVaultFile, s: vault.syncVault };
    process.env.VAULT_GITHUB_WRITE_TOKEN = "w";
    const committed = [];
    vault.commitVaultFile = async (_r, _b, _p, content) => { committed.push(content); return { content: {} }; };
    vault.syncVault = async () => ({ ok: true });
    try {
      const { app: a } = app();
      const res = await supertest(a).post("/api/rag/capture").send(body).expect(200);
      return { res, committed };
    } finally {
      if (saved.t === undefined) delete process.env.VAULT_GITHUB_WRITE_TOKEN; else process.env.VAULT_GITHUB_WRITE_TOKEN = saved.t;
      vault.commitVaultFile = saved.c; vault.syncVault = saved.s;
    }
  }

  it("under the cap: the AI structures it and rag_capture is charged", async () => {
    state.reply = '{"type":"fact","entity":"Car","fields":{"colour":"blue"},"tags":[],"body":""}';
    const { res, committed } = await capture({ text: "car colour blue" });
    assert.equal(res.body.type, "fact");
    assert.equal(res.body.ai_cap, undefined);
    assert.deepEqual(state.charged.map((c) => c.entry_type), ["rag_capture"]);
    assert.match(committed[0], /colour: blue/);
  });

  it("over the cap: the raw note is committed with ai_cap and a note, no model call", async () => {
    state.spent = [100];
    const { res, committed } = await capture({ text: "the car is blue" });
    assert.equal(res.body.ok, true);
    assert.equal(res.body.type, "note");
    assert.equal(res.body.ai_cap, true);
    assert.match(res.body.note, /^Monthly AI budget reached .* Saved as the raw text, without AI structuring\.$/);
    assert.match(committed[0], /the car is blue/);
    assert.deepEqual(state.calls, []);
  });

  it("an unreadable spend also commits the raw note (ai_cap_check_failed)", async () => {
    state.spentThrows = true;
    const { res } = await quiet(() => capture({ text: "the car is blue" }));
    assert.equal(res.body.ok, true);
    assert.equal(res.body.ai_cap_check_failed, true);
    assert.deepEqual(state.calls, []);
  });

  it("a secret capture never reads the cap or calls the model", async () => {
    const { res } = await capture({ text: "safe combo 1-2-3", sensitivity: "secret" });
    assert.equal(res.body.sensitivity, "secret");
    assert.equal(state.reads, 0);
    assert.deepEqual(state.calls, []);
  });
});
