-- Rollback 036.
--
-- Note this DROPS security audit history. Export it first if the rows matter:
--   \copy (SELECT * FROM audit_log) TO 'audit_log_backup.csv' CSV HEADER

DROP INDEX IF EXISTS idx_audit_log_event;
DROP INDEX IF EXISTS idx_audit_log_staff_id;
DROP INDEX IF EXISTS idx_audit_log_occurred_at;
DROP TABLE IF EXISTS audit_log;
