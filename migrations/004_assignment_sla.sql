-- Phase 5 — Assignment, SLA & Staff Accountability (Module 4 core)
-- Apply with:
--   docker exec -i crm-postgres psql -U crm -d crm < migrations/004_assignment_sla.sql
--
-- Scope note: the kickoff prompt's deliverable list is assignment (7.1), SLA
-- countdown + automatic overdue marking (subset of 7.2), and staff performance
-- dashboard queries (7.4) — NOT proactive alerts (REQ-4.5) or auto-reassignment
-- escalation (REQ-4.6), both of which need a scheduler/cron this codebase
-- doesn't have. "Overdue" is computed live via a view, which is stronger than
-- a periodically-flipped flag (never stale between polls) but can't itself
-- push a notification or mutate a row without something driving it.
--
-- Also NOT built: the full staff_activity_log table (REQ-4.7/4.8, section 7.3)
-- — that's a broader audit trail (view/order-created events across every
-- route) the kickoff prompt's deliverable list doesn't call for. What overdue
-- detection actually needs — "was there a recorded staff action since
-- assignment" — is answered directly from messages.sender_type instead.
--
-- Load-bearing prerequisite fix: messages had no way to distinguish an AI
-- auto-reply from a staff-sent message. Without that, "no staff action
-- recorded" would count the AI's instant reply as staff action, and overdue
-- would never fire, and time-to-first-contact/SLA-compliance would measure
-- the bot instead of the human. sender_type is tagged at the two places
-- messages actually get inserted (see index.js).

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS sender_type TEXT CHECK (sender_type IS NULL OR sender_type IN ('ai', 'staff'));

-- Leads — assignment + SLA fields
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS assigned_staff_id  UUID REFERENCES staff_users(id),
  ADD COLUMN IF NOT EXISTS assigned_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_deadline       TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_leads_assigned_staff_id ON leads(assigned_staff_id);

-- Trigger — auto-assign every new ticket to the active sales_agent with the
-- fewest currently-open assigned tickets (REQ-4.1), and start its SLA clock
-- from the customer's current priority segment (REQ-4.3, thresholds from 7.2,
-- Hot/Warm/Cold renamed to the real high/medium/low labels).
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
  -- If no active sales_agent exists, the ticket is created unassigned rather
  -- than failing the insert — graceful degradation, not silent data loss.

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_new_lead_assignment ON leads;
CREATE TRIGGER trg_new_lead_assignment
BEFORE INSERT ON leads
FOR EACH ROW EXECUTE FUNCTION handle_new_lead_assignment();

-- View — per-lead SLA status, computed live (REQ-4.4). "Staff action" means a
-- staff-sent outbound message after assignment — the same signal that makes
-- time-to-first-contact and SLA-compliance% (7.4) measure real humans.
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
-- through orders.lead_id (Phase 3) using "delivered + paid" as "completed",
-- same convention as everywhere else in this codebase.
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
