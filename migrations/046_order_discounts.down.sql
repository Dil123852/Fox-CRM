-- Down migration for 046_order_discounts.sql
--
-- Dropping these columns permanently discards the record of which discount an
-- order was given — including the backfilled ones recovered from orders.notes.
-- The notes prose itself is left intact by this migration, so the backfill
-- could be re-derived by re-applying 046; nothing else could be.
--
-- orders.total_amount is NOT touched: it always held the discounted figure and
-- was correct before 046 existed.

ALTER TABLE orders_all DROP CONSTRAINT IF EXISTS orders_promo_discount_needs_code;
ALTER TABLE orders_all DROP CONSTRAINT IF EXISTS orders_discounts_non_negative;

-- The view is dropped BEFORE the columns, not after: `orders` is SELECT * over
-- orders_all, so it depends on every one of these columns and Postgres refuses
-- to drop them while it exists ("cannot drop column ... because other objects
-- depend on it"). Dropping the view first is also what avoids needing CASCADE,
-- which would silently take anything else depending on the view with it.
DROP VIEW IF EXISTS orders;

ALTER TABLE orders_all
  DROP COLUMN IF EXISTS discount_total,
  DROP COLUMN IF EXISTS volume_discount,
  DROP COLUMN IF EXISTS promo_discount,
  DROP COLUMN IF EXISTS promo_code;

-- Rebuild the view without the dropped columns, and restore the soft-delete
-- trigger that dropping the view removes (same sequence as 040/046).
CREATE VIEW orders AS SELECT * FROM orders_all WHERE deleted_at IS NULL;

CREATE TRIGGER trg_soft_delete INSTEAD OF DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION soft_delete_view();

COMMENT ON VIEW orders IS
  'Live orders only. The real table is orders_all, which also holds soft-deleted rows (deleted_at IS NOT NULL). Query orders_all directly only to show or restore deleted records.';
