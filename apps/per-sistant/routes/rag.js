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

// ---------------------------------------------------------------------------
// Answer cache (Phase 2) — exact-match, corpus-version-aware, 24h freshness.
// All helpers swallow errors so a missing table (pre-migration) degrades to
// "no cache" rather than failing the query.
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function normalizeQuery(q) {
  return String(q || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// A stamp that changes whenever the corpus changes (edit bumps max(updated_at);
// add/delete changes the active row count), so cached answers from a stale
// corpus never match.
async function corpusVersion(pool) {
  try {
    const r = await pool.query(
      `SELECT COALESCE(to_char(max(u), 'YYYYMMDDHH24MISS'), '0') AS v, count(*) AS n
       FROM ( SELECT updated_at AS u FROM notes WHERE deleted_at IS NULL
              UNION ALL SELECT updated_at FROM documents WHERE deleted_at IS NULL
              UNION ALL SELECT updated_at FROM facts WHERE deleted_at IS NULL ) x`
    );
    return `${r.rows[0].v}:${r.rows[0].n}`;
  } catch {
    return "0";
  }
}

async function cacheGet(pool, qn, model, ver) {
  try {
    const r = await pool.query(
      "SELECT answer, sources, created_at FROM rag_answer_cache WHERE query_norm = $1 AND model = $2 AND corpus_version = $3",
      [qn, model, ver]
    );
    if (!r.rows.length) return null;
    if (Date.now() - new Date(r.rows[0].created_at).getTime() > CACHE_TTL_MS) return null;
    return { answer: r.rows[0].answer, sources: r.rows[0].sources };
  } catch {
    return null;
  }
}

async function cacheSet(pool, qn, model, ver, answer, sources) {
  try {
    await pool.query(
      `INSERT INTO rag_answer_cache (query_norm, model, corpus_version, answer, sources, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, now())
       ON CONFLICT (query_norm, model, corpus_version)
       DO UPDATE SET answer = EXCLUDED.answer, sources = EXCLUDED.sources, created_at = now()`,
      [qn, model, ver, answer, JSON.stringify(sources || [])]
    );
  } catch {
    /* cache write is best-effort */
  }
}

// ---------------------------------------------------------------------------
// Structured facts (Phase 2c) — precise, supersedable key-value records with
// temporal validity. "Current" = not deleted, sensitivity normal, and within
// the optional valid_from..valid_to window. Matched facts are injected into the
// answer as an authoritative, cited source so precise lookups ("what's my
// current deductible?") don't depend on fuzzy vector recall.
// ---------------------------------------------------------------------------
const FACTS_LIMIT = 12;

function buildFactsQuery(query, limit) {
  const terms = (String(query).match(/\w+/g) || []).filter((t) => t.length > 2).slice(0, 8);
  const search = terms.length ? terms : [String(query).trim() || ""];
  const params = search.map((t) => `%${t}%`);
  const match = search
    .map((_, i) => `(entity ILIKE $${i + 1} OR attribute ILIKE $${i + 1} OR value ILIKE $${i + 1})`)
    .join(" OR ");
  const score = search
    .map(
      (_, i) =>
        `(CASE WHEN entity ILIKE $${i + 1} THEN 2 ELSE 0 END + CASE WHEN attribute ILIKE $${i + 1} THEN 1 ELSE 0 END + CASE WHEN value ILIKE $${i + 1} THEN 1 ELSE 0 END)`
    )
    .join(" + ");
  params.push(limit);
  const sql = `
    SELECT entity, attribute, value, valid_from, valid_to, (${score}) AS score
    FROM facts
    WHERE deleted_at IS NULL AND sensitivity = 'normal'
      AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)
      AND (valid_from IS NULL OR valid_from <= CURRENT_DATE)
      AND (${match})
    ORDER BY score DESC, entity
    LIMIT $${params.length}`;
  return { sql, params };
}

async function matchFacts(pool, query, limit) {
  try {
    const { sql, params } = buildFactsQuery(query, limit);
    const r = await pool.query(sql, params);
    return r.rows;
  } catch {
    return []; // facts table missing / pre-migration → no facts
  }
}

// Render matched facts into a single authoritative document, grouped by entity.
function factsToDocument(rows) {
  if (!rows || !rows.length) return null;
  const byEntity = new Map();
  for (const f of rows) {
    if (!byEntity.has(f.entity)) byEntity.set(f.entity, []);
    byEntity.get(f.entity).push(f);
  }
  const lines = [];
  for (const [entity, fs] of byEntity) {
    lines.push(`${entity}:`);
    for (const f of fs) {
      const until = f.valid_to ? ` (valid until ${f.valid_to})` : "";
      lines.push(`  ${f.attribute}: ${f.value}${until}`);
    }
  }
  return { title: "Known facts (current)", content: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// Cross-app grounding (Phase 3) — answer finance-flavored questions using
// Perfin data, read-only, via the shell-wired perfinPool (INV-25: never an
// HTTP self-fetch). Only triggered on finance-looking queries so non-finance
// questions don't ship account data to the model. Schema-drift safe (any error
// → null, no finance context).
// ---------------------------------------------------------------------------
const FINANCE_RE =
  /\b(afford|cost|costs?|price[ds]?|pay|paid|payments?|budget|balances?|owe[ds]?|spend(?:ing|t)?|money|accounts?|subscriptions?|premiums?|renew(?:al)?|bills?|cash|savings|credit|debt|expenses?|income|salary|loan|mortgage)\b|\$/i;

function looksFinancial(q) {
  return FINANCE_RE.test(String(q || ""));
}

function money(v) {
  if (v == null) return null;
  const n = Number(v);
  const s = "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? "-" + s : s;
}

async function perfinFinanceSnapshot(perfinPool) {
  if (!perfinPool) return null;
  try {
    const [acc, subs] = await Promise.all([
      perfinPool.query("SELECT name, type, current_balance, credit_limit FROM linked_accounts ORDER BY type, name"),
      perfinPool.query(
        "SELECT display_name, amount, cadence_days, next_expected FROM detected_subscriptions WHERE is_active = true AND is_dismissed = false AND cancelled_at IS NULL"
      ),
    ]);
    const lines = [];
    if (acc.rows.length) {
      lines.push("Accounts:");
      for (const a of acc.rows) {
        const bal = money(a.current_balance) || "balance unknown";
        const lim = a.credit_limit != null ? `, credit limit ${money(a.credit_limit)}` : "";
        lines.push(`  ${a.name} (${a.type || "account"}): ${bal}${lim}`);
      }
    }
    if (subs.rows.length) {
      const monthly = subs.rows
        .filter((s) => Number(s.cadence_days) <= 31)
        .reduce((sum, s) => sum + Number(s.amount || 0), 0);
      lines.push(`Active subscriptions: ${subs.rows.length} (~${money(monthly)}/mo)`);
      const now = Date.now();
      const upcoming = subs.rows
        .filter((s) => {
          if (!s.next_expected) return false;
          const d = (new Date(s.next_expected).getTime() - now) / 86400000;
          return d >= 0 && d <= 14;
        })
        .map((s) => `${s.display_name} ${money(s.amount)} on ${new Date(s.next_expected).toISOString().slice(0, 10)}`);
      if (upcoming.length) lines.push("Upcoming charges (next 14 days): " + upcoming.join("; "));
    }
    if (!lines.length) return null;
    return { title: "Finances (from Perfin)", content: lines.join("\n") };
  } catch {
    return null;
  }
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
      const factDoc = factsToDocument(await matchFacts(pool, query, FACTS_LIMIT));

      // Combine current structured facts (authoritative, listed first) with the
      // retrieved prose sources into one numbered source list.
      const documents = [];
      const sources = [];
      let n = 1;
      if (factDoc) {
        documents.push(factDoc);
        sources.push({ n: n++, id: "facts", kind: "fact", title: factDoc.title });
      }
      // Cross-app grounding: pull a read-only finance snapshot from Perfin for
      // finance-flavored questions ("can I afford the renewal?").
      if (looksFinancial(query)) {
        const financeDoc = await perfinFinanceSnapshot(req.app.get("perfinPool"));
        if (financeDoc) {
          documents.push(financeDoc);
          sources.push({ n: n++, id: "perfin", kind: "finance", title: financeDoc.title });
        }
      }
      for (const r of rows) {
        const title = r.title || (r.kind === "note" ? "Untitled note" : "Untitled");
        documents.push({ title, content: snippet(r.content) });
        sources.push({ n: n++, id: String(r.id), kind: r.kind, title });
      }

      if (!documents.length) {
        return res.json({
          answer: null,
          sources: [],
          note: "Nothing in your knowledge base matched that. Try different words, or add notes/documents first.",
        });
      }

      const model = await getAIModelForFeature("rag");
      if (model === "off" || !isAIAvailable()) {
        // Degrade gracefully: still hand back the matching sources so the
        // page is useful without an AI call (or with the feature disabled).
        return res.json({
          answer: null,
          sources,
          note: isAIAvailable()
            ? "Knowledge Q&A is turned off. Enable it in Settings → AI Features. Showing matching sources."
            : "AI is not configured. Showing matching sources only.",
        });
      }

      // Exact-match answer cache — return a prior answer for the same query
      // when the corpus hasn't changed (and it's < 24h old). Free repeats.
      const qn = normalizeQuery(query);
      const ver = await corpusVersion(pool);
      // Finance-grounded answers depend on live Perfin data, which isn't part of
      // the corpus-version stamp — don't cache them, or a balance change within
      // the 24h window would serve a stale affordability answer.
      const useCache = !looksFinancial(query);
      if (useCache) {
        const cached = await cacheGet(pool, qn, model, ver);
        if (cached) return res.json({ answer: cached.answer, sources: cached.sources, cached: true });
      }

      const SYSTEM =
        "You are a personal knowledge assistant. Answer the question using ONLY the information in the provided documents. A document titled \"Known facts (current)\" holds verified structured facts about the user — treat it as authoritative and prefer it for precise values (numbers, dates, IDs). If the documents do not contain the answer, say plainly that you don't have that information in your knowledge base — do not guess or use outside knowledge. Be concise.";

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
      const finalSources = sources.map((s) => ({ ...s, cited: citedSet.has(s.n - 1) }));
      if (useCache) await cacheSet(pool, qn, model, ver, answer, finalSources);
      res.json({ answer, sources: finalSources, cached: false });
    } catch (err) {
      serverError(res, err);
    }
  });

  // Vault + index status for the Knowledge page / Settings. Cheap; safe to poll.
  router.get("/api/rag/status", async (req, res) => {
    try {
      const cfg = await vaultSync.getVaultConfig(pool).catch(() => ({}));
      const ready = await vaultSync.vectorReady(pool);
      const counts = { documents: 0, embedded: 0, facts: 0 };
      try {
        const c = await pool.query(
          `SELECT (SELECT count(*) FROM documents WHERE deleted_at IS NULL) AS documents,
                  (SELECT count(*) FROM embed_state) AS embedded`
        );
        counts.documents = Number(c.rows[0].documents);
        counts.embedded = Number(c.rows[0].embedded);
      } catch {}
      try {
        const fc = await pool.query("SELECT count(*) AS n FROM facts WHERE deleted_at IS NULL AND sensitivity = 'normal'");
        counts.facts = Number(fc.rows[0].n);
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

  // Browse your own current structured facts. ?entity= filters by entity name;
  // ?all=1 includes expired/future-dated facts. Only 'normal' sensitivity.
  router.get("/api/rag/facts", async (req, res) => {
    try {
      const all = req.query.all === "1" || req.query.all === "true";
      const params = [];
      let where = "deleted_at IS NULL AND sensitivity = 'normal'";
      if (!all) {
        where += " AND (valid_to IS NULL OR valid_to >= CURRENT_DATE) AND (valid_from IS NULL OR valid_from <= CURRENT_DATE)";
      }
      if (req.query.entity) {
        params.push(`%${String(req.query.entity)}%`);
        where += ` AND entity ILIKE $${params.length}`;
      }
      const r = await pool.query(
        `SELECT id, entity, attribute, value, valid_from, valid_to, source_ref, updated_at
         FROM facts WHERE ${where} ORDER BY entity, attribute LIMIT 500`,
        params
      );
      res.json({ facts: r.rows });
    } catch (err) {
      res.json({ facts: [] }); // facts table may not exist pre-migration
    }
  });

  return router;
};

// Exported for unit tests.
module.exports.buildRetrievalQuery = buildRetrievalQuery;
module.exports.normalizeQuery = normalizeQuery;
module.exports.corpusVersion = corpusVersion;
module.exports.cacheGet = cacheGet;
module.exports.cacheSet = cacheSet;
module.exports.buildFactsQuery = buildFactsQuery;
module.exports.factsToDocument = factsToDocument;
module.exports.matchFacts = matchFacts;
module.exports.looksFinancial = looksFinancial;
module.exports.perfinFinanceSnapshot = perfinFinanceSnapshot;
