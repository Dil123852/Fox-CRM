-- Restores handle_new_lead_assignment() to its pre-025 form (no
-- assigned_staff_id-already-set short-circuit) — round-robin for every new
-- lead, unconditionally.
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
