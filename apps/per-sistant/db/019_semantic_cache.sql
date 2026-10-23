-- ============================================================================
-- Per-sistant — Semantic answer cache (RAG v2)
-- ============================================================================
-- Adds a query embedding to rag_answer_cache so paraphrased questions can hit
-- a prior answer (cosine >= 0.97) instead of paying for a fresh model call.
-- Same defensive pgvector posture as 014: when the `vector` extension isn't
-- available the column simply isn't added and the cache stays exact-match
-- only (routes/rag.js swallows the column's absence).
-- ============================================================================

DO $vec$
BEGIN
  -- Installed, not merely available (cycle-7 F10 — db/014 makes the one
  -- creation attempt and tolerates a role that can't create it).
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE 'ALTER TABLE rag_answer_cache ADD COLUMN IF NOT EXISTS query_embedding vector(1024)';
  END IF;
END
$vec$;
