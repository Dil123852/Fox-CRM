-- Rollback for 001_staff_roles.sql
-- Apply ONLY after every later migration's .down.sql has already been applied
-- (004's down drops the FK from leads.assigned_staff_id to this table).
DROP INDEX IF EXISTS idx_staff_users_role;
DROP TABLE IF EXISTS staff_users;
