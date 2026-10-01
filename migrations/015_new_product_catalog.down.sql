-- Rollback for 015_new_product_catalog.sql — removes the 4 new products,
-- restores the old 3 to active, restores the renamed Ayu Spring's original
-- name, and drops the pillow_top_addon_price column.
-- Will orphan any orders/warranties placed against the new 4 products in the
-- meantime (their product_id FKs would dangle) — check for those before
-- rolling back for real, this isn't a no-op once new orders exist.

DELETE FROM products WHERE name IN ('Ayu Sleep 6', 'Nidikumba Rise', 'Nidikumba Signature', 'Nidikumba Ayu Spring');

UPDATE products SET active = true
  WHERE name IN ('Bonnel Spring', 'Nidikumba Ayu Hardback');
UPDATE products SET active = true, name = 'Nidikumba Ayu Spring'
  WHERE name = 'Nidikumba Ayu Spring (Discontinued)';

ALTER TABLE products DROP COLUMN IF EXISTS pillow_top_addon_price;
