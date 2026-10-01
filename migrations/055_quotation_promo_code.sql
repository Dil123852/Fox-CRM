-- 055: a promo code on a quotation — shown, never redeemed
--
-- THE REQUIREMENT. A quotation should be able to carry a promo code, print
-- its discount the same way the order invoice does, and state the code's
-- limits: when it ends (under the quotation's own validity period) and, if it
-- only has a limited number of uses, that the discount depends on a place
-- still being free when the order is placed.
--
-- SHOWN, NOT REDEEMED. redeem_promo_code is never called for a quotation:
-- redeeming uses up the customer's one go at the code and a slot of its cap,
-- which belongs to placing the order. The API validates the code with the
-- same evaluatePromoCode() the website's /validate uses and stores the
-- previewed amount.
--
-- Only the code and the amount are stored here. The code's terms (expiry,
-- cap, how many uses are left) are read live from promo_codes_all when the
-- quotation is shown — promo_codes_all.code is UNIQUE across deleted rows too,
-- so the join is exact — which means a quotation reprinted after the code has
-- been extended states the extended date rather than a stale one.
--
-- discount_total now means volume + promo + custom on a quotation, as on an
-- order (046/053).
--
-- Requires 054. Apply with:
--   docker exec -i crm-postgres psql -U crm -d crm < migrations/055_quotation_promo_code.sql

BEGIN;

ALTER TABLE quotations
  ADD COLUMN IF NOT EXISTS promo_code     TEXT,
  ADD COLUMN IF NOT EXISTS promo_discount NUMERIC(12,2);

ALTER TABLE quotations DROP CONSTRAINT IF EXISTS quotations_promo_non_negative;
ALTER TABLE quotations ADD CONSTRAINT quotations_promo_non_negative
  CHECK (promo_discount IS NULL OR promo_discount >= 0);

-- Same pairing as orders_promo_discount_needs_code (046): an amount the PDF
-- could not name is an amount the customer could not check.
ALTER TABLE quotations DROP CONSTRAINT IF EXISTS quotations_promo_discount_needs_code;
ALTER TABLE quotations ADD CONSTRAINT quotations_promo_discount_needs_code
  CHECK (
    promo_discount IS NULL
    OR promo_discount = 0
    OR (promo_code IS NOT NULL AND length(btrim(promo_code)) > 0)
  );

COMMENT ON COLUMN quotations.promo_code IS
  'Promo code shown on the quotation (validated, NOT redeemed — it is redeemed only when an order is placed). Migration 055.';
COMMENT ON COLUMN quotations.promo_discount IS
  'LKR the promo code takes off, as previewed when the quotation was saved.';

COMMIT;
