-- ============================================================================
-- 021: Job Radar (Per-sistant expansion — see root CLAUDE.md "Priority Next
-- Features", June 2026: built INTO Per-sistant, mirroring the Health & Habits
-- module recipe — NOT a third shell sub-app).
-- ============================================================================
-- Pulls job listings from sanctioned APIs (Adzuna aggregator + direct ATS
-- boards: Greenhouse / Lever / Ashby / Workable over a curated allowlist),
-- dedups on a content hash, scores each for trust (this batch) and fit
-- (Batch 2 — the embedding + Claude fit/legitimacy passes), and surfaces
-- high-fit/high-trust roles via gatherJobRadarSummary.
--
-- Four tables:
--   job_sources          — provider registry + per-source baseline trust_weight
--   job_target_companies — curated ATS allowlist the pollers iterate
--   job_listings         — normalized, deduped listings + trust/fit columns
--   job_profile          — single row: resume/prefs + (Batch 2) profile embedding
--
-- SAFETY: runs inside Per-sistant's single fatal-on-error boot transaction
-- (a throw crashes the whole unified shell), and CI runs every migration TWICE
-- (scripts/ci-migration-test.js). Every statement is therefore idempotent
-- (IF NOT EXISTS / ON CONFLICT DO NOTHING). The pgvector column + HNSW index
-- are added DEFENSIVELY (the db/014 pattern) — only when the `vector` extension
-- is available — so boot still succeeds on a Postgres without pgvector; Batch 1
-- never reads the embedding column, and Batch 2's fit pass gates on its
-- existence. Neon has pgvector, so in practice the column IS created.

-- ---- Provider registry -----------------------------------------------------
-- trust_weight is the source's baseline contribution to a listing's trust_score
-- (0-100): ATS-direct boards are authoritative (90); the Adzuna aggregator is
-- high but a step below (70). Unknown/unsanctioned sources are simply absent
-- (default-excluded) — the ingest pipeline only iterates enabled rows.
CREATE TABLE IF NOT EXISTS job_sources (
  id           SERIAL PRIMARY KEY,
  key          TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL DEFAULT 'ats' CHECK (kind IN ('ats', 'aggregator')),
  trust_weight INT  NOT NULL DEFAULT 50 CHECK (trust_weight >= 0 AND trust_weight <= 100),
  enabled      BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO job_sources (key, kind, trust_weight) VALUES
  ('greenhouse', 'ats',        90),
  ('lever',      'ats',        90),
  ('ashby',      'ats',        90),
  ('workable',   'ats',        90),
  ('adzuna',     'aggregator', 70)
ON CONFLICT (key) DO NOTHING;

-- ---- Curated ATS allowlist -------------------------------------------------
-- The companies whose ATS boards the pollers iterate. Seeded with ONE
-- illustrative example (D4: seed + UI-editable) — the operator curates the rest
-- from the Job Radar page. A wrong/stale slug is harmless: the poller is
-- fail-soft per source (a 404 just yields no listings for that company).
CREATE TABLE IF NOT EXISTS job_target_companies (
  id           SERIAL PRIMARY KEY,
  slug         TEXT NOT NULL,
  ats          TEXT NOT NULL CHECK (ats IN ('greenhouse', 'lever', 'ashby', 'workable')),
  display_name TEXT,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ats, slug)
);

INSERT INTO job_target_companies (slug, ats, display_name, active) VALUES
  ('stripe', 'greenhouse', 'Stripe (example — curate your own on the Jobs page)', true)
ON CONFLICT (ats, slug) DO NOTHING;

-- ---- Listings --------------------------------------------------------------
-- content_hash is the dedup key (UNIQUE): a re-fetch of the same posting hashes
-- identically and upserts (no duplicate). posted_at is the source's CLAIMED
-- date and is untrusted (ghost-job decay keys off our own first_seen instead).
-- fit_score / fit_rationale / legitimacy reasons stay NULL until Batch 2.
CREATE TABLE IF NOT EXISTS job_listings (
  id                 SERIAL PRIMARY KEY,
  source_id          INT REFERENCES job_sources(id),
  source_job_id      TEXT,
  content_hash       TEXT NOT NULL UNIQUE,
  title              TEXT,
  company            TEXT,
  location           TEXT,
  remote             BOOLEAN,
  salary_min         NUMERIC(12,2),
  salary_max         NUMERIC(12,2),
  apply_url          TEXT,
  apply_domain       TEXT,
  description        TEXT,
  posted_at          TIMESTAMPTZ,                       -- claimed by source (untrusted)
  first_seen         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen          TIMESTAMPTZ NOT NULL DEFAULT now(),
  fit_score          INT,                               -- 0-100 (Batch 2)
  fit_rationale      TEXT,                              -- (Batch 2)
  trust_score        INT,                               -- 0-100
  legitimacy         TEXT CHECK (legitimacy IS NULL OR legitimacy IN ('real', 'suspect', 'scam')),
  legitimacy_reasons JSONB,                             -- (Batch 2 Claude pass)
  corroboration_count INT NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'saved', 'applied', 'dismissed')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_listings_status_fit ON job_listings (status, fit_score DESC);
CREATE INDEX IF NOT EXISTS idx_job_listings_last_seen ON job_listings (last_seen);

-- ---- Single-row profile ----------------------------------------------------
CREATE TABLE IF NOT EXISTS job_profile (
  id                SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  resume_text       TEXT,
  preferences_text  TEXT,
  min_salary        NUMERIC(12,2),
  locations         TEXT[],
  remote_pref       TEXT CHECK (remote_pref IS NULL OR remote_pref IN ('remote', 'hybrid', 'onsite', 'any')),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO job_profile (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ---- pgvector columns + HNSW (defensive — only when the extension exists) ---
-- Mirrors db/014_vault_vectors.sql. The embedding columns are vector(1024) to
-- match services/embeddings.js EMBED_DIM; cosine via 1 - (embedding <=> q).
-- Added as nullable columns (additive) so existing rows are untouched.
DO $vec$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;
    EXECUTE 'ALTER TABLE job_listings ADD COLUMN IF NOT EXISTS embedding vector(1024)';
    EXECUTE 'ALTER TABLE job_profile  ADD COLUMN IF NOT EXISTS profile_embedding vector(1024)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_job_listings_embedding ON job_listings USING hnsw (embedding vector_cosine_ops)';
  ELSE
    RAISE NOTICE 'pgvector (vector) extension unavailable — Job Radar fit pass stays off until it is present';
  END IF;
END
$vec$;

-- ---- Job Fit per-feature AI model (Batch 2 registers/uses it; column additive
-- here so the migration owns the schema). Default 'haiku' (cheap fit scoring).
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS ai_model_job_fit TEXT NOT NULL DEFAULT 'haiku';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS job_radar_enabled BOOLEAN NOT NULL DEFAULT false;
