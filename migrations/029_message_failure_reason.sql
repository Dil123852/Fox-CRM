-- 029: record WHY an outbound message failed, and expose who is reachable.
--
-- The real problem this solves: staff send a bulk marketing message, some
-- recipients show "Not delivered", and nothing explains it. The cause is
-- almost always WhatsApp's 24-hour rule — a free-form (non-template) message
-- is only accepted within 24h of the CUSTOMER's own last inbound message.
-- Outside that window Twilio ACCEPTS the API call (so this codebase sees
-- success) and WhatsApp then discards it, reporting error 63016 out-of-band.
-- Confirmed against real Twilio records: a number whose last inbound was 575
-- hours ago failed 63016, while numbers messaged inside their window
-- delivered fine.
--
-- messages.delivery_failed already existed but is a bare boolean, so the
-- reason was lost. These two columns keep it.

BEGIN;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS failure_code   TEXT,
  ADD COLUMN IF NOT EXISTS failure_reason TEXT;

COMMENT ON COLUMN messages.failure_code IS
  'Provider error code when delivery_failed (e.g. Twilio 63016 = outside the 24h free-form window, 63024 = invalid number). NULL when the send succeeded or the code is unknown.';
COMMENT ON COLUMN messages.failure_reason IS
  'Human-readable failure explanation shown to staff, so "Not delivered" is never unexplained.';

-- Who can actually receive a free-form message right now: anyone whose last
-- INBOUND message was under 24 hours ago. This is the pre-send check the
-- Bulk Messages page needs — sending to 50 people and having 45 silently
-- discarded is worse than being told first.
CREATE OR REPLACE VIEW v_customer_reachability AS
SELECT
  c.id                AS customer_id,
  c.whatsapp_number,
  c.contact_whatsapp_number,
  c.name,
  c.channel,
  li.last_inbound_at,
  (li.last_inbound_at IS NOT NULL
     AND li.last_inbound_at > NOW() - INTERVAL '24 hours') AS reachable_freeform,
  CASE
    WHEN li.last_inbound_at IS NULL THEN 'never messaged us — WhatsApp will not accept a free-form message'
    WHEN li.last_inbound_at > NOW() - INTERVAL '24 hours' THEN 'inside the 24h window'
    ELSE 'last messaged ' || to_char(li.last_inbound_at, 'DD Mon YYYY') ||
         ' — outside WhatsApp''s 24h free-form window, needs an approved template'
  END                 AS reachability_note
FROM customers c
LEFT JOIN (
  SELECT customer_id, MAX(received_at) AS last_inbound_at
  FROM messages WHERE direction = 'inbound'
  GROUP BY customer_id
) li ON li.customer_id = c.id;

COMMIT;
