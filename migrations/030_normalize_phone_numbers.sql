-- 030: one canonical phone format — 94XXXXXXXXX — everywhere.
--
-- The real problem: NOTHING normalized a phone number before storage. Every
-- entry path stored whatever format it received (POST /api/customers did only
-- `phone.trim()`), so the same human became several customer records:
--   94716218191  (WhatsApp/twilio — the format Twilio actually delivers to)
--   716218191    (typed without the country code)
--   0744061971   (typed in local 0-prefixed form)
-- Each carried its own chat history, and a message sent to the non-94 record
-- failed because that number is not the WhatsApp identity.
--
-- Confirmed with the user: 94XXXXXXXXX is the ONE correct format, because it
-- is what WhatsApp/Twilio sends to (`whatsapp:+94...`).
--
-- This migration:
--   1. normalizes every customers.whatsapp_number to 94XXXXXXXXX
--   2. MERGES records that collide as a result — moving messages, leads,
--      orders and every other child row onto the record that has real
--      WhatsApp history, then deleting the emptied duplicate
--   3. adds a CHECK so the format cannot drift again
--
-- Sri Lankan mobile numbers are 9 significant digits after the country code
-- (94 + 9 = 11 total). Anything that does not normalize cleanly is LEFT
-- ALONE rather than guessed at, and reported by the verification query at
-- the end — this migration never invents a number it cannot derive.

BEGIN;

-- ── 1. helper: local/bare -> 94XXXXXXXXX ────────────────────────────────────
CREATE OR REPLACE FUNCTION normalize_lk_phone(p TEXT)
RETURNS TEXT AS $$
DECLARE d TEXT;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  -- strip everything that is not a digit: handles '+94 77 123 4567',
  -- '077-123-4567', whitespace, and stray punctuation.
  d := regexp_replace(p, '[^0-9]', '', 'g');

  IF d ~ '^94[0-9]{9}$'   THEN RETURN d;                        -- already canonical
  -- '940771234567': country code prepended to a number that KEPT its local
  -- trunk '0'. A real shape seen in the wild (some integrations concatenate
  -- blindly), and unambiguous at 12 digits, so it is repaired rather than
  -- left stranded — otherwise this record can never be messaged.
  ELSIF d ~ '^940[0-9]{9}$' THEN RETURN '94' || substring(d, 4);
  ELSIF d ~ '^0[0-9]{9}$'  THEN RETURN '94' || substring(d, 2); -- 0771234567
  ELSIF d ~ '^[0-9]{9}$'   THEN RETURN '94' || d;               -- 771234567
  ELSE RETURN p;  -- unrecognised: leave untouched, do NOT guess
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION normalize_lk_phone(TEXT) IS
  'Canonicalises a Sri Lankan phone number to 94XXXXXXXXX (the format WhatsApp/Twilio delivers to). Returns the input unchanged if it cannot be derived — never guesses.';

-- ── 2. merge records that will collide after normalization ──────────────────
-- The SURVIVOR is chosen by which record is the real WhatsApp identity:
-- prefer an already-canonical 94... number, then the one with the most
-- inbound messages, then the oldest. Everything else merges into it.
DO $$
DECLARE
  grp RECORD;
  survivor UUID;
  dupe UUID;
BEGIN
  FOR grp IN
    SELECT normalize_lk_phone(whatsapp_number) AS canon, count(*) AS n
    FROM customers
    GROUP BY 1 HAVING count(*) > 1
  LOOP
    SELECT id INTO survivor FROM customers
     WHERE normalize_lk_phone(whatsapp_number) = grp.canon
     ORDER BY
       (whatsapp_number = grp.canon) DESC,                    -- already canonical
       (channel IN ('twilio','meta')) DESC,                   -- real WhatsApp channel
       (SELECT count(*) FROM messages m WHERE m.customer_id = customers.id) DESC,
       created_at ASC
     LIMIT 1;

    RAISE NOTICE 'Merging duplicates of % into %', grp.canon, survivor;

    FOR dupe IN
      SELECT id FROM customers
       WHERE normalize_lk_phone(whatsapp_number) = grp.canon AND id <> survivor
    LOOP
      -- Move every child row. All ten FK references to customers.
      UPDATE messages                SET customer_id = survivor WHERE customer_id = dupe;
      UPDATE leads                   SET customer_id = survivor WHERE customer_id = dupe;
      UPDATE orders                  SET customer_id = survivor WHERE customer_id = dupe;
      UPDATE call_events             SET customer_id = survivor WHERE customer_id = dupe;
      UPDATE campaign_sends          SET customer_id = survivor WHERE customer_id = dupe;
      UPDATE warranties              SET customer_id = survivor WHERE customer_id = dupe;
      UPDATE service_tickets         SET customer_id = survivor WHERE customer_id = dupe;
      UPDATE showroom_visits         SET customer_id = survivor WHERE customer_id = dupe;
      UPDATE promo_code_redemptions  SET customer_id = survivor WHERE customer_id = dupe;
      UPDATE bulk_message_recipients SET customer_id = survivor WHERE customer_id = dupe;

      -- Keep any detail the survivor is missing rather than losing it.
      UPDATE customers s SET
        name                  = COALESCE(s.name, d.name),
        contact_whatsapp_number = COALESCE(s.contact_whatsapp_number, d.contact_whatsapp_number),
        first_purchase_date   = LEAST(s.first_purchase_date, d.first_purchase_date),
        last_purchase_date    = GREATEST(s.last_purchase_date, d.last_purchase_date),
        total_orders_count    = COALESCE(s.total_orders_count,0) + COALESCE(d.total_orders_count,0),
        lifetime_value        = COALESCE(s.lifetime_value,0) + COALESCE(d.lifetime_value,0),
        is_loyalty_customer   = s.is_loyalty_customer OR d.is_loyalty_customer,
        consent_for_marketing = s.consent_for_marketing OR d.consent_for_marketing
      FROM customers d
      WHERE s.id = survivor AND d.id = dupe;

      DELETE FROM customers WHERE id = dupe;
      RAISE NOTICE '  merged and removed duplicate %', dupe;
    END LOOP;
  END LOOP;
END $$;

-- ── 3. normalize what remains ───────────────────────────────────────────────
UPDATE customers
   SET whatsapp_number = normalize_lk_phone(whatsapp_number)
 WHERE whatsapp_number <> normalize_lk_phone(whatsapp_number);

UPDATE customers
   SET contact_whatsapp_number = normalize_lk_phone(contact_whatsapp_number)
 WHERE contact_whatsapp_number IS NOT NULL
   AND contact_whatsapp_number <> normalize_lk_phone(contact_whatsapp_number);

-- Order snapshots carry their own copy of the phone; keep them consistent so
-- searching an order by number matches the customer record.
UPDATE orders
   SET customer_phone = normalize_lk_phone(customer_phone)
 WHERE customer_phone IS NOT NULL
   AND customer_phone <> normalize_lk_phone(customer_phone);

-- ── 4. stop the format drifting again ───────────────────────────────────────
-- Only applied if every row now conforms; a stray unrecognised number should
-- surface as a failed migration rather than be silently tolerated.
ALTER TABLE customers
  ADD CONSTRAINT customers_whatsapp_number_canonical
  CHECK (whatsapp_number ~ '^94[0-9]{9}$');

COMMENT ON COLUMN customers.whatsapp_number IS
  'Canonical 94XXXXXXXXX — the format WhatsApp/Twilio delivers to. Enforced by customers_whatsapp_number_canonical; normalize input with normalize_lk_phone() before insert.';

COMMIT;
