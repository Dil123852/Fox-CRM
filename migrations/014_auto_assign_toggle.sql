-- Phase 15.3 — Auto-assign toggle. A global on/off switch for the whole
-- team (not per-staff-member — that's a reasonable future addition, not
-- blocking this phase per PHASE_14_15 planning doc).
-- Apply with:
--   docker exec -i crm-postgres psql -U crm -d crm < migrations/014_auto_assign_toggle.sql

CREATE TABLE IF NOT EXISTS app_settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
INSERT INTO app_settings (key, value) VALUES ('auto_assign_enabled', 'true')
  ON CONFLICT (key) DO NOTHING;

-- handle_new_lead_assignment now checks app_settings first — if disabled,
-- the new ticket is left unassigned (assigned_staff_id/sla_deadline stay
-- NULL) instead of round-robin-assigning it. Everything else unchanged.
CREATE OR REPLACE FUNCTION handle_new_lead_assignment()
RETURNS trigger AS $$
DECLARE
  v_staff_id uuid;
  v_priority_label text;
  v_sla_interval interval;
  v_auto_assign_enabled boolean;
BEGIN
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
