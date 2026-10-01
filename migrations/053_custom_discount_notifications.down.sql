-- Down migration for 053_custom_discount_notifications.sql
--
-- Dropping these columns permanently discards which orders were given a
-- custom discount, by whom and why. The reason also survives as prose in
-- orders.notes (the API writes it there), which this does not touch.
-- orders.total_amount is NOT touched: it always held the discounted figure.
--
-- discount_total keeps including any custom amount already given — rewriting
-- it would make invoices stop adding up. Refused instead while such an order
-- exists, so a rollback cannot silently break the invoice total.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM orders_all WHERE custom_discount > 0) THEN
    RAISE EXCEPTION 'Refusing to roll back 053: orders with a custom discount exist';
  END IF;
END $$;

DROP TABLE IF EXISTS staff_notifications;

ALTER TABLE orders_all DROP CONSTRAINT IF EXISTS orders_custom_discount_needs_reason;
ALTER TABLE orders_all DROP CONSTRAINT IF EXISTS orders_custom_discount_non_negative;

-- View first, then its columns (see 046's down for why).
DROP VIEW IF EXISTS orders;

ALTER TABLE orders_all
  DROP COLUMN IF EXISTS custom_discount_at,
  DROP COLUMN IF EXISTS custom_discount_by,
  DROP COLUMN IF EXISTS custom_discount_reason,
  DROP COLUMN IF EXISTS custom_discount;

CREATE VIEW orders AS SELECT * FROM orders_all WHERE deleted_at IS NULL;
CREATE TRIGGER trg_soft_delete INSTEAD OF DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION soft_delete_view();
COMMENT ON VIEW orders IS
  'Live orders only. The real table is orders_all, which also holds soft-deleted rows (deleted_at IS NOT NULL). Query orders_all directly only to show or restore deleted records.';

COMMENT ON COLUMN orders_all.discount_total IS
  'promo_discount + volume_discount. Stored rather than computed so the invoice has one figure to reconcile against total_amount even if another discount kind is added later.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nidikumba_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON orders TO nidikumba_app';
  END IF;
END $$;

COMMIT;
