-- Rollback for 006_retention_promotions.sql
-- Apply in reverse migration order: after 009..007's .down.sql.
DROP VIEW IF EXISTS v_campaign_eligible_customers;
DROP TABLE IF EXISTS campaign_sends;
DROP TABLE IF EXISTS campaigns;

ALTER TABLE customers DROP COLUMN IF EXISTS consent_for_marketing;
ALTER TABLE customers DROP COLUMN IF EXISTS consent_updated_at;
