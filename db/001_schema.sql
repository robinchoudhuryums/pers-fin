-- ============================================================================
-- Personal Subscription Tracker — Neon Postgres Schema
-- ============================================================================
-- Designed for single-user use with Plaid Development environment.
-- All timestamps are UTC. Monetary values use NUMERIC(12,2) to avoid
-- floating-point rounding issues.
--
-- NEON FREE TIER NOTE (0.5 GB):
--   The `transactions` table is the only unbounded-growth table.
--   See the retention policy at the bottom of this file.
-- ============================================================================

-- Enable pgcrypto for encrypting Plaid access tokens at rest.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. plaid_items — one row per Plaid Item (institution link)
-- ----------------------------------------------------------------------------
-- Stores the Plaid Item (one per linked institution).  The access_token is
-- encrypted with pgcrypto's pgp_sym_encrypt using a passphrase you supply
-- at read/write time (kept in your app's environment, never in the DB).
--
-- PLAID DEV NOTE: Development environment supports up to 100 Items with up
-- to 500 live transactions per Item.  Your 5 institutions fit comfortably,
-- but historical depth may be limited.
CREATE TABLE plaid_items (
    id              SERIAL PRIMARY KEY,
    item_id         TEXT UNIQUE NOT NULL,           -- Plaid item_id
    institution_id  TEXT,                            -- e.g. "ins_3" for Chase
    institution_name TEXT NOT NULL,                  -- human-readable
    access_token_enc BYTEA NOT NULL,                -- pgp_sym_encrypt(token, passphrase)
    status          TEXT NOT NULL DEFAULT 'GOOD',    -- GOOD | LOGIN_REQUIRED | …
    consent_expires_at TIMESTAMPTZ,                  -- Plaid consent expiry if provided
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 2. linked_accounts — one row per account inside an Item
-- ----------------------------------------------------------------------------
CREATE TABLE linked_accounts (
    id              SERIAL PRIMARY KEY,
    plaid_item_id   INT NOT NULL REFERENCES plaid_items(id) ON DELETE CASCADE,
    account_id      TEXT UNIQUE NOT NULL,            -- Plaid account_id
    name            TEXT NOT NULL,                    -- account display name
    official_name   TEXT,
    type            TEXT,                             -- depository, credit, etc.
    subtype         TEXT,                             -- checking, credit card, etc.
    mask            TEXT,                             -- last 4 digits
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 3. sync_cursors — Plaid /transactions/sync cursor per Item
-- ----------------------------------------------------------------------------
-- One row per Item.  The cursor tracks where we left off so each sync is
-- incremental.
CREATE TABLE sync_cursors (
    plaid_item_id   INT PRIMARY KEY REFERENCES plaid_items(id) ON DELETE CASCADE,
    cursor          TEXT NOT NULL DEFAULT '',         -- empty string = first sync
    last_synced_at  TIMESTAMPTZ
);

-- ----------------------------------------------------------------------------
-- 4. transactions — raw transactions from Plaid
-- ----------------------------------------------------------------------------
-- GROWTH WARNING: This is the only unbounded table.  At ~500 txns per Item
-- (Dev limit) you're fine initially, but if you move to Production the row
-- count will grow continuously.  See retention policy below.
--
-- The unique constraint on transaction_id allows safe upserts (ON CONFLICT).
CREATE TABLE transactions (
    id              SERIAL PRIMARY KEY,
    account_id      TEXT NOT NULL REFERENCES linked_accounts(account_id),
    transaction_id  TEXT UNIQUE NOT NULL,             -- Plaid transaction_id
    amount          NUMERIC(12,2) NOT NULL,           -- positive = debit (Plaid convention)
    iso_currency_code TEXT DEFAULT 'USD',
    date            DATE NOT NULL,
    authorized_date DATE,
    merchant_name   TEXT,                             -- Plaid's cleaned merchant name
    name            TEXT,                             -- raw transaction name
    category        TEXT[],                           -- Plaid legacy categories
    personal_finance_category JSONB,                  -- Plaid detailed category
    pending         BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_txn_account_date ON transactions (account_id, date DESC);
CREATE INDEX idx_txn_merchant ON transactions (merchant_name) WHERE merchant_name IS NOT NULL;
CREATE INDEX idx_txn_date ON transactions (date);

-- ----------------------------------------------------------------------------
-- 5. detected_subscriptions — recurring charges we've identified
-- ----------------------------------------------------------------------------
CREATE TABLE detected_subscriptions (
    id              SERIAL PRIMARY KEY,
    merchant_key    TEXT NOT NULL,                    -- normalized merchant identifier
    display_name    TEXT NOT NULL,                    -- human-friendly name for digest
    amount          NUMERIC(12,2) NOT NULL,           -- most recent charge amount
    prior_amount    NUMERIC(12,2),                    -- previous charge amount (for Δ detection)
    cadence_days    INT NOT NULL,                     -- 30, 60, 90, etc.
    first_seen      DATE NOT NULL,
    last_charged    DATE NOT NULL,
    next_expected   DATE NOT NULL,                    -- last_charged + cadence_days
    is_active       BOOLEAN NOT NULL DEFAULT true,
    is_new          BOOLEAN NOT NULL DEFAULT true,    -- true until first digest includes it
    amount_changed  BOOLEAN NOT NULL DEFAULT false,   -- true when amount ≠ prior_amount
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (merchant_key, cadence_days)               -- one entry per merchant+cadence pair
);

-- ============================================================================
-- Retention policy for the `transactions` table
-- ============================================================================
-- Keep 18 months of transactions.  Run this weekly (a scheduled n8n workflow
-- or a pg_cron job) to stay well within Neon free tier limits.
--
--   DELETE FROM transactions
--   WHERE date < (CURRENT_DATE - INTERVAL '18 months');
--
-- At ~500 txns/month across 5 institutions, 18 months ≈ 9,000 rows, which is
-- roughly 5–10 MB — well under the 0.5 GB limit.
-- ============================================================================

-- Helper: update updated_at automatically on plaid_items
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_plaid_items_updated_at
    BEFORE UPDATE ON plaid_items
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_detected_subscriptions_updated_at
    BEFORE UPDATE ON detected_subscriptions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
