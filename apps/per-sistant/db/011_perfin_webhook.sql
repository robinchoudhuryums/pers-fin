-- Perfin → Per-sistant webhook integration
-- Store Perfin's pre-rendered HTML alongside the plain-text body, and let the
-- user configure which address Perfin insight emails are delivered to.
ALTER TABLE emails ADD COLUMN IF NOT EXISTS body_html TEXT;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS perfin_webhook_recipient TEXT;
