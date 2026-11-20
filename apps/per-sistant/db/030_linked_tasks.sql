-- Linked tasks (roadmap T2.4 X1a). A task another app keeps in step with an
-- item it owns — under the unified shell, Perfin's rent due, utility amounts,
-- manual bills and a cancelled subscription that charged again — created and
-- closed through services/linked-tasks.js, never through the todo routes.
--   source_app       the app that owns the item ('perfin')
--   source_key       '<app>:<kind>:<id>' — one task per key, including a
--                    trashed row (the unique index has no deleted_at filter),
--                    so a task you deleted isn't recreated
--   source_url       the page that resolves the item, as a path inside the
--                    source app ('/housing' — the task chip adds '/perfin')
--   source_snapshot  the fields the sync last wrote (X1b refreshes a field
--                    only while it still equals this)
--   auto_closed      the sync closed it because the item was resolved; only
--                    such a task is reopened when the item comes back
--   source_detached  you completed or reopened it by hand — the sync never
--                    touches it again (set by the trigger below, so every
--                    completion path counts without each route knowing)
ALTER TABLE todos ADD COLUMN IF NOT EXISTS source_app TEXT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS source_key TEXT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS source_url TEXT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS source_snapshot JSONB;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS auto_closed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS source_detached BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS uq_todos_source_key ON todos (source_key) WHERE source_key IS NOT NULL;

-- A change to a linked task's completed state that the sync didn't make (the
-- sync always changes auto_closed in the same UPDATE) detaches the task.
-- It also clears auto_closed (cycle-9 F48): once you change the task yourself
-- it is no longer "closed by the sync". Reopening an auto-closed task by hand
-- used to leave auto_closed = true on an OPEN task — a later completion by you
-- was then left out of every count (they skip auto_closed), and Ask described
-- the open task as closed by Perfin.
CREATE OR REPLACE FUNCTION todos_detach_linked()
RETURNS TRIGGER AS $$
BEGIN
  NEW.source_detached := true;
  NEW.auto_closed := false;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_todos_detach_linked ON todos;
CREATE TRIGGER trg_todos_detach_linked
    BEFORE UPDATE OF completed ON todos FOR EACH ROW
    WHEN (NEW.source_key IS NOT NULL
          AND NEW.completed IS DISTINCT FROM OLD.completed
          AND NEW.auto_closed IS NOT DISTINCT FROM OLD.auto_closed)
    EXECUTE FUNCTION todos_detach_linked();

-- Rows left in that state before the fix. The sync sets auto_closed only on a
-- task that isn't detached and never touches a detached one, so a task that is
-- both was changed by hand afterwards. (No "completed" in the SET list, so the
-- trigger above doesn't fire; a second run finds nothing.)
UPDATE todos SET auto_closed = false
 WHERE source_key IS NOT NULL AND source_detached AND auto_closed;
