-- ============================================================================
-- Per-sistant — Personal Assistant — Neon Postgres Schema
-- ============================================================================
-- Single-user personal assistant. All timestamps UTC.
-- Designed to work alongside Perfin (shared or separate Neon DB).
-- ============================================================================

-- Enable pgcrypto for future token encryption if needed
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. todos — task list items (short / medium / long-term)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS todos (
    id              SERIAL PRIMARY KEY,
    title           TEXT NOT NULL,
    description     TEXT,
    priority        TEXT NOT NULL DEFAULT 'medium'
                    CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    horizon         TEXT NOT NULL DEFAULT 'short'
                    CHECK (horizon IN ('short', 'medium', 'long')),
    category        TEXT,                             -- e.g. "work", "personal", "health"
    due_date        DATE,
    completed       BOOLEAN NOT NULL DEFAULT false,
    completed_at    TIMESTAMPTZ,
    sort_order      INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_todos_horizon ON todos (horizon, completed);
CREATE INDEX IF NOT EXISTS idx_todos_due ON todos (due_date) WHERE due_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_todos_priority ON todos (priority, completed);

-- ----------------------------------------------------------------------------
-- 2. emails — drafted and scheduled emails
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS emails (
    id              SERIAL PRIMARY KEY,
    recipient_name  TEXT,
    recipient_email TEXT NOT NULL,
    subject         TEXT NOT NULL,
    body            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'scheduled', 'sent', 'failed')),
    scheduled_at    TIMESTAMPTZ,                      -- when to send
    sent_at         TIMESTAMPTZ,                      -- when actually sent
    error_message   TEXT,                             -- if sending failed
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_emails_status ON emails (status);
CREATE INDEX IF NOT EXISTS idx_emails_scheduled ON emails (scheduled_at)
    WHERE status = 'scheduled';

-- ----------------------------------------------------------------------------
-- 3. notes — quick notes / reminders
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notes (
    id              SERIAL PRIMARY KEY,
    title           TEXT,
    content         TEXT NOT NULL,
    pinned          BOOLEAN NOT NULL DEFAULT false,
    color           TEXT DEFAULT 'default',           -- default, warm, teal, green, blue
    reminder_at     TIMESTAMPTZ,                      -- optional reminder time
    reminder_sent   BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notes_pinned ON notes (pinned DESC, updated_at DESC);

-- ----------------------------------------------------------------------------
-- 4. contacts — name→email mapping for quick email addressing
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contacts (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    email           TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_name ON contacts (LOWER(name));

-- ----------------------------------------------------------------------------
-- 5. user_settings — single-row app preferences
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_settings (
    id                      INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    session_timeout_minutes INT NOT NULL DEFAULT 15,
    theme                   TEXT NOT NULL DEFAULT 'dark',
    perfin_url              TEXT,                     -- URL to linked Perfin instance
    default_horizon         TEXT NOT NULL DEFAULT 'short'
                            CHECK (default_horizon IN ('short', 'medium', 'long')),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO user_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ----------------------------------------------------------------------------
-- Auto-update updated_at trigger
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_todos_updated_at
    BEFORE UPDATE ON todos FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_emails_updated_at
    BEFORE UPDATE ON emails FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_notes_updated_at
    BEFORE UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
