-- Revert 051: calls no longer record which agent's phone logged them.
--
-- DESTRUCTIVE for the new data: every call's staff_id/device_id is dropped,
-- and that attribution cannot be reconstructed afterwards (the whole point of
-- 051 is that nothing else records it). Back up first if it matters.
--
-- The view must be DROPPED and re-created, not replaced: CREATE OR REPLACE
-- VIEW cannot remove columns, and it has to go before the columns it reads.
-- Its definition below is copied verbatim from migration 043.

BEGIN;

DROP VIEW IF EXISTS v_missed_call_callbacks;

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
  -- Canonical number for every dated call. occurred_at has no NOT NULL
  -- constraint, and an undated call cannot be ordered against anything, so it
  -- can be neither a miss with a position in time nor a callback: dropped once
  -- here so nothing downstream has to reason about NULL ordering.
  -- Rows with a NULL call_type (one exists in production) simply match neither
  -- 'MISSED' nor 'OUTGOING' below and are inert by construction.
  SELECT
    normalize_lk_phone(ce.raw_phone_number) AS phone_canon,
    ce.id, ce.customer_id, ce.raw_phone_number, ce.contact_name,
    ce.call_type, ce.duration_seconds, ce.occurred_at
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
  t.min_seconds AS threshold_seconds
FROM missed m
CROSS JOIN threshold t
-- Identity comes from the number's most recent missed call, not from a second
-- join back to customers on the phone string: call_events.customer_id is the
-- link the call-tracker sync already resolved, and re-deriving it here would
-- create a second source of truth that could disagree with the Calls page.
LEFT JOIN LATERAL (
  SELECT e.customer_id, e.raw_phone_number, e.contact_name
  FROM ev e
  WHERE e.phone_canon = m.phone_canon
    AND e.call_type = 'MISSED'
    AND e.occurred_at = m.latest_missed_at
  ORDER BY e.id
  LIMIT 1
) latest ON TRUE
LEFT JOIN customers cust ON cust.id = latest.customer_id
-- The FIRST qualifying outgoing call after the latest miss closes it. Scanning
-- forward from latest_missed_at only is what makes an outgoing call placed
-- BEFORE the miss (production has exactly one such row) correctly not count.
LEFT JOIN LATERAL (
  SELECT e.id, e.occurred_at, e.duration_seconds
  FROM ev e
  WHERE e.phone_canon = m.phone_canon
    AND e.call_type = 'OUTGOING'
    AND e.occurred_at > m.latest_missed_at
    AND COALESCE(e.duration_seconds, 0) > t.min_seconds
  ORDER BY e.occurred_at ASC
  LIMIT 1
) cb ON TRUE;

COMMENT ON VIEW v_missed_call_callbacks IS
  'One row per phone number that has ever missed us. done = a qualifying OUTGOING call (longer than app_settings.callback_min_seconds) exists strictly after that number''s LATEST missed call. A new miss returns the row to pending.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nidikumba_app') THEN
    GRANT SELECT ON v_missed_call_callbacks TO nidikumba_app;
  END IF;
END
$$;

DROP INDEX IF EXISTS idx_call_events_staff_occurred;
ALTER TABLE call_events DROP COLUMN IF EXISTS device_id, DROP COLUMN IF EXISTS staff_id;

COMMIT;
