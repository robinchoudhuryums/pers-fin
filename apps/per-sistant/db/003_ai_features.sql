-- ============================================================================
-- Per-sistant — AI Features & Categories Migration
-- ============================================================================
-- Adds: AI model preferences per feature, category presets, note tags
-- ============================================================================

-- AI model preferences in user_settings
-- Each feature can be: 'haiku', 'sonnet', or 'off'
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS ai_model_email_draft TEXT NOT NULL DEFAULT 'haiku';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS ai_model_task_breakdown TEXT NOT NULL DEFAULT 'haiku';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS ai_model_quick_add TEXT NOT NULL DEFAULT 'off';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS ai_model_review_summary TEXT NOT NULL DEFAULT 'haiku';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS ai_model_email_tone TEXT NOT NULL DEFAULT 'haiku';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS ai_model_daily_briefing TEXT NOT NULL DEFAULT 'off';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS ai_model_note_tagging TEXT NOT NULL DEFAULT 'off';

-- Note tags column
ALTER TABLE notes ADD COLUMN IF NOT EXISTS tags TEXT[];
