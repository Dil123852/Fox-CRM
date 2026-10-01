-- 026: Cash on Delivery as a delivery method
--
-- COD is a single real-world arrangement that spans both fields staff used to
-- set independently: the goods travel by delivery AND the money is collected in
-- cash at handover. Modelled as a fourth delivery_method value
-- ('cash_on_delivery') rather than a payment_method value, because it is the
-- delivery that carries the payment — a pickup can never be COD, while a COD
-- order is always a delivery.
--
-- Neither delivery_method nor payment_method has ever had a CHECK constraint,
-- so storing the new value needs no schema change. What this migration adds is
-- the invariant that keeps the two fields from contradicting each other: a COD
-- order must have payment_method='cash'. The dashboard forces this pairing in
-- the UI; the constraint makes it true for any other writer too (a direct
-- PATCH, a script, a future website order path).
--
-- Deliberately NOT constrained here: payment_status. A COD order is legitimately
-- 'pending' from placement until the driver hands it over, at which point the
-- existing delivered-requires-paid path (OrderDetailModal/OrderDeliveryPage's
-- confirm-delivery flow, plus orders_delivered_requires_paid) already flips it
-- to 'paid'. COD needs no new payment mechanics — it needs the two existing
-- fields to be shown and set as one thing.

BEGIN;

-- Backfill first: any pre-existing row that already represents COD in the old
-- two-field way (delivery + cash) is left exactly as it is — this migration
-- does not reinterpret historical orders, since 'delivery' + 'cash' genuinely
-- also meant "pay cash at the showroom before we deliver" for some of them.
-- Only the constraint below is new.
ALTER TABLE orders
  ADD CONSTRAINT orders_cod_requires_cash_payment CHECK (
    delivery_method <> 'cash_on_delivery' OR payment_method = 'cash'
  );

COMMENT ON COLUMN orders.delivery_method IS
  'pickup | delivery | courier | cash_on_delivery. cash_on_delivery is a delivery whose payment is collected in cash at handover — it implies payment_method=''cash'' (enforced by orders_cod_requires_cash_payment) and leaves payment_status ''pending'' until the delivery is confirmed.';

COMMIT;
