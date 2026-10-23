-- Attachment bytes live in Postgres (cycle-7 F121). They used to be written to
-- the app's local uploads/ directory, which Render wipes on every deploy, so
-- every attachment eventually 404'd while its row stayed. NULL = a legacy row
-- whose bytes are still (maybe) on disk; the attachments router copies any
-- such file it can still read into this column at boot.
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS data BYTEA;
