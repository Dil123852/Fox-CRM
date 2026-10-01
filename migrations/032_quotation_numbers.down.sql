-- Revert 032. Quotation numbers already issued STAY on their leads — those
-- references have been given to customers and must not vanish. This only
-- removes the generator.
BEGIN;
DROP FUNCTION IF EXISTS assign_quotation_number(UUID);
DROP SEQUENCE IF EXISTS quotation_number_seq;
COMMENT ON COLUMN leads.quotation_no IS NULL;
COMMIT;
