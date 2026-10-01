-- Phase 13 Item 1 — CRITICAL fix: outbound sends were logged/broadcast as
-- successful regardless of whether the provider actually accepted them.
-- Apply with:
--   docker exec -i crm-postgres psql -U crm -d crm < migrations/010_delivery_status.sql
--
-- Root cause (confirmed by reading the code, not assumed): processIncomingMessage's
-- chunk-send loop and its escalation-bridge send both wrapped
-- sendWhatsAppMessage() in a try/catch that only logged the error and then
-- UNCONDITIONALLY proceeded to insert the message and broadcast it as sent.
-- /api/send-message already tracked success correctly in its API response
-- (waSent), but the frontend (MessageInput.jsx) never checked it, and
-- MessageBubble.jsx rendered a green delivered-tick on every outbound
-- message unconditionally, regardless of delivery_failed. This column is
-- what index.js now sets accurately, and what the frontend now reads.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS delivery_failed BOOLEAN DEFAULT FALSE;
