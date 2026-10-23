-- Linked tasks (roadmap T2.4 X1a). A task another app keeps in step with an
-- item it owns — under the unified shell, Perfin's rent due, utility amounts,
-- manual bills and a cancelled subscription that charged again — created and
-- closed through services/linked-tasks.js, never through the todo routes.
--   source_app       the app that owns the item ('perfin')
--   source_key       '<app>:<kind>:<id>' — one task per key, including a
--                    trashed row (the unique index has no deleted_at filter),
--                    so a task you deleted isn't recreated
--   source_url       the page that resolves the item (a same-app path)
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
CREATE OR REPLACE FUNCTION todos_detach_linked()
RETURNS TRIGGER AS $$
BEGIN
  NEW.source_detached := true;
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
