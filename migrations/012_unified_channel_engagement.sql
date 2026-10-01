-- Phase 14 — Unified Channel Data Collection for Promotions
-- Apply with:
--   docker exec -i crm-postgres psql -U crm -d crm < migrations/012_unified_channel_engagement.sql

-- ── 14.1 — Drop the Dialog call trigger; its logic moved into JS ─────────────
-- handle_call_event/trg_call_event previously did customer find-or-create +
-- open-ticket-create entirely inside a DB trigger, which meant it could never
-- be called from plain JS (e.g. for showroom visits). That logic now lives in
-- whatsapp-backend/index.js as findOrCreateCustomerByPhone/getOrCreateOpenTicket,
-- shared by the WhatsApp webhook, the Dialog webhook, and the new showroom
-- visit endpoint below. The call_events table itself is unchanged; its
-- customer_id column is now populated by the /webhook/dialog route directly
-- instead of a BEFORE INSERT trigger.
DROP TRIGGER IF EXISTS trg_call_event ON call_events;
DROP FUNCTION IF EXISTS handle_call_event();

-- ── 14.2 — Showroom visits ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS showroom_visits (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        UUID REFERENCES customers(id),
  phone              TEXT NOT NULL,
  showroom_location  TEXT NOT NULL,
  products_shown     TEXT,
  outcome            TEXT CHECK (outcome IN ('browsing','interested','ordered','not_interested')),
  staff_id           UUID REFERENCES staff_users(id),
  notes              TEXT,
  visited_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_showroom_visits_customer_id ON showroom_visits(customer_id);

-- ── 14.5 — Unified cross-channel engagement view ─────────────────────────────
CREATE OR REPLACE VIEW v_customer_engagement AS
SELECT
  c.id AS customer_id,
  c.whatsapp_number,
  c.is_loyalty_customer,
  (SELECT MAX(received_at) FROM messages WHERE customer_id = c.id) AS last_whatsapp_at,
  (SELECT MAX(occurred_at) FROM call_events WHERE customer_id = c.id) AS last_call_at,
  (SELECT MAX(visited_at) FROM showroom_visits WHERE customer_id = c.id) AS last_showroom_visit_at,
  (SELECT count(DISTINCT showroom_location) FROM showroom_visits WHERE customer_id = c.id) AS showrooms_visited,
  (
    (EXISTS(SELECT 1 FROM messages WHERE customer_id = c.id))::int +
    (EXISTS(SELECT 1 FROM call_events WHERE customer_id = c.id))::int +
    (EXISTS(SELECT 1 FROM showroom_visits WHERE customer_id = c.id))::int
  ) AS channels_engaged
FROM customers c;

-- ── 14.6 — New campaign segments built on v_customer_engagement ─────────────
ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_target_segment_check;
ALTER TABLE campaigns ADD CONSTRAINT campaigns_target_segment_check
  CHECK (target_segment = ANY (ARRAY[
    'loyalty','potential','all',
    'showroom_no_purchase','multi_channel_no_conversion','gone_quiet'
  ]));

-- showroom_no_purchase: visited a showroom with outcome browsing/interested,
--   never completed a purchase (total_orders_count = 0).
-- multi_channel_no_conversion: engaged on 2+ channels, never became a loyalty
--   customer.
-- gone_quiet: not a loyalty customer, and every channel's last-contact
--   timestamp (treating "never" as older than any real timestamp) is more
--   than trigger_offset_days old. Repurposes trigger_offset_days as "days of
--   cross-channel silence" for this segment specifically, instead of "days
--   since last purchase" as the existing loyalty/potential/all segments use it
--   — the two concepts don't share a campaign row's semantics otherwise.
-- Consent gating and the not-already-sent check below are unchanged and apply
-- identically to all three new segments — no bypass.
CREATE OR REPLACE VIEW v_campaign_eligible_customers AS
SELECT
  camp.id AS campaign_id,
  c.id AS customer_id
FROM campaigns camp
JOIN customers c ON TRUE
LEFT JOIN v_customer_engagement ve ON ve.customer_id = c.id
WHERE (
  (camp.target_segment = 'loyalty'   AND c.is_loyalty_customer = TRUE)
  OR (camp.target_segment = 'potential' AND EXISTS (
        SELECT 1 FROM leads l WHERE l.customer_id = c.id AND l.ticket_state = 'open'
      ))
  OR camp.target_segment = 'all'
  OR (camp.target_segment = 'showroom_no_purchase'
      AND c.total_orders_count = 0
      AND EXISTS (
        SELECT 1 FROM showroom_visits sv
        WHERE sv.customer_id = c.id AND sv.outcome IN ('browsing', 'interested')
      ))
  OR (camp.target_segment = 'multi_channel_no_conversion'
      AND c.is_loyalty_customer = FALSE
      AND COALESCE(ve.channels_engaged, 0) >= 2)
  OR (camp.target_segment = 'gone_quiet' AND c.is_loyalty_customer = FALSE)
)
  AND camp.status = 'active'
  AND c.consent_for_marketing = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM campaign_sends cs WHERE cs.campaign_id = camp.id AND cs.customer_id = c.id
  )
  AND (
    camp.trigger_type = 'ad_hoc'
    OR (
      camp.target_segment IN ('loyalty', 'potential', 'all')
      AND camp.trigger_offset_days IS NOT NULL
      AND c.last_purchase_date IS NOT NULL
      AND c.last_purchase_date + (camp.trigger_offset_days || ' days')::interval <= NOW()
    )
    OR (
      camp.target_segment = 'gone_quiet'
      AND camp.trigger_offset_days IS NOT NULL
      AND GREATEST(
        COALESCE(ve.last_whatsapp_at, '-infinity'::timestamptz),
        COALESCE(ve.last_call_at, '-infinity'::timestamptz),
        COALESCE(ve.last_showroom_visit_at, '-infinity'::timestamptz)
      ) + (camp.trigger_offset_days || ' days')::interval <= NOW()
    )
    OR camp.target_segment IN ('showroom_no_purchase', 'multi_channel_no_conversion')
  );
