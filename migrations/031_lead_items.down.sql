-- Revert 031. The leads row keeps whatever the sync trigger last mirrored
-- onto it (item 0), so no lead is left without its original product — but
-- any SECOND-or-later product is real data that only exists in lead_items
-- and will be lost. Back up first if any lead has more than one item:
--   SELECT lead_id, count(*) FROM lead_items GROUP BY 1 HAVING count(*) > 1;
BEGIN;
DROP VIEW IF EXISTS v_lead_items_summary;
DROP TRIGGER IF EXISTS trg_lead_items_sync ON lead_items;
DROP FUNCTION IF EXISTS sync_lead_first_item();
DROP TABLE IF EXISTS lead_items;
COMMIT;
