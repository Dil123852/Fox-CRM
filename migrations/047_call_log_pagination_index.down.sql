-- Revert 047. Dropping the index only makes the paged call log slower; it
-- never changes what that query returns, so this is safe to run at any time.

DROP INDEX IF EXISTS idx_call_events_occurred_at_id;
