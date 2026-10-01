-- 046: Record the discounts an order was actually given.
--
-- The problem this fixes is a real billing error, not a cosmetic one.
--
-- Two discounts are applied when an order is placed — the volume discount
-- (flat LKR off once 2+ mattresses are in the cart, computed client-side in
-- ShowroomOrderModal/ChatOrderModal) and a promo code's discount. Both were
-- subtracted from the figure sent as `totalAmount`, and then THROWN AWAY: no
-- column held either one. The only trace was an English sentence appended to
-- orders.notes ("Volume discount applied: -LKR 1,500 (2 mattresses)"), which
-- nothing can compute against.
--
-- The consequence, measured against the live database before writing this:
-- the invoice PDF derives its total by summing the line items, because it had
-- nothing else to derive it from. The line items are GROSS. So for every
-- discounted order the invoice printed a total HIGHER than orders.total_amount
-- — 6 of 17 real orders, each overstated by LKR 1,500. The customer was shown
-- a bill larger than the order they agreed to.
--
-- Storing the discount makes the invoice able to show the line the customer
-- needs to see ("Promo SAVE10  - LKR 3,000") AND land on the same total the
-- books already hold. The alternative considered and rejected was reading
-- promo_code_redemptions.discount_applied via its order_id: that link is only
-- written by PATCH /api/promo-codes/redemptions/:id, which is gated to
-- admin/finance while a sales_agent is who places orders — so the link fails
-- silently for exactly the common case. (There are also zero redemption rows
-- in the live database today, so that route would print nothing at all.) And
-- it could never recover the volume discount, which is not a promo code.
--
-- Columns are nullable with no default rather than DEFAULT 0, so "no discount
-- was given" (NULL) stays distinguishable from "a discount of zero was
-- computed" — and so every historical row is untouched rather than being
-- retroactively claimed to have had a zero discount.

-- orders is a VIEW over orders_all (migration 036) — the column goes on the
-- base table.
ALTER TABLE orders_all
  ADD COLUMN IF NOT EXISTS promo_code       TEXT,
  ADD COLUMN IF NOT EXISTS promo_discount   NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS volume_discount  NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS discount_total   NUMERIC(12,2);

COMMENT ON COLUMN orders_all.promo_code IS
  'The promo code applied at placement, as typed. Denormalised on purpose: promo_codes rows are editable and deletable, and an invoice must keep printing the code the customer actually used.';
COMMENT ON COLUMN orders_all.promo_discount IS
  'LKR taken off by the promo code. NULL = no promo code was applied.';
COMMENT ON COLUMN orders_all.volume_discount IS
  'LKR taken off by the 2+/3+ mattress volume rule. NULL = the rule did not apply.';
COMMENT ON COLUMN orders_all.discount_total IS
  'promo_discount + volume_discount. Stored rather than computed so the invoice has one figure to reconcile against total_amount even if another discount kind is added later.';

-- A discount can never be negative. It is subtracted, so a negative value
-- would silently INCREASE what the customer is billed.
--
-- Dropped first because ADD CONSTRAINT has no IF NOT EXISTS in Postgres, and
-- this migration must be safe to re-run.
ALTER TABLE orders_all DROP CONSTRAINT IF EXISTS orders_discounts_non_negative;
ALTER TABLE orders_all
  ADD CONSTRAINT orders_discounts_non_negative
  CHECK (
    (promo_discount  IS NULL OR promo_discount  >= 0) AND
    (volume_discount IS NULL OR volume_discount >= 0) AND
    (discount_total  IS NULL OR discount_total  >= 0)
  );

-- A promo discount without the code it came from cannot be printed on an
-- invoice ("Promo  - LKR 3,000" tells the customer nothing), so the two must
-- arrive together.
ALTER TABLE orders_all DROP CONSTRAINT IF EXISTS orders_promo_discount_needs_code;
ALTER TABLE orders_all
  ADD CONSTRAINT orders_promo_discount_needs_code
  CHECK (
    promo_discount IS NULL
    OR promo_discount = 0
    OR (promo_code IS NOT NULL AND length(btrim(promo_code)) > 0)
  );

-- A view does not pick up a new column on its base table, so it has to be
-- rebuilt or the columns are invisible to every query in the app. Dropping the
-- view also drops its INSTEAD OF DELETE trigger, which is what makes a delete
-- soft — it is recreated below. (Same sequence as migration 040.)
DROP VIEW IF EXISTS orders;
CREATE VIEW orders AS SELECT * FROM orders_all WHERE deleted_at IS NULL;

CREATE TRIGGER trg_soft_delete INSTEAD OF DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION soft_delete_view();

COMMENT ON VIEW orders IS
  'Live orders only. The real table is orders_all, which also holds soft-deleted rows (deleted_at IS NOT NULL). Query orders_all directly only to show or restore deleted records.';

-- ── Backfill the orders whose discount survives only as prose ────────────────
-- Confirmed with the user that orders.total_amount is the figure the customer
-- is genuinely billed, so these rows already hold the right money — what is
-- missing is only the RECORD of why it is lower than the line items.
--
-- The volume discount is recovered from the sentence the modal wrote, not
-- guessed and not recomputed from the cart: recomputing would re-apply today's
-- rule to a historical order that may have been placed under a different one.
-- Matching on the literal format that ShowroomOrderModal/ChatOrderModal emit,
-- with the thousands separator optional.
--
-- Only rows that have no discount recorded yet are touched, so re-running this
-- migration cannot double-count.
UPDATE orders_all
SET volume_discount = sub.amount,
    discount_total  = COALESCE(discount_total, 0) + sub.amount
FROM (
  SELECT id,
         replace(
           (regexp_match(notes, 'Volume discount applied: -LKR ([0-9,]+)'))[1],
           ',', ''
         )::NUMERIC AS amount
  FROM orders_all
  WHERE notes ~ 'Volume discount applied: -LKR [0-9,]+'
) AS sub
WHERE orders_all.id = sub.id
  AND orders_all.volume_discount IS NULL;

UPDATE orders_all
SET promo_code     = sub.code,
    promo_discount = sub.amount,
    discount_total = COALESCE(discount_total, 0) + sub.amount
FROM (
  SELECT id,
         (regexp_match(notes, 'Promo code ([^ ]+) applied: -LKR [0-9,]+'))[1] AS code,
         replace(
           (regexp_match(notes, 'Promo code [^ ]+ applied: -LKR ([0-9,]+)'))[1],
           ',', ''
         )::NUMERIC AS amount
  FROM orders_all
  WHERE notes ~ 'Promo code [^ ]+ applied: -LKR [0-9,]+'
) AS sub
WHERE orders_all.id = sub.id
  AND orders_all.promo_discount IS NULL;
