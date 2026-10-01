-- Rollback 040: remove the per-order second contact number.
--
-- This DESTROYS the recorded numbers. The view must be dropped and rebuilt
-- around the column change for the same reason the forward migration does it.

DROP VIEW IF EXISTS orders;
ALTER TABLE orders_all DROP CONSTRAINT IF EXISTS orders_secondary_phone_canonical;
ALTER TABLE orders_all DROP COLUMN IF EXISTS secondary_phone;
CREATE VIEW orders AS SELECT * FROM orders_all WHERE deleted_at IS NULL;
CREATE TRIGGER trg_soft_delete INSTEAD OF DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION soft_delete_view();
