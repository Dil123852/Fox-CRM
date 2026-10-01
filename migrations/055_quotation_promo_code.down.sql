-- Down migration for 055_quotation_promo_code.sql
--
-- Refused while any quotation carries a promo code: dropping the columns would
-- leave those quotations' stored total_amount lower than their lines and
-- other discounts explain, and the PDF would print a total that does not add
-- up. Remove the codes (edit the quotations) first if a rollback is needed.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM quotations WHERE promo_code IS NOT NULL) THEN
    RAISE EXCEPTION 'Refusing to roll back 055: quotations with a promo code exist';
  END IF;
END $$;

ALTER TABLE quotations DROP CONSTRAINT IF EXISTS quotations_promo_discount_needs_code;
ALTER TABLE quotations DROP CONSTRAINT IF EXISTS quotations_promo_non_negative;
ALTER TABLE quotations
  DROP COLUMN IF EXISTS promo_discount,
  DROP COLUMN IF EXISTS promo_code;

COMMIT;
