-- 036: security audit log
--
-- The 2026-09-10 audit found nothing recorded authentication failures,
-- authorization denials or admin actions. Verified: zero console calls at the
-- 401/403 returns, and no audit table anywhere (REQ-4.7/4.8's
-- staff_activity_log was never built). So an attacker holding a forged or
-- stolen token could read the entire customer database and leave no trace —
-- which also makes any breach-notification assessment impossible, since
-- there is no way to establish what was accessed.
--
-- Deliberately append-only and deliberately NOT foreign-keyed to
-- staff_users: the most interesting rows are the ones where the actor is
-- unknown (an unauthenticated request), or where the account was later
-- deleted. An FK would either reject those rows or let a deletion cascade
-- away the evidence. staff_id is stored as a plain uuid and staff_phone as
-- text, so the record survives the account.
--
-- No PII beyond the actor: `detail` is for identifiers and outcomes, never
-- request bodies, and never a password or token. See the redaction in
-- recordAuditEvent().

CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL PRIMARY KEY,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- What happened. Free text rather than an enum so a new event type never
  -- needs a migration; the application supplies a stable vocabulary
  -- (login.success, login.failure, login.locked, authz.denied, staff.role_change,
  -- staff.password_reset, record.delete, bulk.send).
  event        TEXT NOT NULL,

  -- Who. NULL actor = unauthenticated request.
  staff_id     UUID,
  staff_phone  TEXT,
  staff_role   TEXT,

  -- Where from.
  ip           TEXT,
  method       TEXT,
  path         TEXT,

  -- Structured extras: target id, denied role, reason. Never a request body.
  detail       JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- The three real query patterns: recent activity, one account's history, and
-- "all failures of this kind".
CREATE INDEX IF NOT EXISTS idx_audit_log_occurred_at ON audit_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_staff_id ON audit_log (staff_id, occurred_at DESC) WHERE staff_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_event ON audit_log (event, occurred_at DESC);

COMMENT ON TABLE audit_log IS
  'Append-only security event log. No FK to staff_users on purpose: rows for unauthenticated or since-deleted actors must survive.';
COMMENT ON COLUMN audit_log.detail IS
  'Structured context (target id, reason). Never request bodies, passwords or tokens.';
