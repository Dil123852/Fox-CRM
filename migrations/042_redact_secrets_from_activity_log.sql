-- 042: keep secrets out of the activity log
--
-- SECURITY FIX. log_activity() (migration 035) records whole rows, so every
-- write to staff_users put that account's bcrypt password_hash into
-- activity_log.changes — including the before AND after value on a password
-- change. Confirmed against live data: 15 rows held a hash, and a `viewer`
-- account was able to read another staff member's hash through
-- GET /api/activity/:table/:id, which was ungated.
--
-- The route is now gated, but that alone is not enough: the secret is still in
-- the table, so any future reader, export or backup carries it. This redacts
-- at the source and scrubs what was already written.

CREATE OR REPLACE FUNCTION log_activity() RETURNS TRIGGER AS $$
DECLARE
  v_changes JSONB;
  v_id      TEXT;
  v_row     JSONB;
  v_old     JSONB;
BEGIN
  v_row := to_jsonb(COALESCE(NEW, OLD));
  v_id  := COALESCE(v_row->>'id', '');

  -- Never record a credential or a session artefact. Stripped from both sides
  -- of the diff, so a password change logs THAT it happened and by whom, but
  -- not the hashes. Listed explicitly rather than by pattern: a silent
  -- heuristic would be easy to outgrow without noticing.
  v_row := v_row - 'password_hash' - 'failed_login_count' - 'locked_until' - 'last_failed_login_at';

  IF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD) - 'password_hash' - 'failed_login_count' - 'locked_until' - 'last_failed_login_at';

    SELECT jsonb_object_agg(n.key, jsonb_build_object('from', v_old->n.key, 'to', n.value))
      INTO v_changes
      FROM jsonb_each(v_row) n
     WHERE n.value IS DISTINCT FROM v_old->n.key
       AND n.key <> 'updated_at';

    IF v_changes IS NULL THEN RETURN NEW; END IF;

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

-- Scrub the hashes already recorded. activity_log is append-only by rule
-- (DO INSTEAD NOTHING on UPDATE/DELETE), so the rule is dropped for this one
-- statement and restored immediately — the alternative is leaving a live
-- credential in the table.
DROP RULE IF EXISTS activity_log_no_update ON activity_log;

UPDATE activity_log
   SET changes = changes #- '{password_hash}'
                         #- '{failed_login_count}'
                         #- '{locked_until}'
                         #- '{last_failed_login_at}'
 WHERE table_name IN ('staff_users', 'staff_users_all')
   AND changes IS NOT NULL;

CREATE RULE activity_log_no_update AS ON UPDATE TO activity_log DO INSTEAD NOTHING;
