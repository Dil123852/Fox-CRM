-- 054: standalone quotations, stored under the customer
--
-- THE REQUIREMENT. A Quotations page where staff build a quotation the same
-- way as a New Showroom Order (phone lookup, catalog cart, free items, volume
-- and custom discount), stored against the customer the phone number belongs
-- to (a new number creates the customer, exactly like a showroom order), and
-- then edited, recreated and downloaded as a PDF at any time.
--
-- WHY A NEW TABLE rather than more leads.quotation_no. The existing quotation
-- (migration 032, POST /api/leads/:id/quotation) is one number per LEAD whose
-- lines are the lead's lead_items — an enquiry record, not a priced document.
-- A quotation here has its own lines, its own discounts and its own history
-- (several per customer, a recreated one pointing at its original), none of
-- which fits on a lead row. That older flow is left unchanged.
--
-- NUMBERING shares quotation_number_seq with the lead flow, so the two can
-- never issue the same QUO- number to two different documents. Unlike 032 it
-- IS a column default: a row here only exists because a quotation was made.
--
-- items has the same shape as orders.items ({name, bed_size, qty, unit_price,
-- pillow_top?, free?}; a free line is stored NEGATIVE, migration 049), so a
-- quotation can later become an order without translating its lines.
--
-- Discounts mirror orders (046/053): volume_discount, custom_discount (+ its
-- reason and who gave it — the admin notification fires for quotations too,
-- since a quotation promises the customer that price), discount_total, and a
-- stored total_amount the PDF prints. No promo code: redeeming a code uses up
-- the customer's one go at it, which belongs to placing the order, not to
-- quoting for it.
--
-- recreated_from_id — a quotation made by "Recreate" from an earlier one.
-- ON DELETE SET NULL so the copy outlives its original. There is no delete
-- route; the link is informational.
--
-- customer_id references customers_ALL, not the customers view (an FK cannot
-- target a view — 036).
--
-- staff_notifications.quotation_id — so a custom-discount notification can
-- point at the quotation it was given on (053 only had order_id).
--
-- Requires 053. Apply with:
--   docker exec -i crm-postgres psql -U crm -d crm < migrations/054_quotations.sql

BEGIN;

CREATE TABLE IF NOT EXISTS quotations (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_no           TEXT NOT NULL UNIQUE
                           DEFAULT ('QUO-' || to_char(nextval('quotation_number_seq'), 'FM00000')),
  customer_id            UUID NOT NULL REFERENCES customers_all(id),
  -- Snapshots, like orders.customer_name/customer_phone: the document keeps
  -- the name and number it was issued to even if the customer row changes.
  customer_name          TEXT NOT NULL,
  customer_phone         TEXT NOT NULL,
  secondary_phone        TEXT,
  delivery_address       TEXT,
  items                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  volume_discount        NUMERIC(12,2),
  custom_discount        NUMERIC(12,2),
  custom_discount_reason TEXT,
  custom_discount_by     UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  custom_discount_at     TIMESTAMPTZ,
  discount_total         NUMERIC(12,2),
  total_amount           NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes                  TEXT,
  recreated_from_id      UUID REFERENCES quotations(id) ON DELETE SET NULL,
  created_by             UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  updated_by             UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT quotations_items_is_array CHECK (jsonb_typeof(items) = 'array'),
  CONSTRAINT quotations_money_non_negative CHECK (
    total_amount >= 0
    AND (volume_discount IS NULL OR volume_discount >= 0)
    AND (custom_discount IS NULL OR custom_discount >= 0)
    AND (discount_total  IS NULL OR discount_total  >= 0)
  ),
  CONSTRAINT quotations_custom_discount_needs_reason CHECK (
    custom_discount IS NULL
    OR custom_discount = 0
    OR (custom_discount_reason IS NOT NULL AND length(btrim(custom_discount_reason)) > 0)
  ),
  -- Same canonical format customers.whatsapp_number is held to (030).
  CONSTRAINT quotations_phone_canonical CHECK (customer_phone ~ '^[0-9]{9,15}$')
);

CREATE INDEX IF NOT EXISTS idx_quotations_customer ON quotations (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotations_created  ON quotations (created_at DESC);

COMMENT ON TABLE quotations IS
  'Priced quotations built on the Quotations page, stored under the customer. Distinct from leads.quotation_no (032), which numbers an enquiry. Migration 054.';

-- Audited like orders (035): who changed which price, and when.
DROP TRIGGER IF EXISTS trg_activity_log ON quotations;
CREATE TRIGGER trg_activity_log AFTER INSERT OR UPDATE OR DELETE ON quotations
  FOR EACH ROW EXECUTE FUNCTION log_activity();

ALTER TABLE staff_notifications
  ADD COLUMN IF NOT EXISTS quotation_id UUID REFERENCES quotations(id) ON DELETE CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nidikumba_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON quotations TO nidikumba_app';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE quotation_number_seq TO nidikumba_app';
  END IF;
END $$;

COMMIT;
