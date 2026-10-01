ALTER TABLE customers DROP CONSTRAINT customers_channel_check;
ALTER TABLE customers ADD CONSTRAINT customers_channel_check
  CHECK (channel IN ('meta', 'twilio', 'call', 'showroom'));
