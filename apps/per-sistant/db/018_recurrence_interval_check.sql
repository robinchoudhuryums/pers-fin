-- 018: enforce recurrence_interval >= 1 (broad-scan F9)
--
-- A zero/negative interval made advanceRecurrence() stand still or step
-- backwards, so the calendar's recurring-projection loop churned to its
-- 100-iteration safety cap emitting garbage entries. POST coerced 0 -> 1 via
-- `|| 1` but let negatives through, and PATCH wrote any value verbatim.
-- Clamp existing rows first so adding the CHECK can't fail mid-transaction
-- (migrations are fatal on error), then add the constraint idempotently.

UPDATE todos SET recurrence_interval = 1
WHERE recurrence_interval IS NOT NULL AND recurrence_interval < 1;

UPDATE todo_templates SET recurrence_interval = 1
WHERE recurrence_interval IS NOT NULL AND recurrence_interval < 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_todos_recurrence_interval') THEN
    ALTER TABLE todos ADD CONSTRAINT chk_todos_recurrence_interval
      CHECK (recurrence_interval IS NULL OR recurrence_interval >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_todo_templates_recurrence_interval') THEN
    ALTER TABLE todo_templates ADD CONSTRAINT chk_todo_templates_recurrence_interval
      CHECK (recurrence_interval IS NULL OR recurrence_interval >= 1);
  END IF;
END $$;
