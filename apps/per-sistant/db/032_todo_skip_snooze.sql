-- Cycle-9 F55 — skipped recurring instances and snoozed due dates.
--
-- skipped: "Skip" used to mark the instance completed with completed_at = now(),
-- so analytics, the weekly review, /api/stats "done" and Ask counted a skip as
-- finished work. A skipped instance is now completed = true (it leaves the
-- active list), completed_at NULL and skipped = true — the missed-instance
-- shape (db/022), with its own flag because a skip keeps the streak.
--
-- snoozed_from: the due date an instance had BEFORE it was first snoozed. The
-- next instance is stepped from it, not from the snoozed date — a monthly task
-- due Jan 31 snoozed to Feb 3 used to step to Mar 31, skipping February.
-- Additive and idempotent (every migration re-runs on each boot).
ALTER TABLE todos ADD COLUMN IF NOT EXISTS skipped BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS snoozed_from DATE;
