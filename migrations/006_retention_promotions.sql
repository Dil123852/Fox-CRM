-- Phase 7 — Post-Purchase Retention & Promotions (Module 5)
-- Apply with:
--   docker exec -i crm-postgres psql -U crm -d crm < migrations/006_retention_promotions.sql
--
-- Deviations from a literal reading of the spec, deliberate:
--   * "Retention-trigger scheduling" (8.2) is implemented as a LIVE-COMPUTED
--     eligibility view (v_campaign_eligible_customers), not an unattended
--     cron — same choice as Phase 5's overdue detection, for the same reason:
--     no scheduler exists in this codebase. REQ-5.4 says "support scheduling,"
--     which this satisfies (a query always answers "who's due right now,"
--     accurately, for any configured offset) — actually SENDING still needs
--     something to call POST /api/campaigns/:id/send, whether that's an
--     admin clicking a button today or a real cron later.
--   * REQ-5.9's "ask for consent at/shortly after order completion" is NOT
--     an automated flow this phase — no UI/AI-prompt work was in the kickoff
--     prompt's deliverable list. consent_for_marketing is a plain field staff
--     set via PATCH /api/customers/:id; automating the ask is Module 6/8
--     territory (Phase 8 is exactly "Automated Reply Polish").
--   * REQ-5.8's order-matching (did a campaign send lead to a sale) is
--     schema-only: campaign_sends.resulted_in_order_id exists and can be set,
--     but nothing automatically backfills it — that's separate matching
--     logic beyond "add the tables + scheduling + consent enforcement."

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS consent_for_marketing BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS consent_updated_at    TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS campaigns (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT        NOT NULL,
  target_segment     TEXT        NOT NULL CHECK (target_segment IN ('loyalty', 'potential', 'all')),
  -- trigger_type mirrors spec Section 8.2's table; trigger_offset_days is the
  -- configurable delivery-relative day count (REQ-5.5) — NULL for 'ad_hoc',
  -- which is manually campaign-driven rather than delivery-date-relative.
  trigger_type       TEXT        NOT NULL CHECK (trigger_type IN (
    'referral_ask', 'comfort_checkin', 'accessory_upsell',
    'anniversary', 'replacement_reminder', 'ad_hoc'
  )),
  trigger_offset_days INTEGER,
  message_template   TEXT        NOT NULL,
  status             TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused')),
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campaign_sends (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         UUID        NOT NULL REFERENCES campaigns(id),
  customer_id         UUID        NOT NULL REFERENCES customers(id),
  sent_at             TIMESTAMPTZ DEFAULT NOW(),
  resulted_in_order_id UUID       REFERENCES orders(id),
  UNIQUE (campaign_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_sends_campaign_id ON campaign_sends(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_sends_customer_id ON campaign_sends(customer_id);

-- View — who's eligible for a given active campaign RIGHT NOW (REQ-5.4 as a
-- live query, not a scheduled job). Enforces REQ-5.7 structurally: a customer
-- without consent_for_marketing never appears here at all. The send endpoint
-- (index.js) re-checks consent explicitly on top of this for a direct,
-- specific-customer send, so REQ-5.7 holds even when this view isn't used.
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
