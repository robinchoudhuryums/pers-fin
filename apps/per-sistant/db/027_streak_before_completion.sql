-- The streak a recurring task had just before it was completed (cycle-7 F124).
-- Undo of a completion restores it: a LATE completion resets the streak to 1,
-- so the old "next instance's streak − 1" undo put a 12-day streak back at 0.
ALTER TABLE todos ADD COLUMN IF NOT EXISTS streak_before_completion INT;
