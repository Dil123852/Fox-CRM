-- Rollback 041. DESTROYS every stored payment proof and invoice number.
DROP TABLE IF EXISTS payment_attachments;
DROP VIEW IF EXISTS orders;
ALTER TABLE orders_all
  DROP COLUMN IF EXISTS tax_invoice_no,
  DROP COLUMN IF EXISTS paid_marked_by,
  DROP COLUMN IF EXISTS paid_marked_at;
CREATE VIEW orders AS SELECT * FROM orders_all WHERE deleted_at IS NULL;
CREATE TRIGGER trg_soft_delete INSTEAD OF DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION soft_delete_view();
