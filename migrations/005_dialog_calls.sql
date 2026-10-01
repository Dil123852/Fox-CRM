-- Phase 6 — Dialog Call Integration (Module 4 addition)
-- Apply with:
--   docker exec -i crm-postgres psql -U crm -d crm < migrations/005_dialog_calls.sql
--
-- UPDATE (Phase 16, migration 022): wired up the real Dwesk/Dialog webhook
-- payload (customerCli/dateTime/callId/companyId/callFlowId).
-- UPDATE (Phase 17, migration 023): that Dwesk integration was retired after
-- confirming via an ngrok request log that Dwesk never actually delivered a
-- real webhook to it end-to-end — replaced with POST /api/calls, fed by a
-- self-built Android call-tracker app instead. See migration 023 and the
-- POST /api/calls handler in index.js for the current, correct behavior.
-- The trg_call_event trigger below was dropped in migration 012 (Phase 14)
-- in favor of shared JS logic (findOrCreateCustomerByPhone/
-- getOrCreateOpenTicket) that WhatsApp/showroom visits/the call-tracker app
-- all now use; it's kept here only as history of the original schema work.

CREATE TABLE IF NOT EXISTS call_events (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      UUID        REFERENCES customers(id),
  raw_phone_number TEXT        NOT NULL,
  call_type        TEXT,
  duration_seconds INTEGER,
  occurred_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_events_customer_id ON call_events(customer_id);

-- customers.channel needs a third value: an inbound call can be the first
-- contact ever from a phone number with no prior WhatsApp history.
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_channel_check;
ALTER TABLE customers ADD CONSTRAINT customers_channel_check CHECK (channel IN ('meta', 'twilio', 'call'));

-- Trigger — matches every call event to an existing customer by phone number
-- (REQ-4.12, for display alongside WhatsApp history; does NOT create a
-- customer for an answered call from an unknown number — "where one exists").
-- A missed call (zero/null duration, or call_type indicating no-answer) goes
-- further: creates the customer if none exists, then opens a ticket through
-- the exact same leads-INSERT path a WhatsApp lead uses (REQ-4.14) —
-- trg_new_lead_assignment (Phase 5) picks it up automatically, so the call
-- gets the same round-robin assignment + SLA clock as any other new ticket.
-- Skips creating a duplicate ticket if the customer already has one open
-- (same convention as analyzeConversation() in index.js).
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
