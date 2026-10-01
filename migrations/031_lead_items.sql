-- 031: a lead can hold SEVERAL products, not one.
--
-- The problem: a lead's product lives in five columns on the leads row
-- (product_type, bed_size, scale, qty, unit_price), so a customer comparing
-- two mattresses could only ever have one recorded — the second was lost.
--
-- Design: lead_items is the real store (one row per product asked about);
-- the five existing columns are KEPT and kept in sync with the FIRST item by
-- trigger. That is deliberate: 25 places already read those columns — the
-- Pipeline table, the PDF and Excel exports, GET /api/customers-directory,
-- the Bulk Messages filters, Dashboard and the convert-to-order flow. They
-- all keep working untouched and simply see "the first product". Dropping the
-- columns would mean rewriting every one of those in a single change, for no
-- functional gain.

BEGIN;

CREATE TABLE IF NOT EXISTS lead_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id       UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  product_type  TEXT,
  bed_size      TEXT,
  scale         TEXT,
  qty           INTEGER CHECK (qty IS NULL OR qty > 0),
  -- NUMERIC accepts 'NaN' in Postgres, and one real lead row already holds
  -- it. Note `unit_price >= 0` is NOT sufficient: Postgres sorts NaN as
  -- GREATER than every number, so NaN >= 0 is TRUE and would pass. The
  -- isnan() test is the part that actually blocks it. The backfill below
  -- converts any existing NaN to NULL rather than carrying it forward.
  unit_price    NUMERIC(12,2)
                  CHECK (unit_price IS NULL OR (NOT (unit_price = 'NaN'::numeric) AND unit_price >= 0)),
  pillow_top    BOOLEAN NOT NULL DEFAULT false,
  -- Display/sync order. position 0 is the item mirrored onto the leads row.
  position      INTEGER NOT NULL DEFAULT 0,
  -- Who added it: 'ai' from analyzeConversation, 'staff' from the dashboard.
  -- Load-bearing — the AI reconcile MUST NOT delete a staff-added item, and
  -- it re-runs on every inbound message.
  source        TEXT NOT NULL DEFAULT 'staff' CHECK (source IN ('ai', 'staff')),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_items_lead ON lead_items(lead_id, position);
-- One row per product+size per lead, so the AI reconcile can upsert safely
-- and cannot accumulate duplicates across a long conversation.
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_items_unique
  ON lead_items(lead_id, lower(coalesce(product_type,'')), lower(coalesce(bed_size,'')));

COMMENT ON TABLE lead_items IS
  'Products a lead has asked about — one row each. leads.product_type/bed_size/scale/qty/unit_price mirror position 0 via trg_lead_items_sync so existing single-product readers keep working.';

-- ── backfill: existing single product becomes item 0 ────────────────────────
INSERT INTO lead_items (lead_id, product_type, bed_size, scale, qty, unit_price, position, source)
SELECT id, product_type, bed_size, scale, qty,
       -- NUMERIC 'NaN' is real in this data; store NULL rather than carry a
       -- broken price into the new table.
       CASE WHEN unit_price IS NULL OR unit_price::text = 'NaN' THEN NULL ELSE unit_price END,
       0, 'staff'
FROM leads
WHERE product_type IS NOT NULL OR bed_size IS NOT NULL OR unit_price IS NOT NULL
ON CONFLICT DO NOTHING;

-- ── keep the leads row mirrored to item 0 ───────────────────────────────────
CREATE OR REPLACE FUNCTION sync_lead_first_item()
RETURNS TRIGGER AS $$
DECLARE
  v_lead UUID;
  v_first lead_items;
BEGIN
  v_lead := COALESCE(NEW.lead_id, OLD.lead_id);

  SELECT * INTO v_first FROM lead_items
   WHERE lead_id = v_lead
   ORDER BY position ASC, created_at ASC
   LIMIT 1;

  IF FOUND THEN
    UPDATE leads SET
      product_type = v_first.product_type,
      bed_size     = v_first.bed_size,
      scale        = v_first.scale,
      qty          = v_first.qty,
      unit_price   = v_first.unit_price,
      updated_at   = NOW()
    WHERE id = v_lead;
  ELSE
    -- Last item removed: clear the mirrored columns rather than leave a
    -- product on the lead that no longer exists.
    UPDATE leads SET
      product_type = NULL, bed_size = NULL, scale = NULL,
      qty = NULL, unit_price = NULL, updated_at = NOW()
    WHERE id = v_lead;
  END IF;

  RETURN NULL;  -- AFTER trigger
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lead_items_sync ON lead_items;
CREATE TRIGGER trg_lead_items_sync
AFTER INSERT OR UPDATE OR DELETE ON lead_items
FOR EACH ROW EXECUTE FUNCTION sync_lead_first_item();

-- ── read model: the whole basket per lead, with its total ───────────────────
CREATE OR REPLACE VIEW v_lead_items_summary AS
SELECT
  l.id AS lead_id,
  COUNT(li.id)                                                   AS item_count,
  COALESCE(SUM(COALESCE(li.unit_price,0) * COALESCE(li.qty,1)),0) AS items_total,
  COUNT(li.id) FILTER (WHERE li.source = 'ai')                   AS ai_items,
  COUNT(li.id) FILTER (WHERE li.source = 'staff')                AS staff_items
FROM leads l
LEFT JOIN lead_items li ON li.lead_id = l.id
GROUP BY l.id;

COMMIT;
