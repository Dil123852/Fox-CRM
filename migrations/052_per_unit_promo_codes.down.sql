-- Reverts 052. Restores the 3-argument redeem_promo_code exactly as
-- migration 016 left it. A per_unit code that survives the rollback would
-- silently become a once-per-bill code, so this refuses while any exists —
-- decide what those codes should be (deactivate, or accept per-bill) first.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM promo_codes_all WHERE discount_scope = 'per_unit') THEN
    RAISE EXCEPTION 'per_unit promo codes exist — convert or remove them before rolling back 052';
  END IF;
END $$;

DROP FUNCTION IF EXISTS redeem_promo_code(TEXT, TEXT, NUMERIC, INTEGER);

CREATE OR REPLACE FUNCTION redeem_promo_code(p_code TEXT, p_phone TEXT, p_order_total NUMERIC)
RETURNS TABLE(success BOOLEAN, message TEXT, discount_amount NUMERIC, redemption_id UUID) AS $$
DECLARE
  v_promo RECORD;
  v_discount NUMERIC;
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

  v_discount := CASE v_promo.discount_type
    WHEN 'percent' THEN ROUND(p_order_total * v_promo.discount_percent / 100.0, 2)
    ELSE v_promo.discount_amount
  END;
  v_discount := LEAST(v_discount, p_order_total);

  UPDATE promo_codes SET redemption_count = redemption_count + 1 WHERE id = v_promo.id;

  SELECT id INTO v_customer_id FROM customers WHERE whatsapp_number = p_phone;

  INSERT INTO promo_code_redemptions (promo_code_id, redeemed_phone, customer_id, discount_applied)
  VALUES (v_promo.id, p_phone, v_customer_id, v_discount)
  RETURNING id INTO v_redemption_id;

  RETURN QUERY SELECT TRUE, 'Redeemed'::TEXT, v_discount, v_redemption_id;
END;
$$ LANGUAGE plpgsql;

-- The view must go BEFORE its columns, or Postgres refuses the DROP COLUMN.
DROP VIEW IF EXISTS promo_codes;

ALTER TABLE promo_codes_all DROP CONSTRAINT IF EXISTS promo_codes_max_units_shape;
ALTER TABLE promo_codes_all DROP CONSTRAINT IF EXISTS promo_codes_per_unit_is_amount;
ALTER TABLE promo_codes_all DROP CONSTRAINT IF EXISTS promo_codes_discount_scope_values;
ALTER TABLE promo_codes_all DROP COLUMN IF EXISTS max_units_per_order;
ALTER TABLE promo_codes_all DROP COLUMN IF EXISTS discount_scope;

CREATE VIEW promo_codes AS SELECT * FROM promo_codes_all WHERE deleted_at IS NULL;
CREATE TRIGGER trg_soft_delete INSTEAD OF DELETE ON promo_codes
  FOR EACH ROW EXECUTE FUNCTION soft_delete_view();

COMMIT;
