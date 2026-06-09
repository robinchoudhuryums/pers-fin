-- ============================================================================
-- Per-sistant — Structured facts + temporal validity (Phase 2c)
-- ============================================================================
-- Precise, supersedable key-value records about the user (insurance, accounts,
-- vehicles, …) authored as flat frontmatter in vault "fact files"
-- (`type: fact`). Reserved frontmatter keys (type/entity/valid_from/valid_to/
-- sensitivity/tags/title/embed/private/context) control metadata; every other
-- key becomes one fact row (entity + attribute + value). valid_to NULL = still
-- current. Only 'normal' sensitivity is surfaced/sent to AI. Additive; revert
-- by dropping the table.
-- ============================================================================

CREATE TABLE IF NOT EXISTS facts (
    id            SERIAL PRIMARY KEY,
    source        TEXT NOT NULL DEFAULT 'vault' CHECK (source IN ('vault', 'manual')),
    source_ref    TEXT,                              -- vault file path (one file = many fact rows)
    entity        TEXT NOT NULL,                     -- e.g. "Car Insurance"
    attribute     TEXT NOT NULL,                     -- e.g. "deductible"
    value         TEXT NOT NULL,                     -- e.g. "$1000"
    valid_from    DATE,
    valid_to      DATE,                              -- NULL = still current
    sensitivity   TEXT NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal', 'private', 'secret')),
    tags          TEXT[],
    deleted_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts (LOWER(entity)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_facts_current ON facts (valid_to) WHERE deleted_at IS NULL;

-- set_updated_at() is defined in 001_schema.sql (runs earlier). Guard the
-- trigger so re-runs stay idempotent under the one-transaction migration (PS-1).
DROP TRIGGER IF EXISTS trg_facts_updated_at ON facts;
CREATE TRIGGER trg_facts_updated_at
    BEFORE UPDATE ON facts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
