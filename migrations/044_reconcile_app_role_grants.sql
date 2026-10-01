-- 044: re-grant the app role everything it needs, for objects that exist NOW
--
-- PRODUCTION INCIDENT. Orders could not be placed on the live site: every
-- POST /api/orders returned 500, and the order screen showed "Internal server
-- error". Two endpoints failed in the browser console:
--
--   POST /api/orders                      -> 500
--   GET  /api/orders/:id/attachments      -> 500
--
-- Reproduced exactly by running this codebase against a clone connected as
-- `nidikumba_app`, which is what production uses (migration 037). The server
-- log named the real cause, which is NOT visible to the browser:
--
--   POST /api/orders failed: permission denied for table activity_log
--   GET attachments failed:  permission denied for table payment_attachments
--
-- WHY THE GRANTS WENT MISSING. Migration 037 grants DML on ALL TABLES that
-- existed AT THE MOMENT IT RAN, plus ALTER DEFAULT PRIVILEGES so that FUTURE
-- tables are covered. Neither clause covers a table that was created:
--
--   * BEFORE 037 ran but after the GRANT ... ON ALL TABLES was evaluated, or
--   * by any role OTHER than `crm` (default privileges are per-creating-role), or
--   * in an environment where migrations were applied in a different order
--     than they are numbered — which is what happened here, because this repo
--     has no migration-tracking table and they are applied by hand.
--
-- activity_log (035/036) and payment_attachments (041) are the two that bit.
-- activity_log is the severe one: log_activity() is an AFTER trigger on
-- orders/leads/customers, so the app role needs INSERT on it to write ANY of
-- those rows. Without it, placing an order fails at the trigger — after all
-- the route's own validation passed, which is why the failure looked like a
-- server fault rather than a permissions problem.
--
-- WHY A RE-GRANT RATHER THAN A PER-TABLE FIX: naming the two tables would fix
-- today's outage and leave the same trap for the next table added out of
-- order. This re-runs the grant over whatever exists now, so the database
-- converges on the correct state no matter which migrations an environment
-- has, in which order, as which role. It is idempotent and safe to re-run.
--
-- This does NOT widen the privilege boundary 037 drew: still DML only, still
-- no CREATE, no DROP, no ALTER, no ownership, no superuser.

DO $$
BEGIN
  -- Environments that never adopted the least-privilege role (local dev
  -- connects as the superuser `crm`) have nothing to re-grant. Skipping keeps
  -- this migration runnable everywhere rather than erroring on a missing role.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nidikumba_app') THEN
    RAISE NOTICE 'Role nidikumba_app does not exist here — nothing to re-grant. Skipping.';
    RETURN;
  END IF;

  EXECUTE 'GRANT USAGE ON SCHEMA public TO nidikumba_app';

  -- The app must never create or drop objects. Re-asserted because this
  -- migration is also the place someone will look to understand the role.
  EXECUTE 'REVOKE CREATE ON SCHEMA public FROM nidikumba_app';

  -- Covers every table AND view that exists right now, including the ones
  -- created after 037 without a grant. A view needs SELECT for the reporting
  -- pages; the soft-delete views (orders, leads, ...) additionally need
  -- INSERT/UPDATE/DELETE because the routes write THROUGH them.
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nidikumba_app';

  -- BIGSERIAL/SERIAL columns (activity_log.id, quotation numbers, bulk
  -- batches) need nextval, which requires USAGE on the sequence.
  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nidikumba_app';

  -- Trigger functions run as the CALLING role, so every one of them must be
  -- executable or an ordinary INSERT fails at the trigger — which is the
  -- shape of this very incident.
  EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO nidikumba_app';

  -- Re-assert the default privileges for future objects. 037 already sets
  -- these; repeating them is harmless and makes this file sufficient on its
  -- own if 037 was never applied in some environment.
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE crm IN SCHEMA public '
          'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nidikumba_app';
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE crm IN SCHEMA public '
          'GRANT USAGE, SELECT ON SEQUENCES TO nidikumba_app';
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE crm IN SCHEMA public '
          'GRANT EXECUTE ON FUNCTIONS TO nidikumba_app';
END
$$;

-- Verification. Lists anything the app role still cannot read; expected to
-- return zero rows after this migration. Run it after applying:
--
--   SELECT c.relkind, c.relname
--     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'public'
--      AND c.relkind IN ('r','v','p')
--      AND NOT has_table_privilege('nidikumba_app', c.oid, 'SELECT');
