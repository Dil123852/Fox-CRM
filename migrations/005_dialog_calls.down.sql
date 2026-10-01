-- Rollback for 005_dialog_calls.sql
-- Apply in reverse migration order: after 009..006's .down.sql.
--
-- Safety note: this narrows customers.channel back to ('meta','twilio'). If
-- any customer row has channel='call' (a phone-only contact created by the
-- Dialog trigger), the ADD CONSTRAINT below will fail loudly rather than
-- silently — that's intentional. Decide what to do with those customers
-- (reassign channel, or accept they can't roll back cleanly) before retrying.
DROP TRIGGER IF EXISTS trg_call_event ON call_events;
DROP FUNCTION IF EXISTS handle_call_event();

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_channel_check;
ALTER TABLE customers ADD CONSTRAINT customers_channel_check CHECK (channel IN ('meta', 'twilio'));

DROP TABLE IF EXISTS call_events;
