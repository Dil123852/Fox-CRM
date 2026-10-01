-- 057 — let staff choose NOT to give the volume discount
--
-- The volume discount (2 mattresses = -LKR 1,500, 3+ = -LKR 2,500) was always
-- applied automatically. The business sometimes does not give it, so the order
-- and quotation screens get an "Apply volume discount" tick, on by default.
--
-- Why a column rather than just storing no discount: volume_discount = NULL
-- already means "none" and the edit screen RECOMPUTES the discount from the
-- cart on every save, so an order placed without it would get it back the
-- next time anyone edited it. This flag records the choice so the edit screen
-- (and a recreated quotation) keeps it. 0 is not used as a marker: POST
-- /api/orders deliberately stores a 0 discount as NULL (046).
--
-- true  = staff untick the box: no volume discount even if the cart qualifies
-- false = the discount follows the cart, as before (every existing row)
--
-- orders is a VIEW over orders_all (036), so it is dropped and rebuilt to pick
-- up the column, and its trg_soft_delete INSTEAD OF trigger recreated (same
-- sequence as 046/053) — without it every delete would become a hard delete.

BEGIN;

ALTER TABLE orders_all
  ADD COLUMN IF NOT EXISTS volume_discount_waived BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE quotations
  ADD COLUMN IF NOT EXISTS volume_discount_waived BOOLEAN NOT NULL DEFAULT false;

-- Waived and given at once would be a contradiction on the printed document.
ALTER TABLE orders_all DROP CONSTRAINT IF EXISTS orders_volume_waived_has_no_discount;
ALTER TABLE orders_all ADD CONSTRAINT orders_volume_waived_has_no_discount
  CHECK (NOT volume_discount_waived OR COALESCE(volume_discount, 0) = 0);
ALTER TABLE quotations DROP CONSTRAINT IF EXISTS quotations_volume_waived_has_no_discount;
ALTER TABLE quotations ADD CONSTRAINT quotations_volume_waived_has_no_discount
  CHECK (NOT volume_discount_waived OR COALESCE(volume_discount, 0) = 0);

COMMENT ON COLUMN orders_all.volume_discount_waived IS
  'true = staff chose not to give the volume discount (057). The edit screen keeps it off instead of recomputing it from the cart.';
COMMENT ON COLUMN quotations.volume_discount_waived IS
  'true = staff chose not to give the volume discount on this quotation (057).';

DROP VIEW IF EXISTS orders;
CREATE VIEW orders AS SELECT * FROM orders_all WHERE deleted_at IS NULL;
DROP TRIGGER IF EXISTS trg_soft_delete ON orders;
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
