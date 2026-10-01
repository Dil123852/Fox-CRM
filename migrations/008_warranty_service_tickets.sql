-- Phase 10 — Warranty & Service Tickets (Module 8, Appendix A.7)
-- Apply with:
--   docker exec -i crm-postgres psql -U crm -d crm < migrations/008_warranty_service_tickets.sql
--
-- Deviations from Appendix A.7's literal SQL, deliberate:
--   * Product matching is by name (item->>'name', falling back to the older
--     item->>'product' key), not item->>'product_id' — order line items have
--     no product_id field, exactly as the kickoff prompt itself acknowledges.
--     Same COALESCE pattern Phase 4's stock trigger already uses.
--   * Trigger fires on status='delivered' AND payment_status='paid', not
--     status='completed' — 'completed' isn't a real status value in this
--     schema (established since Phase 3).
--   * handle_new_service_ticket sets priority_score=3 for an escalated
--     ticket, not the spec's literal 10 — this system's real priority_score
--     scale is 1-3 (Phase 2's lead scoring, Phase 5's escalation both use
--     it), and 3 is what "high" means everywhere else here.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS warranty_years INTEGER DEFAULT 5;

CREATE SEQUENCE IF NOT EXISTS warranty_number_seq;

CREATE TABLE IF NOT EXISTS warranties (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  warranty_number TEXT        NOT NULL UNIQUE,
  order_id        UUID        NOT NULL REFERENCES orders(id),
  customer_id     UUID        NOT NULL REFERENCES customers(id),
  product_id      UUID        REFERENCES products(id),
  product_name    TEXT        NOT NULL,
  start_date      DATE        NOT NULL,
  end_date        DATE        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  terms_summary   TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_warranties_customer_id ON warranties(customer_id);
CREATE INDEX IF NOT EXISTS idx_warranties_order_id ON warranties(order_id);

-- Computed, not manually maintained (REQ-9.3) — status can never drift out
-- of sync with reality since it's derived from dates on every read.
CREATE OR REPLACE VIEW v_warranty_status AS
SELECT
  w.*,
  CASE
    WHEN w.status = 'voided' THEN 'voided'
    WHEN CURRENT_DATE > w.end_date THEN 'expired'
    ELSE 'active'
  END AS effective_status,
  GREATEST(w.end_date - CURRENT_DATE, 0) AS days_remaining
FROM warranties w;

-- One warranty per warrantied line item when its order completes (delivered+paid).
CREATE OR REPLACE FUNCTION handle_order_completed_warranty()
RETURNS trigger AS $$
DECLARE
  item jsonb;
  v_name TEXT;
  v_product_id UUID;
  v_warranty_years INT;
BEGIN
  IF NEW.status = 'delivered' AND NEW.payment_status = 'paid'
     AND (OLD.status IS DISTINCT FROM 'delivered' OR OLD.payment_status IS DISTINCT FROM 'paid') THEN
    FOR item IN SELECT * FROM jsonb_array_elements(NEW.items)
    LOOP
      v_name := COALESCE(item->>'name', item->>'product');
      IF v_name IS NULL THEN CONTINUE; END IF;

      SELECT id, warranty_years INTO v_product_id, v_warranty_years FROM products WHERE name = v_name;

      IF v_warranty_years IS NOT NULL THEN
        INSERT INTO warranties (warranty_number, order_id, customer_id, product_id, product_name, start_date, end_date)
        VALUES (
          'WTY-' || to_char(nextval('warranty_number_seq'), 'FM00000'),
          NEW.id, NEW.customer_id, v_product_id, v_name,
          CURRENT_DATE, CURRENT_DATE + (v_warranty_years || ' years')::interval
        );
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Fires alongside the existing handle_order_completed (Phase 3) and
-- handle_order_stock_reservation (Phase 4) triggers on the same event —
-- separate function, separate concern, exactly as Appendix A.7 notes.
DROP TRIGGER IF EXISTS trg_order_completed_warranty ON orders;
CREATE TRIGGER trg_order_completed_warranty
AFTER UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION handle_order_completed_warranty();

CREATE TABLE IF NOT EXISTS service_tickets (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         UUID        NOT NULL REFERENCES orders(id),
  customer_id      UUID        NOT NULL REFERENCES customers(id),
  product_id       UUID        REFERENCES products(id),
  warranty_id      UUID        REFERENCES warranties(id),
  issue_type       TEXT        NOT NULL CHECK (issue_type IN ('warranty_claim', 'defect', 'delivery_damage', 'general_complaint')),
  description      TEXT,
  status           TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  priority         TEXT        DEFAULT 'normal' CHECK (priority IN ('normal', 'high')),
  warranty_valid   BOOLEAN,
  resolution_notes TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  resolved_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_service_tickets_customer_id ON service_tickets(customer_id);
CREATE INDEX IF NOT EXISTS idx_service_tickets_status ON service_tickets(status);

-- Validates against the warranty at creation time (REQ-9.5, no recalculation
-- later), and auto-escalates real defects/delivery damage (REQ-9.6).
CREATE OR REPLACE FUNCTION handle_new_service_ticket()
RETURNS trigger AS $$
DECLARE
  v_effective_status TEXT;
BEGIN
  IF NEW.warranty_id IS NOT NULL THEN
    SELECT effective_status INTO v_effective_status FROM v_warranty_status WHERE id = NEW.warranty_id;
    NEW.warranty_valid := (v_effective_status = 'active');
  END IF;

  IF NEW.issue_type IN ('defect', 'delivery_damage') THEN
    NEW.priority := 'high';
    UPDATE customers SET priority_score = 3, priority_label = 'high', priority_updated_at = NOW()
    WHERE id = NEW.customer_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_new_service_ticket ON service_tickets;
CREATE TRIGGER trg_new_service_ticket
BEFORE INSERT ON service_tickets
FOR EACH ROW EXECUTE FUNCTION handle_new_service_ticket();
