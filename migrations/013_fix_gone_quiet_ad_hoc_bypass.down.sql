-- Rollback for 013_fix_gone_quiet_ad_hoc_bypass.sql — restores the
-- (buggy) view exactly as migration 012 defined it.
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
