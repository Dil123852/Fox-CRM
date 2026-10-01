-- 034: an advance can be taken on ANY order, not only a custom one
--
-- The business case: a customer pays part up front and the rest cash on
-- delivery. That works today only on a custom-size mattress, because
-- orders_advance_only_on_custom (migration 028) FORBIDS advance_required
-- unless is_custom_order = true — confirmed by a real constraint violation
-- when inserting a standard order with an advance.
--
-- Nothing else about the split-payment flow needs to change, which is worth
-- being explicit about: order_payments already records a dated advance,
-- recompute_order_payment() already derives payment_status='partial' and
-- amount_paid from it, v_order_payment_summary already computes
-- advance_satisfied and balance_due, and PATCH /api/orders/:id already
-- collects the balance when an order is marked delivered. Verified end to end
-- on a custom COD order before writing this: a 30,000 advance against a
-- 100,000 total gave payment_status='partial', amount_paid=30,000,
-- advance_satisfied=true, balance_due=70,000. The ONLY blocker was the
-- constraint below.
--
-- is_custom_order is kept and still means what it meant: made-to-order, which
-- is why it drives production and the advance WARNING copy. It just no longer
-- gates whether an advance may exist.

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_advance_only_on_custom;

-- An advance must still be a positive amount within the order total. The
-- total_amount = 0 escape stays: an order can be created before its lines are
-- priced, and orders_advance_within_total already allowed for that.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_advance_within_total;
ALTER TABLE orders ADD CONSTRAINT orders_advance_within_total CHECK (
  advance_required IS NULL
  OR (advance_required > 0 AND (total_amount = 0 OR advance_required <= total_amount))
);

COMMENT ON COLUMN orders.advance_required IS
  'Amount that must be received before the order leaves pending. Allowed on ANY order (migration 034), not just a custom one — a customer may pay part up front and the balance cash on delivery. Satisfied by order_payments rows of kind=''advance''; see v_order_payment_summary.advance_satisfied.';
