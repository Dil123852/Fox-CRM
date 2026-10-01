ALTER TABLE leads
  DROP COLUMN IF EXISTS week_1_date,
  DROP COLUMN IF EXISTS week_1_sent_at,
  DROP COLUMN IF EXISTS week_2_date,
  DROP COLUMN IF EXISTS week_2_sent_at,
  DROP COLUMN IF EXISTS week_3_date,
  DROP COLUMN IF EXISTS week_3_sent_at,
  DROP COLUMN IF EXISTS week_4_date,
  DROP COLUMN IF EXISTS week_4_sent_at;
