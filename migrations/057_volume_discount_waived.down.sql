-- Down migration for 057_volume_discount_waived.sql
--
-- Only removes the flag. Orders and quotations keep their stored totals and
-- discounts, so nothing printed changes — but an order placed WITHOUT the
-- volume discount would get it back the next time someone edits it. Refused
-- while any such row exists, so a rollback cannot quietly re-discount them.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM orders_all WHERE volume_discount_waived)
     OR EXISTS (SELECT 1 FROM quotations WHERE volume_discount_waived) THEN
    RAISE EXCEPTION 'Refusing to roll back 057: orders or quotations without the volume discount exist';
  END IF;
END $$;

ALTER TABLE quotations DROP CONSTRAINT IF EXISTS quotations_volume_waived_has_no_discount;
ALTER TABLE orders_all DROP CONSTRAINT IF EXISTS orders_volume_waived_has_no_discount;

-- View first, then its column (see 046's down for why).
DROP VIEW IF EXISTS orders;

ALTER TABLE orders_all DROP COLUMN IF EXISTS volume_discount_waived;
ALTER TABLE quotations DROP COLUMN IF EXISTS volume_discount_waived;

CREATE VIEW orders AS SELECT * FROM orders_all WHERE deleted_at IS NULL;
CREATE TRIGGER trg_soft_delete INSTEAD OF DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION soft_delete_view();
COMMENT ON VIEW orders IS
  'Live orders only. The real table is orders_all, which also holds soft-deleted rows (deleted_at IS NOT NULL). Query orders_all directly only to show or restore deleted records.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nidikumba_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON orders TO nidikumba_app';
  END IF;
END $$;

COMMIT;
