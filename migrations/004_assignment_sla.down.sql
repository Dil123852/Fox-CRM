-- Rollback for 004_assignment_sla.sql
-- Apply in reverse migration order: after 009..005's .down.sql.
DROP TRIGGER IF EXISTS trg_new_lead_assignment ON leads;
DROP FUNCTION IF EXISTS handle_new_lead_assignment();

DROP VIEW IF EXISTS v_staff_performance;
DROP VIEW IF EXISTS v_lead_sla_status;

DROP INDEX IF EXISTS idx_leads_assigned_staff_id;
ALTER TABLE leads DROP COLUMN IF EXISTS assigned_staff_id;
ALTER TABLE leads DROP COLUMN IF EXISTS assigned_at;
ALTER TABLE leads DROP COLUMN IF EXISTS sla_deadline;

ALTER TABLE messages DROP COLUMN IF EXISTS sender_type;
