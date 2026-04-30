-- 008: Todo templates & performance indexes

-- Todo templates (save/reuse task structures)
CREATE TABLE IF NOT EXISTS todo_templates (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT,
    priority        TEXT NOT NULL DEFAULT 'medium',
    horizon         TEXT NOT NULL DEFAULT 'short',
    category        TEXT,
    recurring       BOOLEAN NOT NULL DEFAULT false,
    recurrence_rule TEXT,
    recurrence_interval INT DEFAULT 1,
    subtasks        JSONB NOT NULL DEFAULT '[]',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Performance indexes for common queries
CREATE INDEX IF NOT EXISTS idx_todos_completed ON todos (completed) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_todos_due_date ON todos (due_date) WHERE deleted_at IS NULL AND completed = false;
CREATE INDEX IF NOT EXISTS idx_todos_priority ON todos (priority) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_todos_category ON todos (category) WHERE deleted_at IS NULL AND category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_todos_recurring ON todos (recurring) WHERE deleted_at IS NULL AND recurring = true;
CREATE INDEX IF NOT EXISTS idx_emails_status ON emails (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_emails_scheduled ON emails (scheduled_at) WHERE deleted_at IS NULL AND status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_notes_pinned ON notes (pinned) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notes_reminder ON notes (reminder_at) WHERE deleted_at IS NULL AND reminder_at IS NOT NULL;
