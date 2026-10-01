-- Rollback 036: restore real tables in place of the views.
--
-- Soft-deleted rows become VISIBLE again when the filtering view is removed,
-- because the data was never destroyed. Decide what to do with them BEFORE
-- rolling back — to discard them instead, run this first:
--
--   DELETE FROM orders_all WHERE deleted_at IS NOT NULL;   -- and each table
--
-- The deleted_at/deleted_by columns are kept, not dropped: they are harmless,
-- and dropping them would destroy the record of what had been deleted.

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'orders', 'order_payments', 'products', 'promo_codes', 'lead_items',
    'leads', 'customers'
  ] LOOP
    IF to_regclass(t || '_all') IS NOT NULL THEN
      -- The INSTEAD OF trigger lives on the view; dropping the view takes it.
      EXECUTE format('DROP VIEW IF EXISTS %I', t);
      EXECUTE format('ALTER TABLE %I RENAME TO %I', t || '_all', t);
    END IF;
  END LOOP;
END $$;

-- Re-point the audit triggers at the restored table names (they followed the
-- relation through the rename, so this only re-asserts the expected state).
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'orders', 'order_payments', 'products', 'promo_codes', 'lead_items',
    'leads', 'customers'
  ] LOOP
    IF to_regclass('log_activity()') IS NOT NULL OR EXISTS (SELECT 1 FROM pg_proc WHERE proname='log_activity') THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_activity_log ON %I', t);
      EXECUTE format(
        'CREATE TRIGGER trg_activity_log AFTER INSERT OR UPDATE OR DELETE ON %I
           FOR EACH ROW EXECUTE FUNCTION log_activity()', t);
    END IF;
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS soft_delete_view();
