-- Revert 027. Drops the separately-collected WhatsApp numbers entirely —
-- this is real staff-entered contact data, so take a backup first if any
-- rows are populated (SELECT count(*) FROM customers
-- WHERE contact_whatsapp_number IS NOT NULL).
BEGIN;
DROP INDEX IF EXISTS idx_customers_contact_whatsapp;
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_contact_whatsapp_number_digits;
ALTER TABLE customers
  DROP COLUMN IF EXISTS contact_whatsapp_number,
  DROP COLUMN IF EXISTS contact_whatsapp_updated_at;
COMMIT;
