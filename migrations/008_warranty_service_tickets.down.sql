-- Rollback for 008_warranty_service_tickets.sql
-- Apply in reverse migration order: after 009's .down.sql.
DROP TRIGGER IF EXISTS trg_new_service_ticket ON service_tickets;
DROP FUNCTION IF EXISTS handle_new_service_ticket();
DROP TABLE IF EXISTS service_tickets;

DROP TRIGGER IF EXISTS trg_order_completed_warranty ON orders;
DROP FUNCTION IF EXISTS handle_order_completed_warranty();
DROP VIEW IF EXISTS v_warranty_status;
DROP TABLE IF EXISTS warranties;
DROP SEQUENCE IF EXISTS warranty_number_seq;

ALTER TABLE products DROP COLUMN IF EXISTS warranty_years;
