-- Two related additions, confirmed with the user:
--
-- 1. Four concrete weekly follow-up dates (replacing the single rolling
--    next_weekly_follow_up_date from migration 018's design). Set all at
--    once when staff mark follow_up_2_done=true — +7/+14/+21/+28 days from
--    that moment — not one-at-a-time as each is reached. All 4 stay
--    editable afterward. Each date, when it passes, triggers its own
--    automated WhatsApp promo send (the user wants the promo repeated on
--    every one of the 4 scheduled weeks, not just once as originally
--    built) — tracked per-date with its own *_sent_at so each of the 4 is
--    independently idempotent, same guard pattern as the original
--    promo_sent_at.
--
-- 2. Ticket closing, with a required reason visible to admins for team
--    monitoring. ticket_state/closed_at/closed_reason already existed
--    (Phase 3) but were never wired to any route or UI — this finally uses
--    them for exactly what they were built for. Reopening is allowed
--    (is_returning_contact/reopened_from_lead_id already exist too, but
--    reopening here just flips ticket_state back rather than creating a
--    new linked lead row — simpler, and the user asked for a straight
--    reopen, not a new-ticket-linked-to-old one).
--
-- Apply with:
--   docker exec -i crm-postgres psql -U crm -d crm < migrations/020_weekly_followup_and_close_reason.sql

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS week_1_date DATE,
  ADD COLUMN IF NOT EXISTS week_1_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS week_2_date DATE,
  ADD COLUMN IF NOT EXISTS week_2_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS week_3_date DATE,
  ADD COLUMN IF NOT EXISTS week_3_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS week_4_date DATE,
  ADD COLUMN IF NOT EXISTS week_4_sent_at TIMESTAMPTZ;
