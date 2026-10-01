-- Phase 3 — Ticket Foundation (Leads + Orders linkage)
-- Apply with:
--   docker exec -i crm-postgres psql -U crm -d crm < migrations/002_ticket_foundation.sql
--
-- Deviations from spec Appendix A.2/A.3, deliberate — see CLAUDE.md:
--   * orders_status_check uses the seven REAL live values: 'pending' (the
--     column's own DEFAULT, set on every INSERT before staff touch the status
--     dropdown) plus the six values OrdersPage.jsx's dropdown offers
--     (new/confirmed/processing/shipped/delivered/cancelled). CLAUDE.md's
--     "six real values" note missed the DEFAULT itself — applying that list
--     as a CHECK constraint failed immediately against the one live order
--     row (status='pending'), which is exactly the kind of surprise
--     PROJECT_PLAN.md's Phase 0 backup rule exists for. Not the spec's
--     nine-value list either — 'new' and 'shipped' are real, 'ready_for_delivery'
--     /'out_for_delivery'/'completed'/'returned' are not.
--   * orders_payment_status_check is the union of the spec's proposed values
--     (pending/partial/paid/refunded) and the value the live dashboard already
--     writes ('failed') — dropping 'failed' would break OrdersPage.jsx today.
--   * "Completed" has no status value of its own: Trigger 1 fires on
--     status='delivered' AND payment_status='paid', matching CLAUDE.md's
--     correction of the spec's original 'completed' check.
--   * Trigger 1 requires 5 customer loyalty columns the spec only lists under
--     Module 5 (Appendix A.2 "Customers — loyalty and consent fields"); added
--     here since Trigger 1 can't run without them. Consent fields stay out of
--     scope for this phase — those belong to Phase 7.
--   * Trigger 2 (auto-priority for a returning loyalty customer) is NOT
--     included — Phase 3's scope was Trigger 1 only, even though Trigger 2
--     would slot into the same columns added here.

-- Leads — extended to serve as the ticket object
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS ticket_state         TEXT        DEFAULT 'open' NOT NULL,
  ADD COLUMN IF NOT EXISTS closed_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_reason        TEXT,
  ADD COLUMN IF NOT EXISTS is_returning_contact BOOLEAN     DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reopened_from_lead_id UUID       REFERENCES leads(id);

ALTER TABLE leads
  ADD CONSTRAINT leads_ticket_state_check CHECK (ticket_state IN ('open', 'closed'));

CREATE INDEX IF NOT EXISTS idx_leads_ticket_state ON leads(ticket_state);

-- Customers — loyalty stats needed by Trigger 1 (consent fields deferred to Phase 7)
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS is_loyalty_customer  BOOLEAN       DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS first_purchase_date  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_purchase_date   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS total_orders_count   INTEGER       DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lifetime_value       NUMERIC(12,2) DEFAULT 0;

-- Orders — link back to the ticket that produced it, track amount paid,
-- and lock the status/payment vocabulary to what's actually live in production
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS lead_id      UUID REFERENCES leads(id),
  ADD COLUMN IF NOT EXISTS amount_paid  NUMERIC(12,2) DEFAULT 0;

ALTER TABLE orders
  ADD CONSTRAINT orders_status_check CHECK (status IN (
    'pending', 'new', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'
  )),
  ADD CONSTRAINT orders_payment_status_check CHECK (payment_status IN (
    'pending', 'partial', 'paid', 'refunded', 'failed'
  )),
  ADD CONSTRAINT orders_delivered_requires_paid
    CHECK (status <> 'delivered' OR payment_status = 'paid');

-- Trigger 1 — an order reaching delivered+paid closes its linked ticket and
-- updates the customer's loyalty stats. Fires only on that exact transition.
CREATE OR REPLACE FUNCTION handle_order_completed()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'delivered' AND NEW.payment_status = 'paid'
     AND (OLD.status IS DISTINCT FROM 'delivered' OR OLD.payment_status IS DISTINCT FROM 'paid') THEN

    IF NEW.lead_id IS NOT NULL THEN
      UPDATE leads
      SET ticket_state = 'closed', closed_at = NOW(), closed_reason = 'purchased'
      WHERE id = NEW.lead_id;
    END IF;

    UPDATE customers
    SET is_loyalty_customer = TRUE,
        total_orders_count  = total_orders_count + 1,
        lifetime_value       = lifetime_value + NEW.total_amount,
        last_purchase_date   = NOW(),
        first_purchase_date  = COALESCE(first_purchase_date, NOW())
    WHERE id = NEW.customer_id;

  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_order_completed ON orders;
CREATE TRIGGER trg_order_completed
AFTER UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION handle_order_completed();
