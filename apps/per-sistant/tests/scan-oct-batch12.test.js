// ============================================================================
// Cycle-7 (Oct 2026) Batch 12 — Knowledge ingest edges
// ============================================================================
// F126  an empty or max_tokens-truncated answer is never cached
// F127  a truncated tree listing is a reported failure (the SHA holds)
// F128  a vault file over 1 MB is read through the blobs API, never ingested empty
// F129  GitHub and Voyage fetches carry a timeout signal
// F130  the RAG endpoints that call the model share the AI limiter; bounded input
// F131  upcomingFacts honors the validity window and the APP_TIMEZONE date
// F132  "--- " delimiters and repeated privacy keys fail closed
// F133  a diverged / behind compare forces a full walk + sweep
// F135  a "fact" capture with no usable fields is written as a note
// ============================================================================

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

// Stub the AI module BEFORE routes/rag.js captures its exports.
const ai = require("../ai");
const realAnswerWithCitations = ai.answerWithCitations;
let citationsReply = { text: "ok", citedIndexes: [0], stop_reason: "end_turn" };
let callAIReply = "{}";
let callAIStop = "end_turn";
const aiCalls = [];
ai.getAIModelForFeature = async () => "sonnet";
ai.isAIAvailable = () => true;
ai.answerWithCitations = async () => {
  if (citationsReply === "throw") throw new Error("citations unavailable");
  return citationsReply;
};
ai.callAI = async (...args) => {
  aiCalls.push(args);
  if (args[4] && typeof args[4] === "object") args[4].stop_reason = callAIStop;
  return callAIReply;
};

const embeddings = require("../services/embeddings");
const vault = require("../services/vault-sync");
const rag = require("../routes/rag");
const { todayStr } = require("../routes/health");

const ROOT = path.join(__dirname, "..");

async function withEnv(env, fn) {
  const keys = Object.keys(env);
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) { if (env[k] == null) delete process.env[k]; else process.env[k] = env[k]; }
  try { return await fn(); } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

function gh(routes, seen = []) {
  return async (url, opts) => {
    seen.push({ url, opts });
    const u = String(url).replace("https://api.github.com", "");
    for (const [re, body] of routes) {
      if (re.test(u)) {
        if (typeof body === "number") return { ok: false, status: body, text: async () => "boom", json: async () => ({}) };
        return { ok: true, status: 200, json: async () => body, text: async () => "" };
      }
    }
    throw new Error("unexpected GitHub call " + u);
  };
}
const file = (text) => ({ encoding: "base64", content: Buffer.from(text).toString("base64") });

function vaultPool({ lastSha = null, indexed = [] } = {}) {
  const calls = [];
  let nextId = 1;
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/vault_enabled, vault_repo/.test(sql)) return { rows: [{ vault_enabled: true, vault_repo: "me/vault", vault_branch: "main", vault_last_sha: lastSha }] };
      if (/to_regclass/.test(sql)) return { rows: [{ t: null }] };
      if (/SELECT source_ref FROM documents/.test(sql)) return { rows: indexed.map((source_ref) => ({ source_ref })) };
      if (/INSERT INTO documents/.test(sql)) return { rows: [{ id: nextId++ }] };
      if (/UPDATE documents SET deleted_at/.test(sql)) return { rows: [{ id: 99 }] };
      return { rows: [] };
    },
    connect: async () => ({ query: async (sql, params) => { calls.push({ sql, params, tx: true }); return { rows: [] }; }, release() {} }),
  };
}
const removedRefs = (pool) => pool.calls.filter((c) => /UPDATE documents SET deleted_at/.test(c.sql)).map((c) => c.params[0]);
const shaAdvanced = (pool) => pool.calls.some((c) => /vault_last_sha = \$1/.test(c.sql));

// ---------------------------------------------------------------------------
describe("F126 — truncated or empty answers are not cached", () => {
  function queryApp() {
    const calls = [];
    const pool = {
      calls,
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (/WITH corpus AS/.test(sql)) return { rows: [{ kind: "note", id: "1", title: "Bike", content: "my bike is red" }] };
        if (/AS v, count\(\*\) AS n/.test(sql)) return { rows: [{ v: "1", n: 1 }] };
        return { rows: [] };
      },
    };
    const app = express();
    app.use(express.json());
    app.use(rag({ pool }));
    return { app, pool };
  }
  const cacheWrites = (pool) => pool.calls.filter((c) => /INSERT INTO rag_answer_cache/.test(c.sql));
  beforeEach(() => { aiCalls.length = 0; callAIStop = "end_turn"; });

  it("a complete answer is cached (control)", async () => {
    citationsReply = { text: "It is red.", citedIndexes: [0], stop_reason: "end_turn" };
    const { app, pool } = queryApp();
    const res = await supertest(app).post("/api/rag/query").send({ query: "what colour is my bike" }).expect(200);
    assert.equal(res.body.answer, "It is red.");
    assert.equal(res.body.truncated, undefined);
    assert.equal(cacheWrites(pool).length, 1);
  });

  it("a max_tokens answer is returned flagged truncated and NOT cached", async () => {
    citationsReply = { text: "It is", citedIndexes: [0], stop_reason: "max_tokens" };
    const { app, pool } = queryApp();
    const res = await supertest(app).post("/api/rag/query").send({ query: "what colour is my bike" }).expect(200);
    assert.equal(res.body.answer, "It is");
    assert.equal(res.body.truncated, true);
    assert.equal(cacheWrites(pool).length, 0);
  });

  it("an empty answer is not served or cached — the sources still come back", async () => {
    citationsReply = { text: "", citedIndexes: [], stop_reason: "end_turn" };
    const { app, pool } = queryApp();
    const res = await supertest(app).post("/api/rag/query").send({ query: "what colour is my bike" }).expect(200);
    assert.equal(res.body.answer, null);
    assert.match(res.body.note, /no answer/);
    assert.equal(res.body.sources.length, 1);
    assert.equal(cacheWrites(pool).length, 0);
  });

  it("the prompt-cite fallback reads stop_reason through callAI's meta", async () => {
    citationsReply = "throw";
    callAIReply = "It is [1]";
    callAIStop = "max_tokens";
    try {
      const { app, pool } = queryApp();
      const res = await supertest(app).post("/api/rag/query").send({ query: "what colour is my bike" }).expect(200);
      assert.equal(res.body.truncated, true);
      assert.equal(cacheWrites(pool).length, 0);
      assert.equal(typeof aiCalls[0][4], "object", "callAI was given a meta object");
    } finally { callAIReply = "{}"; citationsReply = { text: "ok", citedIndexes: [0], stop_reason: "end_turn" }; }
  });

  it("answerWithCitations reports the stop_reason; callAI fills meta", async () => {
    const c = { messages: { create: async () => ({ stop_reason: "max_tokens", content: [{ type: "text", text: "half" }] }) } };
    const out = await realAnswerWithCitations({ model: "sonnet", query: "q", documents: [{ content: "d" }], client: c });
    assert.equal(out.stop_reason, "max_tokens");
    const src = fs.readFileSync(path.join(ROOT, "ai.js"), "utf8");
    assert.match(src, /async function callAI\(model, prompt, maxTokens = 1024, systemPrompt = null, meta = null\)/);
    assert.match(src, /meta\.stop_reason = msg\.stop_reason \|\| null/);
  });

  it("the Knowledge page shows the cut-off note", () => {
    const page = fs.readFileSync(path.join(ROOT, "pages/knowledge.js"), "utf8");
    assert.match(page, /r\.truncated \? '<p style="font-size:11px;color:var\(--warn\)">This answer was cut off/);
  });
});

// ---------------------------------------------------------------------------
describe("F127 — a truncated tree is a reported failure", () => {
  it("listed files are ingested, nothing is swept, the run is not ok and the SHA holds", () =>
    withEnv({ VAULT_GITHUB_TOKEN: "t", VOYAGE_API_KEY: null }, async () => {
      const pool = vaultPool({ indexed: ["a.md", "beyond.md"] });
      const r = await vault.syncVault(pool, {
        full: true,
        fetchImpl: gh([
          [/\/branches\/main$/, { commit: { sha: "HEAD1" } }],
          [/\/git\/trees\/HEAD1/, { tree: [{ type: "blob", path: "a.md" }], truncated: true }],
          [/\/contents\/a\.md/, file("hello")],
        ]),
      });
      assert.equal(r.ok, false);
      assert.equal(r.partial, true);
      assert.match(r.error, /truncated the vault's file list/);
      assert.equal(r.changed, 1);
      assert.ok(pool.calls.some((c) => /INSERT INTO documents/.test(c.sql)), "a.md was still ingested");
      assert.deepEqual(removedRefs(pool), []);
      assert.equal(shaAdvanced(pool), false);
      assert.ok(pool.calls.some((c) => /vault_last_error = \$1/.test(c.sql)), "the error is recorded");
    }));
});

// ---------------------------------------------------------------------------
describe("F128 — a file over 1 MB is read through the blobs API", () => {
  const ctx = (routes) => ({ token: "t", fetchImpl: gh(routes) });

  it("encoding 'none' falls back to the blob", async () => {
    const big = "x".repeat(10);
    const text = await vault.getFileText("me/vault", "big.md", "HEAD1", ctx([
      [/\/contents\/big\.md/, { encoding: "none", content: "", size: 2_000_000, sha: "BLOB1" }],
      [/\/git\/blobs\/BLOB1$/, { encoding: "base64", content: Buffer.from(big).toString("base64") }],
    ]));
    assert.equal(text, big);
  });

  it("no blob either → the file FAILS instead of being ingested empty", async () => {
    await assert.rejects(
      vault.getFileText("me/vault", "big.md", "HEAD1", ctx([
        [/\/contents\/big\.md/, { encoding: "none", content: "", size: 200_000_000, sha: "BLOB2" }],
        [/\/git\/blobs\/BLOB2$/, { message: "too large" }],
      ])),
      /file too large to fetch/
    );
  });

  it("in a sync, a big fact file keeps its facts (no empty re-ingest)", () =>
    withEnv({ VAULT_GITHUB_TOKEN: "t", VOYAGE_API_KEY: null }, async () => {
      const pool = vaultPool();
      const fact = "---\ntype: fact\nentity: Car\ndeductible: 500\n---\n";
      const r = await vault.syncVault(pool, {
        full: true,
        fetchImpl: gh([
          [/\/branches\/main$/, { commit: { sha: "HEAD1" } }],
          [/\/git\/trees\/HEAD1/, { tree: [{ type: "blob", path: "car.md" }] }],
          [/\/contents\/car\.md/, { encoding: "none", content: "", size: 1_500_000, sha: "B" }],
          [/\/git\/blobs\/B$/, file(fact)],
        ]),
      });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.facts, 1);
      const factInsert = pool.calls.find((c) => c.tx && /INSERT INTO facts/.test(c.sql));
      assert.ok(factInsert, "the fact row was written");
    }));
});

// ---------------------------------------------------------------------------
describe("F129 — outbound fetches carry a timeout", () => {
  it("GitHub reads and the capture commit pass an AbortSignal", async () => {
    const seen = [];
    await vault.getFileText("me/vault", "a.md", "H", { token: "t", fetchImpl: gh([[/\/contents\/a\.md/, file("x")]], seen) });
    assert.ok(seen[0].opts.signal instanceof AbortSignal);
    let commitOpts = null;
    await vault.commitVaultFile("me/vault", "main", "c.md", "x", "m", {
      token: "t",
      fetchImpl: async (url, opts) => { commitOpts = opts; return { ok: true, json: async () => ({}) }; },
    });
    assert.ok(commitOpts.signal instanceof AbortSignal);
  });

  it("Voyage requests pass an AbortSignal; a timeout is retried like a network error", () =>
    withEnv({ VOYAGE_API_KEY: "k" }, async () => {
      let n = 0;
      const signals = [];
      const out = await embeddings.embed(["a"], {
        inputType: "query",
        sleep: async () => {},
        fetchImpl: async (url, opts) => {
          signals.push(opts.signal);
          if (n++ === 0) { const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; throw e; }
          return { ok: true, json: async () => ({ data: [{ index: 0, embedding: [1, 2] }] }) };
        },
      });
      assert.deepEqual(out, [[1, 2]]);
      assert.ok(signals.every((s) => s instanceof AbortSignal));
      assert.ok(embeddings.VOYAGE_TIMEOUT_MS.query < embeddings.VOYAGE_TIMEOUT_MS.document);
    }));
});

// ---------------------------------------------------------------------------
describe("F130 — RAG model calls are rate-limited and bounded", () => {
  it("the AI limiter covers query, diagram and capture", () => {
    const src = fs.readFileSync(path.join(ROOT, "middleware.js"), "utf8");
    assert.match(src, /app\.use\(\["\/api\/rag\/query", "\/api\/rag\/diagram", "\/api\/rag\/capture"\], aiLimiter\)/);
  });

  it("an over-long question, diagram request, search or capture is a 400", async () => {
    const pool = { query: async () => ({ rows: [] }) };
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use(rag({ pool }));
    const long = "a".repeat(1001);
    for (const p of ["/api/rag/query", "/api/rag/diagram"]) {
      const res = await supertest(app).post(p).send({ query: long }).expect(400);
      assert.match(res.body.error, /too long \(max 1000/);
    }
    await supertest(app).get("/api/rag/search?q=" + long).expect(400);
    const res = await supertest(app).post("/api/rag/capture").send({ text: "b".repeat(20001) }).expect(400);
    assert.match(res.body.error, /Captured text is too long/);
    // At the limit is fine (reaches the normal no-match path).
    await supertest(app).post("/api/rag/query").send({ query: "a".repeat(1000) }).expect(200);
  });
});

// ---------------------------------------------------------------------------
describe("F131 — upcomingFacts: current facts only, APP_TIMEZONE date", () => {
  it("binds the tz date and filters the validity window on both branches", async () => {
    const calls = [];
    const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
    await rag.upcomingFacts(pool, 30, "2026-10-21");
    assert.deepEqual(calls[0].params, ["30", "2026-10-21"]);
    assert.doesNotMatch(calls[0].sql, /CURRENT_DATE/);
    assert.equal((calls[0].sql.match(/valid_from IS NULL OR valid_from <= \$2::date/g) || []).length, 2);
    assert.match(calls[0].sql, /valid_to IS NULL OR valid_to >= \$2::date/);
    await rag.upcomingFacts(pool);
    assert.equal(calls[1].params[1], todayStr(), "defaults to the APP_TIMEZONE today");
  });
});

// ---------------------------------------------------------------------------
describe("F132 — frontmatter fails closed", () => {
  it("'--- ' delimiters with trailing whitespace still parse", () => {
    const { meta, body } = vault.parseFrontmatter("--- \nsensitivity: secret\n---\t\nbody");
    assert.equal(vault.resolveSensitivity(meta), "secret");
    assert.equal(body, "body");
  });

  it("a repeated sensitivity key keeps the most restrictive value", () => {
    const { meta } = vault.parseFrontmatter("---\nsensitivity: secret\nsensitivity: normal\n---\nx");
    assert.deepEqual(meta.sensitivity, ["secret", "normal"]);
    assert.equal(vault.resolveSensitivity(meta), "secret");
    const rev = vault.parseFrontmatter("---\nsensitivity: normal\nsensitivity: private\n---\nx");
    assert.equal(vault.resolveSensitivity(rev.meta), "private");
  });

  it("repeated embed / private keys fail closed", () => {
    assert.equal(vault.resolveSensitivity(vault.parseFrontmatter("---\nembed: false\nembed: true\n---\n").meta), "private");
    assert.equal(vault.resolveSensitivity(vault.parseFrontmatter("---\nprivate: true\nprivate: false\n---\n").meta), "private");
  });

  it("a block list after a scalar keeps both", () => {
    const { meta } = vault.parseFrontmatter("---\nsensitivity: secret\nsensitivity:\n  - normal\n---\n");
    assert.equal(vault.resolveSensitivity(meta), "secret");
  });

  it("other keys keep last-wins and single values are unchanged", () => {
    const { meta } = vault.parseFrontmatter("---\ntitle: A\ntitle: B\nsensitivity: private\n---\n");
    assert.equal(meta.title, "B");
    assert.equal(meta.sensitivity, "private");
  });
});

// ---------------------------------------------------------------------------
describe("F133 — a diverged compare forces a full walk", () => {
  const ctx = (body) => ({ token: "t", fetchImpl: gh([[/\/compare\//, body]]) });

  it("listChangedFiles trusts only ahead / identical", async () => {
    const files = [{ status: "modified", filename: "a.md" }];
    assert.deepEqual(await vault.listChangedFiles("me/vault", "OLD", "NEW", ctx({ status: "ahead", files })), { changed: ["a.md"], removed: [] });
    for (const status of ["diverged", "behind"]) {
      const r = await vault.listChangedFiles("me/vault", "OLD", "NEW", ctx({ status, files }));
      assert.equal(r.incomplete, true, status);
    }
  });

  it("after a force-push, a file that only existed in the dropped commits is removed", () =>
    withEnv({ VAULT_GITHUB_TOKEN: "t", VOYAGE_API_KEY: null }, async () => {
      const pool = vaultPool({ lastSha: "OLD", indexed: ["a.md", "dropped.md"] });
      const r = await vault.syncVault(pool, {
        fetchImpl: gh([
          [/\/branches\/main$/, { commit: { sha: "NEW" } }],
          [/\/compare\/OLD\.\.\.NEW/, { status: "diverged", files: [{ status: "modified", filename: "a.md" }] }],
          [/\/git\/trees\/NEW/, { tree: [{ type: "blob", path: "a.md" }] }],
          [/\/contents\/a\.md/, file("hello")],
        ]),
      });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(removedRefs(pool), ["dropped.md"]);
      assert.equal(shaAdvanced(pool), true);
    }));
});

// ---------------------------------------------------------------------------
describe("F135 — a fact capture with no fields is saved as a note", () => {
  it("buildCaptureMarkdown writes a note (titled by the entity) when no field survives", () => {
    const md = vault.buildCaptureMarkdown({ type: "fact", entity: "Car", fields: { type: "x", embed: "" }, body: "Notes about the car" });
    const { meta, body } = vault.parseFrontmatter(md);
    assert.equal(vault.isFactFile(meta), false);
    assert.equal(meta.title, "Car");
    assert.equal(body.trim(), "Notes about the car");
    assert.deepEqual(vault.captureFieldLines({ a: "1", type: "fact", b: "" }), ["a: 1"]);
  });

  it("the route reports type 'note' and commits the text", () =>
    withEnv({ VAULT_GITHUB_WRITE_TOKEN: "w" }, async () => {
      const committed = [];
      const realCommit = vault.commitVaultFile;
      const realSync = vault.syncVault;
      vault.commitVaultFile = async (repo, branch, p, content) => { committed.push(content); return { content: {} }; };
      vault.syncVault = async () => ({ ok: true });
      callAIReply = '{"type":"fact","entity":"Car","fields":{},"tags":[],"body":"The car is blue"}';
      try {
        const pool = { query: async () => ({ rows: [{ vault_repo: "me/vault", vault_branch: "main" }] }) };
        const app = express();
        app.use(express.json());
        app.use(rag({ pool }));
        const res = await supertest(app).post("/api/rag/capture").send({ text: "the car is blue" }).expect(200);
        assert.equal(res.body.type, "note");
        assert.doesNotMatch(committed[0], /type: fact/);
        assert.match(committed[0], /The car is blue/);
        // A fact with real fields is still a fact.
        callAIReply = '{"type":"fact","entity":"Car","fields":{"colour":"blue"},"tags":[],"body":""}';
        const res2 = await supertest(app).post("/api/rag/capture").send({ text: "car colour blue" }).expect(200);
        assert.equal(res2.body.type, "fact");
      } finally {
        callAIReply = "{}";
        vault.commitVaultFile = realCommit;
        vault.syncVault = realSync;
      }
    }));
});
