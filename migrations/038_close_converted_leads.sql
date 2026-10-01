-- 038: take converted enquiries off the Pipeline, and link orders back to them
--
-- Confirmed with the user: once an enquiry becomes an order it should leave the
-- lead page, and a later call from that customer should start a fresh enquiry
-- while their order, warranty, staff and call history stays reachable.
--
-- Two problems in the live data this fixes:
--
--   1. orders.lead_id has existed since Phase 3 but NOTHING ever wrote to it —
--      all 12 live orders have it NULL. Without that link an order cannot show
--      which enquiry produced it and conversion reporting is impossible. The
--      API now sets it (POST /api/orders accepts leadId); this backfills what
--      can be established safely for the orders already in the database.
--
--   2. Four leads sit at status='won' with ticket_state='open', so they never
--      leave the Pipeline. Closing them is what removes them, because
--      GET /api/leads filters on ticket_state='open'. Nothing is deleted.
--
-- Closing the ticket is also what makes the reopen behaviour work:
-- getOrCreateOpenTicket() reuses a ticket only while it is open, so the
-- customer's next call or message creates a NEW enquiry rather than reviving a
-- finished sale. That function already behaves this way — it just never had a
-- closed ticket to step past.

-- ── 1. Link orders to their enquiry, ONLY where it is unambiguous ────────────
-- One won lead and one order for that customer means there is exactly one
-- possible pairing. Where a customer has several orders the correct pairing
-- cannot be known from the data (no timestamp rule is reliable: an order can be
-- placed days after the enquiry, and a customer can order twice from one
-- enquiry), so those are deliberately left NULL rather than guessed. Guessing
-- would put a wrong enquiry on a real order's history, which is worse than
-- showing none.
UPDATE orders o
   SET lead_id = l.id
  FROM leads l
 WHERE o.lead_id IS NULL
   AND l.customer_id = o.customer_id
   AND l.status = 'won'
   AND (SELECT count(*) FROM leads x WHERE x.customer_id = o.customer_id AND x.status = 'won') = 1
   AND (SELECT count(*) FROM orders y WHERE y.customer_id = o.customer_id) = 1;

-- ── 2. Close every won enquiry so the Pipeline shows only live work ──────────
-- closed_reason is required by PATCH /api/leads/:id's own validation, so it is
-- set here too rather than leaving these rows in a state the API would reject.
UPDATE leads
   SET ticket_state = 'closed',
       closed_at = COALESCE(closed_at, updated_at, NOW()),
       closed_reason = COALESCE(
         closed_reason,
         CASE
           WHEN EXISTS (SELECT 1 FROM orders o WHERE o.lead_id = leads.id)
             THEN 'Converted to order ' || (SELECT o.order_number FROM orders o WHERE o.lead_id = leads.id LIMIT 1)
           ELSE 'Won — converted to an order before enquiries were closed automatically'
         END
       ),
       updated_at = NOW()
 WHERE status = 'won'
   AND ticket_state = 'open';
