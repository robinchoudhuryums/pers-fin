-- 020: Health & Habits tracker (Per-sistant expansion — see root CLAUDE.md
-- "Priority Next Features" decision, June 2026: built INTO Per-sistant, not
-- as a third shell sub-app).
--
-- Three tables:
--   habits         — habit definitions (boolean check-off or quantity-vs-target)
--   habit_logs     — one row per habit per day (UNIQUE upsert target)
--   health_metrics — measurement time series (weight, sleep, mood, custom…)
--
-- Streaks are COMPUTED AT READ TIME from habit_logs (routes/health.js
-- computeStreaks) rather than stored as counters — no drift, and a backfilled
-- log retroactively repairs a streak. (Todos keep stored streak_count because
-- their instances are consumed by the recurrence roll; habit logs persist.)

CREATE TABLE IF NOT EXISTS habits (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'boolean' CHECK (kind IN ('boolean','quantity')),
  target_value NUMERIC(10,2) CHECK (target_value IS NULL OR target_value > 0),
  unit TEXT,
  schedule TEXT NOT NULL DEFAULT 'daily'
    CHECK (schedule IN ('daily','weekdays','custom_days','weekly')),
  schedule_days INT[],
  times_per_week INT CHECK (times_per_week IS NULL OR (times_per_week >= 1 AND times_per_week <= 7)),
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS habit_logs (
  id SERIAL PRIMARY KEY,
  habit_id INT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  log_date DATE NOT NULL,
  value NUMERIC(10,2) NOT NULL DEFAULT 1 CHECK (value >= 0),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (habit_id, log_date)
);

CREATE INDEX IF NOT EXISTS idx_habit_logs_date ON habit_logs (log_date);

CREATE TABLE IF NOT EXISTS health_metrics (
  id SERIAL PRIMARY KEY,
  metric TEXT NOT NULL,
  value NUMERIC(10,2) NOT NULL,
  unit TEXT,
  recorded_on DATE NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (metric, recorded_on)
);

CREATE INDEX IF NOT EXISTS idx_health_metrics_metric ON health_metrics (metric, recorded_on DESC);
