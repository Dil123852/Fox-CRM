-- Revert 030. Numbers STAY normalized and merged records stay merged — those
-- are real data changes that cannot be safely un-merged. This only removes
-- the constraint and helper so the old mixed formats become possible again.
BEGIN;
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_whatsapp_number_canonical;
COMMENT ON COLUMN customers.whatsapp_number IS NULL;
DROP FUNCTION IF EXISTS normalize_lk_phone(TEXT);
COMMIT;
