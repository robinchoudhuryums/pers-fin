-- ============================================================================
-- Account Balances — Schema Migration
-- ============================================================================
-- Adds balance tracking columns to linked_accounts.
-- Run after 003_teller.sql.
-- ============================================================================

ALTER TABLE linked_accounts
  ADD COLUMN IF NOT EXISTS available_balance NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS current_balance NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS balance_currency TEXT DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS balance_updated_at TIMESTAMPTZ;
