-- Long-term AI insights memory + model/cadence preferences
-- Adds persistent running summary, model choice, and analysis cadence to user_settings.

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS insights_running_summary TEXT DEFAULT NULL;

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS insights_model TEXT NOT NULL DEFAULT 'sonnet';

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS insights_cadence_days INT NOT NULL DEFAULT 30;

-- insights_running_summary: ~200-word cumulative summary the AI updates each run.
-- insights_model: 'haiku', 'sonnet', or 'opus' — maps to claude-*-latest aliases.
-- insights_cadence_days: how often analysis runs (7, 14, 30, 60, 90 days).
