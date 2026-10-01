-- Fix for a real bug found while verifying Phase 14 (migration 012): a
-- gone_quiet campaign created with trigger_type='ad_hoc' matched the FIRST
-- branch of the final timing OR-chain (`camp.trigger_type = 'ad_hoc'`), which
-- short-circuited before the gone_quiet-specific GREATEST(...)+offset check
-- ever ran — so a gone_quiet+ad_hoc campaign matched every non-loyalty
-- customer regardless of how recently they'd engaged, not just the quiet
-- ones. Confirmed by hand: a customer who messaged, called, and visited a
-- showroom minutes ago still showed up as "gone quiet" under the old view.
--
-- Fix: gone_quiet's timing check is no longer reachable via the ad_hoc
-- shortcut at all — it always requires its own offset check, regardless of
-- trigger_type. Every other segment's behavior is unchanged.
--
-- Apply with:
--   docker exec -i crm-postgres psql -U crm -d crm < migrations/013_fix_gone_quiet_ad_hoc_bypass.sql

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
    -- gone_quiet ALWAYS needs its own timing check — never short-circuited
    -- by the ad_hoc branch below, unlike every other segment.
    (camp.target_segment = 'gone_quiet'
      AND camp.trigger_offset_days IS NOT NULL
      AND GREATEST(
        COALESCE(ve.last_whatsapp_at, '-infinity'::timestamptz),
        COALESCE(ve.last_call_at, '-infinity'::timestamptz),
        COALESCE(ve.last_showroom_visit_at, '-infinity'::timestamptz)
      ) + (camp.trigger_offset_days || ' days')::interval <= NOW())
    OR (camp.target_segment != 'gone_quiet' AND (
      camp.trigger_type = 'ad_hoc'
      OR (
        camp.target_segment IN ('loyalty', 'potential', 'all')
        AND camp.trigger_offset_days IS NOT NULL
        AND c.last_purchase_date IS NOT NULL
        AND c.last_purchase_date + (camp.trigger_offset_days || ' days')::interval <= NOW()
      )
      OR camp.target_segment IN ('showroom_no_purchase', 'multi_channel_no_conversion')
    ))
  );
