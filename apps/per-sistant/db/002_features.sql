-- ============================================================================
-- Per-sistant — Feature Additions Migration
-- ============================================================================
-- Adds: recurring tasks, subtasks, email templates, weekly review tracking
-- ============================================================================

-- Recurring task fields on todos
ALTER TABLE todos ADD COLUMN IF NOT EXISTS recurring BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS recurrence_rule TEXT;  -- daily, weekly, monthly, yearly, weekdays
ALTER TABLE todos ADD COLUMN IF NOT EXISTS recurrence_parent_id INT REFERENCES todos(id) ON DELETE SET NULL;

-- Subtasks table
CREATE TABLE IF NOT EXISTS subtasks (
    id              SERIAL PRIMARY KEY,
    todo_id         INT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    completed       BOOLEAN NOT NULL DEFAULT false,
    sort_order      INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subtasks_todo ON subtasks (todo_id, sort_order);

-- Email templates
CREATE TABLE IF NOT EXISTS email_templates (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    subject         TEXT NOT NULL,
    body            TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_email_templates_updated_at
    BEFORE UPDATE ON email_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Weekly reviews
CREATE TABLE IF NOT EXISTS weekly_reviews (
    id              SERIAL PRIMARY KEY,
    week_start      DATE NOT NULL,
    week_end        DATE NOT NULL,
    tasks_completed INT NOT NULL DEFAULT 0,
    tasks_created   INT NOT NULL DEFAULT 0,
    emails_sent     INT NOT NULL DEFAULT 0,
    notes_created   INT NOT NULL DEFAULT 0,
    summary         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (week_start)
);
