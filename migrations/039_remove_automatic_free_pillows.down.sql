-- Rollback 039: restore the per-product free-pillow count.
--
-- The original values cannot be recovered from the database (the column is
-- gone), so every product returns to the schema default of 0. The seed value
-- was 4 on each mattress and 0 on each pillow; restore that by hand if the old
-- behaviour is genuinely wanted:
--
--   UPDATE products SET free_pillows_included = 4 WHERE category = 'mattress';

DROP VIEW IF EXISTS products;
ALTER TABLE products_all ADD COLUMN IF NOT EXISTS free_pillows_included INTEGER DEFAULT 0;
CREATE VIEW products AS SELECT * FROM products_all WHERE deleted_at IS NULL;
CREATE TRIGGER trg_soft_delete INSTEAD OF DELETE ON products
  FOR EACH ROW EXECUTE FUNCTION soft_delete_view();
