-- Phase 9 — Promo Codes & Influencer Tracking
-- Apply with:
--   docker exec -i crm-postgres psql -U crm -d crm < migrations/007_promo_codes.sql
--
-- Not in the requirements spec PDF at all — no REQ numbers, no Appendix A
-- schema. Built from business rules confirmed directly with the user:
--   * A code is either percent-off OR amount-off (mutually exclusive)
--   * Global redemption cap AND once-per-customer, both enforced; optional expiry
--   * Influencers are first-class (commission_percent), not just a code label
--   * validate/redeem are PUBLIC (nidikumba.shop has no backend of its own —
--     anonymous website visitors call these directly) — rate-limited in
--     index.js since real discount logic is exposed with no auth at all
--
-- Known limitation, same pattern as Phase 7's campaign_sends.resulted_in_order_id:
-- promo_code_redemptions.order_id exists but nothing auto-backfills it. The
-- website has no order-creation path of its own (CLAUDE.md: "Order Now" just
-- opens WhatsApp) — a redemption and the eventual WhatsApp-negotiated order
-- are separate touchpoints. PATCH /api/promo-codes/redemptions/:id lets staff
-- link them manually once they notice the connection (e.g. matching phone).
-- Influencer commission is computed only from orders that HAVE been linked.

CREATE TABLE IF NOT EXISTS influencers (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT        NOT NULL,
  handle              TEXT,
  commission_percent  NUMERIC(5,2) NOT NULL DEFAULT 0,
  active              BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS promo_codes (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code                TEXT        NOT NULL UNIQUE,
  discount_type       TEXT        NOT NULL CHECK (discount_type IN ('percent', 'amount')),
  discount_percent    NUMERIC(5,2),
  discount_amount     NUMERIC(12,2),
  max_redemptions     INTEGER,    -- NULL = unlimited
  redemption_count    INTEGER     NOT NULL DEFAULT 0,
  expires_at          TIMESTAMPTZ, -- NULL = never expires
  influencer_id       UUID        REFERENCES influencers(id),
  active              BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT promo_codes_discount_shape CHECK (
    (discount_type = 'percent' AND discount_percent IS NOT NULL AND discount_amount IS NULL)
    OR
    (discount_type = 'amount' AND discount_amount IS NOT NULL AND discount_percent IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS promo_code_redemptions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_code_id     UUID        NOT NULL REFERENCES promo_codes(id),
  redeemed_phone    TEXT        NOT NULL, -- "once per customer" identity, works with or without a customers row
  customer_id       UUID        REFERENCES customers(id),
  order_id          UUID        REFERENCES orders(id), -- see limitation note above; NULL until manually linked
  discount_applied  NUMERIC(12,2) NOT NULL, -- snapshot at redemption time, independent of later code changes
  redeemed_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (promo_code_id, redeemed_phone)
);

CREATE INDEX IF NOT EXISTS idx_promo_code_redemptions_promo_code_id ON promo_code_redemptions(promo_code_id);
CREATE INDEX IF NOT EXISTS idx_promo_codes_influencer_id ON promo_codes(influencer_id);

-- Read-only check — no lock, doesn't consume anything. Used by the AI tool
-- (apply_promo_code) to tell a customer if their code is valid without
-- reserving a redemption slot; also usable as a pre-check before redeem.
CREATE OR REPLACE FUNCTION validate_promo_code(p_code TEXT, p_phone TEXT)
RETURNS TABLE(valid BOOLEAN, message TEXT, discount_type TEXT, discount_percent NUMERIC, discount_amount NUMERIC, promo_code_id UUID) AS $$
DECLARE
  v_promo RECORD;
BEGIN
  SELECT * INTO v_promo FROM promo_codes WHERE code = p_code AND active = TRUE;

  IF v_promo IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Invalid promo code'::TEXT, NULL::TEXT, NULL::NUMERIC, NULL::NUMERIC, NULL::UUID;
    RETURN;
  END IF;
  IF v_promo.expires_at IS NOT NULL AND v_promo.expires_at < NOW() THEN
    RETURN QUERY SELECT FALSE, 'This code has expired'::TEXT, NULL::TEXT, NULL::NUMERIC, NULL::NUMERIC, NULL::UUID;
    RETURN;
  END IF;
  IF v_promo.max_redemptions IS NOT NULL AND v_promo.redemption_count >= v_promo.max_redemptions THEN
    RETURN QUERY SELECT FALSE, 'This code has reached its redemption limit'::TEXT, NULL::TEXT, NULL::NUMERIC, NULL::NUMERIC, NULL::UUID;
    RETURN;
  END IF;
  -- Table-qualified: validate_promo_code's own return column is also named
  -- promo_code_id, which PL/pgSQL treats as an in-scope variable — an
  -- unqualified reference here is genuinely ambiguous (confirmed by running
  -- it: "column reference promo_code_id is ambiguous"), not just a style nit.
  IF EXISTS (
    SELECT 1 FROM promo_code_redemptions pcr
    WHERE pcr.promo_code_id = v_promo.id AND pcr.redeemed_phone = p_phone
  ) THEN
    RETURN QUERY SELECT FALSE, 'This code has already been used on this account'::TEXT, NULL::TEXT, NULL::NUMERIC, NULL::NUMERIC, NULL::UUID;
    RETURN;
  END IF;

  RETURN QUERY SELECT TRUE, 'Valid'::TEXT, v_promo.discount_type, v_promo.discount_percent, v_promo.discount_amount, v_promo.id;
END;
$$ LANGUAGE plpgsql;

-- Race-safe redemption. SELECT ... FOR UPDATE locks the promo_codes row for
-- the transaction: a second concurrent call for the same code blocks until
-- the first commits, then re-reads the already-incremented redemption_count
-- and correctly sees the cap reached. This is what makes "redeem the last
-- available use of a capped code, twice at once" resolve to exactly one
-- success — the thing the plan's verify step specifically tests.
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
  v_discount := LEAST(v_discount, p_order_total); -- never discount more than the order itself

  UPDATE promo_codes SET redemption_count = redemption_count + 1 WHERE id = v_promo.id;

  INSERT INTO promo_code_redemptions (promo_code_id, redeemed_phone, discount_applied)
  VALUES (v_promo.id, p_phone, v_discount)
  RETURNING id INTO v_redemption_id;

  RETURN QUERY SELECT TRUE, 'Redeemed'::TEXT, v_discount, v_redemption_id;
END;
$$ LANGUAGE plpgsql;
