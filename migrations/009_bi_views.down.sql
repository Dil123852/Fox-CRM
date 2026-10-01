-- Rollback for 009_bi_views.sql
-- Apply first (most recent migration rolls back first).
DROP VIEW IF EXISTS v_sales_funnel;
DROP VIEW IF EXISTS v_channel_attribution;
DROP VIEW IF EXISTS v_revenue_daily;
DROP VIEW IF EXISTS v_product_performance;
DROP VIEW IF EXISTS v_loyalty_summary;
