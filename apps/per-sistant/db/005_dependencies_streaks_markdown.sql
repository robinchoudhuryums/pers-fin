-- ============================================================================
-- Per-sistant — Task Dependencies, Streak Tracking, Markdown Notes Migration
-- ============================================================================

-- Task dependencies (blocking / blocked-by relationships)
CREATE TABLE IF NOT EXISTS task_dependencies (
    id              SERIAL PRIMARY KEY,
    todo_id         INT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
    depends_on_id   INT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (todo_id, depends_on_id),
    CHECK (todo_id != depends_on_id)
);

CREATE INDEX IF NOT EXISTS idx_task_deps_todo ON task_dependencies (todo_id);
CREATE INDEX IF NOT EXISTS idx_task_deps_depends ON task_dependencies (depends_on_id);

-- Streak tracking for recurring tasks
ALTER TABLE todos ADD COLUMN IF NOT EXISTS streak_count INT NOT NULL DEFAULT 0;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS best_streak INT NOT NULL DEFAULT 0;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS last_streak_date DATE;

-- Markdown format flag for notes
ALTER TABLE notes ADD COLUMN IF NOT EXISTS format TEXT NOT NULL DEFAULT 'plain';
