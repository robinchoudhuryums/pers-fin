-- User Settings & Financial Insights
-- Run after existing migrations.

CREATE TABLE IF NOT EXISTS user_settings (
    id                      INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    session_timeout_minutes INT NOT NULL DEFAULT 15,
    theme                   TEXT NOT NULL DEFAULT 'dark',
    dashboard_months        INT NOT NULL DEFAULT 6,
    insights_enabled        BOOLEAN NOT NULL DEFAULT false,
    insights_last_run       TIMESTAMPTZ,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO user_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS financial_insights (
    id              SERIAL PRIMARY KEY,
    insight_text    TEXT NOT NULL,
    period_start    DATE,
    period_end      DATE,
    model_used      TEXT,
    tokens_used     INT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
