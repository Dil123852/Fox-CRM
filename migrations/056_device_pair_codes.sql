-- 056: one-time QR codes for signing a Call Tracker phone in
--
-- THE REQUIREMENT. Signing a phone in meant typing the server address, the
-- agent's CRM phone number and password into the app. Now the agent clicks
-- "Connect my phone" on the dashboard (already logged in), and the app scans
-- a QR instead. The QR carries a one-time code that stands in for the
-- password for this single sign-in.
--
-- WHY IT IS SAFE ENOUGH WITHOUT AN APPROVE STEP (confirmed with the user):
--  - the code is created for the LOGGED-IN staff member only, never for
--    someone else, so the QR can only ever sign in the person showing it;
--  - 32 random bytes, of which only the SHA-256 is stored (same as
--    staff_devices.token_hash) — a database dump cannot be replayed;
--  - valid for 5 minutes, and single use: redeeming it is ONE conditional
--    UPDATE (used_at IS NULL AND expires_at > now()), so two phones scanning
--    the same QR cannot both win;
--  - making a new code voids the previous unused ones;
--  - redeeming re-checks the staff member is still active and allowed to
--    pair, and issues the token through the same path as password sign-in,
--    so the agent's previous phone is signed out.
--
-- used_device_id records which phone the code became (the audit trail for
-- "which phone connected with this QR"). ON DELETE SET NULL: the code row
-- outlives a device row being cleaned up.
--
-- Requires 050. Apply with:
--   docker exec -i crm-postgres psql -U crm -d crm < migrations/056_device_pair_codes.sql

BEGIN;

CREATE TABLE IF NOT EXISTS device_pair_codes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id       UUID NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  code_hash      TEXT NOT NULL UNIQUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  used_at        TIMESTAMPTZ,
  used_device_id UUID REFERENCES staff_devices(id) ON DELETE SET NULL,
  CONSTRAINT device_pair_codes_expiry_after_creation CHECK (expires_at > created_at)
);

-- "Void this person's older unused codes" runs on every new code.
CREATE INDEX IF NOT EXISTS idx_device_pair_codes_unused
  ON device_pair_codes (staff_id) WHERE used_at IS NULL;

COMMENT ON TABLE device_pair_codes IS
  'One-time QR codes that sign a Call Tracker phone in without typing a password. SHA-256 only; 5-minute, single use. Migration 056.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nidikumba_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON device_pair_codes TO nidikumba_app';
  END IF;
END $$;

COMMIT;
