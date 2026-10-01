-- Down migration for 056_device_pair_codes.sql
--
-- Only removes the one-time codes. Phones that signed in with a QR keep their
-- staff_devices token and stay signed in: nothing about an issued token
-- depends on the code that produced it.

BEGIN;
DROP TABLE IF EXISTS device_pair_codes;
COMMIT;
