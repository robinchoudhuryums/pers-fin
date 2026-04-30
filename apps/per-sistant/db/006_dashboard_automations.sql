-- ============================================================================
-- Per-sistant — Dashboard Customization, Automations, Attachments Migration
-- ============================================================================

-- Dashboard layout preferences (JSON: widget order and visibility)
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS dashboard_layout JSONB DEFAULT '{"widgets":["search","cards","briefing","tasks","upcoming_emails","perfin","shortcuts"],"hidden":[]}';

-- Automations / rules engine
CREATE TABLE IF NOT EXISTS automations (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    trigger_type    TEXT NOT NULL CHECK (trigger_type IN ('todo_created', 'todo_completed', 'email_created', 'note_created', 'schedule')),
    conditions      JSONB NOT NULL DEFAULT '{}',
    action_type     TEXT NOT NULL CHECK (action_type IN ('set_priority', 'set_category', 'set_horizon', 'add_tag', 'send_notification', 'create_todo')),
    action_data     JSONB NOT NULL DEFAULT '{}',
    enabled         BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- File attachments
CREATE TABLE IF NOT EXISTS attachments (
    id              SERIAL PRIMARY KEY,
    filename        TEXT NOT NULL,
    original_name   TEXT NOT NULL,
    mime_type       TEXT NOT NULL,
    size_bytes      INT NOT NULL,
    entity_type     TEXT NOT NULL CHECK (entity_type IN ('todo', 'email', 'note')),
    entity_id       INT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments (entity_type, entity_id);

-- Location-based reminders
ALTER TABLE todos ADD COLUMN IF NOT EXISTS location_name TEXT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS location_lat DOUBLE PRECISION;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS location_lng DOUBLE PRECISION;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS location_radius INT DEFAULT 200;
