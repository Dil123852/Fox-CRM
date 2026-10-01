-- 041: evidence for marking an order paid, and proof for an advance
--
-- Two requirements, confirmed with the user:
--
--   1. A sales_agent may now set payment_status='paid' (today only admin and
--      finance can), but ONLY with a Tax Invoice number. The invoice number is
--      the evidence — the number written in the real invoice book — so it is
--      required for every transition into 'paid', by anyone.
--
--   2. An advance must be able to carry a payment proof (a bank slip photo,
--      a receipt), attached to the ledger row it belongs to.
--
-- WHY THE BYTES LIVE IN POSTGRES: this backend stores no files anywhere today
-- and has no volume mounted for them. A proof that exists only on the VM's disk
-- is absent from pg_dump, so restoring a backup would bring back the payment
-- row with a dead link to the evidence for it — exactly when the evidence
-- matters. Storing it as bytea keeps proof and payment in one backup and one
-- transaction. Confirmed with the user.

ALTER TABLE orders_all
  ADD COLUMN IF NOT EXISTS tax_invoice_no TEXT,
  ADD COLUMN IF NOT EXISTS paid_marked_by UUID,
  ADD COLUMN IF NOT EXISTS paid_marked_at TIMESTAMPTZ;

COMMENT ON COLUMN orders_all.tax_invoice_no IS
  'The Tax Invoice number evidencing full payment. Required by PATCH /api/orders/:id for any transition into payment_status=''paid''. NULL on orders paid before migration 041.';
COMMENT ON COLUMN orders_all.paid_marked_by IS
  'Staff member who marked the order paid. Not a foreign key, for the same reason activity_log.staff_id is not: the record must outlive the account.';

-- Attachments hang off the LEDGER row, not the order: an order can take several
-- advances and each has its own slip. order_id is denormalised alongside so the
-- order screen can list every proof for an order in one query.
CREATE TABLE IF NOT EXISTS payment_attachments (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- References the BASE table: order_payments is a view (migration 036) and a
  -- view cannot be a foreign-key target. Caught by dry-running this migration
  -- against a clone rather than in production.
  payment_id    UUID        REFERENCES order_payments_all(id) ON DELETE CASCADE,
  order_id      UUID        NOT NULL,
  filename      TEXT        NOT NULL,
  mime_type     TEXT        NOT NULL,
  byte_size     INTEGER     NOT NULL,
  -- The file itself. 4MB ceiling: the API's JSON body limit is 5MB and a
  -- base64 payload is ~33% larger than the file, so anything above this could
  -- not have been uploaded through the route in the first place.
  bytes         BYTEA       NOT NULL,
  uploaded_by   UUID,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_attachments_size CHECK (byte_size > 0 AND byte_size <= 4194304),
  -- Only what a bank slip or receipt actually is. Blocks a document that would
  -- execute if someone later served these files inline.
  CONSTRAINT payment_attachments_type CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf'))
);

COMMENT ON TABLE payment_attachments IS
  'Payment proof (bank slip, receipt) for an order_payments row. Bytes stored in Postgres so the evidence is captured by the same pg_dump as the payment it proves.';

CREATE INDEX IF NOT EXISTS idx_payment_attachments_order   ON payment_attachments (order_id);
CREATE INDEX IF NOT EXISTS idx_payment_attachments_payment ON payment_attachments (payment_id);

-- orders is a VIEW (migration 036) and does not pick up new base-table columns,
-- so it is rebuilt. Dropping it also drops the INSTEAD OF trigger that makes a
-- delete soft, which is recreated below.
DROP VIEW IF EXISTS orders;
CREATE VIEW orders AS SELECT * FROM orders_all WHERE deleted_at IS NULL;

CREATE TRIGGER trg_soft_delete INSTEAD OF DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION soft_delete_view();

COMMENT ON VIEW orders IS
  'Live orders only. The real table is orders_all, which also holds soft-deleted rows (deleted_at IS NOT NULL). Query orders_all directly only to show or restore deleted records.';
