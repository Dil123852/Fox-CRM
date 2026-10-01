-- Rollback 035.

DROP INDEX IF EXISTS idx_staff_users_locked_until;

ALTER TABLE staff_users
  DROP CONSTRAINT IF EXISTS staff_users_failed_login_count_non_negative;

ALTER TABLE staff_users
  DROP COLUMN IF EXISTS failed_login_count,
  DROP COLUMN IF EXISTS locked_until,
  DROP COLUMN IF EXISTS last_failed_login_at;
