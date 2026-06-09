-- ============================================================================
-- Per-sistant — Knowledge answer cache (Phase 2)
-- ============================================================================
-- Exact-match cache for generated Knowledge answers so repeats are free across
-- restarts / Render sleeps (the in-memory ai.js cache is wiped on every cold
-- start). Keyed by normalized query + model + a corpus version stamp, so the
-- cache auto-invalidates when notes/documents change (the stamp is derived from
-- max(updated_at) + active row count). A 24h freshness window is enforced in
-- the route. Additive; revert by dropping the table.
-- ============================================================================

CREATE TABLE IF NOT EXISTS rag_answer_cache (
    id             SERIAL PRIMARY KEY,
    query_norm     TEXT NOT NULL,
    model          TEXT NOT NULL,
    corpus_version TEXT NOT NULL,
    answer         TEXT NOT NULL,
    sources        JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (query_norm, model, corpus_version)
);

CREATE INDEX IF NOT EXISTS idx_rag_cache_created ON rag_answer_cache (created_at);
