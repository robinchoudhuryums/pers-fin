-- ============================================================================
-- CSV Import Support
-- ============================================================================
-- Allows transactions from CSV exports (Chase, Wells Fargo, Capital One, etc.)
-- to be imported into the same transactions table used by Plaid.
--
-- Since `transactions.account_id` references `linked_accounts.account_id`,
-- we create virtual plaid_items and linked_accounts rows for CSV sources.
-- These use the prefix "csv_" to distinguish them from real Plaid items.
-- ============================================================================

-- Track CSV import history to avoid duplicate imports
CREATE TABLE IF NOT EXISTS csv_imports (
    id              SERIAL PRIMARY KEY,
    filename        TEXT NOT NULL,
    institution     TEXT NOT NULL,           -- e.g. "Chase", "Wells Fargo"
    account_label   TEXT,                    -- user-provided label, e.g. "Chase Checking"
    rows_imported   INT NOT NULL DEFAULT 0,
    rows_skipped    INT NOT NULL DEFAULT 0,  -- duplicates or unparseable
    imported_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
