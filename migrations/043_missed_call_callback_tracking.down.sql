-- Rollback 043: remove the missed-call callback tracker.
--
-- The view is computed live and holds no data of its own, so dropping it loses
-- nothing — every fact it reported still lives in call_events.
--
-- The app_settings row IS removed. It exists only for this feature, and leaving
-- an orphaned key behind would make a later re-apply silently inherit a stale
-- threshold through 043's `ON CONFLICT DO NOTHING` seed, so a reinstalled
-- feature would come back configured to whatever someone set months earlier
-- rather than the documented default of 15. NOTE: this does lose an admin's
-- chosen value — back up first if that matters.
--
-- Apply with:
--   docker exec -i crm-postgres psql -U crm -d crm < migrations/043_missed_call_callback_tracking.down.sql

BEGIN;

DROP VIEW IF EXISTS v_missed_call_callbacks;

DROP INDEX IF EXISTS idx_call_events_type_occurred;

DELETE FROM app_settings WHERE key = 'callback_min_seconds';

COMMIT;
