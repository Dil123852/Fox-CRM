-- 045: the super_admin role, and session tracking for "active hours"
--
-- Confirmed with the user: a seventh role that can see and do everything,
-- with delete recovery, edit attribution, user activity and active hours.
--
-- MOST OF WHAT THAT NEEDS ALREADY EXISTS AND IS SIMPLY UNREACHABLE. Migration
-- 035 added activity_log (every write attributed, with a before/after diff),
-- 036 added soft deletes on seven tables plus audit_log. GET /api/activity,
-- GET /api/deleted/:table and POST /api/deleted/:table/:id/restore have all
-- been live since then with NO frontend consuming them. So this migration adds
-- only the two things genuinely missing: the role itself, and session records.
--
-- ── 1. The role ─────────────────────────────────────────────────────────────
-- staff_users.role is a CHECK, not an enum, so widening it is a drop + re-add.
-- The six existing values are preserved exactly; this is purely additive and
-- no existing row changes.

ALTER TABLE staff_users DROP CONSTRAINT IF EXISTS staff_users_role_check;
ALTER TABLE staff_users ADD CONSTRAINT staff_users_role_check CHECK (role IN (
  'super_admin',
  'admin', 'sales_agent', 'inventory_manager',
  'delivery_coordinator', 'finance', 'viewer'
));

COMMENT ON COLUMN staff_users.role IS
  'Six operational roles plus super_admin, which satisfies every requireRole() gate in the API and every route gate in the dashboard. super_admin is an oversight role: activity trail, deleted-record recovery and staff active hours. Restoring a deleted record is super_admin-only (it used to be admin).';

-- SEEDING THE FIRST ONE. Deliberately not done here and not possible from the
-- UI: only a super_admin may grant the role, so an admin promoting themselves
-- would defeat the point. Promote a real account by hand, once:
--
--   UPDATE staff_users SET role = 'super_admin' WHERE phone = '94XXXXXXXXX';
--
-- (The dashboard's User Management screen offers the role thereafter.)

-- ── 2. Sessions ─────────────────────────────────────────────────────────────
-- WHY A TABLE AND NOT A COLUMN: "active hours" needs a span, not a timestamp.
-- A last_login_at column can answer "when did they last sign in" but never
-- "how long were they working on Tuesday", which is what was asked for.
--
-- Note what already exists and is NOT duplicated: audit_log records a
-- 'login.success' row per sign-in (35 of them in the live database today), so
-- login TIMES are already history. What is missing is the END of a session,
-- which is why this table exists at all.
CREATE TABLE IF NOT EXISTS staff_sessions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Not a foreign key, for the same reason activity_log.staff_id is not: the
  -- record of who was working must outlive their staff account.
  staff_id     UUID        NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Advanced by a heartbeat on ordinary authenticated requests. This is what
  -- makes a session honest for someone who closes the tab instead of signing
  -- out -- by far the common case.
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set only by an explicit sign-out. A session that simply stops is left NULL
  -- and closed off by the view below, so the two cases stay distinguishable.
  ended_at     TIMESTAMPTZ,
  end_reason   TEXT CHECK (end_reason IS NULL OR end_reason IN ('logout', 'expired')),
  ip           TEXT,
  user_agent   TEXT
);

COMMENT ON TABLE staff_sessions IS
  'One row per sign-in. last_seen_at is advanced by a throttled heartbeat on authenticated requests; ended_at is set only by an explicit logout. A session with neither is closed off at last_seen_at by v_staff_active_hours.';

CREATE INDEX IF NOT EXISTS idx_staff_sessions_staff ON staff_sessions(staff_id, started_at DESC);
-- Supports the "is there a live session for this token" lookup the heartbeat
-- does on every request, which must not table-scan.
CREATE INDEX IF NOT EXISTS idx_staff_sessions_open ON staff_sessions(staff_id, last_seen_at DESC) WHERE ended_at IS NULL;

-- ── 3. Active hours ─────────────────────────────────────────────────────────
-- Computed LIVE on read, with no scheduler -- the same choice already made for
-- v_lead_sla_status, campaign eligibility and v_missed_call_callbacks. A
-- scheduler exists in this codebase (the follow-up promo) but it is for things
-- that must FIRE at a moment; nothing needs to fire here.
--
-- THE STALE-SESSION RULE: a session whose heartbeat stopped more than 30
-- minutes ago is treated as having ended at its last heartbeat. Without this a
-- forgotten tab would report an eight-hour day. 30 minutes is well clear of
-- the 5-minute heartbeat interval, so a brief network drop never truncates a
-- real session.
DROP VIEW IF EXISTS v_staff_active_hours;
CREATE VIEW v_staff_active_hours AS
WITH bounded AS (
  SELECT
    s.staff_id,
    s.started_at,
    -- The session's real end: an explicit logout, else the last heartbeat once
    -- it has gone stale, else now() for one that is genuinely still live.
    COALESCE(
      s.ended_at,
      CASE WHEN s.last_seen_at < now() - INTERVAL '30 minutes' THEN s.last_seen_at END,
      now()
    ) AS finished_at,
    s.ended_at IS NULL AND s.last_seen_at >= now() - INTERVAL '30 minutes' AS is_live
  FROM staff_sessions s
)
SELECT
  b.staff_id,
  st.name  AS staff_name,
  st.role  AS staff_role,
  -- Bucketed by LOCAL day, not UTC: a shift that runs past midnight UTC is
  -- still one working day to the person who worked it. Matches the DATE
  -- handling established in migration 018.
  (b.started_at AT TIME ZONE 'Asia/Colombo')::date AS day,
  COUNT(*)                                          AS session_count,
  MIN(b.started_at)                                 AS first_seen,
  MAX(b.finished_at)                                AS last_seen,
  -- Summed per session rather than last_seen - first_seen, so a lunch break
  -- between two sessions is not counted as time worked.
  ROUND(SUM(EXTRACT(EPOCH FROM (b.finished_at - b.started_at)))::numeric, 0) AS active_seconds,
  BOOL_OR(b.is_live)                                AS currently_online
FROM bounded b
LEFT JOIN staff_users st ON st.id = b.staff_id
GROUP BY b.staff_id, st.name, st.role, (b.started_at AT TIME ZONE 'Asia/Colombo')::date;

COMMENT ON VIEW v_staff_active_hours IS
  'Per staff member per local (Asia/Colombo) day: session count, first/last seen, total active seconds, and whether they are online now. Duration is summed per session so a gap between sessions is not counted as time worked. A session idle >30 min is closed off at its last heartbeat.';

-- Login history from BEFORE this migration. audit_log already holds a
-- 'login.success' row per sign-in, so exposing it here means the Users & hours
-- screen shows real history from day one instead of being empty until new
-- sessions accumulate. Kept separate from the view above because these rows
-- have no end time -- presenting them as sessions with a duration would be
-- inventing data.
-- THE staff_id COLUMN IS ALWAYS NULL ON THESE ROWS, and joining on it would
-- silently produce a column of dashes rather than an error. Verified against
-- the live data: all 37 login.success rows have staff_id IS NULL.
--
-- The reason is structural, not a bug: recordAuditEvent() fills staff_id from
-- req.staff, and POST /api/auth/login runs BEFORE the middleware that
-- populates it — there is no authenticated user yet at the moment a login is
-- recorded. The id is written into `detail` instead, which is why this view
-- reads detail->>'staffId' and falls back to the column for any other event.
--
-- staff_phone IS populated, so the phone is used as a second fallback for a
-- row whose account has since been deleted. Rows that still resolve to nobody
-- are logins by accounts that have since been removed — shown as blank rather
-- than hidden, because the sign-in did happen.
--
-- DROP before CREATE, not CREATE OR REPLACE: replacing a view cannot change
-- its column list, so on a database that already has an earlier version of
-- this view the REPLACE is silently ignored and the old definition survives.
-- That is exactly what happened while building this — the fix appeared to
-- apply cleanly and the data was unchanged.
DROP VIEW IF EXISTS v_staff_login_history;
CREATE VIEW v_staff_login_history AS
SELECT
  COALESCE((a.detail->>'staffId')::UUID, a.staff_id) AS staff_id,
  COALESCE(st.name, byphone.name)                    AS staff_name,
  COALESCE(st.role, byphone.role)                    AS staff_role,
  a.occurred_at,
  (a.occurred_at AT TIME ZONE 'Asia/Colombo')::date  AS day,
  a.ip,
  a.staff_phone,
  a.event
FROM audit_log a
LEFT JOIN staff_users st      ON st.id = COALESCE((a.detail->>'staffId')::UUID, a.staff_id)
LEFT JOIN staff_users byphone ON byphone.phone = a.staff_phone
WHERE a.event IN ('login.success', 'login.failure', 'login.locked', 'login.lockout_triggered');

COMMENT ON VIEW v_staff_login_history IS
  'Sign-in attempts from audit_log, including failures and lockouts. Pre-dates staff_sessions, so it is the only source of login history from before migration 045. Has no session end -- use v_staff_active_hours for durations.';
