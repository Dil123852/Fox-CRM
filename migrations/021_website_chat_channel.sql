-- Adds 'webchat' as a real customers.channel value — the nidikumba.shop
-- AI chat widget (sticky icon on the marketing site) is its own contact
-- channel, distinct from 'meta'/'twilio' (WhatsApp), 'call' (Dialog), and
-- 'showroom' (walk-in). A website visitor has no WhatsApp number of their
-- own by default, so the widget asks for one before starting the chat —
-- confirmed with the user rather than making whatsapp_number nullable,
-- which would touch every existing table/feature built on that column
-- being required. Once given, that number is treated exactly like any
-- other channel's customer: same customers row, same leads, same staff
-- dashboard, same AI tools (escalation/promo/warranty).

ALTER TABLE customers DROP CONSTRAINT customers_channel_check;
ALTER TABLE customers ADD CONSTRAINT customers_channel_check
  CHECK (channel IN ('meta', 'twilio', 'call', 'showroom', 'webchat'));
