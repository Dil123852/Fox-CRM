-- Phase 16 — real Dwesk/Dialog incoming-call webhook payload finally
-- confirmed (customerCli, dateTime, callId, companyId, callFlowId), replacing
-- the field-name guesses migration 005 shipped with. That guesswork read
-- from/phone_number/caller_id and duration/call_duration/call_type — none of
-- which exist in the real payload. The real webhook fires at ring-time only,
-- with no duration or answered/missed outcome field at all, so the old
-- missed-call-only ticket logic no longer applies: every incoming call now
-- opens a ticket (getOrCreateOpenTicket already dedupes against an existing
-- open one, so a customer calling twice in a row doesn't get two tickets).
--
-- call_id is Dwesk's own idempotency key for this event — stored unique so a
-- retried webhook delivery (network timeout, Dwesk's own retry-on-non-2xx
-- behavior per the doc's section 6) doesn't create a duplicate call_events
-- row or double-open a ticket.

ALTER TABLE call_events
  ADD COLUMN IF NOT EXISTS dialog_call_id     TEXT,
  ADD COLUMN IF NOT EXISTS dialog_company_id  TEXT,
  ADD COLUMN IF NOT EXISTS dialog_call_flow_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_events_dialog_call_id
  ON call_events(dialog_call_id)
  WHERE dialog_call_id IS NOT NULL;
