-- Which migrations has THIS database actually had applied?
--
-- There is no migrations tracking table in this project (see README.md — files
-- are applied by hand, in ascending order), so the only honest way to answer
-- the question is to look for the schema artifact each migration creates and
-- report what is really there.
--
-- Read-only: this script creates nothing and changes nothing. Run it against
-- any environment to see what that environment is missing:
--
--   docker exec -i <container> psql -U crm -d crm -f - < migrations/check_applied.sql
--   psql "$DATABASE_URL" -f migrations/check_applied.sql
--
-- A migration showing MISSING is one you still need to apply there, in
-- ascending order. Note the numbering has one real quirk this reflects:
-- 035/036/037 each have TWO unrelated files sharing the number.
--
-- Four entries cannot be detected by schema shape alone and are reported
-- honestly rather than guessed at:
--   022 is RETIRED by 023 and SHOULD read MISSING on a healthy database.
--   038 is a one-off data UPDATE that creates nothing, so nothing can prove it
--       ran; it is safe to re-run (it only closes leads already converted).
--   049 is also a one-off data UPDATE (it corrects the totals of unpaid orders
--       that subtracted their free pillows); safe to re-run — it only raises a
--       total that is still below the corrected figure, so a second run is
--       UPDATE 0.
--   044 only grants privileges, so it is detected by the specific grant whose
--       absence caused the incident it fixed. Where the least-privilege role
--       does not exist (a database connecting as the owner `crm`), it reads
--       n/a rather than MISSING — there is nothing there to grant to.

WITH checks(seq, migration, artifact, present) AS (
  VALUES
    (  1, '001_staff_roles',                'staff_users table',                to_regclass('public.staff_users')                  IS NOT NULL),
    (  2, '002_ticket_foundation',          'leads.ticket_state',               to_regclass('public.leads')                        IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='leads' AND column_name='ticket_state')),
    (  3, '003_order_lifecycle',            'orders.delivery_time_slot',        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='delivery_time_slot')),
    (  4, '004_assignment_sla',             'v_lead_sla_status view',           to_regclass('public.v_lead_sla_status')            IS NOT NULL),
    (  5, '005_dialog_calls',               'call_events table',                to_regclass('public.call_events')                  IS NOT NULL),
    (  6, '006_retention_promotions',       'campaigns table',                  to_regclass('public.campaigns')                    IS NOT NULL),
    (  7, '007_promo_codes',                'promo_codes table',                to_regclass('public.promo_codes')                  IS NOT NULL),
    (  8, '008_warranty_service_tickets',   'warranties table',                 to_regclass('public.warranties')                   IS NOT NULL),
    (  9, '009_bi_views',                   'v_sales_funnel view',              to_regclass('public.v_sales_funnel')               IS NOT NULL),
    ( 10, '010_delivery_status',            'orders.delivery_driver',           EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='delivery_driver')),
    ( 11, '011_showroom_orders',            'customers.channel = showroom',     EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='customers' AND column_name='channel')),
    ( 12, '012_unified_channel_engagement', 'showroom_visits table',            to_regclass('public.showroom_visits')              IS NOT NULL),
    ( 13, '013_fix_gone_quiet_ad_hoc',      'v_campaign_eligible_customers',    to_regclass('public.v_campaign_eligible_customers') IS NOT NULL),
    ( 14, '014_auto_assign_toggle',         'app_settings table',               to_regclass('public.app_settings')                 IS NOT NULL),
    ( 15, '015_new_product_catalog',        'product Nidikumba Rise',           to_regclass('public.products') IS NOT NULL AND EXISTS (SELECT 1 FROM products WHERE name='Nidikumba Rise')),
    ( 16, '016_promo_redemption_cust_link', 'promo_code_redemptions.customer_id', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='promo_code_redemptions' AND column_name='customer_id')),
    ( 17, '017_promo_product_scoping',      'promo_codes.eligible_product_names', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='promo_codes' AND column_name='eligible_product_names')),
    ( 18, '018_automated_followup',         'leads.follow_up_1_date',           EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='leads' AND column_name='follow_up_1_date')),
    ( 19, '019_lead_priority',              'leads.priority',                   EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='leads' AND column_name='priority')),
    ( 20, '020_weekly_followup_close',      'leads.week_1_date',                EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='leads' AND column_name='week_1_date')),
    ( 21, '021_website_chat_channel',       'customers.channel = webchat',      EXISTS (SELECT 1 FROM pg_constraint WHERE conname LIKE '%channel%' AND pg_get_constraintdef(oid) LIKE '%webchat%')),
    ( 22, '022_dialog_webhook_real_fields', 'RETIRED by 023 (expect MISSING)',  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='call_events' AND column_name='dialog_call_id')),
    ( 23, '023_call_tracker_app',           'call_events.dedup_key',            EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='call_events' AND column_name='dedup_key')),
    ( 24, '024_bulk_messages',              'bulk_message_batches table',       to_regclass('public.bulk_message_batches')         IS NOT NULL),
    ( 25, '025_call_owner_assignment',      'assignment fn respects preset id', EXISTS (SELECT 1 FROM pg_proc WHERE proname='handle_new_lead_assignment' AND prosrc LIKE '%NEW.assigned_staff_id IS NOT NULL%')),
    ( 26, '026_cash_on_delivery',           'orders_cod_requires_cash_payment', EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_cod_requires_cash_payment')),
    ( 27, '027_contact_whatsapp_number',    'customers.contact_whatsapp_number', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='customers' AND column_name='contact_whatsapp_number')),
    ( 28, '028_order_payments',             'order_payments table',             to_regclass('public.order_payments')               IS NOT NULL),
    ( 29, '029_message_failure_reason',     'messages.failure_reason',          EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='messages' AND column_name='failure_reason')),
    ( 30, '030_normalize_phone_numbers',    'normalize_lk_phone() function',    EXISTS (SELECT 1 FROM pg_proc WHERE proname='normalize_lk_phone')),
    ( 31, '031_lead_items',                 'lead_items table',                 to_regclass('public.lead_items')                   IS NOT NULL),
    ( 32, '032_quotation_numbers',          'leads.quotation_no',               EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='leads' AND column_name='quotation_no')),
    ( 33, '033_lead_items_pillow_top_key',  'lead_items.pillow_top',            EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='lead_items' AND column_name='pillow_top')),
    ( 34, '034_advance_on_any_order',       'advance allowed w/o custom order',  NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_advance_only_on_custom')),
    ( 35, '035_login_lockout',              'staff_users.locked_until',         EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='staff_users' AND column_name='locked_until')),
    ( 35, '035_activity_log',               'activity_log table',               to_regclass('public.activity_log')                 IS NOT NULL),
    ( 36, '036_audit_log',                  'audit_log table',                  to_regclass('public.audit_log')                    IS NOT NULL),
    ( 36, '036_soft_delete',                'orders_all base table',            to_regclass('public.orders_all')                   IS NOT NULL),
    -- The role is `nidikumba_app`. This line used to look for 'crm_app', a
    -- name that appears in no migration anywhere, so 037 reported MISSING on
    -- every database including correctly-migrated ones — and on production,
    -- where 044 proves the role is in real use.
    ( 37, '037_least_privilege_app_role',   'nidikumba_app role',               EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nidikumba_app')),
    ( 38, '038_close_converted_leads',      'DATA-ONLY: no artifact, see note',  NULL),
    ( 39, '039_remove_auto_free_pillows',   'no auto free-pillow trigger',      NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_order_free_pillows')),
    ( 40, '040_order_secondary_phone',      'orders.secondary_phone',           EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='secondary_phone')),
    ( 41, '041_payment_evidence',           'orders.tax_invoice_no',            EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='tax_invoice_no')),
    ( 42, '042_redact_secrets_activity',    'log_activity() strips secrets',    EXISTS (SELECT 1 FROM pg_proc WHERE proname='log_activity' AND prosrc LIKE '%password_hash%')),
    ( 43, '043_missed_call_callbacks',      'v_missed_call_callbacks view',     to_regclass('public.v_missed_call_callbacks')      IS NOT NULL),
    -- there is no 044
    -- Grants only, so there is no new object to look for. Detected by the
    -- specific privilege whose absence caused the production incident 044
    -- fixed: nidikumba_app could not INSERT into activity_log, which is an
    -- AFTER trigger on orders/leads/customers, so every order placement 500'd.
    -- Reads "n/a (role not used here)" where the least-privilege role does not
    -- exist at all — a local database connecting as the owner `crm` never
    -- needed this migration.
    ( 44, '044_reconcile_app_role_grants',  'nidikumba_app INSERT on activity_log',
        CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nidikumba_app')
             THEN NULL
             ELSE has_table_privilege('nidikumba_app', 'public.activity_log', 'INSERT')
        END),
    ( 45, '045_super_admin_role',           'staff_sessions table',             to_regclass('public.staff_sessions')               IS NOT NULL),
    ( 46, '046_order_discounts',            'orders.discount_total',            EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='discount_total')),
    ( 47, '047_call_log_pagination_index',  'idx_call_events_occurred_at_id',   to_regclass('public.idx_call_events_occurred_at_id') IS NOT NULL),
    ( 48, '048_leads_pipeline_pagination_index', 'idx_leads_open_created_at_id', to_regclass('public.idx_leads_open_created_at_id') IS NOT NULL),
    ( 49, '049_free_items_cost_nothing',    'DATA-ONLY: no artifact, see note',  NULL),
    ( 50, '050_click_to_call',              'staff_devices + dial_requests',    to_regclass('public.staff_devices') IS NOT NULL AND to_regclass('public.dial_requests') IS NOT NULL),
    ( 51, '051_call_event_staff',           'call_events.staff_id',             EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='call_events' AND column_name='staff_id')),
    ( 52, '052_per_unit_promo_codes',       'promo_codes_all.discount_scope',   EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='promo_codes_all' AND column_name='discount_scope')),
    ( 53, '053_custom_discount_notifications', 'orders_all.custom_discount + staff_notifications', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders_all' AND column_name='custom_discount') AND to_regclass('public.staff_notifications') IS NOT NULL),
    ( 54, '054_quotations',                 'quotations table',                 to_regclass('public.quotations') IS NOT NULL),
    ( 55, '055_quotation_promo_code',       'quotations.promo_code',            EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='quotations' AND column_name='promo_code')),
    ( 56, '056_device_pair_codes',          'device_pair_codes table',          to_regclass('public.device_pair_codes') IS NOT NULL),
    ( 57, '057_volume_discount_waived',     'orders_all.volume_discount_waived', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders_all' AND column_name='volume_discount_waived')),
    ( 58, '058_per_agent_visibility',       'orders_all.placed_by',             EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders_all' AND column_name='placed_by'))
)
SELECT
  migration,
  artifact,
  CASE
    -- NULL means "cannot be determined here", for two different reasons:
    -- 038 creates nothing to look for, and 044 only matters where the
    -- least-privilege role exists. Named per migration so neither is read as
    -- the other.
    WHEN present IS NULL AND migration LIKE '044%' THEN 'n/a (nidikumba_app role not used here)'
    WHEN present IS NULL THEN 'unknown (data-only migration)'
    WHEN present THEN 'applied'
    ELSE 'MISSING'
  END AS status
FROM checks
ORDER BY seq, migration;
