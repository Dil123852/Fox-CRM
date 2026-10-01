-- 043: missed-call callback tracking
--
-- Staff need one answer per phone number: have we rung this person back yet?
-- A missed call that nobody returns is a lost lead, and today that failure is
-- invisible — call_events records the miss, the Calls page shows it under a
-- "Missed" tab, and nothing anywhere tracks whether anyone called back.
--
-- Confirmed with the user: a missed call counts as "called back" when there is
-- a LATER OUTGOING call to the same number lasting MORE THAN the configured
-- threshold (default 15 seconds). The duration bar is the point — a 3-second
-- outgoing call is a ring-out or a misdial, not a conversation.
--
-- Confirmed with the user, and why this way, not the alternative:
--
--   * ONE ROW PER NUMBER, not per missed call. Staff work a call-back list by
--     person, not by event — three misses from one customer is one phone call
--     to make, not three. missed_count carries the volume instead.
--
--   * Status is evaluated against the LATEST miss ONLY. The alternative, "done
--     if ANY miss ever got a callback", is monotonic: once a number went Done
--     it could never return to Pending, so a customer who missed you again
--     this morning would stay hidden under Done forever. That hides live work,
--     which is the one thing this page exists to surface. The deliberate
--     consequence is that a NEW miss flips a Done row back to Pending.
--
--   * NO deadline, NO SLA, NO overdue state. Two states only: pending / done.
--     Deliberately unlike v_lead_sla_status (migration 004), which does have a
--     clock — confirmed with the user that callbacks are not time-boxed.
--
--   * Grouped by normalize_lk_phone(raw_phone_number), NOT the raw string.
--     call_events stores whatever the Android call-tracker sent, and that app's
--     normalizeCallTrackerNumber() (whatsapp-backend/index.js) only strips
--     non-digits — it does NOT canonicalize, so '0765550001' and '94765550001'
--     arrive as two different strings for one human. Grouping on the raw value
--     would split that person into two rows, each with half the history, and a
--     miss could sit Pending right next to its own callback. normalize_lk_phone
--     (migration 030) is the existing canonicalizer and is reused rather than
--     reimplemented. Every call_events row happens to be canonical today, which
--     is exactly why this trap is invisible until the next sync from a phone
--     with a contact saved as '077...'.
--
--   * A VIEW, computed live on read, never materialized — same convention as
--     v_lead_sla_status / v_warranty_status. The threshold is admin-editable
--     and must re-evaluate all history the instant it changes, which a
--     materialized table could not do without a refresh job.
--
-- The threshold is read from app_settings INSIDE the view rather than passed
-- in by the route. That keeps every consumer — the route, a future report, an
-- ad-hoc psql query — in agreement about whether a number is done. A
-- route-supplied parameter would let two callers reach opposite conclusions
-- about the same number, which is exactly the ambiguity this page removes.
--
-- Boundary rules below are deliberate:
--   * `> threshold`, not `>=` — "more than 15 seconds" means 15s does NOT
--     count and 16s does.
--   * `> latest_missed_at`, not `>=` — an equal timestamp coming out of one
--     Android call log is far more likely to be the same event synced oddly
--     than a genuine sub-second callback.
--   * COALESCE(duration_seconds, 0) — a NULL-duration outgoing call is not
--     evidence that a conversation happened.
--
-- Apply with:
--   docker exec -i crm-postgres psql -U crm -d crm < migrations/043_missed_call_callback_tracking.sql

BEGIN;

-- ── 1. the configurable threshold ───────────────────────────────────────────
-- Same key/value shape as auto_assign_enabled (migration 014). Seeded to the
-- confirmed default of 15; ON CONFLICT DO NOTHING so re-running this file
-- never stomps a threshold an admin has since chosen.
INSERT INTO app_settings (key, value) VALUES ('callback_min_seconds', '15')
  ON CONFLICT (key) DO NOTHING;

-- ── 2. one row per phone number that has ever missed us ─────────────────────
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

-- ── 3. supporting index ─────────────────────────────────────────────────────
-- The view filters call_events by call_type and scans forward on occurred_at.
-- Trivial at 5 rows, but a synced device's call log runs to the hundreds and
-- this view is read on every page load.
CREATE INDEX IF NOT EXISTS idx_call_events_type_occurred
  ON call_events (call_type, occurred_at);

-- ── 4. runtime role access ──────────────────────────────────────────────────
-- Migration 037's ALTER DEFAULT PRIVILEGES already grants SELECT on future
-- tables and views to nidikumba_app — but ONLY for objects created by role
-- `crm`. Stated explicitly here so applying this file as any other role does
-- not silently leave the app unable to read the view. Guarded because the
-- role does not exist in every dev database.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nidikumba_app') THEN
    GRANT SELECT ON v_missed_call_callbacks TO nidikumba_app;
  END IF;
END
$$;

COMMIT;
