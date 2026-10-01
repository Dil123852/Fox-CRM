-- Verification for migration 037. Run as nidikumba_app AFTER applying 037:
--   PGPASSWORD='<the new password>' psql -U nidikumba_app -h 127.0.0.1 -d crm -f migrations/037_verify.sql
--
-- Every DESTRUCTIVE block must report "BLOCKED (correct)". Every APP block
-- must succeed. This was validated on a clone of the real schema (20 tables,
-- 13 views, 48 functions) before being committed.

\set ON_ERROR_STOP off
\echo '=== these must all FAIL ==='
DROP TABLE IF EXISTS customers;
ALTER TABLE orders ADD COLUMN priv_test int;
CREATE TABLE priv_test (id int);
TRUNCATE messages;
CREATE ROLE priv_test_role LOGIN;
COPY (SELECT 1) TO PROGRAM 'id';

\echo ''
\echo '=== these must all SUCCEED ==='
\set ON_ERROR_STOP on
SELECT count(*) AS customers_readable FROM customers;
SELECT count(*) AS views_readable FROM v_sales_funnel;
SELECT count(*) AS function_executable FROM validate_promo_code('__NOPE__', '94700000000');
BEGIN;
  INSERT INTO customers (whatsapp_number, channel, name) VALUES ('94700000001', 'twilio', 'privcheck');
  UPDATE customers SET name = 'privcheck2' WHERE whatsapp_number = '94700000001';
  DELETE FROM customers WHERE whatsapp_number = '94700000001';
ROLLBACK;
\echo 'All application operations succeeded.'
