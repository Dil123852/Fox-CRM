-- 047: index the call log's paging sort
--
-- GET /api/calls became paginated and filtered server-side. Every page it
-- serves ends in the same
--
--   ORDER BY ce.occurred_at DESC NULLS LAST, ce.id DESC
--
-- and call_events had no index on occurred_at at all — only customer_id,
-- dedup_key, and (call_type, occurred_at). So each page was a full scan plus a
-- sort of the entire table, which is fine at 500 rows and steadily less fine
-- as a lifetime call log accumulates.
--
-- The trailing `id DESC` is part of the index because it is part of the sort:
-- occurred_at is not unique (a synced batch can carry several calls with the
-- same timestamp), and without a tiebreak Postgres may order equal rows
-- differently between two queries — which, under LIMIT/OFFSET, means a row
-- appearing on two pages or on none. The index makes that deterministic order
-- the cheap one.
--
-- NULLS LAST matches the query. occurred_at is nullable, and the default for
-- DESC is NULLS FIRST, so an index without this clause would not satisfy the
-- ORDER BY and would be ignored.
--
-- CONCURRENTLY is deliberately NOT used: it cannot run inside the transaction
-- this project's migrations execute in. The table is small enough that a brief
-- lock is not a problem, and the call tracker retries a failed sync anyway.

CREATE INDEX IF NOT EXISTS idx_call_events_occurred_at_id
  ON call_events (occurred_at DESC NULLS LAST, id DESC);

COMMENT ON INDEX idx_call_events_occurred_at_id IS
  'Backs the paged call log (GET /api/calls). Column order and NULLS LAST must match that query''s ORDER BY exactly, or it will not be used.';
