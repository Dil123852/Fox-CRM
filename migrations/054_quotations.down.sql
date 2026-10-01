-- Down migration for 054_quotations.sql
--
-- Dropping the table permanently discards every quotation made on the
-- Quotations page. Refused while any exist, so a rollback cannot silently
-- delete documents customers have been given. quotation_number_seq is kept:
-- it belongs to 032, and resetting it would re-issue numbers already used.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.quotations') IS NOT NULL AND EXISTS (SELECT 1 FROM quotations) THEN
    RAISE EXCEPTION 'Refusing to roll back 054: quotations exist';
  END IF;
END $$;

ALTER TABLE staff_notifications DROP COLUMN IF EXISTS quotation_id;
DROP TABLE IF EXISTS quotations;

COMMIT;
