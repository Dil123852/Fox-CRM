-- Phase 17 — Dwesk/Dialog webhook integration retired in favor of a
-- self-built Android call-tracker app (reads the phone's own call log,
-- POSTs synced entries to this CRM). Confirmed with the user: Dwesk's
-- /webhook/dialog never received a real request in testing (the ngrok
-- request log showed zero deliveries from Dwesk's servers, only our own
-- manual test POSTs), and the user built their own app instead.
--
-- call_events and customers.channel='call' are kept — they're generic, not
-- Dwesk-specific, so the new app's synced calls land in the same table/
-- channel the dashboard's existing call-history UI already reads from.
-- Only the 3 dialog_*-specific columns (added in migration 022 for Dwesk's
-- customerCli/dateTime/callId/companyId/callFlowId payload shape) are
-- dropped, since nothing populates them anymore.

DROP INDEX IF EXISTS idx_call_events_dialog_call_id;

ALTER TABLE call_events
  DROP COLUMN IF EXISTS dialog_call_id,
  DROP COLUMN IF EXISTS dialog_company_id,
  DROP COLUMN IF EXISTS dialog_call_flow_id;

-- The call-tracker app syncs a batch of call-log entries per tap of "Sync
-- Calls" — potentially re-sending calls already synced in an earlier batch
-- (there's no since-timestamp/cursor in its payload). contact_name and
-- sim_slot are real fields this app sends that Dwesk's payload never had.
ALTER TABLE call_events
  ADD COLUMN IF NOT EXISTS contact_name TEXT,
  ADD COLUMN IF NOT EXISTS sim_slot     INTEGER,
  ADD COLUMN IF NOT EXISTS dedup_key    TEXT;

-- Natural key: same number + same call timestamp + same duration + same
-- direction can only be one real call-log entry. Lets a re-synced batch be
-- inserted idempotently without needing the app to track what it already
-- sent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_call_events_dedup_key
  ON call_events(dedup_key)
  WHERE dedup_key IS NOT NULL;
