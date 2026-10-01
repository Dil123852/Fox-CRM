-- 027: a separately-collected WhatsApp number for call-originated customers
--
-- Why this is needed: customers.whatsapp_number is this schema's required
-- identity field, and the call path (POST /api/calls, via
-- findOrCreateCustomerByPhone) writes the number the customer CALLED FROM
-- into it. That number is frequently a landline or a non-WhatsApp mobile, so
-- every outbound WhatsApp message to such a customer silently fails.
--
-- Deliberately a NEW nullable column rather than editing whatsapp_number in
-- place, for two concrete reasons:
--   1. whatsapp_number is the lookup key every channel dedups on
--      (findOrCreateCustomerByPhone does SELECT ... WHERE whatsapp_number=$1),
--      so overwriting it would orphan the customer from the number they
--      actually call from, and a second call would create a duplicate row.
--   2. It has no UNIQUE constraint, so overwriting it with a number another
--      customer already holds would create two rows sharing an identity —
--      the same duplicate-key hazard already documented for products.name.
--
-- NULL means "no separate number collected" — send to whatsapp_number as
-- before. Set means "message this number instead", resolved centrally in
-- sendWhatsAppMessage()/sendWhatsAppImage() so every outbound path (AI
-- replies, order confirmations, follow-up promos, campaigns, bulk sends)
-- picks it up without each call site needing to know.

BEGIN;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS contact_whatsapp_number TEXT,
  ADD COLUMN IF NOT EXISTS contact_whatsapp_updated_at TIMESTAMPTZ;

COMMENT ON COLUMN customers.contact_whatsapp_number IS
  'Separately-collected WhatsApp number, for customers whose whatsapp_number (the number they called from) has no WhatsApp. NULL = none collected; when set, all outbound WhatsApp messaging targets this number instead. Never used as a lookup/dedup key — whatsapp_number remains the identity field.';

-- Digits only, 9-15 (E.164 max is 15). Matches how the call path normalizes
-- an incoming number (strips non-digits, never assumes a country code) and
-- how sendWhatsAppMessage builds `whatsapp:+<digits>` for Twilio.
ALTER TABLE customers
  ADD CONSTRAINT customers_contact_whatsapp_number_digits CHECK (
    contact_whatsapp_number IS NULL
    OR contact_whatsapp_number ~ '^[0-9]{9,15}$'
  );

-- Partial index: only the rows that actually have one, so staff-facing
-- lookups by this number stay fast without indexing mostly-NULLs.
CREATE INDEX IF NOT EXISTS idx_customers_contact_whatsapp
  ON customers (contact_whatsapp_number)
  WHERE contact_whatsapp_number IS NOT NULL;

COMMIT;
