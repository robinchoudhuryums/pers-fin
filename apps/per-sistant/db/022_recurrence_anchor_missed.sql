-- 022: recurrence anchor day + "missed" instances (Sept 2026 broad scan, PD-2 / PB-10)
--
-- PD-2: monthly/yearly recurrences drifted at month-end — advanceRecurrence()
-- used setMonth/setFullYear, so a task due Jan 31 went to Mar 3, then Apr 3…
-- and never returned to month-end (Feb 29 yearly → Mar 1 forever). Each new
-- instance now carries the chain's ORIGINAL day-of-month and the next due date
-- is clamped to the target month's length (Jan 31 → Feb 28 → Mar 31).
-- NULL = derive from the instance's own due_date (legacy rows / first advance).
--
-- PB-10: the midnight roll marked a MISSED recurring instance completed, so
-- analytics and the weekly review counted missed tasks as done. A rolled
-- instance is now `missed = true` with completed_at NULL (it still leaves the
-- active list via completed = true).
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS) — safe to re-run (PS-1).

ALTER TABLE todos ADD COLUMN IF NOT EXISTS recurrence_anchor_day INT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS missed BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_todos_recurrence_anchor_day') THEN
    ALTER TABLE todos ADD CONSTRAINT chk_todos_recurrence_anchor_day
      CHECK (recurrence_anchor_day IS NULL OR recurrence_anchor_day BETWEEN 1 AND 31);
  END IF;
END $$;
