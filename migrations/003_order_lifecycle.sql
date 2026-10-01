-- Phase 4 — Order Lifecycle Completion (Module 3 remainder)
-- Apply with:
--   docker exec -i crm-postgres psql -U crm -d crm < migrations/003_order_lifecycle.sql
--
-- Deviations from spec Section 6.3/6.4, deliberate — see CLAUDE.md:
--   * Stock is tracked per PRODUCT LINE (products.stock_quantity), not per
--     variant/SKU. Order items only carry a free-text name + qty (no product_id,
--     no size field), so per-variant tracking would need fragile size-parsing
--     out of that name. Same trade-off Phase 10 already accepts for warranties.
--   * REQ-3.9's "Ready for Delivery" status doesn't exist in the real 7-value
--     orders.status list (see migration 002) — delivery scheduling fields are
--     gated on 'shipped' instead, the closest real analog.
--   * REQ-3.11 (reuse delivery-zone data from lead scoring) is skipped — no
--     zone data exists anywhere in this system (Phase 2 already dropped that
--     signal from lead scoring for the same reason).
--   * REQ-3.7's time-based reservation expiry (24-48h without payment) is NOT
--     implemented — it needs a scheduler/cron subsystem that doesn't exist in
--     this codebase. Only the confirm-reserves / cancel-releases / paid-finalizes
--     transitions are implemented, via trigger.
--   * "Reorder alert" (REQ-3.8) is a pull, not a push: GET /api/products/low-stock
--     (see index.js). No email/push notification infra exists to alert through.
--
-- Also fixes the underlying reason stock matching would otherwise silently
-- fail: LeadsPage.jsx's PRODUCT_OPTS offered fictional product names
-- ("Bonnel Spring Mattress", "Pocket Spring Mattress", ...) that don't match
-- products.name, and its order items used a different key ("product") than
-- OrderModal.jsx's ("name"). Both fixed in the frontend as part of this phase.

-- Products — per-product-line stock tracking
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS stock_quantity     INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS reserved_quantity  INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS reorder_threshold  INTEGER DEFAULT 5 NOT NULL;

-- Orders — delivery scheduling fields, gated on 'shipped' (the real analog to
-- the spec's non-existent "Ready for Delivery" status)
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS delivery_time_slot         TEXT,
  ADD COLUMN IF NOT EXISTS delivery_driver             TEXT,
  ADD COLUMN IF NOT EXISTS delivery_confirmation_note  TEXT;

ALTER TABLE orders
  ADD CONSTRAINT orders_delivery_scheduling_requires_shipped CHECK (
    (delivery_time_slot IS NULL AND delivery_driver IS NULL)
    OR status IN ('shipped', 'delivered')
  ),
  ADD CONSTRAINT orders_delivered_requires_confirmation_note
    CHECK (status <> 'delivered' OR delivery_confirmation_note IS NOT NULL);

-- Trigger — reserve stock on confirm, release on cancel, finalize on delivered+paid.
-- Matches order items to products by name (item->>'name', falling back to the
-- older item->>'product' key used by pre-fix rows) — same fragile-but-only-
-- available matching Phase 10 will use for warranties.
CREATE OR REPLACE FUNCTION handle_order_stock_reservation()
RETURNS trigger AS $$
DECLARE
  item jsonb;
  v_qty int;
  v_name text;
BEGIN
  -- Reserve when newly confirmed
  IF NEW.status = 'confirmed' AND OLD.status IS DISTINCT FROM 'confirmed' THEN
    FOR item IN SELECT * FROM jsonb_array_elements(NEW.items)
    LOOP
      v_name := COALESCE(item->>'name', item->>'product');
      v_qty  := COALESCE((item->>'qty')::int, 1);
      IF v_name IS NOT NULL THEN
        UPDATE products SET reserved_quantity = reserved_quantity + v_qty WHERE name = v_name;
      END IF;
    END LOOP;
  END IF;

  -- Release when a confirmed order is cancelled
  IF NEW.status = 'cancelled' AND OLD.status = 'confirmed' THEN
    FOR item IN SELECT * FROM jsonb_array_elements(OLD.items)
    LOOP
      v_name := COALESCE(item->>'name', item->>'product');
      v_qty  := COALESCE((item->>'qty')::int, 1);
      IF v_name IS NOT NULL THEN
        UPDATE products SET reserved_quantity = GREATEST(reserved_quantity - v_qty, 0) WHERE name = v_name;
      END IF;
    END LOOP;
  END IF;

  -- Finalize the sale when delivered+paid: convert the reservation into a real stock decrement
  IF NEW.status = 'delivered' AND NEW.payment_status = 'paid'
     AND (OLD.status IS DISTINCT FROM 'delivered' OR OLD.payment_status IS DISTINCT FROM 'paid') THEN
    FOR item IN SELECT * FROM jsonb_array_elements(NEW.items)
    LOOP
      v_name := COALESCE(item->>'name', item->>'product');
      v_qty  := COALESCE((item->>'qty')::int, 1);
      IF v_name IS NOT NULL THEN
        UPDATE products
        SET stock_quantity     = GREATEST(stock_quantity - v_qty, 0),
            reserved_quantity  = GREATEST(reserved_quantity - v_qty, 0)
        WHERE name = v_name;
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_order_stock_reservation ON orders;
CREATE TRIGGER trg_order_stock_reservation
AFTER UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION handle_order_stock_reservation();
