-- Phase 1 (Module 2) — Staff Roles & Access Control
-- Apply to the running database with:
--   docker exec -i crm-postgres psql -U crm -d crm < migrations/001_staff_roles.sql

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

CREATE INDEX IF NOT EXISTS idx_staff_users_role ON staff_users(role);
