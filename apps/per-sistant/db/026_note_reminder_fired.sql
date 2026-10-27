-- When a note's reminder last fired the `reminder_due` webhook / Slack message
-- (cycle-7 F116 — the event was selectable but never fired). A reminder fires
-- once: when reminder_at has passed and reminder_fired_at is NULL or older than
-- reminder_at (moving the reminder later re-arms it).
ALTER TABLE notes ADD COLUMN IF NOT EXISTS reminder_fired_at TIMESTAMPTZ;
