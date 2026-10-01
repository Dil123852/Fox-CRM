-- CRM Automation PostgreSQL Schema
-- Run automatically by Docker on first start

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── customers ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  whatsapp_number  TEXT          NOT NULL UNIQUE,
  name             TEXT,
  priority_score   INTEGER       DEFAULT 1,
  priority_label   TEXT          DEFAULT 'low',
  priority_updated_at TIMESTAMPTZ,
  ai_enabled       BOOLEAN       DEFAULT TRUE,
  -- 'call' (Phase 6) covers a customer whose first-ever contact was a Dialog
  -- phone call rather than WhatsApp. 'showroom' (migration 011) covers a
  -- walk-in customer created via POST /api/customers when staff place an
  -- order for them directly (no prior WhatsApp/call contact). 'webchat'
  -- (migration 021) covers the nidikumba.shop AI chat widget — the visitor
  -- provides a WhatsApp number before chatting, so it's treated identically
  -- to any other channel from that point on.
  channel          TEXT          NOT NULL DEFAULT 'meta' CHECK (channel IN ('meta', 'twilio', 'call', 'showroom', 'webchat')),
  -- loyalty stats (Phase 3 / Module 5 groundwork) — set by trg_order_completed
  is_loyalty_customer  BOOLEAN       DEFAULT FALSE,
  first_purchase_date  TIMESTAMPTZ,
  last_purchase_date   TIMESTAMPTZ,
  total_orders_count   INTEGER       DEFAULT 0,
  lifetime_value       NUMERIC(12,2) DEFAULT 0,
  -- marketing consent (Phase 7) — a plain staff-set field; no automated
  -- post-purchase "ask" flow this phase (that's Module 6/8 territory)
  consent_for_marketing BOOLEAN      DEFAULT FALSE,
  consent_updated_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ   DEFAULT NOW()
);

-- ── messages ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id          UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  direction            TEXT        NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  content              TEXT        NOT NULL,
  whatsapp_message_id  TEXT,
  -- who sent an outbound message (Phase 5) — NULL for inbound (customer) messages.
  -- Load-bearing for SLA/overdue detection: without it, the AI's instant
  -- auto-reply would look identical to a real staff response.
  sender_type          TEXT CHECK (sender_type IS NULL OR sender_type IN ('ai', 'staff')),
  -- Phase 13 fix: whether OUR attempt to send this outbound message to the
  -- provider actually failed. Before this, a failed send was still logged
  -- and broadcast as if delivered — see migration 010_delivery_status.sql.
  delivery_failed      BOOLEAN DEFAULT FALSE,
  received_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── leads ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leads (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status            TEXT        DEFAULT 'new',
  source            TEXT        DEFAULT 'Facebook',
  product_type      TEXT,
  bed_size          TEXT,
  scale             TEXT,
  qty               INTEGER,
  unit_price        NUMERIC(12,2),
  location          TEXT,
  delivery_address  TEXT,
  quotation_no      TEXT,
  next_contact_date DATE,
  follow_up_notes   TEXT,
  category          TEXT,
  first_call        TEXT,
  second_call       TEXT,
  week_01           TEXT,
  week_02           TEXT,
  week_03           TEXT,
  week_04           TEXT,
  -- ticket lifecycle (Phase 3 / Module 4 groundwork)
  ticket_state          TEXT        DEFAULT 'open' NOT NULL CHECK (ticket_state IN ('open', 'closed')),
  closed_at             TIMESTAMPTZ,
  closed_reason         TEXT,
  is_returning_contact  BOOLEAN     DEFAULT FALSE,
  reopened_from_lead_id UUID        REFERENCES leads(id),
  -- assignment + SLA (Phase 5) — set automatically by trg_new_lead_assignment.
  -- No inline REFERENCES here: staff_users is created later in this file
  -- (Phase 1 added it near the indexes section) — the FK is added below,
  -- right after staff_users exists.
  assigned_staff_id UUID,
  assigned_at       TIMESTAMPTZ,
  sla_deadline      TIMESTAMPTZ,
  -- automated follow-up schedule (migration 018) — follow_up_1/2 set by
  -- trg_new_lead_assignment (+2/+4 days from creation); promo_sent_at and
  -- next_weekly_follow_up_date managed by whatsapp-backend/scheduler.js
  -- once follow_up_2's date passes with the lead still open. All 4 dates
  -- are staff-editable via PATCH /api/leads/:id.
  follow_up_1_date  DATE,
  follow_up_1_done  BOOLEAN     NOT NULL DEFAULT FALSE,
  follow_up_2_date  DATE,
  follow_up_2_done  BOOLEAN     NOT NULL DEFAULT FALSE,
  promo_sent_at     TIMESTAMPTZ,
  next_weekly_follow_up_date DATE,
  -- 4 concrete weekly follow-up dates (migration 020) — set all at once
  -- when staff mark follow_up_2_done=true (+7/+14/+21/+28 days from that
  -- moment), replacing the single-rolling-date design above for new leads.
  -- Each date independently triggers its own automated promo send when it
  -- passes, guarded by its own *_sent_at (same idempotency pattern as
  -- promo_sent_at). All 4 stay staff-editable afterward.
  week_1_date       DATE,
  week_1_sent_at    TIMESTAMPTZ,
  week_2_date       DATE,
  week_2_sent_at    TIMESTAMPTZ,
  week_3_date       DATE,
  week_3_sent_at    TIMESTAMPTZ,
  week_4_date       DATE,
  week_4_sent_at    TIMESTAMPTZ,
  -- Per-lead priority (migration 019), staff-editable directly on the
  -- Pipeline table — deliberately separate from customers.priority_label
  -- (AI-driven chat/SLA priority); one customer can have several leads
  -- over time, each with its own priority here.
  priority          TEXT        NOT NULL DEFAULT 'medium' CHECK (priority IN ('high', 'medium', 'low')),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ── orders ────────────────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS order_number_seq START 1001;

CREATE TABLE IF NOT EXISTS orders (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number         TEXT        DEFAULT 'ORD-' || to_char(nextval('order_number_seq'), 'FM00000'),
  customer_id          UUID        NOT NULL REFERENCES customers(id),
  lead_id              UUID        REFERENCES leads(id),
  customer_name        TEXT,
  customer_phone       TEXT,
  items                JSONB       DEFAULT '[]',
  total_amount         NUMERIC(12,2) DEFAULT 0,
  amount_paid          NUMERIC(12,2) DEFAULT 0,
  currency             TEXT        DEFAULT 'LKR',
  -- Real live values only — 'pending' is the default every order starts at;
  -- new/confirmed/processing/shipped/delivered/cancelled come from OrdersPage.jsx's
  -- dropdown. NOT the spec's proposed values (no ready_for_delivery/out_for_delivery/
  -- completed/returned) — "completed" here means delivered + paid, no status value.
  status               TEXT        DEFAULT 'pending'
    CHECK (status IN ('pending', 'new', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled')),
  payment_status       TEXT        DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'partial', 'paid', 'refunded', 'failed')),
  CONSTRAINT orders_delivered_requires_paid CHECK (status <> 'delivered' OR payment_status = 'paid'),
  delivery_address     TEXT,
  delivery_date        DATE,
  -- pickup | delivery | courier | cash_on_delivery. 'cash_on_delivery'
  -- (migration 026) is a delivery whose payment is collected in cash at
  -- handover, so it implies payment_method='cash' (see the constraint below
  -- payment_method) and leaves payment_status 'pending' until delivery is
  -- confirmed. No CHECK on the value set itself — never has had one.
  delivery_method      TEXT        DEFAULT 'delivery',
  -- delivery scheduling (Phase 4) — gated on 'shipped', the real analog to the
  -- spec's non-existent "Ready for Delivery" status
  delivery_time_slot        TEXT,
  delivery_driver             TEXT,
  delivery_confirmation_note  TEXT,
  CONSTRAINT orders_delivery_scheduling_requires_shipped CHECK (
    (delivery_time_slot IS NULL AND delivery_driver IS NULL) OR status IN ('shipped', 'delivered')
  ),
  CONSTRAINT orders_delivered_requires_confirmation_note
    CHECK (status <> 'delivered' OR delivery_confirmation_note IS NOT NULL),
  payment_method       TEXT        DEFAULT 'cash',
  -- migration 026: COD spans both fields, so they must not contradict
  CONSTRAINT orders_cod_requires_cash_payment CHECK (
    delivery_method <> 'cash_on_delivery' OR payment_method = 'cash'
  ),
  special_requirements TEXT,
  notes                TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- ── products ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  category               TEXT        NOT NULL CHECK (category IN ('mattress', 'pillow')),
  brand                  TEXT        NOT NULL DEFAULT 'Nidikumba',
  name                   TEXT        NOT NULL,
  collection             TEXT,
  spring_type            TEXT,
  description            TEXT,
  has_pillow_top_option  BOOLEAN     DEFAULT FALSE,
  free_pillows_included  INTEGER     DEFAULT 0,
  variants               JSONB       NOT NULL DEFAULT '[]',
  active                 BOOLEAN     DEFAULT TRUE,
  -- per-product-line stock (Phase 4) — see migration 003 for why not per-variant
  stock_quantity     INTEGER DEFAULT 0 NOT NULL,
  reserved_quantity  INTEGER DEFAULT 0 NOT NULL,
  reorder_threshold  INTEGER DEFAULT 5 NOT NULL,
  warranty_years     INTEGER DEFAULT 5,
  -- Flat addon price for the optional pillow-top upgrade (migration 015) —
  -- NULL for products with has_pillow_top_option = false.
  pillow_top_addon_price NUMERIC(10,2),
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);

-- ── call_events (Phase 6; Dwesk/Dialog webhook retired, Phase 17 migration
-- 023 — a self-built Android call-tracker app syncing the phone's own call
-- log is the real integration now) ────────────────────────────────────────
-- POST /api/calls (whatsapp-backend/index.js) receives batched call-log
-- entries; dedup_key (number+timestamp+duration+direction) makes a re-synced
-- batch idempotent since the app has no since-cursor and may resend history.
CREATE TABLE IF NOT EXISTS call_events (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      UUID        REFERENCES customers(id),
  raw_phone_number TEXT        NOT NULL,
  call_type        TEXT,
  duration_seconds INTEGER,
  occurred_at      TIMESTAMPTZ,
  contact_name     TEXT,
  sim_slot         INTEGER,
  dedup_key        TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── showroom_visits (Phase 14) — a walk-in visit staff log by hand, distinct
-- from a showroom ORDER (orders table, migration 011). Feeds
-- v_customer_engagement below and the showroom_no_purchase campaign segment.
-- staff_id has no inline FK — staff_users doesn't exist yet at this point in
-- the file (same reason as leads.assigned_staff_id above); added below once
-- staff_users exists.
CREATE TABLE IF NOT EXISTS showroom_visits (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        UUID REFERENCES customers(id),
  phone              TEXT NOT NULL,
  showroom_location  TEXT NOT NULL,
  products_shown     TEXT,
  outcome            TEXT CHECK (outcome IN ('browsing','interested','ordered','not_interested')),
  staff_id           UUID,
  notes              TEXT,
  visited_at         TIMESTAMPTZ DEFAULT NOW()
);

-- ── campaigns / campaign_sends (Phase 7 / Module 5) ───────────────────────────
CREATE TABLE IF NOT EXISTS campaigns (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT        NOT NULL,
  -- showroom_no_purchase/multi_channel_no_conversion/gone_quiet added Phase 14
  -- (migration 012), built on v_customer_engagement below.
  target_segment     TEXT        NOT NULL CHECK (target_segment IN (
    'loyalty', 'potential', 'all',
    'showroom_no_purchase', 'multi_channel_no_conversion', 'gone_quiet'
  )),
  trigger_type       TEXT        NOT NULL CHECK (trigger_type IN (
    'referral_ask', 'comfort_checkin', 'accessory_upsell',
    'anniversary', 'replacement_reminder', 'ad_hoc'
  )),
  trigger_offset_days INTEGER,
  message_template   TEXT        NOT NULL,
  status             TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused')),
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campaign_sends (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         UUID        NOT NULL REFERENCES campaigns(id),
  customer_id         UUID        NOT NULL REFERENCES customers(id),
  sent_at             TIMESTAMPTZ DEFAULT NOW(),
  resulted_in_order_id UUID       REFERENCES orders(id),
  UNIQUE (campaign_id, customer_id)
);

-- ── bulk_message_batches / bulk_message_recipients (migration 024) ───────────
-- History for the admin-only Bulk Messages page — one row per send action,
-- one row per recipient, same shape as campaigns/campaign_sends above but
-- for a direct staff-picked send rather than a consent-gated campaign
-- segment.
CREATE TABLE IF NOT EXISTS bulk_message_batches (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sent_by      UUID        REFERENCES staff_users(id),
  message      TEXT        NOT NULL,
  image_url    TEXT,
  sent_count   INTEGER     NOT NULL DEFAULT 0,
  total_count  INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bulk_message_recipients (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id     UUID        NOT NULL REFERENCES bulk_message_batches(id) ON DELETE CASCADE,
  customer_id  UUID        NOT NULL REFERENCES customers(id),
  sent         BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── influencers / promo_codes / promo_code_redemptions (Phase 9) ─────────────
-- Not in the requirements spec PDF at all - built from business rules
-- confirmed directly with the user. See migration 007_promo_codes.sql for
-- the full design notes (public validate/redeem, no-auto-backfill limitation).
CREATE TABLE IF NOT EXISTS influencers (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT        NOT NULL,
  handle              TEXT,
  commission_percent  NUMERIC(5,2) NOT NULL DEFAULT 0,
  active              BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS promo_codes (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code                TEXT        NOT NULL UNIQUE,
  discount_type       TEXT        NOT NULL CHECK (discount_type IN ('percent', 'amount')),
  discount_percent    NUMERIC(5,2),
  discount_amount     NUMERIC(12,2),
  max_redemptions     INTEGER,
  redemption_count    INTEGER     NOT NULL DEFAULT 0,
  expires_at          TIMESTAMPTZ,
  influencer_id       UUID        REFERENCES influencers(id),
  active              BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  eligible_product_names TEXT[], -- NULL/empty = applies to every product (migration 017)
  CONSTRAINT promo_codes_discount_shape CHECK (
    (discount_type = 'percent' AND discount_percent IS NOT NULL AND discount_amount IS NULL)
    OR
    (discount_type = 'amount' AND discount_amount IS NOT NULL AND discount_percent IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS promo_code_redemptions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_code_id     UUID        NOT NULL REFERENCES promo_codes(id),
  redeemed_phone    TEXT        NOT NULL,
  customer_id       UUID        REFERENCES customers(id),
  order_id          UUID        REFERENCES orders(id),
  discount_applied  NUMERIC(12,2) NOT NULL,
  redeemed_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (promo_code_id, redeemed_phone)
);

-- ── warranties / service_tickets (Phase 10 / Module 8, Appendix A.7) ─────────
-- See migration 008_warranty_service_tickets.sql for the full deviation notes
-- (name-based product matching, delivered+paid not 'completed', priority 3
-- not the spec's literal 10 — this system's real scale is 1-3).
CREATE SEQUENCE IF NOT EXISTS warranty_number_seq;

CREATE TABLE IF NOT EXISTS warranties (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  warranty_number TEXT        NOT NULL UNIQUE,
  order_id        UUID        NOT NULL REFERENCES orders(id),
  customer_id     UUID        NOT NULL REFERENCES customers(id),
  product_id      UUID        REFERENCES products(id),
  product_name    TEXT        NOT NULL,
  start_date      DATE        NOT NULL,
  end_date        DATE        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  terms_summary   TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS service_tickets (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         UUID        NOT NULL REFERENCES orders(id),
  customer_id      UUID        NOT NULL REFERENCES customers(id),
  product_id       UUID        REFERENCES products(id),
  warranty_id      UUID        REFERENCES warranties(id),
  issue_type       TEXT        NOT NULL CHECK (issue_type IN ('warranty_claim', 'defect', 'delivery_damage', 'general_complaint')),
  description      TEXT,
  status           TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  priority         TEXT        DEFAULT 'normal' CHECK (priority IN ('normal', 'high')),
  warranty_valid   BOOLEAN,
  resolution_notes TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  resolved_at      TIMESTAMPTZ
);

-- ── staff_users (Phase 1 / Module 2 — Staff Roles & Access Control) ──────────
CREATE TABLE IF NOT EXISTS staff_users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL,
  phone         TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  role          TEXT        NOT NULL CHECK (role IN (
    'admin', 'sales_agent', 'inventory_manager',
    'delivery_coordinator', 'finance', 'viewer'
  )),
  active        BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- leads.assigned_staff_id's FK — added here, not inline above, since
-- staff_users didn't exist yet when leads was created earlier in this file.
ALTER TABLE leads
  ADD CONSTRAINT leads_assigned_staff_id_fkey FOREIGN KEY (assigned_staff_id) REFERENCES staff_users(id);

-- showroom_visits.staff_id's FK — same reason as above.
ALTER TABLE showroom_visits
  ADD CONSTRAINT showroom_visits_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff_users(id);
CREATE INDEX IF NOT EXISTS idx_showroom_visits_customer_id ON showroom_visits(customer_id);

-- ── indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_staff_users_role     ON staff_users(role);
CREATE INDEX IF NOT EXISTS idx_leads_ticket_state   ON leads(ticket_state);
CREATE INDEX IF NOT EXISTS idx_leads_assigned_staff_id ON leads(assigned_staff_id);
CREATE INDEX IF NOT EXISTS idx_call_events_customer_id ON call_events(customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_call_events_dedup_key ON call_events(dedup_key) WHERE dedup_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bulk_message_recipients_batch_id ON bulk_message_recipients(batch_id);
CREATE INDEX IF NOT EXISTS idx_bulk_message_recipients_customer_id ON bulk_message_recipients(customer_id);
CREATE INDEX IF NOT EXISTS idx_bulk_message_batches_created_at ON bulk_message_batches(created_at);
CREATE INDEX IF NOT EXISTS idx_promo_code_redemptions_promo_code_id ON promo_code_redemptions(promo_code_id);
CREATE INDEX IF NOT EXISTS idx_promo_codes_influencer_id ON promo_codes(influencer_id);
CREATE INDEX IF NOT EXISTS idx_warranties_customer_id ON warranties(customer_id);
CREATE INDEX IF NOT EXISTS idx_warranties_order_id ON warranties(order_id);
CREATE INDEX IF NOT EXISTS idx_service_tickets_customer_id ON service_tickets(customer_id);
CREATE INDEX IF NOT EXISTS idx_service_tickets_status ON service_tickets(status);
CREATE INDEX IF NOT EXISTS idx_campaign_sends_campaign_id ON campaign_sends(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_sends_customer_id ON campaign_sends(customer_id);
CREATE INDEX IF NOT EXISTS idx_messages_customer_id ON messages(customer_id);
CREATE INDEX IF NOT EXISTS idx_messages_received_at ON messages(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_customer_id    ON leads(customer_id);
CREATE INDEX IF NOT EXISTS idx_leads_status         ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_created_at     ON leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_customer_id   ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_customers_created_at ON customers(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_products_category    ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_active      ON products(active);

-- ── Trigger 1 (Phase 3 / Appendix A.3) ────────────────────────────────────────
-- An order reaching delivered+paid closes its linked ticket and updates the
-- customer's loyalty stats. Fires only on that exact transition.
CREATE OR REPLACE FUNCTION handle_order_completed()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'delivered' AND NEW.payment_status = 'paid'
     AND (OLD.status IS DISTINCT FROM 'delivered' OR OLD.payment_status IS DISTINCT FROM 'paid') THEN

    IF NEW.lead_id IS NOT NULL THEN
      UPDATE leads
      SET ticket_state = 'closed', closed_at = NOW(), closed_reason = 'purchased'
      WHERE id = NEW.lead_id;
    END IF;

    UPDATE customers
    SET is_loyalty_customer = TRUE,
        total_orders_count  = total_orders_count + 1,
        lifetime_value       = lifetime_value + NEW.total_amount,
        last_purchase_date   = NOW(),
        first_purchase_date  = COALESCE(first_purchase_date, NOW())
    WHERE id = NEW.customer_id;

  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_order_completed ON orders;
CREATE TRIGGER trg_order_completed
AFTER UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION handle_order_completed();

-- ── Trigger 2 (Phase 4) ────────────────────────────────────────────────────────
-- Reserve stock on confirm, release on cancel, finalize (real decrement) on
-- delivered+paid. Matches order items to products by name (item->>'name',
-- falling back to the older item->>'product' key) — see migration 003.
CREATE OR REPLACE FUNCTION handle_order_stock_reservation()
RETURNS trigger AS $$
DECLARE
  item jsonb;
  v_qty int;
  v_name text;
BEGIN
  IF NEW.status = 'confirmed' AND OLD.status IS DISTINCT FROM 'confirmed' THEN
    FOR item IN SELECT * FROM jsonb_array_elements(NEW.items)
    LOOP
      v_name := COALESCE(item->>'name', item->>'product');
      v_qty  := COALESCE((item->>'qty')::int, 1);
      IF v_name IS NOT NULL THEN
        UPDATE products SET reserved_quantity = reserved_quantity + v_qty WHERE name = v_name;
      END IF;
    END LOOP;
  END IF;

  IF NEW.status = 'cancelled' AND OLD.status = 'confirmed' THEN
    FOR item IN SELECT * FROM jsonb_array_elements(OLD.items)
    LOOP
      v_name := COALESCE(item->>'name', item->>'product');
      v_qty  := COALESCE((item->>'qty')::int, 1);
      IF v_name IS NOT NULL THEN
        UPDATE products SET reserved_quantity = GREATEST(reserved_quantity - v_qty, 0) WHERE name = v_name;
      END IF;
    END LOOP;
  END IF;

  IF NEW.status = 'delivered' AND NEW.payment_status = 'paid'
     AND (OLD.status IS DISTINCT FROM 'delivered' OR OLD.payment_status IS DISTINCT FROM 'paid') THEN
    FOR item IN SELECT * FROM jsonb_array_elements(NEW.items)
    LOOP
      v_name := COALESCE(item->>'name', item->>'product');
      v_qty  := COALESCE((item->>'qty')::int, 1);
      IF v_name IS NOT NULL THEN
        UPDATE products
        SET stock_quantity    = GREATEST(stock_quantity - v_qty, 0),
            reserved_quantity = GREATEST(reserved_quantity - v_qty, 0)
        WHERE name = v_name;
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_order_stock_reservation ON orders;
CREATE TRIGGER trg_order_stock_reservation
AFTER UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION handle_order_stock_reservation();

-- ── Trigger 3 (Phase 5) ────────────────────────────────────────────────────────
-- Auto-assign every new ticket to the active sales_agent with the fewest
-- currently-open assigned tickets (REQ-4.1), and start its SLA clock from the
-- customer's current priority segment (REQ-4.3; Hot/Warm/Cold renamed to the
-- real high/medium/low labels). No-op (stays unassigned) if no active
-- sales_agent exists — graceful degradation, not a failed insert.
-- app_settings (Phase 15.3) — a global on/off switch for the whole team's
-- auto-assignment, not per-staff-member. Checked at the top of the trigger
-- below; disabled leaves a new ticket unassigned (no assigned_staff_id, no
-- sla_deadline) instead of round-robin-assigning it.
CREATE TABLE IF NOT EXISTS app_settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
INSERT INTO app_settings (key, value) VALUES ('auto_assign_enabled', 'true')
  ON CONFLICT (key) DO NOTHING;

-- Call-owner assignment (migration 025) — when whatsapp-backend/index.js's
-- POST /api/calls or /api/calls/start resolves the calling device's owner
-- (staff_users.phone matched against the device's registered owner phone)
-- it inserts the lead with assigned_staff_id already set, bypassing
-- round-robin entirely for that one insert. Every other channel (WhatsApp,
-- web chat, showroom visits) still goes through plain round-robin below,
-- unchanged. Falls back to round-robin when no staff phone match is found.
CREATE OR REPLACE FUNCTION handle_new_lead_assignment()
RETURNS trigger AS $$
DECLARE
  v_staff_id uuid;
  v_priority_label text;
  v_sla_interval interval;
  v_auto_assign_enabled boolean;
BEGIN
  NEW.follow_up_1_date := (NOW() + INTERVAL '2 days')::date;
  NEW.follow_up_2_date := (NOW() + INTERVAL '4 days')::date;

  IF NEW.assigned_staff_id IS NOT NULL THEN
    NEW.assigned_at := NOW();

    SELECT priority_label INTO v_priority_label FROM customers WHERE id = NEW.customer_id;
    v_sla_interval := CASE v_priority_label
      WHEN 'high'   THEN INTERVAL '1 hour'
      WHEN 'medium' THEN INTERVAL '4 hours'
      ELSE               INTERVAL '24 hours'
    END;
    NEW.sla_deadline := NEW.assigned_at + v_sla_interval;

    RETURN NEW;
  END IF;

  SELECT (value = 'true') INTO v_auto_assign_enabled
  FROM app_settings WHERE key = 'auto_assign_enabled';

  IF COALESCE(v_auto_assign_enabled, true) = false THEN
    RETURN NEW;
  END IF;

  SELECT su.id INTO v_staff_id
  FROM staff_users su
  LEFT JOIN leads l ON l.assigned_staff_id = su.id AND l.ticket_state = 'open'
  WHERE su.role = 'sales_agent' AND su.active = true
  GROUP BY su.id, su.created_at
  ORDER BY count(l.id) ASC, su.created_at ASC
  LIMIT 1;

  IF v_staff_id IS NOT NULL THEN
    NEW.assigned_staff_id := v_staff_id;
    NEW.assigned_at := NOW();

    SELECT priority_label INTO v_priority_label FROM customers WHERE id = NEW.customer_id;
    v_sla_interval := CASE v_priority_label
      WHEN 'high'   THEN INTERVAL '1 hour'
      WHEN 'medium' THEN INTERVAL '4 hours'
      ELSE               INTERVAL '24 hours'
    END;
    NEW.sla_deadline := NEW.assigned_at + v_sla_interval;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_new_lead_assignment ON leads;
CREATE TRIGGER trg_new_lead_assignment
BEFORE INSERT ON leads
FOR EACH ROW EXECUTE FUNCTION handle_new_lead_assignment();

-- View — per-lead SLA status, computed live (REQ-4.4). "Staff action" means a
-- staff-sent outbound message after assignment (messages.sender_type='staff'),
-- the same signal that makes time-to-first-contact and SLA-compliance% (7.4)
-- measure real humans instead of the AI's instant auto-reply.
CREATE OR REPLACE VIEW v_lead_sla_status AS
SELECT
  l.id AS lead_id,
  l.customer_id,
  l.assigned_staff_id,
  l.assigned_at,
  l.sla_deadline,
  l.ticket_state,
  (
    SELECT MIN(m.received_at) FROM messages m
    WHERE m.customer_id = l.customer_id AND m.direction = 'outbound'
      AND m.sender_type = 'staff' AND m.received_at >= l.assigned_at
  ) AS first_staff_contact_at,
  CASE
    WHEN l.assigned_at IS NULL OR l.ticket_state <> 'open' THEN false
    WHEN EXISTS (
      SELECT 1 FROM messages m
      WHERE m.customer_id = l.customer_id AND m.direction = 'outbound'
        AND m.sender_type = 'staff' AND m.received_at >= l.assigned_at
    ) THEN false
    WHEN l.sla_deadline < NOW() THEN true
    ELSE false
  END AS is_overdue
FROM leads l
WHERE l.assigned_staff_id IS NOT NULL;

-- View — per-staff performance (7.4 / REQ-4.9). Revenue and conversion read
-- through orders.lead_id (Phase 3) using "delivered + paid" as "completed".
CREATE OR REPLACE VIEW v_staff_performance AS
SELECT
  su.id AS staff_id,
  su.name AS staff_name,
  count(l.id) FILTER (WHERE l.ticket_state = 'open') AS open_assigned,
  count(l.id) FILTER (WHERE vs.is_overdue) AS overdue_count,
  count(l.id) AS total_assigned,
  count(l.id) FILTER (WHERE l.ticket_state = 'closed' AND l.closed_reason = 'purchased') AS converted_count,
  round(100.0 * count(l.id) FILTER (WHERE l.ticket_state = 'closed' AND l.closed_reason = 'purchased')
    / NULLIF(count(l.id), 0), 1) AS conversion_pct,
  coalesce(sum(o.total_amount) FILTER (WHERE o.status = 'delivered' AND o.payment_status = 'paid'), 0) AS revenue,
  avg(vs.first_staff_contact_at - l.assigned_at) AS avg_time_to_first_contact
FROM staff_users su
LEFT JOIN leads l  ON l.assigned_staff_id = su.id
LEFT JOIN v_lead_sla_status vs ON vs.lead_id = l.id
LEFT JOIN orders o ON o.lead_id = l.id
WHERE su.role = 'sales_agent'
GROUP BY su.id, su.name;

-- Trigger 4 (Phase 6) — REMOVED in Phase 14 (migration 012). Call-event
-- customer/ticket matching used to happen here (handle_call_event/
-- trg_call_event: match by whatsapp_number, create the customer + an open
-- ticket on a missed call) but a DB trigger can't be called from plain JS,
-- which showroom visits needed to do too. That logic now lives in
-- whatsapp-backend/index.js as findOrCreateCustomerByPhone/
-- getOrCreateOpenTicket, shared by the WhatsApp webhook, the Dialog webhook
-- (POST /webhook/dialog), and POST /api/showroom-visits. See CLAUDE.md.

-- View (Phase 14) — one row per customer summarizing engagement across all
-- three channels (WhatsApp, Dialog calls, showroom visits). Backs the new
-- campaign segments below.
CREATE OR REPLACE VIEW v_customer_engagement AS
SELECT
  c.id AS customer_id,
  c.whatsapp_number,
  c.is_loyalty_customer,
  (SELECT MAX(received_at) FROM messages WHERE customer_id = c.id) AS last_whatsapp_at,
  (SELECT MAX(occurred_at) FROM call_events WHERE customer_id = c.id) AS last_call_at,
  (SELECT MAX(visited_at) FROM showroom_visits WHERE customer_id = c.id) AS last_showroom_visit_at,
  (SELECT count(DISTINCT showroom_location) FROM showroom_visits WHERE customer_id = c.id) AS showrooms_visited,
  (
    (EXISTS(SELECT 1 FROM messages WHERE customer_id = c.id))::int +
    (EXISTS(SELECT 1 FROM call_events WHERE customer_id = c.id))::int +
    (EXISTS(SELECT 1 FROM showroom_visits WHERE customer_id = c.id))::int
  ) AS channels_engaged
FROM customers c;

-- View (Phase 7, extended Phase 14) — who's eligible for a given active
-- campaign RIGHT NOW. Enforces REQ-5.7 structurally: a customer without
-- consent_for_marketing never appears here. The send endpoint re-checks
-- consent explicitly on top of this, so REQ-5.7 holds even for a direct
-- specific-customer send.
--
-- The 3 Phase-14 segments: showroom_no_purchase (visited with outcome
-- browsing/interested, never completed an order), multi_channel_no_conversion
-- (engaged on 2+ channels, not a loyalty customer), gone_quiet (not a loyalty
-- customer, silent across every channel for trigger_offset_days — that column
-- means "days since last purchase" for loyalty/potential/all but is
-- repurposed here as "days of cross-channel silence", since those are
-- different concepts a campaign row can't express two ways at once).
CREATE OR REPLACE VIEW v_campaign_eligible_customers AS
SELECT
  camp.id AS campaign_id,
  c.id AS customer_id
FROM campaigns camp
JOIN customers c ON TRUE
LEFT JOIN v_customer_engagement ve ON ve.customer_id = c.id
WHERE (
  (camp.target_segment = 'loyalty'   AND c.is_loyalty_customer = TRUE)
  OR (camp.target_segment = 'potential' AND EXISTS (
        SELECT 1 FROM leads l WHERE l.customer_id = c.id AND l.ticket_state = 'open'
      ))
  OR camp.target_segment = 'all'
  OR (camp.target_segment = 'showroom_no_purchase'
      AND c.total_orders_count = 0
      AND EXISTS (
        SELECT 1 FROM showroom_visits sv
        WHERE sv.customer_id = c.id AND sv.outcome IN ('browsing', 'interested')
      ))
  OR (camp.target_segment = 'multi_channel_no_conversion'
      AND c.is_loyalty_customer = FALSE
      AND COALESCE(ve.channels_engaged, 0) >= 2)
  OR (camp.target_segment = 'gone_quiet' AND c.is_loyalty_customer = FALSE)
)
  AND camp.status = 'active'
  AND c.consent_for_marketing = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM campaign_sends cs WHERE cs.campaign_id = camp.id AND cs.customer_id = c.id
  )
  AND (
    -- gone_quiet ALWAYS needs its own timing check — never short-circuited by
    -- the ad_hoc branch below, unlike every other segment. (Fixed in
    -- migration 013 after 14.7 verification caught a gone_quiet+ad_hoc
    -- campaign matching every non-loyalty customer regardless of recency.)
    (camp.target_segment = 'gone_quiet'
      AND camp.trigger_offset_days IS NOT NULL
      AND GREATEST(
        COALESCE(ve.last_whatsapp_at, '-infinity'::timestamptz),
        COALESCE(ve.last_call_at, '-infinity'::timestamptz),
        COALESCE(ve.last_showroom_visit_at, '-infinity'::timestamptz)
      ) + (camp.trigger_offset_days || ' days')::interval <= NOW())
    OR (camp.target_segment != 'gone_quiet' AND (
      camp.trigger_type = 'ad_hoc'
      OR (
        camp.target_segment IN ('loyalty', 'potential', 'all')
        AND camp.trigger_offset_days IS NOT NULL
        AND c.last_purchase_date IS NOT NULL
        AND c.last_purchase_date + (camp.trigger_offset_days || ' days')::interval <= NOW()
      )
      OR camp.target_segment IN ('showroom_no_purchase', 'multi_channel_no_conversion')
    ))
  );

-- Promo codes (Phase 9) — read-only check + race-safe redemption. See
-- migration 007_promo_codes.sql for the full design rationale.
CREATE OR REPLACE FUNCTION validate_promo_code(p_code TEXT, p_phone TEXT)
RETURNS TABLE(valid BOOLEAN, message TEXT, discount_type TEXT, discount_percent NUMERIC, discount_amount NUMERIC, promo_code_id UUID) AS $$
DECLARE
  v_promo RECORD;
BEGIN
  SELECT * INTO v_promo FROM promo_codes WHERE code = p_code AND active = TRUE;

  IF v_promo IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Invalid promo code'::TEXT, NULL::TEXT, NULL::NUMERIC, NULL::NUMERIC, NULL::UUID;
    RETURN;
  END IF;
  IF v_promo.expires_at IS NOT NULL AND v_promo.expires_at < NOW() THEN
    RETURN QUERY SELECT FALSE, 'This code has expired'::TEXT, NULL::TEXT, NULL::NUMERIC, NULL::NUMERIC, NULL::UUID;
    RETURN;
  END IF;
  IF v_promo.max_redemptions IS NOT NULL AND v_promo.redemption_count >= v_promo.max_redemptions THEN
    RETURN QUERY SELECT FALSE, 'This code has reached its redemption limit'::TEXT, NULL::TEXT, NULL::NUMERIC, NULL::NUMERIC, NULL::UUID;
    RETURN;
  END IF;
  -- Table-qualified: this function's own return column is also named
  -- promo_code_id, which PL/pgSQL treats as an in-scope variable — an
  -- unqualified reference here is genuinely ambiguous (confirmed by running
  -- it: "column reference promo_code_id is ambiguous"), not just a style nit.
  IF EXISTS (
    SELECT 1 FROM promo_code_redemptions pcr
    WHERE pcr.promo_code_id = v_promo.id AND pcr.redeemed_phone = p_phone
  ) THEN
    RETURN QUERY SELECT FALSE, 'This code has already been used on this account'::TEXT, NULL::TEXT, NULL::NUMERIC, NULL::NUMERIC, NULL::UUID;
    RETURN;
  END IF;

  RETURN QUERY SELECT TRUE, 'Valid'::TEXT, v_promo.discount_type, v_promo.discount_percent, v_promo.discount_amount, v_promo.id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION redeem_promo_code(p_code TEXT, p_phone TEXT, p_order_total NUMERIC)
RETURNS TABLE(success BOOLEAN, message TEXT, discount_amount NUMERIC, redemption_id UUID) AS $$
DECLARE
  v_promo RECORD;
  v_discount NUMERIC;
  v_redemption_id UUID;
  v_customer_id UUID;
BEGIN
  SELECT * INTO v_promo FROM promo_codes WHERE code = p_code AND active = TRUE FOR UPDATE;

  IF v_promo IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Invalid promo code'::TEXT, NULL::NUMERIC, NULL::UUID;
    RETURN;
  END IF;
  IF v_promo.expires_at IS NOT NULL AND v_promo.expires_at < NOW() THEN
    RETURN QUERY SELECT FALSE, 'This code has expired'::TEXT, NULL::NUMERIC, NULL::UUID;
    RETURN;
  END IF;
  IF v_promo.max_redemptions IS NOT NULL AND v_promo.redemption_count >= v_promo.max_redemptions THEN
    RETURN QUERY SELECT FALSE, 'This code has reached its redemption limit'::TEXT, NULL::NUMERIC, NULL::UUID;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM promo_code_redemptions pcr
    WHERE pcr.promo_code_id = v_promo.id AND pcr.redeemed_phone = p_phone
  ) THEN
    RETURN QUERY SELECT FALSE, 'This code has already been used on this account'::TEXT, NULL::NUMERIC, NULL::UUID;
    RETURN;
  END IF;

  v_discount := CASE v_promo.discount_type
    WHEN 'percent' THEN ROUND(p_order_total * v_promo.discount_percent / 100.0, 2)
    ELSE v_promo.discount_amount
  END;
  v_discount := LEAST(v_discount, p_order_total);

  UPDATE promo_codes SET redemption_count = redemption_count + 1 WHERE id = v_promo.id;

  SELECT id INTO v_customer_id FROM customers WHERE whatsapp_number = p_phone;

  INSERT INTO promo_code_redemptions (promo_code_id, redeemed_phone, customer_id, discount_applied)
  VALUES (v_promo.id, p_phone, v_customer_id, v_discount)
  RETURNING id INTO v_redemption_id;

  RETURN QUERY SELECT TRUE, 'Redeemed'::TEXT, v_discount, v_redemption_id;
END;
$$ LANGUAGE plpgsql;

-- Warranty status (Phase 10) — computed, not manually maintained (REQ-9.3).
CREATE OR REPLACE VIEW v_warranty_status AS
SELECT
  w.*,
  CASE
    WHEN w.status = 'voided' THEN 'voided'
    WHEN CURRENT_DATE > w.end_date THEN 'expired'
    ELSE 'active'
  END AS effective_status,
  GREATEST(w.end_date - CURRENT_DATE, 0) AS days_remaining
FROM warranties w;

-- One warranty per warrantied line item when its order completes
-- (delivered+paid). Matches products by name (item->>'name', falling back
-- to item->>'product') — same pattern as Phase 4's stock-reservation
-- trigger, since order line items have no product_id.
CREATE OR REPLACE FUNCTION handle_order_completed_warranty()
RETURNS trigger AS $$
DECLARE
  item jsonb;
  v_name TEXT;
  v_product_id UUID;
  v_warranty_years INT;
BEGIN
  IF NEW.status = 'delivered' AND NEW.payment_status = 'paid'
     AND (OLD.status IS DISTINCT FROM 'delivered' OR OLD.payment_status IS DISTINCT FROM 'paid') THEN
    FOR item IN SELECT * FROM jsonb_array_elements(NEW.items)
    LOOP
      v_name := COALESCE(item->>'name', item->>'product');
      IF v_name IS NULL THEN CONTINUE; END IF;

      SELECT id, warranty_years INTO v_product_id, v_warranty_years FROM products WHERE name = v_name;

      IF v_warranty_years IS NOT NULL THEN
        INSERT INTO warranties (warranty_number, order_id, customer_id, product_id, product_name, start_date, end_date)
        VALUES (
          'WTY-' || to_char(nextval('warranty_number_seq'), 'FM00000'),
          NEW.id, NEW.customer_id, v_product_id, v_name,
          CURRENT_DATE, CURRENT_DATE + (v_warranty_years || ' years')::interval
        );
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Fires alongside handle_order_completed (Phase 3) and
-- handle_order_stock_reservation (Phase 4) on the same event — separate
-- function, separate concern.
DROP TRIGGER IF EXISTS trg_order_completed_warranty ON orders;
CREATE TRIGGER trg_order_completed_warranty
AFTER UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION handle_order_completed_warranty();

-- Validates against the warranty at creation time (REQ-9.5), and
-- auto-escalates real defects/delivery damage (REQ-9.6). priority_score=3
-- matches this system's real 1-3 scale, not the spec's literal 10.
CREATE OR REPLACE FUNCTION handle_new_service_ticket()
RETURNS trigger AS $$
DECLARE
  v_effective_status TEXT;
BEGIN
  IF NEW.warranty_id IS NOT NULL THEN
    SELECT effective_status INTO v_effective_status FROM v_warranty_status WHERE id = NEW.warranty_id;
    NEW.warranty_valid := (v_effective_status = 'active');
  END IF;

  IF NEW.issue_type IN ('defect', 'delivery_damage') THEN
    NEW.priority := 'high';
    UPDATE customers SET priority_score = 3, priority_label = 'high', priority_updated_at = NOW()
    WHERE id = NEW.customer_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_new_service_ticket ON service_tickets;
CREATE TRIGGER trg_new_service_ticket
BEFORE INSERT ON service_tickets
FOR EACH ROW EXECUTE FUNCTION handle_new_service_ticket();

-- ── Business Intelligence views (Phase 11, Appendix A.6) ──────────────────────
-- Pure reporting, no new tables. Corrections from the spec's literal SQL:
-- status='delivered' AND payment_status='paid' (not 'completed'), item->>'qty'
-- (not 'quantity'), and the same name/product key fallback Phase 4/10 use.
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

-- ── seed: Nidikumba Mattresses catalog (Phase — real catalog, migration 015) ──
-- Real prices confirmed directly against "The Natural Choice Pvt Ltd" price
-- list (Kurunagala promotion pricing, adopted as the real standing catalog
-- per the user). variants shape is {size, dimension, price} — dimension is
-- the exact WxL in inches (e.g. "72x36"), the real per-unit variant now,
-- since each product has exactly one fixed thickness (no more {size,height}
-- spring-thickness variants — thickness is fixed per product, named in its
-- description). "Extra Large" is a real 5th size category alongside
-- Single/Double/Queen/King.
INSERT INTO products (category, name, collection, spring_type, description, has_pillow_top_option, free_pillows_included, warranty_years, pillow_top_addon_price, variants)
SELECT * FROM (VALUES
  ('mattress', 'Ayu Sleep 6', 'Ayu Sleep', 'Foam',
   'Therapeutic 6" firm foam mattress built for back pain relief — no pillow top, no soft comfort layer, just firm direct support that keeps the spine aligned.',
   FALSE, 0, 12, NULL::numeric,
   '[{"size":"Single","dimension":"72x36","price":28500},{"size":"Single","dimension":"75x36","price":29400},{"size":"Single","dimension":"78x36","price":30400},{"size":"Single","dimension":"84x36","price":32800},{"size":"Double","dimension":"72x48","price":36200},{"size":"Double","dimension":"75x48","price":37800},{"size":"Double","dimension":"78x48","price":39100},{"size":"Double","dimension":"84x48","price":42100},{"size":"Queen","dimension":"72x60","price":44300},{"size":"Queen","dimension":"75x60","price":45800},{"size":"Queen","dimension":"78x60","price":47500},{"size":"Queen","dimension":"84x60","price":51200},{"size":"King","dimension":"72x72","price":52400},{"size":"King","dimension":"75x72","price":54100},{"size":"King","dimension":"78x72","price":56700},{"size":"King","dimension":"72x84","price":59400},{"size":"Extra Large","dimension":"75x78","price":58000},{"size":"Extra Large","dimension":"78x78","price":61800},{"size":"Extra Large","dimension":"84x75","price":63900},{"size":"Extra Large","dimension":"84x78","price":65400},{"size":"Extra Large","dimension":"84x84","price":70300}]'::jsonb),

  ('mattress', 'Nidikumba Rise', 'Rise', 'Continuous Spring',
   '8.5" continuous-spring mattress — a cost-efficient coil construction, firmer than the Signature, aimed at budget-conscious customers who still need real back support. Optional pillow-top upgrade available.',
   TRUE, 4, 12, 25000,
   '[{"size":"Single","dimension":"72x36","price":39700},{"size":"Single","dimension":"75x36","price":42300},{"size":"Single","dimension":"78x36","price":43600},{"size":"Single","dimension":"84x36","price":45100},{"size":"Double","dimension":"72x48","price":47000},{"size":"Double","dimension":"75x48","price":48100},{"size":"Double","dimension":"78x48","price":49100},{"size":"Double","dimension":"84x48","price":50800},{"size":"Queen","dimension":"72x60","price":52100},{"size":"Queen","dimension":"75x60","price":53800},{"size":"Queen","dimension":"78x60","price":54900},{"size":"Queen","dimension":"84x60","price":61500},{"size":"King","dimension":"72x72","price":62600},{"size":"King","dimension":"75x72","price":63400},{"size":"King","dimension":"78x72","price":64900},{"size":"King","dimension":"72x84","price":69500},{"size":"Extra Large","dimension":"75x78","price":67800},{"size":"Extra Large","dimension":"78x78","price":70700},{"size":"Extra Large","dimension":"84x75","price":74700},{"size":"Extra Large","dimension":"84x78","price":76600},{"size":"Extra Large","dimension":"84x84","price":82800}]'::jsonb),

  ('mattress', 'Nidikumba Signature', 'Signature', 'Bonnell Spring',
   '10.5" classic Bonnell-spring innerspring mattress with a bouncy, responsive feel. Optional pillow-top upgrade available.',
   TRUE, 4, 12, 25000,
   '[{"size":"Single","dimension":"72x36","price":47500},{"size":"Single","dimension":"75x36","price":49800},{"size":"Single","dimension":"78x36","price":50800},{"size":"Single","dimension":"84x36","price":53300},{"size":"Double","dimension":"72x48","price":55200},{"size":"Double","dimension":"75x48","price":56800},{"size":"Double","dimension":"78x48","price":58100},{"size":"Double","dimension":"84x48","price":59400},{"size":"Queen","dimension":"72x60","price":62100},{"size":"Queen","dimension":"75x60","price":66400},{"size":"Queen","dimension":"78x60","price":67400},{"size":"Queen","dimension":"84x60","price":70000},{"size":"King","dimension":"72x72","price":72600},{"size":"King","dimension":"75x72","price":73900},{"size":"King","dimension":"78x72","price":75500},{"size":"King","dimension":"72x84","price":82400},{"size":"Extra Large","dimension":"75x78","price":78800},{"size":"Extra Large","dimension":"78x78","price":83600},{"size":"Extra Large","dimension":"84x75","price":85800},{"size":"Extra Large","dimension":"84x78","price":87700},{"size":"Extra Large","dimension":"84x84","price":96100}]'::jsonb),

  ('mattress', 'Nidikumba Ayu Spring', 'Ayu Pocketed', 'Pocket Spring',
   '8.5" pocket-spring mattress — the flagship of the range, with individually-wrapped coils for superior motion isolation, contouring, and orthopedic support. Positioned as the premium/luxury option. Optional pillow-top upgrade available.',
   TRUE, 4, 12, 25000,
   '[{"size":"Single","dimension":"72x36","price":50500},{"size":"Single","dimension":"75x36","price":52500},{"size":"Single","dimension":"78x36","price":54300},{"size":"Single","dimension":"84x36","price":60500},{"size":"Double","dimension":"72x48","price":62700},{"size":"Double","dimension":"75x48","price":65700},{"size":"Double","dimension":"78x48","price":67700},{"size":"Double","dimension":"84x48","price":70500},{"size":"Queen","dimension":"72x60","price":74500},{"size":"Queen","dimension":"75x60","price":77700},{"size":"Queen","dimension":"78x60","price":80800},{"size":"Queen","dimension":"84x60","price":86500},{"size":"King","dimension":"72x72","price":87500},{"size":"King","dimension":"75x72","price":93500},{"size":"King","dimension":"78x72","price":97500},{"size":"King","dimension":"72x84","price":101500},{"size":"Extra Large","dimension":"75x78","price":99500},{"size":"Extra Large","dimension":"78x78","price":107000},{"size":"Extra Large","dimension":"84x75","price":114000},{"size":"Extra Large","dimension":"84x78","price":116700},{"size":"Extra Large","dimension":"84x84","price":124000}]'::jsonb),

  ('pillow', 'Bolster Pillow', NULL, NULL,
   'Firm cylindrical support pillow. Given free (4 per qualifying mattress) or purchasable separately.',
   FALSE, 0, 5, NULL, '[{"price":2500}]'::jsonb),
  ('pillow', 'Gel Pillow', NULL, NULL,
   'Cooling gel-infused pillow. Given free (4 per qualifying mattress) or purchasable separately.',
   FALSE, 0, 5, NULL, '[{"price":4500}]'::jsonb)
) AS seed(category, name, collection, spring_type, description, has_pillow_top_option, free_pillows_included, warranty_years, pillow_top_addon_price, variants)
WHERE NOT EXISTS (SELECT 1 FROM products);
