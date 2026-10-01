-- Rollback 035: remove the activity log and its triggers.
--
-- NOTE: this DROPS the recorded history. Take a backup first if the log holds
-- anything worth keeping — the rules on activity_log block DELETE, but they do
-- not block DROP TABLE.

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'leads', 'lead_items',
    'orders', 'order_payments',
    'customers',
    'products',
    'warranties', 'service_tickets',
    'promo_codes', 'promo_code_redemptions', 'influencers',
    'staff_users'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_activity_log ON %I', t);
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS log_activity();
DROP FUNCTION IF EXISTS log_activity_write(TEXT, TEXT, TEXT, JSONB, JSONB);
DROP TABLE IF EXISTS activity_log;
