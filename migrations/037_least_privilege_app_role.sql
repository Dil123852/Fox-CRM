-- 037: a least-privilege database role for the application
--
-- FINDING (not in the 2026-09-10 report — found while hardening): the
-- application connects to Postgres as `crm`, which is a SUPERUSER that also
-- owns every object:
--
--   \du  ->  crm | Superuser, Create role, Create DB, Replication, Bypass RLS
--
-- That turns any backend compromise into total control of the database
-- server, not just this database: DROP TABLE, reading every other database on
-- the instance, and COPY ... FROM PROGRAM, which executes shell commands as
-- the postgres OS user. It also means the SQL-injection surface, which is
-- currently clean, would be catastrophic rather than merely bad if a single
-- interpolation bug were ever introduced.
--
-- This migration creates `nidikumba_app` with only what the running app
-- needs: DML on the existing tables, sequence usage, and EXECUTE on the
-- functions the routes call (validate_promo_code, redeem_promo_code, and the
-- trigger functions invoked implicitly). No CREATE, no DROP, no ALTER, no
-- GRANT, not an owner, not a superuser.
--
-- MIGRATIONS KEEP RUNNING AS `crm`. DDL is a deploy-time action by a human
-- with a backup, which is exactly the privilege boundary being drawn here.
--
-- ============================ APPLYING THIS =============================
-- This migration alone changes nothing about how the app connects. After
-- applying it you must also:
--   1. Set a real password below (or ALTER ROLE ... PASSWORD afterwards).
--   2. Point DATABASE_URL at nidikumba_app instead of crm, and restart.
--   3. Verify every flow still works (see 037_verify.sql).
-- Until step 2, the app keeps using the superuser. Sequenced this way on
-- purpose: creating the role is safe and reversible, switching the
-- connection is the part that needs a maintenance window.
-- ========================================================================

-- Password is intentionally a placeholder: a real one must never be committed.
-- Set it at apply time, e.g.
--   ALTER ROLE nidikumba_app WITH PASSWORD '<openssl rand -base64 32>';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nidikumba_app') THEN
    CREATE ROLE nidikumba_app WITH LOGIN PASSWORD 'CHANGE_ME_BEFORE_USE'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

-- Connect and see the schema, nothing more at the schema level.
GRANT CONNECT ON DATABASE crm TO nidikumba_app;
GRANT USAGE ON SCHEMA public TO nidikumba_app;

-- Explicitly NOT granted: CREATE on the schema. The app must never be able to
-- add or drop objects.
REVOKE CREATE ON SCHEMA public FROM nidikumba_app;

-- DML on what exists today. Views are included by ALL TABLES; the read-only
-- reporting views need SELECT, which this covers.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nidikumba_app;

-- BIGSERIAL/SERIAL columns (audit_log.id, quotation numbers, bulk batches)
-- need nextval, which requires USAGE on the sequence.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nidikumba_app;

-- The routes call validate_promo_code/redeem_promo_code directly, and every
-- INSERT/UPDATE fires trigger functions that must be executable by the
-- caller. 48 functions exist; granting per-function would silently break a
-- trigger the next time one is added.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO nidikumba_app;

-- Objects created by FUTURE migrations must be reachable too, or the app
-- breaks the next time a table is added. Tied to `crm` because that is the
-- role that runs migrations and will own what it creates.
ALTER DEFAULT PRIVILEGES FOR ROLE crm IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nidikumba_app;
ALTER DEFAULT PRIVILEGES FOR ROLE crm IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO nidikumba_app;
ALTER DEFAULT PRIVILEGES FOR ROLE crm IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO nidikumba_app;

COMMENT ON ROLE nidikumba_app IS
  'Runtime application role. DML only — no DDL, no ownership, no superuser. Migrations run as crm.';
