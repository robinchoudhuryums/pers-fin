-- ============================================================================
-- Migration 010: Data integrity constraints & missing indexes
-- ============================================================================

-- Indexes for automations table (queried by enabled + trigger_type)
CREATE INDEX IF NOT EXISTS idx_automations_enabled_trigger ON automations (enabled, trigger_type);

-- Indexes for webhooks table (queried by enabled)
CREATE INDEX IF NOT EXISTS idx_webhooks_enabled ON webhooks (enabled);

-- Composite index for subtasks (queried by todo_id + completed for progress)
CREATE INDEX IF NOT EXISTS idx_subtasks_todo_completed ON subtasks (todo_id, completed);

-- Index for email_templates (queried by name)
CREATE INDEX IF NOT EXISTS idx_email_templates_name ON email_templates (name);

-- Location coordinate validation
DO $$
BEGIN
  -- Validate latitude range [-90, 90]
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_location_lat') THEN
    ALTER TABLE todos ADD CONSTRAINT chk_location_lat CHECK (location_lat IS NULL OR (location_lat >= -90 AND location_lat <= 90));
  END IF;
  -- Validate longitude range [-180, 180]
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_location_lng') THEN
    ALTER TABLE todos ADD CONSTRAINT chk_location_lng CHECK (location_lng IS NULL OR (location_lng >= -180 AND location_lng <= 180));
  END IF;
  -- Validate location radius > 0
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_location_radius') THEN
    ALTER TABLE todos ADD CONSTRAINT chk_location_radius CHECK (location_radius IS NULL OR location_radius > 0);
  END IF;
END $$;
