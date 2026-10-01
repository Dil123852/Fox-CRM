-- Per-lead priority, editable by staff directly on the Pipeline table.
-- Deliberately separate from customers.priority_label/priority_score
-- (AI-driven, chat-scoring, affects SLA deadline calculation at
-- assignment time) — the user was explicit this is a different concept:
-- "not the whatsapp chat priority ... for every lead". One customer can
-- have several leads/tickets over time, each with its own priority here.
--
-- Apply with:
--   docker exec -i crm-postgres psql -U crm -d crm < migrations/019_lead_priority.sql

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('high', 'medium', 'low'));
