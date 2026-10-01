-- 036: soft deletes — nothing is ever really removed
--
-- Confirmed with the user: every delete in this system must be a soft delete,
-- and an admin must be able to see and restore what was deleted.
--
-- HOW, AND WHY THIS WAY: whatsapp-backend/index.js runs 164 raw pool.query()
-- calls, ~110 of them SELECTs, in one 4,000-line file with no database wrapper
-- to hook. Adding "AND deleted_at IS NULL" by hand to each would be slow and,
-- far worse, a single missed query silently leaks deleted records back into the
-- UI — the kind of bug nobody notices until a customer sees a cancelled order.
--
-- So the filtering is done in the DATABASE. Each affected table is renamed to
-- <name>_all and a VIEW with the ORIGINAL name is created over it, filtering out
-- soft-deleted rows. Postgres auto-updatable views pass INSERT/UPDATE/DELETE
-- straight through to the base table, so:
--
--   * every existing SELECT keeps working AND becomes soft-delete-aware with no
--     code change at all;
--   * every existing INSERT/UPDATE keeps working unchanged;
--   * the app's own triggers (stock reservation, payment recompute, warranty
--     creation) keep working — verified on the real tables before writing this:
--     an `UPDATE products SET reserved_quantity=... WHERE name=...` through the
--     view updates the real row.
--
-- Foreign keys and triggers follow the table through the rename (they are
-- attached to the relation, not the name), so warranties/orders/service tickets
-- still reference a soft-deleted product correctly rather than breaking. That
-- is deliberate: history must keep resolving even after a delete.
--
-- Tables covered are exactly the five with a DELETE route, plus leads and
-- customers (deletable in the admin UI and both parents of business history).

-- ── 1. The columns ───────────────────────────────────────────────────────────
-- deleted_by is not a foreign key for the same reason activity_log.staff_id is
-- not: the record of who deleted something must outlive their staff account.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'orders', 'order_payments', 'products', 'promo_codes', 'lead_items',
    'leads', 'customers'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS deleted_by UUID', t);
    -- Partial index: the views below filter on deleted_at IS NULL on every
    -- read, and only a small minority of rows are ever deleted.
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_%s_not_deleted ON %I (deleted_at) WHERE deleted_at IS NULL', t, t);
  END LOOP;
END $$;

-- ── 2. Rename each table and put a filtering view in its place ───────────────
-- Guarded by to_regclass so re-running the migration is safe: if <t>_all already
-- exists the swap has been done and is skipped.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'orders', 'order_payments', 'products', 'promo_codes', 'lead_items',
    'leads', 'customers'
  ] LOOP
    IF to_regclass(t || '_all') IS NULL THEN
      EXECUTE format('ALTER TABLE %I RENAME TO %I', t, t || '_all');
      EXECUTE format(
        'CREATE VIEW %I AS SELECT * FROM %I WHERE deleted_at IS NULL', t, t || '_all');
    END IF;
  END LOOP;
END $$;

COMMENT ON VIEW orders IS
  'Live orders only. The real table is orders_all, which also holds soft-deleted rows (deleted_at IS NOT NULL). Query orders_all directly only to show or restore deleted records.';
COMMENT ON VIEW products IS
  'Live products only; the real table is products_all. Note "deleted" is distinct from active=false: inactive means retired from the catalog but still real (the 3 historical products), deleted means removed by a user and restorable by an admin.';

-- ── 3. A DELETE through the view becomes a soft delete ───────────────────────
-- Everything else about the views is auto-updatable, but a real DELETE would
-- still hard-delete from the base table. This turns it into an UPDATE, so even
-- a route that was overlooked, or a hand-typed DELETE, cannot destroy data.
--
-- An INSTEAD OF TRIGGER rather than a RULE, and the difference is not cosmetic:
-- a rule reports rowCount 0 for a delete that actually succeeded, which is
-- indistinguishable from "not found" — measured against the real driver, and it
-- would have made every existing DELETE route return a false 404. The trigger
-- reports 1 for a row it soft-deleted and 0 for one that was not there, so all
-- five DELETE routes keep working with no code change.
--
-- The actor comes from the same app.staff_id Express sets for the audit log.
CREATE OR REPLACE FUNCTION soft_delete_view() RETURNS TRIGGER AS $fn$
BEGIN
  EXECUTE format(
    'UPDATE %I SET deleted_at = NOW(),'
    '              deleted_by = NULLIF(current_setting(''app.staff_id'', true), '''')::UUID'
    ' WHERE id = $1 AND deleted_at IS NULL',
    TG_TABLE_NAME || '_all'
  ) USING OLD.id;
  RETURN OLD;
END;
$fn$ LANGUAGE plpgsql;

COMMENT ON FUNCTION soft_delete_view() IS
  'INSTEAD OF DELETE on each soft-deletable view: marks the base row deleted instead of removing it, recording who from app.staff_id.';

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'orders', 'order_payments', 'products', 'promo_codes', 'lead_items',
    'leads', 'customers'
  ] LOOP
    -- Drop the rule form in case an earlier revision of this migration ran.
    EXECUTE format('DROP RULE IF EXISTS %I ON %I', t || '_soft_delete', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_soft_delete ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_soft_delete INSTEAD OF DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION soft_delete_view()', t);
  END LOOP;
END $$;

-- ── 4. Audit the real tables, not the views ──────────────────────────────────
-- Migration 035 attached trg_activity_log to these relations by name. The rename
-- carried each trigger to <t>_all, which is what we want (it sees every write,
-- including soft deletes). Re-assert it so a fresh database built by applying
-- 035 then 036 ends up identical to one where 036 ran second.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'orders', 'order_payments', 'products', 'promo_codes', 'lead_items',
    'leads', 'customers'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_activity_log ON %I', t || '_all');
    EXECUTE format(
      'CREATE TRIGGER trg_activity_log AFTER INSERT OR UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION log_activity()', t || '_all');
  END LOOP;
END $$;
