-- Keep-alive settings for Render free tier
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS keep_alive_enabled BOOLEAN DEFAULT false;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS keep_alive_start INT DEFAULT 6;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS keep_alive_end INT DEFAULT 0;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS keep_alive_timezone TEXT DEFAULT 'America/New_York';
