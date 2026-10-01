-- 040: a second contact number, required on every new order
--
-- Confirmed with the user: every order must carry an additional contact number
-- and it is not optional. In practice this is the person who will actually
-- take the delivery, or someone to call when the main number does not answer —
-- so it belongs on the ORDER, not the customer: the same customer can give a
-- different second number for each order.
--
-- WHY NOT customers.contact_whatsapp_number: that column (migration 027) is a
-- different thing. It exists because a call-originated customer's calling
-- number is often a landline, so staff record a reachable WhatsApp number for
-- MESSAGING them, once, on the customer. It is per-customer and feeds
-- whatsappTarget(); this one is per-order and is for the delivery contact.
-- Overloading either would break the other.
--
-- NOT NULL is deliberately NOT applied to the column. The 13 existing orders
-- predate the rule and have no value to backfill, and inventing one (copying
-- customer_phone) would fabricate a second contact that nobody gave. The
-- requirement is enforced where new orders are created — POST /api/orders
-- rejects a missing value, and all four order screens block submit — so
-- history stays honest while every new order carries the number.

ALTER TABLE orders_all
  ADD COLUMN IF NOT EXISTS secondary_phone TEXT;

COMMENT ON COLUMN orders_all.secondary_phone IS
  'Additional contact number for this order (delivery contact / backup if the main number does not answer). Required on new orders by POST /api/orders; NULL on orders placed before migration 040. Canonical 94XXXXXXXXX, normalized by normalizePhone() on write.';

-- Same canonical format the rest of the system enforces (migration 030), so a
-- second number cannot drift into a shape the messaging path cannot dial.
-- Allows NULL for the pre-existing rows.
ALTER TABLE orders_all
  DROP CONSTRAINT IF EXISTS orders_secondary_phone_canonical;
ALTER TABLE orders_all
  ADD CONSTRAINT orders_secondary_phone_canonical
  CHECK (secondary_phone IS NULL OR secondary_phone ~ '^94[0-9]{9}$');

-- orders is a VIEW (migration 036), and a view does not pick up a new column on
-- its base table, so it has to be rebuilt or the column is invisible to every
-- query in the app. Dropping the view also drops its INSTEAD OF DELETE trigger,
-- which is what makes a delete soft — it is recreated below.
DROP VIEW IF EXISTS orders;
CREATE VIEW orders AS SELECT * FROM orders_all WHERE deleted_at IS NULL;

CREATE TRIGGER trg_soft_delete INSTEAD OF DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION soft_delete_view();

COMMENT ON VIEW orders IS
  'Live orders only. The real table is orders_all, which also holds soft-deleted rows (deleted_at IS NOT NULL). Query orders_all directly only to show or restore deleted records.';
