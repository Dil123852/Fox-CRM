-- 052: per-mattress promo codes
--
-- THE REQUIREMENT. Some fixed-amount codes are given once per BILL (today's
-- only behaviour); others are given once per MATTRESS. BMICH2500 on a bill
-- with two mattresses must give LKR 5,000, not 2,500.
--
-- promo_codes.discount_scope
--   'order'    — the amount/percent applies once to the eligible subtotal.
--                Every existing code, and the default, so nothing already
--                issued changes meaning.
--   'per_unit' — discount_amount x number of eligible units. Only for
--                amount codes: 20% off each mattress IS 20% off their total,
--                so a percent code has nothing to scale (CHECK below).
--
-- promo_codes.max_units_per_order — optional cap on how many units a
-- per_unit code counts on one bill (NULL = no cap, the same convention as
-- max_redemptions IS NULL meaning unlimited).
--
-- WHAT A "UNIT" IS is decided in JS (whatsapp-backend/index.js,
-- countEligibleUnits), not here — exactly like migration 017's product
-- scoping, because order items have no product_id and matching them to
-- products is by name. A scoped code counts units of its eligible products;
-- an unscoped per_unit code counts mattress-category products only, so two
-- pillows on the bill do not multiply a per-mattress discount.
--
-- redeem_promo_code gains p_units (DEFAULT 1). The count comes in from JS,
-- but the multiplication, the cap and the "never more than the order"
-- ceiling stay inside the locked function, so the stored discount_applied
-- is still computed under the row lock. The old 3-argument signature is
-- DROPPED rather than overloaded: a 3-arg and a 4-arg-with-default function
-- side by side make every 3-arg call ambiguous. Existing 3-arg callers (the
-- website's /redeem, which sends no items) resolve to the new function with
-- p_units = 1 — identical to today's result.
--
-- promo_codes is a VIEW over promo_codes_all (migration 036, soft delete).
-- The columns and CHECKs go on the table; the view's SELECT * was expanded
-- when it was created, so it is dropped and rebuilt to expose them — and its
-- trg_soft_delete INSTEAD OF trigger recreated, or every promo-code delete
-- would silently become a hard delete (same sequence as 040 and 046).
-- Nothing else depends on the view (checked via pg_depend before writing this).
--
-- EXECUTE for the app role comes from migration 037/044's
-- ALTER DEFAULT PRIVILEGES FOR ROLE crm; granted explicitly below as well in
-- case this is run as a different role.
--
-- Apply with:
--   docker exec -i crm-postgres psql -U crm -d crm < migrations/052_per_unit_promo_codes.sql

BEGIN;

ALTER TABLE promo_codes_all
  ADD COLUMN IF NOT EXISTS discount_scope TEXT NOT NULL DEFAULT 'order',
  ADD COLUMN IF NOT EXISTS max_units_per_order INTEGER;

ALTER TABLE promo_codes_all DROP CONSTRAINT IF EXISTS promo_codes_discount_scope_values;
ALTER TABLE promo_codes_all ADD CONSTRAINT promo_codes_discount_scope_values
  CHECK (discount_scope IN ('order', 'per_unit'));

ALTER TABLE promo_codes_all DROP CONSTRAINT IF EXISTS promo_codes_per_unit_is_amount;
ALTER TABLE promo_codes_all ADD CONSTRAINT promo_codes_per_unit_is_amount
  CHECK (discount_scope = 'order' OR discount_type = 'amount');

-- A unit cap only means something on a per_unit code, and must be >= 1.
ALTER TABLE promo_codes_all DROP CONSTRAINT IF EXISTS promo_codes_max_units_shape;
ALTER TABLE promo_codes_all ADD CONSTRAINT promo_codes_max_units_shape
  CHECK (max_units_per_order IS NULL OR (max_units_per_order >= 1 AND discount_scope = 'per_unit'));

COMMENT ON COLUMN promo_codes_all.discount_scope IS
  'order = the discount applies once to the bill; per_unit = discount_amount once per eligible unit (mattresses, or the code''s eligible_product_names). Migration 052.';
COMMENT ON COLUMN promo_codes_all.max_units_per_order IS
  'Optional cap on how many units a per_unit code counts on one bill. NULL = no cap.';

DROP VIEW IF EXISTS promo_codes;
CREATE VIEW promo_codes AS SELECT * FROM promo_codes_all WHERE deleted_at IS NULL;
DROP TRIGGER IF EXISTS trg_soft_delete ON promo_codes;
CREATE TRIGGER trg_soft_delete INSTEAD OF DELETE ON promo_codes
  FOR EACH ROW EXECUTE FUNCTION soft_delete_view();

DROP FUNCTION IF EXISTS redeem_promo_code(TEXT, TEXT, NUMERIC);

CREATE OR REPLACE FUNCTION redeem_promo_code(p_code TEXT, p_phone TEXT, p_order_total NUMERIC, p_units INTEGER DEFAULT 1)
RETURNS TABLE(success BOOLEAN, message TEXT, discount_amount NUMERIC, redemption_id UUID) AS $$
DECLARE
  v_promo RECORD;
  v_discount NUMERIC;
  v_units INTEGER;
  v_redemption_id UUID;
  v_customer_id UUID;
BEGIN
  SELECT * INTO v_promo FROM promo_codes WHERE code = p_code AND active = TRUE FOR UPDATE;

  IF v_promo IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Invalid promo code'::TEXT, NULL::NUMERIC, NULL::UUID;
    RETURN;
  END IF;
  IF v_promo.expires_at IS NOT NULL AND v_promo.expires_at < NOW() THEN
    RETURN QUERY SELECT FALSE, 'This code has expired'::TEXT, NULL::NUMERIC, NULL::UUID;
    RETURN;
  END IF;
  IF v_promo.max_redemptions IS NOT NULL AND v_promo.redemption_count >= v_promo.max_redemptions THEN
    RETURN QUERY SELECT FALSE, 'This code has reached its redemption limit'::TEXT, NULL::NUMERIC, NULL::UUID;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM promo_code_redemptions pcr
    WHERE pcr.promo_code_id = v_promo.id AND pcr.redeemed_phone = p_phone
  ) THEN
    RETURN QUERY SELECT FALSE, 'This code has already been used on this account'::TEXT, NULL::NUMERIC, NULL::UUID;
    RETURN;
  END IF;

  IF v_promo.discount_scope = 'per_unit' THEN
    v_units := COALESCE(p_units, 1);
    IF v_promo.max_units_per_order IS NOT NULL THEN
      v_units := LEAST(v_units, v_promo.max_units_per_order);
    END IF;
    -- A per-unit code with nothing to count must fail, not record a
    -- zero-value redemption that uses up the customer's one go at the code.
    IF v_units < 1 THEN
      RETURN QUERY SELECT FALSE, 'This code applies per mattress and the order has no eligible mattress'::TEXT, NULL::NUMERIC, NULL::UUID;
      RETURN;
    END IF;
    v_discount := v_promo.discount_amount * v_units;
  ELSE
    v_discount := CASE v_promo.discount_type
      WHEN 'percent' THEN ROUND(p_order_total * v_promo.discount_percent / 100.0, 2)
      ELSE v_promo.discount_amount
    END;
  END IF;
  v_discount := LEAST(v_discount, p_order_total); -- never discount more than the order itself

  UPDATE promo_codes SET redemption_count = redemption_count + 1 WHERE id = v_promo.id;

  SELECT id INTO v_customer_id FROM customers WHERE whatsapp_number = p_phone;

  INSERT INTO promo_code_redemptions (promo_code_id, redeemed_phone, customer_id, discount_applied)
  VALUES (v_promo.id, p_phone, v_customer_id, v_discount)
  RETURNING id INTO v_redemption_id;

  RETURN QUERY SELECT TRUE, 'Redeemed'::TEXT, v_discount, v_redemption_id;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nidikumba_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION redeem_promo_code(TEXT, TEXT, NUMERIC, INTEGER) TO nidikumba_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON promo_codes TO nidikumba_app';
  END IF;
END $$;

COMMIT;
