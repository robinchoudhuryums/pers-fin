-- ============================================================================
-- Per-sistant — Knowledge / RAG Migration (Phase 0)
-- ============================================================================
-- Additive only — creates the personal-knowledge corpus scaffolding without
-- touching any existing table's data. Safe to revert by dropping the
-- `documents` table and the `ai_model_rag` column; nothing else depends on it.
--
-- Phase 0 retrieves over `notes` + `documents` via keyword search (no
-- embeddings yet). Phase 1 adds pgvector + the Obsidian-vault ingest that
-- populates `documents` (source='vault'). The columns below are intentionally
-- forward-compatible with that:
--   - sensitivity: 'normal' (embeddable + retrievable + sent to AI),
--                  'private' (retrievable but never embedded — Phase 1),
--                  'secret'  (never embedded, never sent to AI — local-only).
--     Phase 0 already excludes 'secret' rows from the retrieval corpus.
--   - (source, source_ref) unique index gives Phase 1's vault sync an
--     ON CONFLICT target for idempotent per-file upserts.
-- ============================================================================

-- Per-feature model selection for the Knowledge Q&A feature. Defaults to
-- sonnet (RAG answers benefit from the stronger model); 'off' disables it.
-- Read via getAIModelForFeature('rag') — 'rag' is registered in
-- config.VALID_AI_FEATURES.
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS ai_model_rag TEXT NOT NULL DEFAULT 'sonnet';

-- Personal-knowledge documents. In Phase 0 this is empty (the corpus is your
-- existing notes); it fills up in Phase 1 when the Obsidian vault is indexed.
CREATE TABLE IF NOT EXISTS documents (
    id            SERIAL PRIMARY KEY,
    source        TEXT NOT NULL DEFAULT 'manual'
                  CHECK (source IN ('manual', 'vault', 'note')),
    source_ref    TEXT,                              -- vault file path / external id
    title         TEXT,
    content       TEXT NOT NULL,
    tags          TEXT[],
    sensitivity   TEXT NOT NULL DEFAULT 'normal'
                  CHECK (sensitivity IN ('normal', 'private', 'secret')),
    deleted_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_documents_active ON documents (updated_at DESC)
    WHERE deleted_at IS NULL;
-- ON CONFLICT target for Phase 1's per-file vault upserts (one row per path).
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_source_ref
    ON documents (source, source_ref) WHERE source_ref IS NOT NULL;

-- set_updated_at() is defined in 001_schema.sql, which runs before this file
-- (migrations apply in sorted filename order). CREATE TRIGGER has no
-- IF NOT EXISTS form and migrations run in one fatal-on-error transaction, so
-- guard with DROP TRIGGER IF EXISTS to keep re-runs idempotent (PS-1).
DROP TRIGGER IF EXISTS trg_documents_updated_at ON documents;
CREATE TRIGGER trg_documents_updated_at
    BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();
