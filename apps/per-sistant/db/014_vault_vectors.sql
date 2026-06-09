-- ============================================================================
-- Per-sistant — Vault Vectors Migration (Phase 1)
-- ============================================================================
-- Adds the semantic-retrieval layer: pgvector chunks + embed bookkeeping +
-- Obsidian-vault sync config. Additive only; revert by dropping the chunks /
-- embed_state tables and the vault_* columns.
--
-- SAFETY: this migration runs inside Per-sistant's single fatal-on-error
-- transaction, and the whole unified shell (both apps) fails to boot if it
-- throws. pgvector is therefore created DEFENSIVELY — only if the `vector`
-- extension is actually available on this Postgres. If it isn't, the chunks
-- table simply isn't created, the migration still succeeds, and Knowledge
-- transparently falls back to Phase 0 keyword retrieval (routes/rag.js +
-- services/vault-sync.vectorReady gate on the table's existence). Neon has
-- pgvector available, so in practice the table IS created.
-- ============================================================================

-- Vector store — created only when pgvector is available (see SAFETY above).
DO $vec$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;

    -- Polymorphic chunks: a chunk belongs to either a `note` or a `document`
    -- (source_kind, source_id) — mirrors Perfin's polymorphic
    -- account_balance_snapshots. No FK because the two source tables have
    -- independent lifecycles; sync prunes orphans explicitly.
    EXECUTE $ddl$
      CREATE TABLE IF NOT EXISTS chunks (
        id           SERIAL PRIMARY KEY,
        source_kind  TEXT NOT NULL CHECK (source_kind IN ('note', 'document')),
        source_id    INT  NOT NULL,
        chunk_index  INT  NOT NULL,
        content      TEXT NOT NULL,
        embedding    vector(1024),
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (source_kind, source_id, chunk_index)
      )
    $ddl$;
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_chunks_lookup ON chunks (source_kind, source_id)';
    -- HNSW + cosine: matches the 1 - (embedding <=> query) cosine retrieval.
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON chunks USING hnsw (embedding vector_cosine_ops)';
  ELSE
    RAISE NOTICE 'pgvector (vector) extension unavailable — Knowledge stays on keyword retrieval';
  END IF;
END
$vec$;

-- Embed bookkeeping — content hash per source so unchanged notes/docs aren't
-- re-embedded on every sync (saves Voyage calls). Isolated table (not a column
-- on notes/documents) so revert is a clean drop and notes stay untouched.
-- No vector type here, so it's created unconditionally.
CREATE TABLE IF NOT EXISTS embed_state (
    source_kind  TEXT NOT NULL,
    source_id    INT  NOT NULL,
    content_sha  TEXT NOT NULL,
    chunk_count  INT  NOT NULL DEFAULT 0,
    embedded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source_kind, source_id)
);

-- Obsidian-vault sync config (non-secret — the GitHub token is the
-- VAULT_GITHUB_TOKEN env var, never stored here).
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS vault_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS vault_repo TEXT;                              -- "owner/name"
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS vault_branch TEXT NOT NULL DEFAULT 'main';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS vault_last_sha TEXT;                          -- last-indexed commit
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS vault_last_synced_at TIMESTAMPTZ;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS vault_last_error TEXT;
