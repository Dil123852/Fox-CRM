-- Call-owner lead assignment. Confirmed with the user: every staff member
-- carries their own phone (the Android call-tracker app), so a call that
-- reaches Janith's phone should assign straight to Janith, not round-robin
-- to whoever has the fewest open tickets — the same round-robin every other
-- channel (WhatsApp, web chat, showroom visits) keeps using unchanged.
--
-- The match happens in whatsapp-backend/index.js (POST /api/calls and
-- /api/calls/start), which now looks up staff_users.phone against the
-- device's own registered owner phone (sent by the app as `ownerPhone`) and
-- passes a resolved assigned_staff_id straight into the leads INSERT. This
-- migration only has to make handle_new_lead_assignment() get out of the
-- way when that's already been set — everything else about the trigger
-- (follow-up dates, SLA deadline math) stays identical, just computed
-- against whichever staff id ends up on the row, forced or round-robin.
-- Falls back to the existing round-robin untouched when the calling number
-- doesn't match any active staff phone (confirmed with the user) — this
-- migration doesn't change that path at all.
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

  -- Already resolved by the caller (call-owner match) — skip round-robin
  -- entirely, but still compute assigned_at/sla_deadline for this forced
  -- assignee, same as the round-robin path below would.
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
