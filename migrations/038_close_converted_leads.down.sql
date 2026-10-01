-- Rollback 038: reopen the enquiries this closed and drop the links it made.
--
-- Only rows this migration actually touched are reverted: a ticket is reopened
-- only if its closed_reason is one this migration wrote, so an enquiry a human
-- closed for their own reason is left closed.

UPDATE leads
   SET ticket_state = 'open',
       closed_at = NULL,
       closed_reason = NULL,
       updated_at = NOW()
 WHERE status = 'won'
   AND ticket_state = 'closed'
   AND (closed_reason LIKE 'Converted to order %'
        OR closed_reason = 'Won — converted to an order before enquiries were closed automatically');

-- Unlink only the pairings the backfill could have created (one won lead and
-- one order for that customer). An orders.lead_id written by the application
-- after this migration ran is left in place.
UPDATE orders o
   SET lead_id = NULL
  FROM leads l
 WHERE o.lead_id = l.id
   AND l.status = 'won'
   AND (SELECT count(*) FROM leads x WHERE x.customer_id = o.customer_id AND x.status = 'won') = 1
   AND (SELECT count(*) FROM orders y WHERE y.customer_id = o.customer_id) = 1;
