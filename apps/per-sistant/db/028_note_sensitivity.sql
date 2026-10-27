-- Notes privacy tier (cycle-7 F134 / ST5). Vault documents and facts have a
-- sensitivity (normal / private / secret) but notes didn't: every note was
-- embedded, keyword-retrieved for Knowledge answers and listed in the Ask
-- context, so a note holding an account number or a medical detail went to the
-- AI. Only 'normal' notes are embedded, retrieved or sent to the AI now;
-- 'private' notes stay visible in the app, and a 'secret' note's text is also
-- masked in lists and labels until it is opened. Existing notes stay 'normal'.
ALTER TABLE notes ADD COLUMN IF NOT EXISTS sensitivity TEXT NOT NULL DEFAULT 'normal';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_notes_sensitivity') THEN
    ALTER TABLE notes ADD CONSTRAINT chk_notes_sensitivity CHECK (sensitivity IN ('normal', 'private', 'secret'));
  END IF;
END $$;
