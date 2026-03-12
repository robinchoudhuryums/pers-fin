-- Long-term AI insights memory
-- Adds a persistent running summary to user_settings so the AI can maintain
-- cumulative context across months without token bloat.

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS insights_running_summary TEXT DEFAULT NULL;

-- Comment: This stores a concise (~200 word) cumulative summary that the AI
-- updates after each analysis. It captures key long-term patterns, baselines,
-- and progress on past recommendations — acting as persistent memory.
