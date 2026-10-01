-- 048: index the Pipeline's paging sort
--
-- Same class of fix as 047, on the page that matters most. GET /api/leads is
-- paginated and filtered server-side, and every page it serves for the default
-- sort ends in
--
--   ORDER BY l.created_at DESC NULLS LAST, l.id DESC
--
-- leads_all had an index on created_at (idx_leads_created_at) but nothing that
-- matched this ORDER BY, so Postgres could not use it: the sort is DESC with
-- NULLS LAST and carries an `id DESC` tiebreak, and the rows are filtered by
-- `ticket_state='open' AND deleted_at IS NULL`.
--
-- The consequence measured on a production-sized clone (5,394 open leads,
-- 40k messages): the planner read EVERY open lead, joined customers,
-- staff_users and v_lead_sla_status across all of them, ran the two correlated
-- subqueries, and only THEN top-N heapsorted down to the 20 rows on screen.
-- One page of 20 cost 1,280 ms, and the cost scaled with the number of open
-- leads rather than with the page size — so the Pipeline got steadily slower
-- purely by taking on business. With this index the same query is 5 ms.
--
-- PARTIAL, on exactly the rows the Pipeline reads. `ticket_state='open'` is
-- the route's default and the overwhelming majority of its traffic, and
-- `deleted_at IS NULL` is what the leads view itself applies (036). Keeping
-- both in the predicate makes the index dramatically smaller than the table
-- and lets the index scan satisfy the filter without rechecking the heap.
--
-- The trailing `id DESC` is part of the index because it is part of the sort:
-- created_at is not unique (a call sync opens several tickets in the same
-- instant), and without a tiebreak equal rows can order differently between
-- two queries — under LIMIT/OFFSET that means a lead appearing on two pages or
-- on none. Same reasoning as 047.
--
-- NULLS LAST matches the query for the same reason as 047: DESC defaults to
-- NULLS FIRST, so an index without this clause would not satisfy the ORDER BY
-- and would simply be ignored.
--
-- Only the DEFAULT sort is indexed. The other four (name, followup, status,
-- priority) sort on expressions — lower(c.name), a COALESCE across six date
-- columns, array_position(...) — which cannot share this index and are not
-- what the page loads on. This index covers the sort staff actually arrive on.
--
-- CONCURRENTLY is deliberately NOT used: it cannot run inside the transaction
-- this project's migrations execute in, and it is a read-path index — a brief
-- lock costs nothing that a retry does not cover.

CREATE INDEX IF NOT EXISTS idx_leads_open_created_at_id
  ON leads_all (created_at DESC NULLS LAST, id DESC)
  WHERE deleted_at IS NULL AND ticket_state = 'open';

COMMENT ON INDEX idx_leads_open_created_at_id IS
  'Backs the paged Pipeline (GET /api/leads, default sort). Column order, NULLS LAST and the partial WHERE must match that query exactly, or it will not be used.';
