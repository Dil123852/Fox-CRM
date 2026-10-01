-- Rollback for 002_ticket_foundation.sql
-- Apply in reverse migration order: after 009..003's .down.sql.
DROP TRIGGER IF EXISTS trg_order_completed ON orders;
DROP FUNCTION IF EXISTS handle_order_completed();

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_delivered_requires_paid;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders DROP COLUMN IF EXISTS lead_id;
ALTER TABLE orders DROP COLUMN IF EXISTS amount_paid;

ALTER TABLE customers DROP COLUMN IF EXISTS is_loyalty_customer;
ALTER TABLE customers DROP COLUMN IF EXISTS first_purchase_date;
ALTER TABLE customers DROP COLUMN IF EXISTS last_purchase_date;
ALTER TABLE customers DROP COLUMN IF EXISTS total_orders_count;
ALTER TABLE customers DROP COLUMN IF EXISTS lifetime_value;

DROP INDEX IF EXISTS idx_leads_ticket_state;
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_ticket_state_check;
ALTER TABLE leads DROP COLUMN IF EXISTS ticket_state;
ALTER TABLE leads DROP COLUMN IF EXISTS closed_at;
ALTER TABLE leads DROP COLUMN IF EXISTS closed_reason;
ALTER TABLE leads DROP COLUMN IF EXISTS is_returning_contact;
ALTER TABLE leads DROP COLUMN IF EXISTS reopened_from_lead_id;
