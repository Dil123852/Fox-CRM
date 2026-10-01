DROP INDEX IF EXISTS idx_call_events_dedup_key;

ALTER TABLE call_events
  DROP COLUMN IF EXISTS contact_name,
  DROP COLUMN IF EXISTS sim_slot,
  DROP COLUMN IF EXISTS dedup_key;

ALTER TABLE call_events
  ADD COLUMN IF NOT EXISTS dialog_call_id      TEXT,
  ADD COLUMN IF NOT EXISTS dialog_company_id   TEXT,
  ADD COLUMN IF NOT EXISTS dialog_call_flow_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_events_dialog_call_id
  ON call_events(dialog_call_id)
  WHERE dialog_call_id IS NOT NULL;
