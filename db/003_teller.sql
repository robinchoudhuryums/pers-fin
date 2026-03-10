-- ============================================================================
-- Teller Integration — Schema Migration
-- ============================================================================
-- Adds Teller enrollment support alongside existing Plaid tables.
-- The transactions and detected_subscriptions tables are shared.
-- Run after 001_schema.sql and 002_csv_import.sql.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. teller_enrollments — one row per Teller enrollment (institution link)
-- ----------------------------------------------------------------------------
CREATE TABLE teller_enrollments (
    id                  SERIAL PRIMARY KEY,
    enrollment_id       TEXT UNIQUE NOT NULL,        -- from Teller Connect callback
    institution_name    TEXT NOT NULL,                -- human-readable bank name
    access_token_enc    BYTEA NOT NULL,               -- pgp_sym_encrypt(token, passphrase)
    status              TEXT NOT NULL DEFAULT 'GOOD', -- GOOD | DISCONNECTED | ERROR
    last_synced_txn_date DATE,                        -- tracks incremental sync position
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_teller_enrollments_updated_at
    BEFORE UPDATE ON teller_enrollments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- 2. Allow linked_accounts to reference either Plaid or Teller
-- ----------------------------------------------------------------------------
-- Make plaid_item_id nullable so Teller accounts don't need a Plaid item
ALTER TABLE linked_accounts
    ALTER COLUMN plaid_item_id DROP NOT NULL;

-- Add Teller foreign key
ALTER TABLE linked_accounts
    ADD COLUMN teller_enrollment_id INT REFERENCES teller_enrollments(id) ON DELETE CASCADE;

-- Ensure every account belongs to at least one provider
ALTER TABLE linked_accounts
    ADD CONSTRAINT chk_account_source
    CHECK (plaid_item_id IS NOT NULL OR teller_enrollment_id IS NOT NULL);
