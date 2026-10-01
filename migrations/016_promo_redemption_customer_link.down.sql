-- Rollback for 016_promo_redemption_customer_link.sql — restores
-- redeem_promo_code exactly as migration 007 defined it (customer_id never
-- populated).
CREATE OR REPLACE FUNCTION redeem_promo_code(p_code TEXT, p_phone TEXT, p_order_total NUMERIC)
RETURNS TABLE(success BOOLEAN, message TEXT, discount_amount NUMERIC, redemption_id UUID) AS $$
DECLARE
  v_promo RECORD;
  v_discount NUMERIC;
  v_redemption_id UUID;
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

  INSERT INTO promo_code_redemptions (promo_code_id, redeemed_phone, discount_applied)
  VALUES (v_promo.id, p_phone, v_discount)
  RETURNING id INTO v_redemption_id;

  RETURN QUERY SELECT TRUE, 'Redeemed'::TEXT, v_discount, v_redemption_id;
END;
$$ LANGUAGE plpgsql;
