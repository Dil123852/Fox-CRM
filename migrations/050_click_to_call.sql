-- 050: click-to-call — paired phones and dial requests
--
-- WHAT THIS ENABLES. A "Call" button in the dashboard that makes the CLICKER's
-- own Android phone (running the Call Tracker app) dial the customer. Until now
-- the phone could only talk TO the CRM; nothing could tell a specific phone to
-- do anything, because the CRM had no idea which phone belonged to whom.
--
-- staff_devices — one paired phone per staff member.
--
--   The app used to authenticate with ONE shared key baked into the APK
--   (CALL_TRACKER_API_KEY), and identified its owner by a phone number the
--   user typed in (ownerPhone). Both were self-asserted: anyone holding the
--   APK could extract the key and claim to be any agent. That was tolerable
--   while the phone only uploaded its own call log. It is not tolerable once
--   the CRM sends customer numbers DOWN to a phone and makes it dial — the
--   wrong phone would receive the number, or an agent's phone could be made to
--   call someone they never chose to.
--
--   So each phone now signs in once with the staff member's own CRM login and
--   receives its OWN random token. Only a SHA-256 hash of that token is stored
--   (token_hash): a database leak must not hand out working phone
--   credentials. Revoking one lost phone (revoked_at) cuts off only that phone.
--
--   One ACTIVE phone per staff member, enforced by a partial unique index:
--   "call from my phone" must resolve to exactly one device. Pairing a new
--   phone revokes the old one in the same transaction (see POST
--   /api/devices/pair), rather than failing on the index.
--
-- dial_requests — who asked to call whom, and what happened.
--
--   Doubles as the audit trail: "did Nimal really call this customer at 3pm,
--   from the CRM?" is answerable from here. The number is copied into the row
--   (phone_number) because it is what was actually dialled; the customer's
--   number can change later.
--
--   expires_at bounds the request to 60 seconds. A phone that was offline for
--   an hour must NOT suddenly dial a customer when it reconnects — the agent
--   has long since moved on. There is no scheduler in this codebase, so
--   expiry is evaluated on read (the same live-computation choice as
--   v_lead_sla_status): the server never delivers an expired request, and the
--   phone also drops one that arrives late.
--
--   customer_id/lead_id are ON DELETE SET NULL, not CASCADE: this is audit
--   data, and deleting a customer must not erase the record that they were
--   called.

CREATE TABLE IF NOT EXISTS staff_devices (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id     UUID NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  device_name  TEXT,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  CONSTRAINT staff_devices_token_hash_is_sha256 CHECK (token_hash ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_devices_one_active_per_staff
  ON staff_devices (staff_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS dial_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id     UUID NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  device_id    UUID REFERENCES staff_devices(id) ON DELETE SET NULL,
  -- customers/leads are soft-delete VIEWS since migration 036; a foreign key
  -- must point at the underlying *_all tables.
  customer_id  UUID REFERENCES customers_all(id) ON DELETE SET NULL,
  lead_id      UUID REFERENCES leads_all(id) ON DELETE SET NULL,
  phone_number TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'delivered', 'dialing', 'busy', 'needs_tap', 'failed')),
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '60 seconds'
);

-- "This staff member's recent/pending requests" — the double-click guard and
-- the redelivery-on-reconnect lookup both read exactly this.
CREATE INDEX IF NOT EXISTS idx_dial_requests_staff_created
  ON dial_requests (staff_id, created_at DESC);

-- Production connects as the least-privilege role (migration 037). Its default
-- privileges only cover tables created BY `crm`, and migration 044 documents
-- the outage caused by relying on that. Granted explicitly so these two tables
-- work no matter which role applies this file. Skipped where the role does not
-- exist (local dev connects as the owner).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nidikumba_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON staff_devices, dial_requests TO nidikumba_app';
  END IF;
END
$$;
