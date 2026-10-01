-- 035: per-account login lockout
--
-- The 2026-09-10 security audit found that brute-force protection on
-- POST /api/auth/login was per-IP only (express-rate-limit, 10 attempts /
-- 15 min). There was no per-account counter, no lockout and no backoff, so a
-- distributed attacker got 10 guesses per IP per 15 minutes against a known
-- admin phone number, indefinitely, with nothing recorded against the
-- account itself. The same audit found POST /api/staff enforced no password
-- policy at all, which made weak passwords a realistic target.
--
-- Tracked on staff_users rather than in a separate attempts table: the only
-- questions this needs to answer are "how many consecutive failures" and "is
-- this account locked right now", both of which are per-account state, not
-- history. Real audit history is a separate concern (see 036).
--
-- failed_login_count resets to 0 on any successful login. locked_until is set
-- once the count crosses the threshold, and is compared against now() at
-- login time, so a lock expires on its own with no scheduler — the same
-- computed-on-read pattern this codebase already uses for SLA overdue and
-- campaign eligibility.

ALTER TABLE staff_users
  ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_failed_login_at TIMESTAMPTZ;

-- A negative count would be a bug, not a state worth representing.
ALTER TABLE staff_users
  ADD CONSTRAINT staff_users_failed_login_count_non_negative
  CHECK (failed_login_count >= 0);

-- Only locked accounts are ever looked up by this column.
CREATE INDEX IF NOT EXISTS idx_staff_users_locked_until
  ON staff_users (locked_until)
  WHERE locked_until IS NOT NULL;

COMMENT ON COLUMN staff_users.failed_login_count IS
  'Consecutive failed login attempts. Reset to 0 on success.';
COMMENT ON COLUMN staff_users.locked_until IS
  'When set and in the future, login is refused for this account regardless of password.';
