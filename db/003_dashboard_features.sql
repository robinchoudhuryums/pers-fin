-- ============================================================================
-- Dashboard Features: dismiss, manual entry, cancellation tracking
-- ============================================================================
-- Run after 001_schema.sql and 002_csv_import.sql

-- Add dismiss/cancellation columns to detected_subscriptions
ALTER TABLE detected_subscriptions
  ADD COLUMN IF NOT EXISTS is_dismissed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'detected',  -- 'detected' | 'manual'
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancel_confirmed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS notes TEXT;
