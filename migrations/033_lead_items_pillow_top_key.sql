-- 033: pillow-top is part of a lead item's identity
--
-- Migration 031's unique key was (lead_id, product_type, bed_size), which
-- treated "Nidikumba Ayu Spring 75x72" and "Nidikumba Ayu Spring 75x72 with
-- the pillow-top upgrade" as the SAME item — so adding the second one was
-- rejected with "That product and size is already on this lead."
--
-- They are genuinely different things a customer can be quoted: the pillow-top
-- addon is a flat LKR 25,000 on top of the dimension's price (CLAUDE.md), so
-- they carry different unit_price values and a customer comparing the two
-- needs both on the quotation. pillow_top therefore belongs in the key.
--
-- Safe to add: pillow_top is NOT NULL DEFAULT false, so the key can never go
-- ambiguous on a NULL, and no existing row pair collides under the new key
-- (verified against live data before applying — 0 duplicate groups).

DROP INDEX IF EXISTS idx_lead_items_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_items_unique
  ON lead_items(
    lead_id,
    lower(coalesce(product_type, '')),
    lower(coalesce(bed_size, '')),
    coalesce(pillow_top, false)
  );

COMMENT ON INDEX idx_lead_items_unique IS
  'One row per (lead, product, size, pillow-top choice). The pillow-top variant is a distinct item at a different price, not a duplicate of the plain one.';
