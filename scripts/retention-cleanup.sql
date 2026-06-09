-- ============================================================================
-- Transaction Retention Cleanup
-- ============================================================================
-- Reference SQL mirroring POST /api/cleanup (teller/routes/subscriptions.js).
-- Run manually when needed (or via pg_cron) to keep the transactions table
-- within Neon free tier limits.
--
-- Keeps 36 months of data — MUST be >= the app's longest analytical window so
-- cleanup doesn't silently truncate it: subscription/transfer detection queries
-- 36 months, seasonal forecasting analyzes 24, and year-over-year needs ~24.
-- (An 18-month window quietly degraded all three.) At ~500 txns/month across
-- 5 institutions, 36 months is ~18,000 rows (~10-20 MB) — still well under the
-- 0.5 GB limit. Keep this INTERVAL in lockstep with POST /api/cleanup.
-- ============================================================================

DELETE FROM transactions
WHERE date < (CURRENT_DATE - INTERVAL '36 months');

-- Optional: also clean up old detected subscriptions that have been
-- inactive for more than 6 months
DELETE FROM detected_subscriptions
WHERE is_active = false
  AND updated_at < (CURRENT_DATE - INTERVAL '6 months');
