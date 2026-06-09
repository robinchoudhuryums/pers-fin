-- ============================================================================
-- Per-sistant — Fact verification (Phase 4)
-- ============================================================================
-- The "verify this fact" trust loop. Verification is keyed by the fact's
-- CONTENT (entity, attribute, value), NOT a row id — because vault sync
-- replaces fact rows on every run (upsertFacts deletes + re-inserts). Keying on
-- content means a verification survives re-sync as long as the value is
-- unchanged, and correctly resets when the value changes (a changed fact should
-- be re-verified). Additive; revert by dropping the table.
-- ============================================================================

CREATE TABLE IF NOT EXISTS fact_verifications (
    entity       TEXT NOT NULL,
    attribute    TEXT NOT NULL,
    value        TEXT NOT NULL,
    verified_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (entity, attribute, value)
);
