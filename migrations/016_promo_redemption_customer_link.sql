-- Real gap found while building promo-code usage visibility: redeem_promo_code
-- never populated promo_code_redemptions.customer_id (the column exists, but
-- every redemption from this path left it NULL) even when the redeeming
-- phone number already matches an existing customers row — e.g. someone
-- who's messaged on WhatsApp before, then redeems a code on the website.
-- Best-effort only: looks up an existing customer by phone, never creates
-- one (this route is anonymous/public — creating a customer here would be a
-- much bigger behavior change than a redemption-tracking fix).
--
-- Apply with:
--   docker exec -i crm-postgres psql -U crm -d crm < migrations/016_promo_redemption_customer_link.sql

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
  v_discount := LEAST(v_discount, p_order_total); -- never discount more than the order itself

  UPDATE promo_codes SET redemption_count = redemption_count + 1 WHERE id = v_promo.id;

  SELECT id INTO v_customer_id FROM customers WHERE whatsapp_number = p_phone;

  INSERT INTO promo_code_redemptions (promo_code_id, redeemed_phone, customer_id, discount_applied)
  VALUES (v_promo.id, p_phone, v_customer_id, v_discount)
  RETURNING id INTO v_redemption_id;

  RETURN QUERY SELECT TRUE, 'Redeemed'::TEXT, v_discount, v_redemption_id;
END;
$$ LANGUAGE plpgsql;
