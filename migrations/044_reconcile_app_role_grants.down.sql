-- Down for 044.
--
-- Deliberately a NO-OP on the grants themselves.
--
-- 044 re-grants the app role exactly the privileges migration 037 intends it
-- to have. "Undoing" that would mean revoking privileges the running
-- application needs — i.e. deliberately recreating the production outage 044
-- fixed (orders failing with "permission denied for table activity_log").
--
-- There is also no safe target to revert TO: the broken state was not a
-- designed state, it was the accidental result of tables being created
-- without a grant, and which tables those were differs per environment.
--
-- To genuinely remove the app role's access, drop the role itself — that is
-- migration 037's concern, not this one, and it requires pointing
-- DATABASE_URL back at `crm` first or the application loses its connection.

DO $$
BEGIN
  RAISE NOTICE '044 down is intentionally a no-op: reverting these grants would break the running app. See the comment in this file.';
END
$$;
