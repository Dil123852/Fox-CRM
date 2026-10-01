-- Down migration for 058_per_agent_visibility.sql
--
-- DESTRUCTIVE for the new data: every order's placed_by is dropped and cannot
-- be reconstructed afterwards. Back up first if it matters.
--
-- The callbacks view goes back to 051's one-row-per-number definition
-- (verbatim below). Its columns are unchanged, so CREATE OR REPLACE works.

BEGIN;

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

COMMENT ON VIEW v_missed_call_callbacks IS
  'One row per phone number that has ever missed us. done = a qualifying OUTGOING call (longer than app_settings.callback_min_seconds) exists strictly after that number''s LATEST missed call. A new miss returns the row to pending. missed_on_* / called_back_by_* name whose phone (migration 051); NULL for calls synced before 051.';

-- View first, then its column (see 046's down for why).
DROP VIEW IF EXISTS orders;

DROP INDEX IF EXISTS idx_orders_all_placed_by;
ALTER TABLE orders_all DROP COLUMN IF EXISTS placed_by;

CREATE VIEW orders AS SELECT * FROM orders_all WHERE deleted_at IS NULL;
CREATE TRIGGER trg_soft_delete INSTEAD OF DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION soft_delete_view();
COMMENT ON VIEW orders IS
  'Live orders only. The real table is orders_all, which also holds soft-deleted rows (deleted_at IS NOT NULL). Query orders_all directly only to show or restore deleted records.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nidikumba_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON orders TO nidikumba_app';
  END IF;
END $$;

COMMIT;
