-- Revert 028. Drops the payments ledger — that is real financial history, so
-- take a backup first if any rows exist:
--   SELECT count(*) FROM order_payments;
-- orders.amount_paid / payment_status keep whatever values the trigger last
-- derived; they are not reset, since staff may have acted on them.
BEGIN;
DROP VIEW IF EXISTS v_order_payment_summary;
DROP TRIGGER IF EXISTS trg_order_payment_change ON order_payments;
DROP FUNCTION IF EXISTS handle_order_payment_change();
DROP FUNCTION IF EXISTS recompute_order_payment(UUID);
DROP TABLE IF EXISTS order_payments;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_advance_within_total;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_advance_only_on_custom;
ALTER TABLE orders
  DROP COLUMN IF EXISTS is_custom_order,
  DROP COLUMN IF EXISTS advance_required;
COMMIT;
