DROP INDEX IF EXISTS idx_call_events_dialog_call_id;

ALTER TABLE call_events
  DROP COLUMN IF EXISTS dialog_call_id,
  DROP COLUMN IF EXISTS dialog_company_id,
  DROP COLUMN IF EXISTS dialog_call_flow_id;
