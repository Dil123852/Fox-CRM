-- Rollback 037.
--
-- Only safe once DATABASE_URL points back at `crm`, otherwise the running app
-- loses its login. Check first:
--   grep DATABASE_URL whatsapp-backend/.env

ALTER DEFAULT PRIVILEGES FOR ROLE crm IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM nidikumba_app;
ALTER DEFAULT PRIVILEGES FOR ROLE crm IN SCHEMA public
  REVOKE USAGE, SELECT ON SEQUENCES FROM nidikumba_app;
ALTER DEFAULT PRIVILEGES FOR ROLE crm IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM nidikumba_app;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM nidikumba_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM nidikumba_app;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM nidikumba_app;
REVOKE USAGE ON SCHEMA public FROM nidikumba_app;
REVOKE CONNECT ON DATABASE crm FROM nidikumba_app;

DROP ROLE IF EXISTS nidikumba_app;
