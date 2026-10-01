-- Revert 048. Dropping the index only makes the paged Pipeline slower; it
-- never changes which leads that query returns or in what order, so this is
-- safe to run at any time.

DROP INDEX IF EXISTS idx_leads_open_created_at_id;
