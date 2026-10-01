-- Showroom order placement: staff can now create an order for a walk-in
-- customer directly from the dashboard (phone/PC), with no prior WhatsApp
-- conversation or lead required. This adds a 'showroom' customer.channel
-- value for customers created this way (find-or-create by phone via the new
-- POST /api/customers route), distinct from 'meta'/'twilio' (first contact
-- was an inbound WhatsApp message) and 'call' (first contact was a phone call).
--
-- Apply with:
--   docker exec -i crm-postgres psql -U crm -d crm < migrations/011_showroom_orders.sql

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_channel_check;
ALTER TABLE customers ADD CONSTRAINT customers_channel_check
  CHECK (channel IN ('meta', 'twilio', 'call', 'showroom'));
