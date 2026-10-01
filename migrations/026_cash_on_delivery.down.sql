-- Revert 026: drop the COD delivery/payment pairing constraint.
-- Any orders already stored as delivery_method='cash_on_delivery' keep that
-- value — this only removes the invariant, it does not rewrite real order data.
BEGIN;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_cod_requires_cash_payment;
COMMENT ON COLUMN orders.delivery_method IS NULL;
COMMIT;
