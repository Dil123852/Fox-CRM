-- Rollback for 012_unified_channel_engagement.sql.
-- Restores handle_call_event/trg_call_event exactly as migration
-- 005_dialog_calls.sql defined it, drops the new view/table, and restores the
-- original 3-value campaigns.target_segment constraint. Will fail on the
-- constraint restore if any campaign row already uses one of the new segment
-- values — reassign those rows first if rolling back for real.

DROP VIEW IF EXISTS v_campaign_eligible_customers;
ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_target_segment_check;
ALTER TABLE campaigns ADD CONSTRAINT campaigns_target_segment_check
  CHECK (target_segment = ANY (ARRAY['loyalty', 'potential', 'all']));

-- Recreate the original view (pre-14.6) so campaigns keep working post-rollback.
CREATE OR REPLACE VIEW v_campaign_eligible_customers AS
SELECT
  camp.id AS campaign_id,
  c.id AS customer_id
FROM campaigns camp
JOIN customers c ON (
  (camp.target_segment = 'loyalty'   AND c.is_loyalty_customer = TRUE)
  OR (camp.target_segment = 'potential' AND EXISTS (
        SELECT 1 FROM leads l WHERE l.customer_id = c.id AND l.ticket_state = 'open'
      ))
  OR camp.target_segment = 'all'
)
WHERE camp.status = 'active'
  AND c.consent_for_marketing = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM campaign_sends cs WHERE cs.campaign_id = camp.id AND cs.customer_id = c.id
  )
  AND (
    camp.trigger_type = 'ad_hoc'
    OR (
      camp.trigger_offset_days IS NOT NULL
      AND c.last_purchase_date IS NOT NULL
      AND c.last_purchase_date + (camp.trigger_offset_days || ' days')::interval <= NOW()
    )
  );

DROP VIEW IF EXISTS v_customer_engagement;
DROP INDEX IF EXISTS idx_showroom_visits_customer_id;
DROP TABLE IF EXISTS showroom_visits;

CREATE OR REPLACE FUNCTION handle_call_event()
RETURNS trigger AS $$
DECLARE
  v_customer_id uuid;
  v_open_lead_id uuid;
  v_is_missed boolean;
BEGIN
  v_is_missed := NEW.duration_seconds = 0 OR NEW.duration_seconds IS NULL OR NEW.call_type ILIKE '%miss%';

  SELECT id INTO v_customer_id FROM customers WHERE whatsapp_number = NEW.raw_phone_number;

  IF v_is_missed THEN
    IF v_customer_id IS NULL THEN
      INSERT INTO customers (whatsapp_number, channel) VALUES (NEW.raw_phone_number, 'call')
      RETURNING id INTO v_customer_id;
    END IF;

    SELECT id INTO v_open_lead_id FROM leads WHERE customer_id = v_customer_id AND ticket_state = 'open';
    IF v_open_lead_id IS NULL THEN
      INSERT INTO leads (customer_id, status, source) VALUES (v_customer_id, 'new', 'Dialog call');
    END IF;
  END IF;

  NEW.customer_id := v_customer_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_call_event ON call_events;
CREATE TRIGGER trg_call_event
BEFORE INSERT ON call_events
FOR EACH ROW EXECUTE FUNCTION handle_call_event();
