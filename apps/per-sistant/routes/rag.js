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
    SELECT entity, attribute, value, valid_from, valid_to,
           EXISTS(SELECT 1 FROM fact_verifications fv
                  WHERE fv.entity = facts.entity AND fv.attribute = facts.attribute AND fv.value = facts.value) AS verified,
           (${score}) AS score
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

// Proactive surfacing (Phase 3): facts with an upcoming date — either the
// validity window ending (valid_to) or a date-valued attribute (renewal/
// expiration/due/deadline). Returns rows { entity, kind, on_date, days_away }
// within `days`. Used by the notification check. Schema-drift safe.
async function upcomingFacts(pool, days = 30) {
  try {
    const r = await pool.query(
      `SELECT entity, kind, on_date, (on_date - CURRENT_DATE) AS days_away FROM (
         SELECT entity, 'expires'::text AS kind, valid_to AS on_date
         FROM facts
         WHERE deleted_at IS NULL AND sensitivity = 'normal' AND valid_to IS NOT NULL
         UNION ALL
         SELECT entity, attribute AS kind,
                -- to_date (not value::date) so a date-SHAPED but out-of-range
                -- value (e.g. '2025-02-30') doesn't THROW and abort the whole
                -- query — which would silently disable ALL upcoming-fact
                -- notifications (K2). to_date is lenient (rolls over) and never
                -- raises on a digit-shaped input.
                CASE WHEN value ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN to_date(value, 'YYYY-MM-DD') END AS on_date
         FROM facts
         WHERE deleted_at IS NULL AND sensitivity = 'normal'
           AND attribute ~* '(renew|expir|due|deadline|valid.?until|ends?)'
       ) s
       WHERE on_date IS NOT NULL
         AND on_date >= CURRENT_DATE
         AND on_date <= CURRENT_DATE + ($1 || ' days')::interval
       ORDER BY on_date
       LIMIT 50`,
      [String(parseInt(days, 10) || 30)]
    );
    return r.rows;
  } catch {
    return [];
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
      const mark = f.verified ? " [verified]" : "";
      lines.push(`  ${f.attribute}: ${f.value}${until}${mark}`);
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

// Strip ```mermaid fences the model sometimes wraps around the diagram.
function stripMermaidFences(s) {
  return String(s || "")
    .replace(/^\s*```(?:mermaid)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
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
        if (cached) {
          return res.json({
            answer: cached.answer,
            sources: cached.sources,
            cached: true,
            grounded: (cached.sources || []).some((s) => s.cited),
          });
        }
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
      // Trust signal: did the answer actually cite a provided source? An
      // ungrounded answer (no citations) may have drawn on outside knowledge —
      // the UI flags it for the user to double-check.
      const grounded = finalSources.some((s) => s.cited);
      if (useCache) await cacheSet(pool, qn, model, ver, answer, finalSources);
      res.json({ answer, sources: finalSources, cached: false, grounded });
    } catch (err) {
      serverError(res, err);
    }
  });

  // Generate a Mermaid diagram from the knowledge base. Retrieves the same way
  // as /query (facts + finance + prose), then asks the model for Mermaid only.
  // Generative output, so no Citations and no answer-cache here.
  router.post("/api/rag/diagram", async (req, res) => {
    try {
      const query = (req.body && req.body.query || "").toString().trim();
      if (!query) return res.status(400).json({ error: "Query is required." });

      const rows = await retrieve(query, MAX_SOURCES);
      const factDoc = factsToDocument(await matchFacts(pool, query, FACTS_LIMIT));
      const documents = [];
      const sources = [];
      let n = 1;
      if (factDoc) { documents.push(factDoc); sources.push({ n: n++, id: "facts", kind: "fact", title: factDoc.title }); }
      if (looksFinancial(query)) {
        const financeDoc = await perfinFinanceSnapshot(req.app.get("perfinPool"));
        if (financeDoc) { documents.push(financeDoc); sources.push({ n: n++, id: "perfin", kind: "finance", title: financeDoc.title }); }
      }
      for (const r of rows) {
        const title = r.title || (r.kind === "note" ? "Untitled note" : "Untitled");
        documents.push({ title, content: snippet(r.content) });
        sources.push({ n: n++, id: String(r.id), kind: r.kind, title });
      }

      if (!documents.length) {
        return res.json({ mermaid: null, sources: [], note: "Nothing in your knowledge base matched that." });
      }

      const model = await getAIModelForFeature("rag");
      if (model === "off" || !isAIAvailable()) {
        return res.json({
          mermaid: null,
          sources,
          note: isAIAvailable()
            ? "Knowledge Q&A is turned off. Enable it in Settings → AI Features."
            : "AI is not configured.",
        });
      }

      const context = documents.map((d, i) => `[${i + 1}] ${d.title}\n${d.content}`).join("\n\n");
      const raw = await callAI(
        model,
        `Data:\n${context}\n\nDiagram request: "${query}"`,
        1500,
        "You generate Mermaid diagrams from the user's personal data. Output ONLY valid Mermaid syntax — no prose, no explanation, no markdown code fences. Pick the most fitting diagram type (flowchart TD, mindmap, timeline, or erDiagram). Use ONLY information present in the provided data; never invent nodes or values. Keep node labels short and avoid characters that break Mermaid (quotes, parentheses) inside labels."
      );
      res.json({ mermaid: stripMermaidFences(raw), sources });
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

  // Capture: turn raw text (a pasted email, a dictated note) into a markdown
  // note/fact and COMMIT it to the vault repo. Outward write — gated on a
  // separate write-scoped token (VAULT_GITHUB_WRITE_TOKEN); refuses cleanly if
  // it isn't set, so nothing can write to the repo until the operator opts in.
  router.post("/api/rag/capture", async (req, res) => {
    try {
      const text = (req.body && req.body.text || "").toString().trim();
      if (!text) return res.status(400).json({ error: "text is required." });

      const writeToken = process.env.VAULT_GITHUB_WRITE_TOKEN;
      if (!writeToken) {
        return res.status(400).json({
          error: "Capture is not configured. Set VAULT_GITHUB_WRITE_TOKEN (a write-scoped GitHub token for your vault repo).",
        });
      }
      const cfg = await vaultSync.getVaultConfig(pool);
      if (!cfg.vault_repo) {
        return res.status(400).json({ error: "No vault repo configured. Set it in Settings → Knowledge." });
      }

      // Default: store the raw text as a note. If AI is on, let it structure the
      // capture (note vs fact, fields, tags) — falling back to the raw note.
      let entry = { type: req.body.kind === "fact" ? "fact" : "note", title: null, entity: null, fields: {}, tags: [], body: text };
      const model = await getAIModelForFeature("rag");
      if (model !== "off" && isAIAvailable()) {
        try {
          const raw = await callAI(
            model,
            `Captured text:\n"""\n${text}\n"""`,
            800,
            'Convert the captured text into a personal-knowledge entry. Return ONLY a JSON object: {"type":"note"|"fact","title":string,"entity":string|null,"fields":{key:value},"tags":[string],"body":string}. Use "fact" when the text is mostly discrete attributes about one entity (account, policy, device, person): put those attributes in "fields" (short snake_case keys) and the name in "entity". Otherwise use "note" with the prose in "body". Do not invent information.'
          );
          const m = raw.match(/\{[\s\S]*\}/);
          if (m) {
            const p = JSON.parse(m[0]);
            entry = {
              type: p.type === "fact" ? "fact" : "note",
              title: p.title || null,
              entity: p.entity || null,
              fields: p.fields && typeof p.fields === "object" ? p.fields : {},
              tags: Array.isArray(p.tags) ? p.tags.slice(0, 10) : [],
              body: p.body || text,
            };
          }
        } catch (e) {
          /* fall back to the raw note */
        }
      }

      const title = entry.title || entry.entity || text.slice(0, 40);
      const md = vaultSync.buildCaptureMarkdown(entry);
      const date = new Date().toISOString().slice(0, 10);
      const rand = Math.random().toString(36).slice(2, 7);
      const path = `captures/${date}-${vaultSync.slugify(title)}-${rand}.md`;
      const result = await vaultSync.commitVaultFile(
        cfg.vault_repo,
        cfg.vault_branch || "main",
        path,
        md,
        `capture: ${title}`,
        { token: writeToken }
      );
      // Index it soon (non-blocking; next cron would also pick it up).
      vaultSync.syncVault(pool).catch(() => {});
      res.json({ ok: true, path, type: entry.type, html_url: (result.content && result.content.html_url) || null });
    } catch (err) {
      serverError(res, err);
    }
  });

  // Secret tier: local exact/substring match over sensitivity='secret' items,
  // returned VERBATIM to the user. This is a pure DB read with NO model call —
  // and the AI retrieval paths (buildRetrievalQuery, buildFactsQuery,
  // perfinFinanceSnapshot) all require sensitivity='normal', so secret content
  // is never embedded and never enters a prompt. Stored in your own DB, never
  // sent to Voyage/Anthropic.
  router.get("/api/rag/secret-lookup", async (req, res) => {
    try {
      const q = (req.query.q || "").toString().trim();
      if (!q) return res.status(400).json({ error: "Query is required." });
      const like = `%${q}%`;
      const results = [];
      try {
        const docs = await pool.query(
          "SELECT title, content FROM documents WHERE deleted_at IS NULL AND sensitivity = 'secret' AND (title ILIKE $1 OR content ILIKE $1) ORDER BY updated_at DESC LIMIT 20",
          [like]
        );
        docs.rows.forEach((d) => results.push({ kind: "document", title: d.title || "Untitled", content: d.content }));
      } catch {}
      try {
        const facts = await pool.query(
          "SELECT entity, attribute, value FROM facts WHERE deleted_at IS NULL AND sensitivity = 'secret' AND (entity ILIKE $1 OR attribute ILIKE $1 OR value ILIKE $1) ORDER BY entity LIMIT 50",
          [like]
        );
        facts.rows.forEach((f) => results.push({ kind: "fact", title: `${f.entity} — ${f.attribute}`, content: f.value }));
      } catch {}
      res.json({ results, note: "Local match over secret items — never embedded, never sent to AI." });
    } catch (err) {
      serverError(res, err);
    }
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
        `SELECT id, entity, attribute, value, valid_from, valid_to, source_ref, updated_at,
                EXISTS(SELECT 1 FROM fact_verifications fv
                       WHERE fv.entity = facts.entity AND fv.attribute = facts.attribute AND fv.value = facts.value) AS verified
         FROM facts WHERE ${where} ORDER BY entity, attribute LIMIT 500`,
        params
      );
      res.json({ facts: r.rows });
    } catch (err) {
      res.json({ facts: [] }); // facts table may not exist pre-migration
    }
  });

  // Verify-this-fact trust loop. Keyed by content (entity, attribute, value) so
  // it survives vault re-syncs (which replace fact rows) and resets when the
  // value changes. Pass verified:false to clear.
  router.post("/api/rag/facts/verify", async (req, res) => {
    try {
      const { entity, attribute, value } = req.body || {};
      const verified = req.body && req.body.verified !== false; // default true
      if (!entity || !attribute || value == null) {
        return res.status(400).json({ error: "entity, attribute, and value are required." });
      }
      if (verified) {
        await pool.query(
          `INSERT INTO fact_verifications (entity, attribute, value, verified_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (entity, attribute, value) DO UPDATE SET verified_at = now()`,
          [String(entity), String(attribute), String(value)]
        );
      } else {
        await pool.query(
          "DELETE FROM fact_verifications WHERE entity = $1 AND attribute = $2 AND value = $3",
          [String(entity), String(attribute), String(value)]
        );
      }
      res.json({ ok: true, verified });
    } catch (err) {
      serverError(res, err);
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
module.exports.upcomingFacts = upcomingFacts;
module.exports.looksFinancial = looksFinancial;
module.exports.perfinFinanceSnapshot = perfinFinanceSnapshot;
module.exports.stripMermaidFences = stripMermaidFences;
