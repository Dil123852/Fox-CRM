-- Automated follow-up scheduling: on lead creation, auto-set two call
-- reminder dates (day 2, day 4). Both are dashboard reminders only, no
-- auto-send tied to them — a logged/handled call just clears its own
-- *_done flag, the other date is unaffected (confirmed with the user).
-- After follow_up_2's date passes with the lead still open, a new
-- scheduler (whatsapp-backend/scheduler.js) sends one automated WhatsApp
-- promo image+caption (admin-configured via app_settings, see below) and
-- switches the lead into open-ended weekly reminder mode
-- (next_weekly_follow_up_date, rolling +7 days each time it's reached,
-- until the lead is won/lost) — no further auto-sends after that, weekly
-- reminders are dashboard-only like the first two calls.
--
-- All four dates are staff-editable at any time (PATCH /api/leads/:id
-- already accepts arbitrary allowed fields — these are added to that list).
--
-- Apply with:
--   docker exec -i crm-postgres psql -U crm -d crm < migrations/018_automated_followup_schedule.sql

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS follow_up_1_date DATE,
  ADD COLUMN IF NOT EXISTS follow_up_1_done BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS follow_up_2_date DATE,
  ADD COLUMN IF NOT EXISTS follow_up_2_done BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS promo_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_weekly_follow_up_date DATE;

-- Extends the existing BEFORE INSERT trigger (Phase 5, handle_new_lead_assignment)
-- rather than adding a second trigger on the same event — one INSERT, one
-- pass. Follow-up dates are set unconditionally (independent of the
-- auto_assign_enabled toggle above them in this function): staff still want
-- call reminders on a lead even with auto-assignment switched off.
CREATE OR REPLACE FUNCTION handle_new_lead_assignment()
RETURNS TRIGGER AS $$
DECLARE
  v_staff_id uuid;
  v_priority_label text;
  v_sla_interval interval;
  v_auto_assign_enabled boolean;
BEGIN
  NEW.follow_up_1_date := (NOW() + INTERVAL '2 days')::date;
  NEW.follow_up_2_date := (NOW() + INTERVAL '4 days')::date;

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
