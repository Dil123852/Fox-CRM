-- 032: real quotation numbers, generated on demand.
--
-- leads.quotation_no already existed as a free-text field, but nothing ever
-- generated a value (all 7 live leads have it NULL) and staff had to invent
-- one by hand. A quotation you hand a customer needs a stable, unique
-- reference, so this adds a sequence in the same shape as order_number
-- ('ORD-01001' -> 'QUO-01001') and a function to claim the next one.
--
-- Deliberately NOT a column DEFAULT, unlike orders.order_number: a lead
-- exists from the first WhatsApp message, long before anyone quotes for it,
-- and burning a quotation number on every enquiry would leave huge gaps in
-- the sequence and imply quotations that were never sent. The number is
-- claimed when a quotation is actually created.

BEGIN;

CREATE SEQUENCE IF NOT EXISTS quotation_number_seq START 1001;

-- Claims and stores the next quotation number for a lead, unless it already
-- has one — so re-downloading a quotation keeps the SAME reference the
-- customer was given rather than issuing a new one each time.
CREATE OR REPLACE FUNCTION assign_quotation_number(p_lead_id UUID)
RETURNS TEXT AS $$
DECLARE
  v_existing TEXT;
  v_new      TEXT;
BEGIN
  SELECT NULLIF(btrim(quotation_no), '') INTO v_existing
    FROM leads WHERE id = p_lead_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead % not found', p_lead_id;
  END IF;

  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  v_new := 'QUO-' || to_char(nextval('quotation_number_seq'), 'FM00000');
  UPDATE leads SET quotation_no = v_new, updated_at = NOW() WHERE id = p_lead_id;
  RETURN v_new;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION assign_quotation_number(UUID) IS
  'Returns the lead''s quotation number, claiming the next one from quotation_number_seq only if it has none. Idempotent: re-downloading a quotation reuses the reference already given to the customer.';

COMMENT ON COLUMN leads.quotation_no IS
  'Quotation reference (QUO-0XXXX), claimed by assign_quotation_number() when a quotation is first created. NULL until then — a lead exists long before anyone quotes for it. Staff-editable.';

COMMIT;
