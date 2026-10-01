-- 035: activity log — who created, changed or deleted every business record
--
-- Confirmed with the user: history is wanted for the business records behind
-- Pipeline, Orders, Customers, Inventory, Warranty, Promo codes and User
-- Management — and explicitly NOT for WhatsApp chat. So `messages` and
-- `call_events` are deliberately not audited, and neither are the bulk/campaign
-- send tables: those rows ARE the record of what happened (who sent what, when)
-- and are never edited, so auditing them would only duplicate themselves.
--
-- WHY A TRIGGER RATHER THAN CODE IN EACH ROUTE: whatsapp-backend/index.js runs
-- 164 raw pool.query() calls with no database wrapper to hook. Logging from the
-- routes would mean touching dozens of call sites and would silently miss every
-- one that was overlooked — and a missing audit row is invisible until the day
-- someone needs it. A trigger cannot be bypassed, and it also captures writes
-- made by the app's OWN triggers (stock reservation, payment recompute) which
-- no amount of route-level code would ever see.
--
-- HOW THE ACTOR IS KNOWN: Express sets `app.staff_id`/`app.staff_name` per
-- request (a transaction-local GUC) from the JWT it already verifies. A write
-- with no actor set — the follow-up scheduler, a psql session, a DB trigger —
-- records NULL and is shown as "System", which is honest rather than blaming
-- whichever staff member happened to be last.

CREATE TABLE IF NOT EXISTS activity_log (
  id          BIGSERIAL   PRIMARY KEY,
  table_name  TEXT        NOT NULL,
  record_id   TEXT        NOT NULL,
  action      TEXT        NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE', 'RESTORE')),

  -- Who. staff_id is deliberately NOT a foreign key: an audit row must outlive
  -- the staff account it refers to, and staff_users is itself soft-deletable in
  -- migration 036. staff_name/staff_role are copied in at write time for the
  -- same reason — the log must still read correctly after a rename.
  staff_id    UUID,
  staff_name  TEXT,
  staff_role  TEXT,

  -- What changed: {"field": {"from": x, "to": y}} for an UPDATE, the whole new
  -- row for an INSERT, the whole final row for a DELETE. jsonb so a field can
  -- be queried directly (e.g. everything that ever touched total_amount).
  changes     JSONB,

  -- A human label for the record, resolved at write time (order number, product
  -- name, customer name). Without it the log reads as bare UUIDs, and the real
  -- row may be gone by the time anyone looks.
  label       TEXT,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE activity_log IS
  'Append-only history of every create/update/delete on the audited business tables. Written by trg_activity_log on each table; never written by application code directly.';

-- The two real read patterns: one record''s own history (the History panel on an
-- order/lead/product) and the global admin activity feed, newest first.
CREATE INDEX IF NOT EXISTS idx_activity_log_record  ON activity_log (table_name, record_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_recent  ON activity_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_staff   ON activity_log (staff_id, created_at DESC);

-- Append-only: an audit trail that can be edited is not an audit trail. Writes
-- come only from the trigger below (which runs as the table owner and is not
-- affected by these rules).
CREATE OR REPLACE RULE activity_log_no_update AS ON UPDATE TO activity_log DO INSTEAD NOTHING;
CREATE OR REPLACE RULE activity_log_no_delete AS ON DELETE TO activity_log DO INSTEAD NOTHING;


-- Shared write step, so the branches above cannot drift apart.
CREATE OR REPLACE FUNCTION log_activity_write(
  p_table TEXT, p_id TEXT, p_action TEXT, p_changes JSONB, p_row JSONB
) RETURNS VOID AS $$
DECLARE
  v_label TEXT;
BEGIN
  -- A human name for the record. COALESCE down the columns each table actually
  -- has; ->> on a missing key is NULL, so one expression covers every table.
  v_label := COALESCE(
    p_row->>'order_number',      -- orders
    p_row->>'warranty_number',   -- warranties
    p_row->>'code',              -- promo_codes
    p_row->>'name',              -- products, customers, staff_users, influencers
    p_row->>'product_type',      -- lead_items
    p_row->>'customer_name',     -- orders (fallback)
    p_row->>'issue_type',        -- service_tickets
    p_id
  );

  INSERT INTO activity_log (table_name, record_id, action, staff_id, staff_name, staff_role, changes, label)
  VALUES (
    p_table, p_id, p_action,
    -- NULLIF because a GUC that was never set reads as '' , not NULL.
    NULLIF(current_setting('app.staff_id',   true), '')::UUID,
    NULLIF(current_setting('app.staff_name', true), ''),
    NULLIF(current_setting('app.staff_role', true), ''),
    p_changes, v_label
  );
END;
$$ LANGUAGE plpgsql;

-- ── The generic trigger ───────────────────────────────────────────────────────
-- One function for every audited table; TG_TABLE_NAME tells it where it ran.
CREATE OR REPLACE FUNCTION log_activity() RETURNS TRIGGER AS $$
DECLARE
  v_changes JSONB;
  v_id      TEXT;
  v_row     JSONB;
  v_old     JSONB;
BEGIN
  v_row := to_jsonb(COALESCE(NEW, OLD));
  v_id  := COALESCE(v_row->>'id', '');

  IF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD);

    -- Only the fields that actually changed, as {from, to}. A no-op UPDATE
    -- (the app re-saving an unchanged form) writes nothing at all, so the
    -- history stays readable instead of filling with empty entries.
    SELECT jsonb_object_agg(n.key, jsonb_build_object('from', v_old->n.key, 'to', n.value))
      INTO v_changes
      FROM jsonb_each(v_row) n
     WHERE n.value IS DISTINCT FROM v_old->n.key
       -- updated_at moves on every write and says nothing on its own.
       AND n.key <> 'updated_at';

    IF v_changes IS NULL THEN RETURN NEW; END IF;

    -- A soft delete and a restore are UPDATEs to deleted_at (migration 036),
    -- but they are what a reader actually cares about, so name them properly.
    IF v_changes ? 'deleted_at' THEN
      IF v_row->>'deleted_at' IS NOT NULL THEN
        PERFORM log_activity_write(TG_TABLE_NAME, v_id, 'DELETE', jsonb_build_object('deleted', to_jsonb(TRUE)), v_row);
        RETURN NULL;
      ELSE
        PERFORM log_activity_write(TG_TABLE_NAME, v_id, 'RESTORE', jsonb_build_object('restored', to_jsonb(TRUE)), v_row);
        RETURN NULL;
      END IF;
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    v_changes := v_row;
  ELSE
    v_changes := v_row;
  END IF;

  PERFORM log_activity_write(TG_TABLE_NAME, v_id, TG_OP, v_changes, v_row);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;


COMMENT ON FUNCTION log_activity() IS
  'Generic audit trigger. Records who (from the app.staff_* settings Express sets per request) changed what (field-level from/to diff) on the audited business tables.';


-- ── Attach to the 12 audited tables ──────────────────────────────────────────
-- Deliberately NOT attached: messages and call_events (chat/call history, the
-- user explicitly excluded these), bulk_message_batches/bulk_message_recipients
-- /campaign_sends (send logs — already a record of what happened),
-- showroom_visits and app_settings.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'leads', 'lead_items',
    'orders', 'order_payments',
    'customers',
    'products',
    'warranties', 'service_tickets',
    'promo_codes', 'promo_code_redemptions', 'influencers',
    'staff_users'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_activity_log ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_activity_log AFTER INSERT OR UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION log_activity()', t);
  END LOOP;
END $$;
