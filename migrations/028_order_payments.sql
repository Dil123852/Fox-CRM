-- 028: payments ledger + custom-item advance requirement
--
-- The real business need: a customised (made-to-order) mattress needs an
-- ADVANCE taken before production starts, with the BALANCE collected later —
-- so one order has several payments over time, each with its own amount,
-- method and date.
--
-- What already existed and is reused, not replaced:
--   orders.payment_status  — already had 'partial' in its CHECK (Phase 3)
--   orders.amount_paid     — already tracked money received (Phase 3)
-- Both were effectively unusable: 'partial' was never offered in the UI and
-- amount_paid was only ever auto-set to the full total on delivery. This
-- migration makes them real by giving them a source of truth underneath.
--
-- Design: order_payments is the ledger (one row per real payment received);
-- orders.amount_paid and orders.payment_status are DERIVED from it by trigger
-- so the two can never drift out of sync. Editing amount_paid by hand is no
-- longer how money is recorded — a payment row is.

BEGIN;

CREATE TABLE IF NOT EXISTS order_payments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  -- Same vocabulary as orders.payment_method, plus 'cheque' which the
  -- lead-conversion modal already offers. No CHECK constraint on the value
  -- set, matching how orders.payment_method has never had one.
  method        TEXT NOT NULL DEFAULT 'cash',
  -- What this payment IS, for the receipt and for the advance rule:
  --   advance — taken up front, before production/dispatch
  --   balance — the remainder
  --   refund  — money returned (stored as a positive amount with kind
  --             'refund'; the trigger subtracts it, so the ledger reads as a
  --             real statement rather than hiding a negative number)
  kind          TEXT NOT NULL DEFAULT 'balance'
                  CHECK (kind IN ('advance', 'balance', 'refund')),
  -- Bank slip number, cheque number, transfer reference — whatever staff
  -- need to reconcile this against a bank statement later.
  reference     TEXT,
  note          TEXT,
  paid_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_by   UUID REFERENCES staff_users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_payments_order ON order_payments(order_id);
CREATE INDEX IF NOT EXISTS idx_order_payments_paid_at ON order_payments(paid_at DESC);

-- Custom / made-to-order flag + the advance it requires.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS is_custom_order    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS advance_required   NUMERIC(12,2);

COMMENT ON COLUMN orders.is_custom_order IS
  'Made-to-order/customised item: cannot be resold if the customer walks away, so an advance is required before the order may be confirmed (enforced in PATCH /api/orders/:id).';
COMMENT ON COLUMN orders.advance_required IS
  'Advance that must be received before a custom order can leave pending. NULL on a non-custom order.';

ALTER TABLE orders
  ADD CONSTRAINT orders_advance_only_on_custom CHECK (
    advance_required IS NULL OR is_custom_order = true
  ),
  ADD CONSTRAINT orders_advance_within_total CHECK (
    advance_required IS NULL OR total_amount = 0 OR advance_required <= total_amount
  );

-- Recompute orders.amount_paid + payment_status from the ledger.
--
-- Deliberately does NOT touch an order that has no ledger rows at all: the
-- live data includes an order sitting at payment_status='paid' with
-- amount_paid=0 (a real pre-existing inconsistency), and a migration that
-- silently flipped it back to 'pending' would be rewriting history staff
-- already acted on. Only orders with real payments recorded are derived.
CREATE OR REPLACE FUNCTION recompute_order_payment(p_order_id UUID)
RETURNS VOID AS $$
DECLARE
  v_total   NUMERIC(12,2);
  v_paid    NUMERIC(12,2);
  v_rows    INTEGER;
  v_status  TEXT;
BEGIN
  SELECT total_amount INTO v_total FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT
    COALESCE(SUM(CASE WHEN kind = 'refund' THEN -amount ELSE amount END), 0),
    COUNT(*)
  INTO v_paid, v_rows
  FROM order_payments WHERE order_id = p_order_id;

  IF v_rows = 0 THEN RETURN; END IF;

  -- 'paid' only when the full total is covered. A zero-total order (a real
  -- row exists) is treated as paid once any payment is recorded, since
  -- there is nothing left to owe.
  v_status := CASE
    WHEN v_paid <= 0                        THEN 'pending'
    WHEN v_total > 0 AND v_paid < v_total   THEN 'partial'
    ELSE 'paid'
  END;

  UPDATE orders
     SET amount_paid    = GREATEST(v_paid, 0),
         payment_status = v_status,
         updated_at     = NOW()
   WHERE id = p_order_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION handle_order_payment_change()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    PERFORM recompute_order_payment(OLD.order_id);
    RETURN OLD;
  END IF;
  PERFORM recompute_order_payment(NEW.order_id);
  -- An UPDATE that moves a payment between orders must fix both.
  IF (TG_OP = 'UPDATE' AND NEW.order_id <> OLD.order_id) THEN
    PERFORM recompute_order_payment(OLD.order_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_order_payment_change ON order_payments;
CREATE TRIGGER trg_order_payment_change
AFTER INSERT OR UPDATE OR DELETE ON order_payments
FOR EACH ROW EXECUTE FUNCTION handle_order_payment_change();

-- Read model for the payments UI: what's owed, what's in, whether the
-- custom-order advance has actually been met.
CREATE OR REPLACE VIEW v_order_payment_summary AS
SELECT
  o.id                AS order_id,
  o.order_number,
  o.customer_name,
  o.total_amount,
  o.amount_paid,
  o.payment_status,
  o.status,
  o.is_custom_order,
  o.advance_required,
  GREATEST(o.total_amount - o.amount_paid, 0)  AS balance_due,
  (SELECT COALESCE(SUM(amount), 0) FROM order_payments p
    WHERE p.order_id = o.id AND p.kind = 'advance') AS advance_paid,
  (o.advance_required IS NULL
     OR (SELECT COALESCE(SUM(amount), 0) FROM order_payments p
          WHERE p.order_id = o.id AND p.kind = 'advance') >= o.advance_required
  )                   AS advance_satisfied,
  (SELECT COUNT(*) FROM order_payments p WHERE p.order_id = o.id) AS payment_count,
  (SELECT MAX(paid_at) FROM order_payments p WHERE p.order_id = o.id) AS last_payment_at
FROM orders o;

COMMIT;
