-- 053: staff-given custom discount on an order + in-app staff notifications
--
-- THE REQUIREMENT. The volume discount (2 mattresses = -1,500, 3+ = -2,500)
-- is computed automatically and cannot be changed. Staff also need to give a
-- discretionary discount of their own — a negotiated price, a long-time
-- customer — and when a SALES AGENT (or any non-admin) gives one, the admins
-- must be told, and the discount must be written into the order's internal
-- notes so the reason travels with the order.
--
-- orders_all.custom_discount — LKR, applied ON TOP of the volume and promo
--   discounts (confirmed approach: the volume rule stays automatic; this is
--   an extra amount, not an override). NULL = none given, same convention as
--   the 046 columns.
-- orders_all.custom_discount_reason — required whenever an amount is stored
--   (CHECK below): a discount with no stated reason is exactly what the admin
--   notification is meant to question.
-- orders_all.custom_discount_by / _at — WHO gave it, taken from the logged-in
--   user by the API, never from the request body.
--
-- discount_total now means volume + promo + custom. It is written by the API
-- (as since 046), so no backfill is needed: no existing order has a custom
-- discount.
--
-- staff_notifications — one row per RECIPIENT. Stored rather than only pushed
-- over SSE so an admin who was not logged in when the discount was given
-- still sees it. read_at NULL = unread.
--
-- orders is a VIEW over orders_all (036), so it is dropped and rebuilt to
-- expose the new columns, and trg_soft_delete recreated — otherwise every
-- order delete would silently become a hard delete (same sequence as 040,
-- 046). Nothing else depends on the view (checked via pg_depend).
--
-- Apply with:
--   docker exec -i crm-postgres psql -U crm -d crm < migrations/053_custom_discount_notifications.sql

BEGIN;

ALTER TABLE orders_all
  ADD COLUMN IF NOT EXISTS custom_discount        NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS custom_discount_reason TEXT,
  ADD COLUMN IF NOT EXISTS custom_discount_by     UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS custom_discount_at     TIMESTAMPTZ;

COMMENT ON COLUMN orders_all.custom_discount IS
  'LKR taken off at staff discretion, on top of volume_discount and promo_discount. NULL = none given. Migration 053.';
COMMENT ON COLUMN orders_all.custom_discount_reason IS
  'Why the custom discount was given. Required whenever custom_discount > 0.';
COMMENT ON COLUMN orders_all.custom_discount_by IS
  'The staff member who gave (or last changed) the custom discount.';

ALTER TABLE orders_all DROP CONSTRAINT IF EXISTS orders_custom_discount_non_negative;
ALTER TABLE orders_all ADD CONSTRAINT orders_custom_discount_non_negative
  CHECK (custom_discount IS NULL OR custom_discount >= 0);

ALTER TABLE orders_all DROP CONSTRAINT IF EXISTS orders_custom_discount_needs_reason;
ALTER TABLE orders_all ADD CONSTRAINT orders_custom_discount_needs_reason
  CHECK (
    custom_discount IS NULL
    OR custom_discount = 0
    OR (custom_discount_reason IS NOT NULL AND length(btrim(custom_discount_reason)) > 0)
  );

COMMENT ON COLUMN orders_all.discount_total IS
  'promo_discount + volume_discount + custom_discount (053). Stored so the invoice has one figure to reconcile against total_amount.';

DROP VIEW IF EXISTS orders;
CREATE VIEW orders AS SELECT * FROM orders_all WHERE deleted_at IS NULL;
DROP TRIGGER IF EXISTS trg_soft_delete ON orders;
CREATE TRIGGER trg_soft_delete INSTEAD OF DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION soft_delete_view();
COMMENT ON VIEW orders IS
  'Live orders only. The real table is orders_all, which also holds soft-deleted rows (deleted_at IS NOT NULL). Query orders_all directly only to show or restore deleted records.';

CREATE TABLE IF NOT EXISTS staff_notifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id UUID NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  actor_id     UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT,
  -- References orders_all, not the view: an FK cannot target a view, and a
  -- soft-deleted order keeps its notifications (the dashboard just cannot
  -- open it any more).
  order_id     UUID REFERENCES orders_all(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_staff_notifications_recipient
  ON staff_notifications (recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_notifications_unread
  ON staff_notifications (recipient_id) WHERE read_at IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nidikumba_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON orders TO nidikumba_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON staff_notifications TO nidikumba_app';
  END IF;
END $$;

COMMIT;
