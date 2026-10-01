-- Down for 045.
--
-- REFUSES rather than silently failing if a super_admin still exists. Narrowing
-- the CHECK while a row holds 'super_admin' would abort with a constraint
-- violation naming only the constraint, which reads like a corrupt database
-- rather than "demote your super admin first". The explicit check below says
-- what to do.

DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM staff_users WHERE role = 'super_admin';
  IF n > 0 THEN
    RAISE EXCEPTION
      'Cannot revert 045: % staff account(s) still hold the super_admin role. Demote them first, e.g. UPDATE staff_users SET role = ''admin'' WHERE role = ''super_admin'';', n;
  END IF;
END
$$;

DROP VIEW IF EXISTS v_staff_login_history;
DROP VIEW IF EXISTS v_staff_active_hours;

-- Session history is real data about who was working when. Dropping the table
-- discards it irrecoverably, which is the opposite of what this feature is for,
-- so the table is deliberately KEPT. Drop it by hand if that is genuinely
-- wanted:
--
--   DROP TABLE staff_sessions;

ALTER TABLE staff_users DROP CONSTRAINT IF EXISTS staff_users_role_check;
ALTER TABLE staff_users ADD CONSTRAINT staff_users_role_check CHECK (role IN (
  'admin', 'sales_agent', 'inventory_manager',
  'delivery_coordinator', 'finance', 'viewer'
));

COMMENT ON COLUMN staff_users.role IS NULL;
