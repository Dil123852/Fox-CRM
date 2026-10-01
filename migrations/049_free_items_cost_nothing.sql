-- 049: free pillows cost the customer nothing — correct the totals that
-- subtracted them.
--
-- Free items are stored as order lines with a NEGATIVE unit_price and
-- free: true (039). Every order screen then totalled the order as
-- sum(unit_price * qty) over ALL lines, so the gift's value came off the
-- mattress price: a 53,800 mattress with four free bolsters was saved as
-- 43,800. Confirmed with the user: the customer pays for the paid lines only;
-- a free line is shown at full worth and deducted again, netting to zero.
-- The order screens and the invoice are fixed in the same change; this
-- corrects the orders already saved.
--
-- Correct total = paid lines - volume_discount - promo_discount.
-- Every affected order was checked by hand first: in each one the stored
-- total was short by exactly the free lines' value.
--
-- Scope, deliberately narrow:
--   * only orders that HAVE a free line and whose stored total is below the
--     corrected one (so re-running changes nothing: UPDATE 0)
--   * only orders with NO rows in order_payments — money has not been
--     recorded against them, so no receipt or balance already sent to the
--     customer is contradicted
--   * never a delivered order — that bill is settled
-- Orders outside that scope are left for staff to review by hand.

WITH per_order AS (
  SELECT o.id,
         GREATEST(0,
           COALESCE((
             SELECT sum((i->>'unit_price')::numeric * COALESCE((i->>'qty')::int, 1))
             FROM jsonb_array_elements(o.items) i
             WHERE COALESCE(i->>'free', '') <> 'true'
               AND COALESCE((i->>'unit_price')::numeric, 0) >= 0
           ), 0)
           - COALESCE(o.volume_discount, 0)
           - COALESCE(o.promo_discount, 0)
         ) AS corrected
  FROM orders_all o
  WHERE jsonb_typeof(o.items) = 'array'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(o.items) i
      WHERE i->>'free' = 'true' OR COALESCE((i->>'unit_price')::numeric, 0) < 0
    )
    AND o.status <> 'delivered'
    AND NOT EXISTS (SELECT 1 FROM order_payments p WHERE p.order_id = o.id)
)
UPDATE orders_all o
SET total_amount = p.corrected
FROM per_order p
WHERE o.id = p.id
  AND o.total_amount < p.corrected;
