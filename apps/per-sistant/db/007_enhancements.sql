-- 007: Recurring improvements, cross-entity workflows, notifications, analytics, webhooks
-- Adds custom recurrence intervals, skip/snooze, entity links, webhook config, analytics views

-- Custom recurrence interval (e.g., "every 3 days", "every 2 weeks")
ALTER TABLE todos ADD COLUMN IF NOT EXISTS recurrence_interval INT DEFAULT 1;
-- Skip/snooze: track skipped count and snooze-until date
ALTER TABLE todos ADD COLUMN IF NOT EXISTS skipped_count INT NOT NULL DEFAULT 0;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS snoozed_until DATE;

-- Cross-entity links (todo<->note, todo<->email, note<->email)
CREATE TABLE IF NOT EXISTS entity_links (
    id              SERIAL PRIMARY KEY,
    source_type     TEXT NOT NULL CHECK (source_type IN ('todo', 'email', 'note')),
    source_id       INT NOT NULL,
    target_type     TEXT NOT NULL CHECK (target_type IN ('todo', 'email', 'note')),
    target_id       INT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source_type, source_id, target_type, target_id)
);

-- Webhooks configuration
CREATE TABLE IF NOT EXISTS webhooks (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    url             TEXT NOT NULL,
    events          TEXT[] NOT NULL DEFAULT '{}',
    headers         JSONB NOT NULL DEFAULT '{}',
    enabled         BOOLEAN NOT NULL DEFAULT true,
    last_triggered  TIMESTAMPTZ,
    last_status     INT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Notification preferences in settings
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS notify_due_tasks BOOLEAN DEFAULT true;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS notify_overdue BOOLEAN DEFAULT true;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS notify_streaks BOOLEAN DEFAULT true;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS notify_email_sent BOOLEAN DEFAULT true;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS slack_webhook_url TEXT;
