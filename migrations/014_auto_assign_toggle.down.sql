-- Rollback for 014_auto_assign_toggle.sql — restores
-- handle_new_lead_assignment exactly as it was before the toggle check, and
-- drops app_settings.
CREATE OR REPLACE FUNCTION handle_new_lead_assignment()
RETURNS trigger AS $$
DECLARE
  v_staff_id uuid;
  v_priority_label text;
  v_sla_interval interval;
BEGIN
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

DROP TABLE IF EXISTS app_settings;
