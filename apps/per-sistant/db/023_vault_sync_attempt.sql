-- 023: vault sync attempt timestamp (Sept 2026 broad scan, KR-11)
--
-- vault_last_synced_at used to be stamped on EVERY run, including a failed one,
-- so a vault sync that had been failing for days still looked fresh on the
-- Knowledge page. It now means "last SUCCESSFUL sync"; this column records
-- every attempt (success or failure), so the two together show how long the
-- sync has been failing. Additive and idempotent.

ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS vault_last_attempt_at TIMESTAMPTZ;
