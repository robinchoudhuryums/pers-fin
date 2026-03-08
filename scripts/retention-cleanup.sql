-- ============================================================================
-- Transaction Retention Cleanup
-- ============================================================================
-- Run this weekly (via n8n schedule or pg_cron) to keep the transactions
-- table within Neon free tier limits.
--
-- Keeps 18 months of data. At ~500 txns/month across 5 institutions,
-- that's roughly 9,000 rows (~5-10 MB) — well under the 0.5 GB limit.
-- ============================================================================

DELETE FROM transactions
WHERE date < (CURRENT_DATE - INTERVAL '18 months');

-- Optional: also clean up old detected subscriptions that have been
-- inactive for more than 6 months
DELETE FROM detected_subscriptions
WHERE is_active = false
  AND updated_at < (CURRENT_DATE - INTERVAL '6 months');
