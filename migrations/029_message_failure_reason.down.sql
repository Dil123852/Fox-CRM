-- Revert 029.
BEGIN;
DROP VIEW IF EXISTS v_customer_reachability;
ALTER TABLE messages
  DROP COLUMN IF EXISTS failure_code,
  DROP COLUMN IF EXISTS failure_reason;
COMMIT;
