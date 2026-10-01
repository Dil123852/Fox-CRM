-- Rollback for 011_showroom_orders.sql — restores the original 3-value
-- channel constraint. Will fail if any customer row already has
-- channel='showroom'; reassign those rows first if rolling back for real.
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_channel_check;
ALTER TABLE customers ADD CONSTRAINT customers_channel_check
  CHECK (channel IN ('meta', 'twilio', 'call'));
