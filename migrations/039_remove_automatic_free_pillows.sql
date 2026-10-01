-- 039: free products are chosen per order, not implied by the catalog
--
-- Confirmed with the user: the free-pillow offer is negotiated with each
-- customer, so it cannot live on the product row. Staff now pick the giveaway
-- in the Free Product section on every order screen, and it is stored as a
-- real order item carrying a NEGATIVE unit_price and free: true.
--
-- What this replaces:
--   * products.free_pillows_included — a per-product count that only ever fed
--     a line in the AI catalog prompt and a field in the Inventory form. It
--     never reached an order, so nothing about existing orders changes.
--   * the server-side rule in GET /api/orders/:id/invoice that counted
--     mattresses and synthesised "4 free pillows at LKR 1,700". That figure
--     appeared on no order record — the invoice invented it at render time,
--     which is exactly why it could not be negotiated. Removed in the same
--     change as this migration.
--
-- Deliberately NOT dropped: nothing else. orders.items is jsonb, so storing a
-- free line needs no schema change at all, and both order triggers read only
-- name and qty — verified against the live trigger, where a free Bolster x4
-- correctly reserved 4 units. A giveaway really does reduce stock.

-- products is a VIEW since migration 036 (soft deletes), so the column has to
-- be dropped from the base table and the view rebuilt over it. The view is a
-- plain SELECT * filter, so recreating it is exactly what 036 created.
DROP VIEW IF EXISTS products;
ALTER TABLE products_all DROP COLUMN IF EXISTS free_pillows_included;
CREATE VIEW products AS SELECT * FROM products_all WHERE deleted_at IS NULL;

-- 036 also put an INSTEAD OF DELETE trigger on the view so a delete becomes a
-- soft delete. Dropping the view dropped that trigger with it, so it must be
-- put back or deletes would start destroying rows again.
CREATE TRIGGER trg_soft_delete INSTEAD OF DELETE ON products
  FOR EACH ROW EXECUTE FUNCTION soft_delete_view();

COMMENT ON VIEW products IS
  'Live products only; the real table is products_all. Note "deleted" is distinct from active=false: inactive means retired from the catalog but still real (the 3 historical products), deleted means removed by a user and restorable by an admin.';
