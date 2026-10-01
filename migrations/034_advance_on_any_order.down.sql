-- Revert 034: restrict advances back to custom orders only.
--
-- NOTE: this FAILS if any standard order already carries an advance, which is
-- exactly what 034 exists to allow. Clear those first:
--   UPDATE orders SET advance_required = NULL
--   WHERE is_custom_order = false AND advance_required IS NOT NULL;
-- Do that only if you accept losing the record of what was agreed.

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_advance_within_total;
ALTER TABLE orders ADD CONSTRAINT orders_advance_within_total CHECK (
  advance_required IS NULL OR total_amount = 0 OR advance_required <= total_amount
);

ALTER TABLE orders ADD CONSTRAINT orders_advance_only_on_custom CHECK (
  advance_required IS NULL OR is_custom_order = true
);
