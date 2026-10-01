-- Revert 050. Removes click-to-call: every paired phone is un-paired (the app
-- falls back to "not signed in") and the dial history is DELETED — take a copy
-- of dial_requests first if that audit trail is needed.
--
-- dial_requests goes first: it references staff_devices.

DROP TABLE IF EXISTS dial_requests;
DROP TABLE IF EXISTS staff_devices;
