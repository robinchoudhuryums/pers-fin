// ============================================================================
// Broad-scan (Sept 2026) Batch 11 — Knowledge lifecycle & retrieval
// ============================================================================
// KR-3   vault documents + facts are ingested without embeddings; backfill
// KR-4   stopwords, per-source ranking, matching-passage window
// KR-7   Voyage retry/backoff; per-file isolation; removals first
// KR-8   the sync lock is claimed before the first await
// KR-9   the finance snapshot uses Perfin's getNetWorth
// KR-10  capture: reserved keys dropped, sensitivity choice, no AI when private
// KR-11  success-only last_synced_at, attempt stamp, reindex outcome, alert
// KR-12  inline-citation fallback is grounded
// KR-13  the answer cache is pruned
// KR-14  word-boundary attribute match, vault_repo validation, header
// ============================================================================

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const supertest = require("supertest");

// Stub the AI module BEFORE routes/rag.js captures its exports.
const ai = require("../ai");
const aiCalls = [];
let citationsBehavior = "throw";
let callAIReply = "{}";
ai.getAIModelForFeature = async () => "sonnet";
ai.isAIAvailable = () => true;
ai.callAI = async (...args) => { aiCalls.push(args); return callAIReply; };
ai.answerWithCitations = async () => {
  if (citationsBehavior === "throw") throw new Error("citations unavailable");
  return { text: "ok", citedIndexes: [0] };
};

const embeddings = require("../services/embeddings");
const vault = require("../services/vault-sync");
const rag = require("../routes/rag");
const notificationsRouter = require("../routes/notifications");

const ROOT = path.join(__dirname, "..");
const REPO = path.join(ROOT, "..", "..");

// --- helpers ----------------------------------------------------------------
function gh(routes) {
  return async (url) => {
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

function vaultPool({ lastSha = null, vectorTable = true, indexed = [], embedState = {}, backfill = [] } = {}) {
  const calls = [];
  let nextId = 1;
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/vault_enabled, vault_repo/.test(sql)) return { rows: [{ vault_enabled: true, vault_repo: "me/vault", vault_branch: "main", vault_last_sha: lastSha }] };
      if (/to_regclass/.test(sql)) return { rows: [{ t: vectorTable ? "chunks" : null }] };
      if (/SELECT source_ref FROM documents/.test(sql)) return { rows: indexed.map((source_ref) => ({ source_ref })) };
      if (/INSERT INTO documents/.test(sql)) return { rows: [{ id: nextId++ }] };
      if (/UPDATE documents SET deleted_at/.test(sql)) return { rows: [{ id: 99 }] };
      if (/SELECT content_sha FROM embed_state/.test(sql)) {
        const sha = embedState[params[1]];
        return { rows: sha ? [{ content_sha: sha }] : [] };
      }
      if (/NOT EXISTS \(SELECT 1 FROM embed_state/.test(sql)) return { rows: backfill };
      return { rows: [] };
    },
    connect: async () => ({ query: async (sql, params) => { calls.push({ sql, params, tx: true }); return { rows: [] }; }, release() {} }),
  };
}
const sqlOf = (pool, re) => pool.calls.filter((c) => re.test(c.sql));

async function withEnv(env, fn) {
  const keys = Object.keys(env);
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) { if (env[k] == null) delete process.env[k]; else process.env[k] = env[k]; }
  try { return await fn(); } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

// ---------------------------------------------------------------------------
describe("KR-3 — the vault is ingested even without embeddings", () => {
  it("no VOYAGE key: documents + facts are written, nothing is embedded, the sha advances", () =>
    withEnv({ VAULT_GITHUB_TOKEN: "t", VOYAGE_API_KEY: null }, async () => {
      const pool = vaultPool({ vectorTable: false });
      const r = await vault.syncVault(pool, {
        full: true,
        fetchImpl: gh([
          [/\/branches\/main$/, { commit: { sha: "H1" } }],
          [/\/git\/trees\/H1/, { tree: [{ type: "blob", path: "note.md" }, { type: "blob", path: "car.md" }] }],
          [/\/contents\/note\.md/, file("# Trip\nVisit Rome")],
          [/\/contents\/car\.md/, file("---\ntype: fact\nentity: Car\ndeductible: 500\n---\n")],
        ]),
      });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.embeddings, false);
      assert.equal(sqlOf(pool, /INSERT INTO documents/).length, 1, "prose document ingested");
      assert.ok(pool.calls.some((c) => c.tx && /INSERT INTO facts/.test(c.sql)), "facts ingested");
      assert.equal(sqlOf(pool, /(FROM|INTO) chunks/).length, 0, "no chunks table touched without pgvector");
      const done = sqlOf(pool, /SET vault_last_sha = \$1/);
      assert.equal(done.length, 1);
      assert.equal(done[0].params[0], "H1");
    }));

  it("an embedding of the SAME text is kept when Voyage is temporarily off", () =>
    withEnv({ VAULT_GITHUB_TOKEN: "t", VOYAGE_API_KEY: null }, async () => {
      const body = "Visit Rome";
      const sha = vault.sha256("chunkv" + vault.CHUNKING_VERSION + "\n" + body);
      const pool = vaultPool({ embedState: { 1: sha } });
      await vault.syncVault(pool, {
        full: true,
        fetchImpl: gh([
          [/\/branches\/main$/, { commit: { sha: "H1" } }],
          [/\/git\/trees\/H1/, { tree: [{ type: "blob", path: "note.md" }] }],
          [/\/contents\/note\.md/, file(body)],
        ]),
      });
      assert.equal(sqlOf(pool, /DELETE FROM embed_state/).length, 0, "current embedding kept");
    }));

  it("a CHANGED document's stale embedding is dropped so the backfill re-embeds it", () =>
    withEnv({ VAULT_GITHUB_TOKEN: "t", VOYAGE_API_KEY: null }, async () => {
      const pool = vaultPool({ embedState: { 1: "old-sha" } });
      await vault.syncVault(pool, {
        full: true,
        fetchImpl: gh([
          [/\/branches\/main$/, { commit: { sha: "H1" } }],
          [/\/git\/trees\/H1/, { tree: [{ type: "blob", path: "note.md" }] }],
          [/\/contents\/note\.md/, file("new text")],
        ]),
      });
      assert.equal(sqlOf(pool, /DELETE FROM embed_state/).length, 1);
      assert.equal(sqlOf(pool, /DELETE FROM chunks/).length, 1, "old chunks stop being retrievable");
    }));

  it("with embeddings available, unembedded vault documents are backfilled", () =>
    withEnv({ VAULT_GITHUB_TOKEN: "t", VOYAGE_API_KEY: "pa" }, async () => {
      const realEmbed = embeddings.embed;
      const embedded = [];
      embeddings.embed = async (parts) => { embedded.push(...parts); return parts.map(() => [0.1, 0.2]); };
      try {
        const pool = vaultPool({ lastSha: "H1", backfill: [{ id: 7, source_ref: "old.md", content: "ingested while Voyage was off" }] });
        const r = await vault.syncVault(pool, { fetchImpl: gh([[/\/branches\/main$/, { commit: { sha: "H1" } }]]) });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.up_to_date, true);
        assert.equal(r.embedded, 1, "backfill runs even when the vault is up to date");
        assert.deepEqual(embedded, ["ingested while Voyage was off"]);
      } finally { embeddings.embed = realEmbed; }
    }));
});

// ---------------------------------------------------------------------------
describe("KR-7 — one failure no longer aborts the sync", () => {
  it("a failing file is isolated; removals ran first; the sha is NOT advanced", () =>
    withEnv({ VAULT_GITHUB_TOKEN: "t", VOYAGE_API_KEY: null }, async () => {
      const pool = vaultPool({ indexed: ["gone.md", "good.md", "bad.md"] });
      const r = await vault.syncVault(pool, {
        full: true,
        fetchImpl: gh([
          [/\/branches\/main$/, { commit: { sha: "H2" } }],
          [/\/git\/trees\/H2/, { tree: [{ type: "blob", path: "bad.md" }, { type: "blob", path: "good.md" }] }],
          [/\/contents\/bad\.md/, 500],
          [/\/contents\/good\.md/, file("fine")],
        ]),
      });
      assert.equal(r.ok, false);
      assert.equal(r.partial, true);
      assert.equal(r.failed, 1);
      assert.equal(r.failures[0].path, "bad.md");
      const idx = (re) => pool.calls.findIndex((c) => re.test(c.sql));
      assert.ok(idx(/UPDATE documents SET deleted_at/) < idx(/INSERT INTO documents/), "removal before ingest");
      assert.equal(sqlOf(pool, /INSERT INTO documents/).length, 1, "good.md still ingested");
      assert.equal(sqlOf(pool, /SET vault_last_sha/).length, 0, "range retried next sync");
      assert.equal(sqlOf(pool, /vault_last_synced_at = now\(\)/).length, 0, "a failed run is not 'synced'");
      assert.match(sqlOf(pool, /SET vault_last_error = \$1/)[0].params[0], /1 file\(s\) failed.*bad\.md/);
    }));

  function voyage(statuses) {
    let i = 0;
    const calls = [];
    const fetchImpl = async () => {
      const st = statuses[Math.min(i++, statuses.length - 1)];
      calls.push(st);
      if (st === "net") throw new Error("ECONNRESET");
      return {
        ok: st === 200,
        status: st,
        headers: { get: (h) => (h === "retry-after" && st === 429 ? "2" : null) },
        json: async () => ({ data: [{ index: 0, embedding: [1, 2] }] }),
        text: async () => "err",
      };
    };
    return { fetchImpl, calls };
  }

  it("Voyage 429 / 5xx / network errors are retried, honoring Retry-After", () =>
    withEnv({ VOYAGE_API_KEY: "pa" }, async () => {
      const waits = [];
      const v = voyage([429, 503, "net", 200]);
      const out = await embeddings.embed(["x"], { inputType: "document", fetchImpl: v.fetchImpl, sleep: async (ms) => waits.push(ms) });
      assert.deepEqual(out, [[1, 2]]);
      assert.equal(v.calls.length, 4);
      assert.equal(waits[0], 2000, "Retry-After seconds honored");
    }));

  it("a 400 is not retried; retries are bounded; queries retry once", () =>
    withEnv({ VOYAGE_API_KEY: "pa" }, async () => {
      const sleep = async () => {};
      const bad = voyage([400]);
      await assert.rejects(embeddings.embed(["x"], { fetchImpl: bad.fetchImpl, sleep }), /Voyage 400/);
      assert.equal(bad.calls.length, 1);
      const always = voyage([429]);
      await assert.rejects(embeddings.embed(["x"], { inputType: "document", fetchImpl: always.fetchImpl, sleep }), /Voyage 429/);
      assert.equal(always.calls.length, 4, "1 try + 3 retries");
      const q = voyage([429]);
      await assert.rejects(embeddings.embed(["x"], { inputType: "query", fetchImpl: q.fetchImpl, sleep }), /Voyage 429/);
      assert.equal(q.calls.length, 2, "interactive query: 1 retry");
    }));

  it("syncNotes keeps going past a note that fails to embed", () =>
    withEnv({ VOYAGE_API_KEY: "pa" }, async () => {
      const realEmbed = embeddings.embed;
      embeddings.embed = async (parts) => {
        if (parts.some((p) => /poison/.test(p))) throw new Error("Voyage 500: down");
        return parts.map(() => [0.1]);
      };
      try {
        const pool = {
          query: async (sql) => {
            if (/to_regclass/.test(sql)) return { rows: [{ t: "chunks" }] };
            if (/FROM notes WHERE deleted_at IS NULL/.test(sql)) return { rows: [{ id: 1, title: "a", content: "poison" }, { id: 2, title: "b", content: "fine" }] };
            return { rows: [] };
          },
          connect: async () => ({ query: async () => ({ rows: [] }), release() {} }),
        };
        const r = await vault.syncNotes(pool);
        assert.equal(r.ok, false);
        assert.equal(r.failed, 1);
        assert.equal(r.embedded, 1, "the healthy note was embedded");
      } finally { embeddings.embed = realEmbed; }
    }));
});

// ---------------------------------------------------------------------------
describe("KR-8 — the sync lock is claimed before the first await", () => {
  it("two concurrent syncVault calls: the second is busy", () =>
    withEnv({ VAULT_GITHUB_TOKEN: "t", VOYAGE_API_KEY: null }, async () => {
      let release;
      const gate = new Promise((r) => { release = r; });
      const pool = vaultPool();
      const slowPool = { ...pool, query: async (sql, p) => { if (/vault_enabled, vault_repo/.test(sql)) await gate; return pool.query(sql, p); } };
      const first = vault.syncVault(slowPool, { full: true, fetchImpl: gh([[/\/branches\/main$/, 503]]) });
      const second = await vault.syncVault(slowPool, { full: true });
      assert.equal(second.reason, "busy");
      assert.equal(await vault.syncNotes(slowPool).then((r) => r.reason), "busy", "notes share the lock");
      release();
      await first;
      assert.equal(vault.isSyncing(), false, "released after the run");
    }));

  it("the lock is released even when the vault isn't configured", async () => {
    const r = await vault.syncVault({ query: async () => ({ rows: [{ vault_enabled: false }] }) });
    assert.equal(r.reason, "not_configured");
    assert.equal(vault.isSyncing(), false);
  });
});

// ---------------------------------------------------------------------------
describe("KR-11 — failures stay visible", () => {
  it("a thrown sync records the error and the attempt, not a fresh last_synced_at", () =>
    withEnv({ VAULT_GITHUB_TOKEN: "t", VOYAGE_API_KEY: null }, async () => {
      const pool = vaultPool();
      const r = await vault.syncVault(pool, { fetchImpl: gh([[/\/branches\/main$/, 401]]) });
      assert.equal(r.ok, false);
      assert.equal(sqlOf(pool, /vault_last_attempt_at = now\(\)/).length, 1);
      assert.equal(sqlOf(pool, /vault_last_synced_at = now/).length, 0);
      assert.equal(sqlOf(pool, /SET vault_last_error = \$1/).length, 1);
    }));

  it("reindexOutcome: not_configured / not_ready are fine; errors and partials are not", () => {
    assert.equal(rag.reindexOutcome({ vault: { ok: true }, notes: { ok: true } }), true);
    assert.equal(rag.reindexOutcome({ vault: { ok: false, reason: "not_configured" }, notes: { ok: false, reason: "not_ready" } }), true);
    assert.equal(rag.reindexOutcome({ vault: { ok: false, partial: true }, notes: { ok: true } }), false);
    assert.equal(rag.reindexOutcome({ vault: { ok: true }, notes: { ok: false, error: "x" } }), false);
    assert.equal(rag.reindexOutcome({ vault: { ok: false, reason: "busy" }, notes: { ok: true } }), false);
    assert.equal(rag.reindexOutcome(null), false);
  });

  it("the notification check surfaces a failing vault sync", async () => {
    const pool = {
      query: async (sql) => {
        if (/vault_enabled, vault_last_error/.test(sql)) return { rows: [{ vault_enabled: true, vault_last_error: "GitHub 401 bad token", vault_last_synced_at: new Date("2026-10-01T00:00:00Z") }] };
        return { rows: [] };
      },
    };
    const app = express();
    app.use(notificationsRouter({ pool }));
    const res = await supertest(app).get("/api/notifications/check").expect(200);
    const n = res.body.notifications.find((x) => x.type === "vault_sync_error");
    assert.ok(n, JSON.stringify(res.body));
    assert.match(n.title, /last good sync 2026-10-01.*GitHub 401/);
    assert.equal(res.body.counts.vault_sync_error, 1);
  });

  it("no alert when the vault is healthy or disabled", async () => {
    for (const row of [{ vault_enabled: true, vault_last_error: null }, { vault_enabled: false, vault_last_error: "x" }]) {
      const pool = { query: async (sql) => (/vault_enabled, vault_last_error/.test(sql) ? { rows: [row] } : { rows: [] }) };
      const app = express();
      app.use(notificationsRouter({ pool }));
      const res = await supertest(app).get("/api/notifications/check").expect(200);
      assert.ok(!res.body.notifications.some((x) => x.type === "vault_sync_error"));
    }
  });

  it("the Action waits for the result and fails on ok:false; dashboard links the alert", () => {
    const wf = fs.readFileSync(path.join(REPO, ".github/workflows/knowledge-reindex.yml"), "utf8");
    assert.match(wf, /api\/rag\/status/);
    assert.match(wf, /s\.ok===false\?"failed"/);
    const dash = fs.readFileSync(path.join(ROOT, "pages/dashboard-script.js"), "utf8");
    assert.match(dash, /n\.entity === 'knowledge'/);
    assert.match(dash, /vault_sync_error/);
    assert.match(fs.readFileSync(path.join(ROOT, "db/023_vault_sync_attempt.sql"), "utf8"), /ADD COLUMN IF NOT EXISTS vault_last_attempt_at/);
  });
});

// ---------------------------------------------------------------------------
describe("KR-4 — retrieval ranking", () => {
  it("stopwords are dropped from both keyword legs", () => {
    assert.deepEqual(rag.searchTerms("What is the deductible on my car insurance?"), ["deductible", "car", "insurance"]);
    assert.deepEqual(rag.buildRetrievalQuery("what is the deductible", 8).params, ["%deductible%", 8]);
    assert.deepEqual(rag.buildFactsQuery("what's the current deductible", 5, "2026-10-08").params.slice(0, 2), ["%current%", "%deductible%"]);
    assert.deepEqual(rag.searchTerms("what are those"), ["what are those"], "all-stopword query falls back to the phrase");
    // Content words that are often what a note is ABOUT stay searchable.
    assert.deepEqual(rag.searchTerms("where is my will"), ["will"]);
    assert.deepEqual(rag.searchTerms("show my May shopping list"), ["show", "May", "shopping", "list"]);
  });

  it("many chunks of one document no longer outrank everything else", () => {
    const row = (kind, id) => ({ kind, id: String(id), content: "c" });
    const vec = [row("document", 1), row("document", 1), row("document", 1), row("document", 2)];
    const kw = [row("document", 2)];
    const fused = rag.fuseRetrieval(vec, kw, 10);
    assert.equal(fused[0].id, "2", "found by both legs beats one doc's repeated chunks");
  });

  it("bestChunkPerSource keeps the first (closest) chunk of each source", () => {
    const rows = [{ kind: "document", id: "1", content: "best" }, { kind: "document", id: "1", content: "worse" }, { kind: "note", id: "1", content: "n" }];
    assert.deepEqual(rag.bestChunkPerSource(rows, 8).map((r) => r.content), ["best", "n"]);
    assert.equal(rag.bestChunkPerSource(rows, 1).length, 1);
  });

  it("matchingWindow sends the passage around the match, not the document head", () => {
    const doc = "intro ".repeat(600) + "the policy deductible is 500 dollars " + "tail ".repeat(400);
    const w = rag.matchingWindow(doc, ["deductible"]);
    assert.match(w, /deductible is 500/);
    assert.ok(w.length <= 1502);
    assert.equal(rag.matchingWindow("short text", ["x"]), "short text");
  });

  it("/api/rag/search over-fetches vector chunks and windows keyword hits", () =>
    withEnv({ VOYAGE_API_KEY: "pa" }, async () => {
      const realEmbed = embeddings.embed;
      embeddings.embed = async () => [[0.5]];
      const longDoc = "filler ".repeat(500) + "the renewal fee is $120 " + "end ".repeat(200);
      let vecLimit;
      const pool = {
        query: async (sql, params) => {
          if (/to_regclass/.test(sql)) return { rows: [{ t: "chunks" }] };
          if (/FROM chunks c/.test(sql)) {
            vecLimit = params[1];
            return { rows: [{ kind: "document", id: "1", content: "chunk A", title: "Big" }, { kind: "document", id: "1", content: "chunk B", title: "Big" }, { kind: "note", id: "4", content: "n", title: "N" }] };
          }
          if (/WITH corpus AS/.test(sql)) return { rows: [{ kind: "document", id: "2", title: "Policy", content: longDoc }] };
          return { rows: [] };
        },
      };
      try {
        const app = express();
        app.use(rag({ pool }));
        const res = await supertest(app).get("/api/rag/search").query({ q: "what is the renewal fee" }).expect(200);
        assert.equal(vecLimit, 32, "8 sources × 4 chunks over-fetched");
        const ids = res.body.results.map((r) => r.kind + ":" + r.id);
        assert.deepEqual(ids.slice().sort(), ["document:1", "document:2", "note:4"]);
        const policy = res.body.results.find((r) => r.id === "2");
        assert.match(policy.snippet, /renewal fee is \$120/);
      } finally { embeddings.embed = realEmbed; }
    }));
});

// ---------------------------------------------------------------------------
describe("KR-9 — the finance snapshot agrees with Perfin's getNetWorth", () => {
  const { getNetWorth } = require("../../../teller/services/financial-queries");
  function perfinPool() {
    return {
      query: async (sql) => {
        if (/FROM linked_accounts la/.test(sql)) {
          // The Plaid brokerage phantom (account_id in investment_accounts) is
          // excluded by getNetWorth's own NOT EXISTS — the fake returns what
          // that query would.
          return { rows: [
            { name: "Checking", type: "depository", available_balance: 2000, current_balance: 2100 },
            { name: "Visa", type: "credit", current_balance: 300 },
            { name: "Auto loan", type: "loan", current_balance: 15000 },
          ] };
        }
        if (/FROM investment_accounts ia/.test(sql)) return { rows: [{ name: "Schwab", account_type: "brokerage", balance: 40000 }] };
        if (/credit_limit IS NOT NULL/.test(sql)) return { rows: [{ name: "Visa", credit_limit: 5000 }] };
        if (/FROM detected_subscriptions/.test(sql)) {
          return { rows: [
            { display_name: "Netflix", amount: 15, cadence_days: 30, next_expected: null },
            { display_name: "Insurance", amount: 1200, cadence_days: 365, next_expected: null },
          ] };
        }
        return { rows: [] };
      },
    };
  }

  it("net worth, signed debts and investments match getNetWorth", async () => {
    const pool = perfinPool();
    const nw = await getNetWorth(pool);
    const doc = await rag.perfinFinanceSnapshot(pool);
    const fmt = (n) => (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    assert.ok(doc.content.includes(`Net worth: ${fmt(nw.net_worth)}`), doc.content);
    assert.match(doc.content, /Net worth: \$26,700\.00/);
    assert.match(doc.content, /Auto loan \(loan\): -\$15,000\.00 owed/);
    assert.match(doc.content, /Visa \(credit\): -\$300\.00 owed, credit limit \$5,000\.00/);
    assert.match(doc.content, /Schwab \(brokerage\): \$40,000\.00/);
  });

  it("monthly subscription cost includes non-monthly cadences (amount × 30 / cadence)", async () => {
    const doc = await rag.perfinFinanceSnapshot(perfinPool());
    // 15 + 1200 × 30/365 = 113.63
    assert.match(doc.content, /Active subscriptions: 2 \(~\$113\.63\/mo\)/);
    assert.equal(rag.monthlyEquivalent(90, 90), 30);
    assert.equal(rag.monthlyEquivalent(10, 0), 0);
  });
});

// ---------------------------------------------------------------------------
describe("KR-10 — capture", () => {
  it("model-supplied fields can't override reserved metadata", () => {
    const md = vault.buildCaptureMarkdown({
      type: "fact", entity: "Car",
      fields: { type: "note", sensitivity: "normal", embed: "true", valid_to: "2000-01-01", deductible: "500" },
      sensitivity: "secret",
    });
    const { meta } = vault.parseFrontmatter(md);
    assert.equal(vault.isFactFile(meta), true);
    assert.equal(vault.resolveSensitivity(meta), "secret");
    assert.deepEqual(vault.extractFacts(meta, "x.md").map((f) => f.attribute), ["deductible"]);
    assert.equal((md.match(/^type:/gm) || []).length, 1);
  });

  function captureApp() {
    const committed = [];
    const realCommit = vault.commitVaultFile;
    const realSync = vault.syncVault;
    vault.commitVaultFile = async (repo, branch, p, content) => { committed.push(content); return { content: {} }; };
    vault.syncVault = async () => ({ ok: true });
    const pool = { query: async () => ({ rows: [{ vault_repo: "me/vault", vault_branch: "main" }] }) };
    const app = express();
    app.use(express.json());
    app.use(rag({ pool }));
    return { app, committed, restore() { vault.commitVaultFile = realCommit; vault.syncVault = realSync; } };
  }

  beforeEach(() => { aiCalls.length = 0; });

  it("a secret capture is never sent to the AI and is written as secret", () =>
    withEnv({ VAULT_GITHUB_WRITE_TOKEN: "w" }, async () => {
      const c = captureApp();
      try {
        const res = await supertest(c.app).post("/api/rag/capture").send({ text: "safe combo 12-34-56", sensitivity: "secret" }).expect(200);
        assert.equal(res.body.sensitivity, "secret");
        assert.equal(aiCalls.length, 0, "no model call for a secret capture");
        assert.match(c.committed[0], /sensitivity: secret/);
      } finally { c.restore(); }
    }));

  it("a normal capture still goes through the AI; a bad sensitivity is a 400", () =>
    withEnv({ VAULT_GITHUB_WRITE_TOKEN: "w" }, async () => {
      const c = captureApp();
      try {
        callAIReply = '{"type":"fact","entity":"Car","fields":{"type":"note","deductible":"500"},"tags":[],"body":""}';
        await supertest(c.app).post("/api/rag/capture").send({ text: "car deductible 500" }).expect(200);
        assert.equal(aiCalls.length, 1);
        assert.match(c.committed[0], /^---\ntype: fact\n/);
        assert.doesNotMatch(c.committed[0], /type: note/);
        await supertest(c.app).post("/api/rag/capture").send({ text: "x", sensitivity: "public" }).expect(400);
      } finally { callAIReply = "{}"; c.restore(); }
    }));

  it("the capture form offers the sensitivity choice", () => {
    const page = fs.readFileSync(path.join(ROOT, "pages/knowledge.js"), "utf8");
    assert.match(page, /id="k-capture-sensitivity"/);
    assert.match(page, /sensitivity:document\.getElementById\('k-capture-sensitivity'\)\.value/);
  });
});

// ---------------------------------------------------------------------------
describe("KR-12 — the inline-citation fallback is grounded", () => {
  it("parseInlineCitations reads [n], [2][3] and [1, 4], within range", () => {
    assert.deepEqual(rag.parseInlineCitations("a [1] b [2][3] c [1, 4] d [9]", 4), [0, 1, 2, 3]);
    assert.deepEqual(rag.parseInlineCitations("no markers", 3), []);
  });

  it("when Citations fails, a fallback answer that cites [n] is grounded", async () => {
    citationsBehavior = "throw";
    callAIReply = "Your deductible is $500 [1].";
    try {
      const pool = {
        query: async (sql) => {
          if (/WITH corpus AS/.test(sql)) return { rows: [{ kind: "note", id: "1", title: "Car", content: "deductible 500" }] };
          return { rows: [] };
        },
      };
      const app = express();
      app.use(express.json());
      app.use(rag({ pool }));
      const res = await supertest(app).post("/api/rag/query").send({ query: "car deductible" }).expect(200);
      assert.equal(res.body.grounded, true, JSON.stringify(res.body));
      assert.equal(res.body.sources[0].cited, true);
    } finally { callAIReply = "{}"; }
  });
});

// ---------------------------------------------------------------------------
describe("KR-13 — the answer cache is pruned", () => {
  it("every cache write deletes rows that can never hit again", async () => {
    const calls = [];
    const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
    await rag.cacheSet(pool, "q", "sonnet", "2026-10-08|v:1", "a", []);
    const prune = calls.find((c) => /DELETE FROM rag_answer_cache/.test(c.sql));
    assert.ok(prune);
    assert.match(prune.sql, /corpus_version <> \$1 OR created_at < now\(\) - interval '24 hours'/);
    assert.deepEqual(prune.params, ["2026-10-08|v:1"]);
  });
});

// ---------------------------------------------------------------------------
describe("KR-14 — boundaries, validation and docs", () => {
  it("upcomingFacts matches whole attribute segments only", () => {
    const src = fs.readFileSync(path.join(ROOT, "routes/rag.js"), "utf8");
    assert.match(src, /attribute ~\* '\(\^\|\[\^a-z0-9\]\)\(renew\[a-z\]\*\|expir\[a-z\]\*\|due\|deadline\|valid\[\^a-z0-9\]\?until\|ends\?\)\(\[\^a-z0-9\]\|\$\)'/);
    assert.doesNotMatch(src, /'\(renew\|expir\|due\|deadline\|valid\.\?until\|ends\?\)'/);
  });

  it("vault_repo rejects path traversal but accepts real repo names", async () => {
    const pool = { query: async () => ({ rows: [{}] }) };
    const app = express();
    app.use(express.json());
    app.use(require("../routes/settings")({ pool, config: require("../config") }));
    for (const bad of ["../..", "me/..", "me/.", "-x/y", "a.b/c", "nope"]) {
      await supertest(app).patch("/api/settings").send({ vault_repo: bad }).expect(400);
    }
    for (const good of ["me/vault", "me/.github", "my-org/notes_v2.1"]) {
      await supertest(app).patch("/api/settings").send({ vault_repo: good }).expect(200);
    }
  });

  it("the rag.js header no longer describes the Phase 0/2 plan", () => {
    const src = fs.readFileSync(path.join(ROOT, "routes/rag.js"), "utf8").slice(0, 1500);
    assert.doesNotMatch(src, /Phase 2 will replace callAI/);
    assert.match(src, /HYBRID/);
  });
});
