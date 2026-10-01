-- 051: record WHICH agent's phone logged each call
--
-- THE GAP. A call reached an agent only through the lead it opened
-- (getOrCreateOpenTicket assigns a NEW lead to the phone's owner). When the
-- customer already had an open lead — say agent A's — and agent B called
-- them, the call was attached to A's lead and nothing anywhere recorded that
-- B made it. The Calls page could not say who called, and the Callbacks page
-- could not say who returned a missed call.
--
-- THE FIX. Each call_events row now carries:
--   staff_id  — the staff member whose phone logged the call (made it,
--               received it, or missed it).
--   device_id — the paired phone it came from (migration 050).
--
-- Reading the pair:
--   staff_id + device_id  -> VERIFIED: the phone signed in with that agent's
--                            own CRM login.
--   staff_id, no device   -> CLAIMED: an older app build that still sends a
--                            self-typed ownerPhone with the shared key. Shown,
--                            but marked unverified in the UI.
--   neither               -> unknown: a call synced before this migration, or
--                            from an unmatched legacy phone.
--
-- NO BACKFILL, deliberately. Nothing records which phone logged an existing
-- row. Filling staff_id from the lead's assigned_staff_id would write exactly
-- the wrong answer this migration exists to stop giving (A for B's call), so
-- historical rows stay NULL and read as "—".
--
-- ON DELETE SET NULL on both: a call is history. Removing a staff account or
-- an un-paired phone must not delete, or block deleting, the calls it made.

BEGIN;

ALTER TABLE call_events
  ADD COLUMN IF NOT EXISTS staff_id  UUID REFERENCES staff_users(id)   ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS device_id UUID REFERENCES staff_devices(id) ON DELETE SET NULL;

-- "This agent's calls, newest first" — the Calls page's staff filter.
CREATE INDEX IF NOT EXISTS idx_call_events_staff_occurred
  ON call_events (staff_id, occurred_at DESC)
  WHERE staff_id IS NOT NULL;

-- ── The callback tracker learns who ─────────────────────────────────────────
-- Identical to migration 043's definition except for the staff columns: ev
-- carries staff_id, the two LATERALs return it, and four columns are appended
-- at the END (CREATE OR REPLACE VIEW only allows adding columns at the end).
--   missed_on_*      — whose phone the number's latest miss rang on.
--   called_back_by_* — whose phone made the call that closed it.
-- Callback status itself is unchanged: ANY agent's qualifying call still
-- counts, since a customer rung back by a colleague has been rung back.
CREATE OR REPLACE VIEW v_missed_call_callbacks AS
WITH threshold AS (
  -- app_settings.value is free TEXT with no CHECK, so a hand-edited 'abc' or
  -- '' must degrade to the default instead of erroring for every reader.
  SELECT COALESCE(
    NULLIF(regexp_replace(
      COALESCE((SELECT value FROM app_settings WHERE key = 'callback_min_seconds'), ''),
      '[^0-9]', '', 'g'
    ), '')::int,
    15
  ) AS min_seconds
),
ev AS (
  SELECT
    normalize_lk_phone(ce.raw_phone_number) AS phone_canon,
    ce.id, ce.customer_id, ce.raw_phone_number, ce.contact_name,
    ce.call_type, ce.duration_seconds, ce.occurred_at, ce.staff_id
  FROM call_events ce
  WHERE ce.occurred_at IS NOT NULL
),
missed AS (
  SELECT
    phone_canon,
    COUNT(*)          AS missed_count,
    MAX(occurred_at)  AS latest_missed_at,
    MIN(occurred_at)  AS first_missed_at
  FROM ev
  WHERE call_type = 'MISSED'
  GROUP BY phone_canon
)
SELECT
  m.phone_canon,
  latest.raw_phone_number,
  m.missed_count,
  m.first_missed_at,
  m.latest_missed_at,
  latest.customer_id,
  cust.name         AS customer_name,
  latest.contact_name,
  cb.occurred_at        AS called_back_at,
  cb.duration_seconds   AS callback_duration_seconds,
  (cb.id IS NOT NULL)   AS is_called_back,
  CASE WHEN cb.id IS NOT NULL THEN 'done' ELSE 'pending' END AS callback_status,
  -- NULL while pending; the UI renders a dash rather than a bogus zero.
  CASE WHEN cb.id IS NOT NULL
       THEN cb.occurred_at - m.latest_missed_at END AS time_to_callback,
  t.min_seconds AS threshold_seconds,
  latest.staff_id AS missed_on_staff_id,
  ms.name         AS missed_on_staff_name,
  cb.staff_id     AS called_back_by_staff_id,
  cbs.name        AS called_back_by_name
FROM missed m
CROSS JOIN threshold t
LEFT JOIN LATERAL (
  SELECT e.customer_id, e.raw_phone_number, e.contact_name, e.staff_id
  FROM ev e
  WHERE e.phone_canon = m.phone_canon
    AND e.call_type = 'MISSED'
    AND e.occurred_at = m.latest_missed_at
  ORDER BY e.id
  LIMIT 1
) latest ON TRUE
LEFT JOIN customers cust ON cust.id = latest.customer_id
LEFT JOIN LATERAL (
  SELECT e.id, e.occurred_at, e.duration_seconds, e.staff_id
  FROM ev e
  WHERE e.phone_canon = m.phone_canon
    AND e.call_type = 'OUTGOING'
    AND e.occurred_at > m.latest_missed_at
    AND COALESCE(e.duration_seconds, 0) > t.min_seconds
  ORDER BY e.occurred_at ASC
  LIMIT 1
) cb ON TRUE
LEFT JOIN staff_users ms  ON ms.id  = latest.staff_id
LEFT JOIN staff_users cbs ON cbs.id = cb.staff_id;

COMMENT ON VIEW v_missed_call_callbacks IS
  'One row per phone number that has ever missed us. done = a qualifying OUTGOING call (longer than app_settings.callback_min_seconds) exists strictly after that number''s LATEST missed call. A new miss returns the row to pending. missed_on_* / called_back_by_* name whose phone (migration 051); NULL for calls synced before 051.';

COMMIT;
