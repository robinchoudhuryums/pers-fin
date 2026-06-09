// ============================================================================
// Per-sistant — Knowledge / RAG Routes (Phase 0)
// ============================================================================
// Personal knowledge base Q&A. Phase 0 uses keyword retrieval over `notes` +
// `documents` (no embeddings); Phase 1 swaps the retrieval step for pgvector
// cosine search behind the same endpoints.
//
//   GET  /api/rag/search?q=...   retrieval only — zero LLM cost
//   POST /api/rag/query {query}  retrieve, then a source-grounded Claude answer
//
// The query path answers ONLY from retrieved sources and cites them inline by
// [n]; the source list is returned alongside so the UI can show provenance.
// Gated by getAIModelForFeature('rag') + isAIAvailable(); search works with no
// AI configured. Phase 2 will replace callAI here with a dedicated Citations
// function (multi-block) — callAI's single-text-block return is fine for now.
// ============================================================================

const express = require("express");
const { callAI, answerWithCitations, getAIModelForFeature, isAIAvailable } = require("../ai");
const embeddings = require("../services/embeddings");
const vaultSync = require("../services/vault-sync");
const { serverError } = require("../errors");

// Cap how much of each source we feed the model, and how many sources.
const MAX_SOURCES = 8;
const MAX_SNIPPET_CHARS = 1500;

// Background reindex status (module-scoped so it survives across requests).
// The real concurrency lock lives in vault-sync (isSyncing); this is UI state.
let reindexState = { running: false, started_at: null, finished_at: null, result: null, error: null };

// Build a parameterized keyword query over the notes + documents corpus
// (the fallback path when embeddings/pgvector aren't available). Returns
// { sql, params }. Only 'normal'-sensitivity documents are retrievable —
// 'private'/'secret' rows are never returned and never sent to the model.
function buildRetrievalQuery(query, limit) {
  const terms = (String(query).match(/\w+/g) || [])
    .filter((t) => t.length > 2)
    .slice(0, 8);
  const search = terms.length ? terms : [String(query).trim() || ""];
  const params = search.map((t) => `%${t}%`);
  const match = search
    .map((_, i) => `(title ILIKE $${i + 1} OR content ILIKE $${i + 1})`)
    .join(" OR ");
  const score = search
    .map(
      (_, i) =>
        `(CASE WHEN title ILIKE $${i + 1} THEN 2 ELSE 0 END + CASE WHEN content ILIKE $${i + 1} THEN 1 ELSE 0 END)`
    )
    .join(" + ");
  params.push(limit);
  const sql = `
    WITH corpus AS (
      SELECT id::text AS id, title, content, 'note'::text AS kind, updated_at
      FROM notes WHERE deleted_at IS NULL
      UNION ALL
      SELECT id::text AS id, title, content, 'document'::text AS kind, updated_at
      FROM documents WHERE deleted_at IS NULL AND sensitivity = 'normal'
    )
    SELECT id, title, content, kind, updated_at, (${score}) AS score
    FROM corpus
    WHERE ${match}
    ORDER BY score DESC, updated_at DESC
    LIMIT $${params.length}`;
  return { sql, params };
}

function snippet(text) {
  const t = String(text || "");
  return t.length > MAX_SNIPPET_CHARS ? t.slice(0, MAX_SNIPPET_CHARS) + "…" : t;
}

module.exports = function ({ pool }) {
  const router = express.Router();

  // Vector retrieval over the polymorphic chunk store, joining back to the
  // source row to get its title and honor deleted/sensitivity filters. Only
  // 'normal' documents (and non-deleted notes) are retrievable.
  const VECTOR_SQL = `
    SELECT c.source_kind AS kind, c.source_id::text AS id, c.content,
           COALESCE(n.title, d.title) AS title,
           COALESCE(n.updated_at, d.updated_at) AS updated_at
    FROM chunks c
    LEFT JOIN notes n ON c.source_kind = 'note' AND n.id = c.source_id
    LEFT JOIN documents d ON c.source_kind = 'document' AND d.id = c.source_id
    WHERE c.embedding IS NOT NULL
      AND ( (c.source_kind = 'note' AND n.deleted_at IS NULL)
         OR (c.source_kind = 'document' AND d.deleted_at IS NULL AND d.sensitivity = 'normal') )
    ORDER BY c.embedding <=> $1::vector
    LIMIT $2`;

  // Vector-first; falls back to keyword (Phase 0) when Voyage isn't configured,
  // the chunks table doesn't exist, the query embed fails, or nothing matched.
  async function retrieve(query, limit) {
    if (embeddings.isConfigured() && (await vaultSync.vectorReady(pool))) {
      try {
        const [qvec] = await embeddings.embed([query], { inputType: "query" });
        const r = await pool.query(VECTOR_SQL, [embeddings.toVectorLiteral(qvec), limit]);
        if (r.rows.length) return r.rows;
      } catch (e) {
        // fall through to keyword retrieval on any embedding/vector error
      }
    }
    const { sql, params } = buildRetrievalQuery(query, limit);
    const r = await pool.query(sql, params);
    return r.rows;
  }

  // Retrieval only — no model call, so this is free and works without an API key.
  router.get("/api/rag/search", async (req, res) => {
    try {
      const q = (req.query.q || "").toString().trim();
      if (!q) return res.status(400).json({ error: "Query is required." });
      const rows = await retrieve(q, MAX_SOURCES);
      res.json({
        results: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          title: r.title || null,
          snippet: snippet(r.content),
          updated_at: r.updated_at,
        })),
      });
    } catch (err) {
      serverError(res, err);
    }
  });

  // Source-grounded answer. Retrieves first, then asks Claude to answer using
  // ONLY the retrieved sources, citing them inline by [n].
  router.post("/api/rag/query", async (req, res) => {
    try {
      const query = (req.body && req.body.query || "").toString().trim();
      if (!query) return res.status(400).json({ error: "Query is required." });

      const rows = await retrieve(query, MAX_SOURCES);
      const sources = rows.map((r, i) => ({
        n: i + 1,
        id: r.id,
        kind: r.kind,
        title: r.title || (r.kind === "note" ? "Untitled note" : "Untitled"),
      }));

      if (!rows.length) {
        return res.json({
          answer: null,
          sources: [],
          note: "Nothing in your knowledge base matched that. Try different words, or add notes/documents first.",
        });
      }

      const model = await getAIModelForFeature("rag");
      if (model === "off" || !isAIAvailable()) {
        // Degrade gracefully: still hand back the retrieved sources so the
        // page is useful without an AI call (or with the feature disabled).
        return res.json({
          answer: null,
          sources,
          note: isAIAvailable()
            ? "Knowledge Q&A is turned off. Enable it in Settings → AI Features. Showing matching sources."
            : "AI is not configured. Showing matching sources only.",
        });
      }

      const SYSTEM =
        "You are a personal knowledge assistant. Answer the question using ONLY the information in the provided documents. If the documents do not contain the answer, say plainly that you don't have that information in your knowledge base — do not guess or use outside knowledge. Be concise.";
      const documents = rows.map((r) => ({
        title: r.title || (r.kind === "note" ? "Untitled note" : "Untitled"),
        content: snippet(r.content),
      }));

      // Real Citations: the model cites which document backed each claim. Fall
      // back to the prompt-cite path if the citations call fails for any reason.
      let answer;
      let citedIndexes = [];
      try {
        const out = await answerWithCitations({ model, system: SYSTEM, query, documents });
        answer = out.text;
        citedIndexes = out.citedIndexes;
      } catch (e) {
        const context = documents.map((d, i) => `[${i + 1}] ${d.title}\n${d.content}`).join("\n\n");
        answer = await callAI(
          model,
          `Sources:\n${context}\n\nQuestion: "${query}"`,
          1024,
          `${SYSTEM} Cite the sources you use inline with their bracketed numbers, e.g. [1] or [2][3].`
        );
      }

      const citedSet = new Set(citedIndexes);
      res.json({ answer, sources: sources.map((s) => ({ ...s, cited: citedSet.has(s.n - 1) })) });
    } catch (err) {
      serverError(res, err);
    }
  });

  // Vault + index status for the Knowledge page / Settings. Cheap; safe to poll.
  router.get("/api/rag/status", async (req, res) => {
    try {
      const cfg = await vaultSync.getVaultConfig(pool).catch(() => ({}));
      const ready = await vaultSync.vectorReady(pool);
      const counts = { documents: 0, embedded: 0 };
      try {
        const c = await pool.query(
          `SELECT (SELECT count(*) FROM documents WHERE deleted_at IS NULL) AS documents,
                  (SELECT count(*) FROM embed_state) AS embedded`
        );
        counts.documents = Number(c.rows[0].documents);
        counts.embedded = Number(c.rows[0].embedded);
      } catch {}
      res.json({
        vault: {
          enabled: !!cfg.vault_enabled,
          repo: cfg.vault_repo || null,
          branch: cfg.vault_branch || "main",
          last_synced_at: cfg.vault_last_synced_at || null,
          last_error: cfg.vault_last_error || null,
        },
        embeddings_configured: embeddings.isConfigured(),
        vector_ready: ready,
        counts,
        reindex: reindexState,
      });
    } catch (err) {
      serverError(res, err);
    }
  });

  // Kick a full reindex in the background (vault re-walk + notes). Returns 202
  // immediately; poll GET /api/rag/status for progress. 409 if already running.
  // Auth: under the unified shell this is reachable from the GitHub Actions
  // cron via x-api-key (the shell validates it); browsers use the session.
  router.post("/api/rag/reindex", async (req, res) => {
    if (reindexState.running || vaultSync.isSyncing()) {
      return res.status(409).json({ error: "A sync/reindex is already running." });
    }
    reindexState = { running: true, started_at: new Date().toISOString(), finished_at: null, result: null, error: null };
    res.status(202).json({ started: true });
    (async () => {
      try {
        reindexState.result = await vaultSync.reindexAll(pool);
      } catch (e) {
        reindexState.error = e.message;
      } finally {
        reindexState.running = false;
        reindexState.finished_at = new Date().toISOString();
      }
    })();
  });

  return router;
};

// Exported for unit tests (parameterized-query construction is pure).
module.exports.buildRetrievalQuery = buildRetrievalQuery;
