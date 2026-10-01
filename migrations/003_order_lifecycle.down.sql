-- Rollback for 003_order_lifecycle.sql
-- Apply in reverse migration order: after 009..004's .down.sql.
DROP TRIGGER IF EXISTS trg_order_stock_reservation ON orders;
DROP FUNCTION IF EXISTS handle_order_stock_reservation();

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_delivered_requires_confirmation_note;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_delivery_scheduling_requires_shipped;
ALTER TABLE orders DROP COLUMN IF EXISTS delivery_time_slot;
ALTER TABLE orders DROP COLUMN IF EXISTS delivery_driver;
ALTER TABLE orders DROP COLUMN IF EXISTS delivery_confirmation_note;

ALTER TABLE products DROP COLUMN IF EXISTS stock_quantity;
ALTER TABLE products DROP COLUMN IF EXISTS reserved_quantity;
ALTER TABLE products DROP COLUMN IF EXISTS reorder_threshold;
