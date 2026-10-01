-- Revert 033: drop pillow_top from the lead item key.
--
-- NOTE: this can fail if a lead legitimately holds both the plain and the
-- pillow-top version of the same product+size — which is exactly what 033
-- exists to allow. Remove one of the pair before reverting.

DROP INDEX IF EXISTS idx_lead_items_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_items_unique
  ON lead_items(lead_id, lower(coalesce(product_type, '')), lower(coalesce(bed_size, '')));
