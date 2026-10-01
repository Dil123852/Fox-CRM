-- Adds multi-provider support (Meta Cloud API + Twilio WhatsApp Sandbox).
-- init.sql only runs on a fresh volume, so run this manually against an existing DB:
--   docker exec -i crm-postgres psql -U crm -d crm < db/migrations/001_add_channel_to_customers.sql

ALTER TABLE customers ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'meta';
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_channel_check;
ALTER TABLE customers ADD CONSTRAINT customers_channel_check CHECK (channel IN ('meta', 'twilio'));
