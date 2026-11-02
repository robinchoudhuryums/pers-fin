-- Linked-task tombstones (cycle-8 F16). A linked task deleted for good — a
-- permanent delete from the trash, Empty Trash or the 30-day purge — frees its
-- row's unique source_key, so the next sync used to create the task again
-- (with its automations, webhooks and Slack post). The trigger below keeps the
-- key here whenever a todo carrying one is hard-deleted, on every delete path,
-- and services/linked-tasks.js never inserts a key that is listed. Keys are
-- kept for good: they name one period / occurrence / charge, so a key only
-- comes back when that same item is still open in the source.
CREATE TABLE IF NOT EXISTS linked_task_tombstones (
    source_key TEXT PRIMARY KEY,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION todos_tombstone_linked()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO linked_task_tombstones (source_key) VALUES (OLD.source_key)
    ON CONFLICT (source_key) DO NOTHING;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_todos_tombstone_linked ON todos;
CREATE TRIGGER trg_todos_tombstone_linked
    BEFORE DELETE ON todos FOR EACH ROW
    WHEN (OLD.source_key IS NOT NULL)
    EXECUTE FUNCTION todos_tombstone_linked();
