-- Design refresh: palette preference for the warm-paper UI.
-- Valid values: copper | indigo | forest | slate | plum | mono
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS palette TEXT NOT NULL DEFAULT 'copper'
  CHECK (palette IN ('copper','indigo','forest','slate','plum','mono'));
