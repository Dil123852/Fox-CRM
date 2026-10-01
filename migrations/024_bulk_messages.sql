-- Bulk Messages history — the new admin-only Bulk Messages page (filters
-- leads by priority/product/source, picks recipients, sends one message +
-- optional image to all of them) had no record of what was sent. Every send
-- lands in `messages` like any other staff-sent row, but nothing there ties
-- a batch of those rows back together or records the image URL used — you
-- can't tell "these 40 messages were one bulk send" from the messages table
-- alone. Two tables, same shape as campaigns/campaign_sends (Phase 7): one
-- row per send action, one row per recipient in that action.
CREATE TABLE IF NOT EXISTS bulk_message_batches (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sent_by      UUID        REFERENCES staff_users(id),
  message      TEXT        NOT NULL,
  image_url    TEXT,
  sent_count   INTEGER     NOT NULL DEFAULT 0,
  total_count  INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bulk_message_recipients (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id     UUID        NOT NULL REFERENCES bulk_message_batches(id) ON DELETE CASCADE,
  customer_id  UUID        NOT NULL REFERENCES customers(id),
  sent         BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bulk_message_recipients_batch_id ON bulk_message_recipients(batch_id);
CREATE INDEX IF NOT EXISTS idx_bulk_message_recipients_customer_id ON bulk_message_recipients(customer_id);
CREATE INDEX IF NOT EXISTS idx_bulk_message_batches_created_at ON bulk_message_batches(created_at);
