-- 058 — each sales agent sees their own orders and missed calls
--
-- ORDERS. Nothing recorded who placed an order, so there was nothing to
-- scope a sales agent's order list by and nothing to show an admin. New
-- orders_all.placed_by is set server-side by POST /api/orders from the
-- logged-in staff member (never from the request body).
--
-- NO BACKFILL (confirmed with the user). Existing orders stay NULL and read
-- as "Unknown". A sales agent still sees an old order when it came from a lead
-- assigned to them (orders.lead_id -> leads.assigned_staff_id); admins always
-- see every order.
--
-- ON DELETE SET NULL: an order is history. Deleting a staff account must not
-- delete, or block deleting, the orders they placed.
--
-- CALLBACKS. v_missed_call_callbacks was one row per phone NUMBER across all
-- agents, so every agent saw every miss. It is now one row per (agent whose
-- phone missed it, number). A row is still DONE when ANY agent returns the
-- call (a customer rung back by a colleague has been rung back), and
-- called_back_by_* says who. Misses synced before 051 have no staff_id and
-- form their own group (missed_on_staff_id NULL), shown to admins only.
-- A number missed on two agents' phones is now two rows — one per agent's
-- list — which is the point.
--
-- Column list and order of the view are unchanged, so CREATE OR REPLACE works.
--
-- orders is a VIEW over orders_all (036): rebuilt to pick up the column, and
-- its trg_soft_delete INSTEAD OF trigger recreated (same sequence as 057) —
-- without it every delete would become a hard delete.

BEGIN;

ALTER TABLE orders_all
  ADD COLUMN IF NOT EXISTS placed_by UUID REFERENCES staff_users(id) ON DELETE SET NULL;

-- "This agent's orders, newest first".
CREATE INDEX IF NOT EXISTS idx_orders_all_placed_by
  ON orders_all (placed_by, created_at DESC)
  WHERE placed_by IS NOT NULL;

COMMENT ON COLUMN orders_all.placed_by IS
  'Staff member who placed the order (058), set by POST /api/orders from the login. NULL for orders placed before 058.';

DROP VIEW IF EXISTS orders;
CREATE VIEW orders AS SELECT * FROM orders_all WHERE deleted_at IS NULL;
DROP TRIGGER IF EXISTS trg_soft_delete ON orders;
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

-- ── Callbacks per agent ─────────────────────────────────────────────────────
-- Identical to 051's definition except: missed groups by (staff_id,
-- phone_canon), the "latest miss" lateral is that agent's latest miss, and
-- missed_on_staff_id is the group's own staff_id. The callback lateral is
-- unchanged: any agent's qualifying OUTGOING call after THIS agent's latest
-- miss closes the row.
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
    staff_id,
    phone_canon,
    COUNT(*)          AS missed_count,
    MAX(occurred_at)  AS latest_missed_at,
    MIN(occurred_at)  AS first_missed_at
  FROM ev
  WHERE call_type = 'MISSED'
  GROUP BY staff_id, phone_canon
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
  m.staff_id      AS missed_on_staff_id,
  ms.name         AS missed_on_staff_name,
  cb.staff_id     AS called_back_by_staff_id,
  cbs.name        AS called_back_by_name
FROM missed m
CROSS JOIN threshold t
LEFT JOIN LATERAL (
  SELECT e.customer_id, e.raw_phone_number, e.contact_name
  FROM ev e
  WHERE e.phone_canon = m.phone_canon
    AND e.staff_id IS NOT DISTINCT FROM m.staff_id
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
LEFT JOIN staff_users ms  ON ms.id  = m.staff_id
LEFT JOIN staff_users cbs ON cbs.id = cb.staff_id;

COMMENT ON VIEW v_missed_call_callbacks IS
  'One row per (agent whose phone missed it, phone number) (058). done = a qualifying OUTGOING call by ANY agent (longer than app_settings.callback_min_seconds) exists strictly after that agent''s LATEST miss of the number. A new miss returns the row to pending. missed_on_staff_id NULL = misses synced before 051.';

COMMIT;
