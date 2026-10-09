-- 024: own AI model settings for Ask and Smart Suggestions (Sept 2026 broad scan, PD-7)
--
-- The top-bar Ask (/api/ai/query) and the dashboard Smart Suggestions used the
-- daily_briefing model, which defaults to 'off' — so Ask answered "AI is not
-- enabled" on a fresh install even with ANTHROPIC_API_KEY set, and turning the
-- briefing off silently turned Ask off too. Each now has its own column (and
-- Settings row). Existing installs inherit their current behaviour once: Smart
-- Suggestions copies the briefing model; Ask copies it too unless the briefing
-- is off, in which case Ask (a typed, user-initiated question) gets 'haiku'.
-- The UPDATEs only touch NULLs, so re-running this file changes nothing.

ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS ai_model_natural_language_query TEXT;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS ai_model_smart_suggestions TEXT;

UPDATE user_settings
   SET ai_model_natural_language_query =
         CASE WHEN COALESCE(ai_model_daily_briefing, 'off') = 'off' THEN 'haiku' ELSE ai_model_daily_briefing END
 WHERE ai_model_natural_language_query IS NULL;
UPDATE user_settings
   SET ai_model_smart_suggestions = COALESCE(ai_model_daily_briefing, 'off')
 WHERE ai_model_smart_suggestions IS NULL;

ALTER TABLE user_settings ALTER COLUMN ai_model_natural_language_query SET DEFAULT 'haiku';
ALTER TABLE user_settings ALTER COLUMN ai_model_smart_suggestions SET DEFAULT 'off';
ALTER TABLE user_settings ALTER COLUMN ai_model_natural_language_query SET NOT NULL;
ALTER TABLE user_settings ALTER COLUMN ai_model_smart_suggestions SET NOT NULL;
