-- Phase 11 — Business Intelligence Dashboard (Module 7, Appendix A.6)
-- Apply with:
--   docker exec -i crm-postgres psql -U crm -d crm < migrations/009_bi_views.sql
--
-- Pure reporting — no new tables, just 5 corrected views over data every
-- earlier phase already produces. Corrections from Appendix A.6's literal
-- SQL, all following patterns already established in earlier migrations:
--   * "completed" -> status='delivered' AND payment_status='paid'
--     (established Phase 3 — 'completed' isn't a real status value)
--   * item->>'quantity' -> item->>'qty' (the real key order items use)
--   * item name lookup uses COALESCE(item->>'name', item->>'product') —
--     same fallback Phase 4/10 already use for the same reason
--
-- REQ-8.7's staff leaderboard is NOT being skipped for lack of data (the
-- kickoff prompt's caveat assumed Phase 1/5 might not exist yet) - both are
-- real and already have live data. Phase 5's v_staff_performance and
-- GET /api/performance already ARE the staff leaderboard (ranked by
-- overdue count then conversion rate, admin/viewer see the full team).
-- Nothing new needed here.

CREATE OR REPLACE VIEW v_sales_funnel AS
SELECT
  date_trunc('month', created_at) AS month,
  count(*) AS tickets_opened,
  count(*) FILTER (WHERE ticket_state = 'closed') AS tickets_converted,
  round(100.0 * count(*) FILTER (WHERE ticket_state = 'closed') / NULLIF(count(*), 0), 1) AS conversion_pct
FROM leads
GROUP BY 1 ORDER BY 1;

CREATE OR REPLACE VIEW v_channel_attribution AS
SELECT
  l.source,
  count(*) AS tickets,
  count(*) FILTER (WHERE l.ticket_state = 'closed') AS converted,
  round(100.0 * count(*) FILTER (WHERE l.ticket_state = 'closed') / NULLIF(count(*), 0), 1) AS conversion_pct,
  coalesce(sum(o.total_amount), 0) AS revenue
FROM leads l
LEFT JOIN orders o ON o.lead_id = l.id AND o.status = 'delivered' AND o.payment_status = 'paid'
GROUP BY l.source ORDER BY revenue DESC;

CREATE OR REPLACE VIEW v_revenue_daily AS
SELECT date_trunc('day', updated_at) AS day,
  count(*) AS orders_completed, sum(total_amount) AS revenue
FROM orders
WHERE status = 'delivered' AND payment_status = 'paid'
GROUP BY 1 ORDER BY 1;

CREATE OR REPLACE VIEW v_product_performance AS
SELECT
  COALESCE(item->>'name', item->>'product') AS product_name,
  count(*) AS times_ordered,
  sum(COALESCE((item->>'qty')::int, 1)) AS units_sold,
  sum(COALESCE((item->>'qty')::int, 1) * COALESCE((item->>'unit_price')::numeric, 0)) AS revenue
FROM orders o, jsonb_array_elements(o.items) AS item
WHERE o.status = 'delivered' AND o.payment_status = 'paid'
GROUP BY 1 ORDER BY revenue DESC;

CREATE OR REPLACE VIEW v_loyalty_summary AS
SELECT
  count(*) FILTER (WHERE is_loyalty_customer) AS loyalty_customers,
  count(*) FILTER (WHERE NOT is_loyalty_customer) AS potential_customers,
  round(avg(lifetime_value) FILTER (WHERE is_loyalty_customer), 2) AS avg_lifetime_value
FROM customers;
