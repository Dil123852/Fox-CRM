-- Adds a products catalog so the AI answers with real product names/sizes/prices
-- instead of a hardcoded list baked into the system prompt.
-- init.sql only runs on a fresh volume, so run this manually against an existing DB:
--   docker exec -i crm-postgres psql -U crm -d crm < db/migrations/002_add_products.sql

CREATE TABLE IF NOT EXISTS products (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  category               TEXT        NOT NULL CHECK (category IN ('mattress', 'pillow')),
  brand                  TEXT        NOT NULL DEFAULT 'Nidikumba',
  name                   TEXT        NOT NULL,        -- e.g. "Nidikumba Ayu Spring"
  collection             TEXT,                        -- e.g. "ARYU Pocketed"
  spring_type            TEXT,                        -- e.g. "Bonnel Spring", "Pocketed Spring", "Hardback"
  description            TEXT,
  has_pillow_top_option  BOOLEAN     DEFAULT FALSE,
  free_pillows_included  INTEGER     DEFAULT 0,
  variants               JSONB       NOT NULL DEFAULT '[]', -- [{ "size": "Single", "height": 10, "price": 45000 }]
  active                 BOOLEAN     DEFAULT TRUE,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_active   ON products(active);

-- ── seed: Nidikumba Mattresses catalog ────────────────────────────────────────
-- Prices below are EXAMPLE placeholders (LKR) — update via the dashboard or
-- `UPDATE products SET variants = '...' WHERE name = '...';` with real prices.

INSERT INTO products (category, name, collection, spring_type, description, has_pillow_top_option, free_pillows_included, variants) VALUES
(
  'mattress',
  'Bonnel Spring',
  'Signature',
  'Bonnel Spring',
  'Classic interconnected spring system, firm support, excellent everyday value.',
  FALSE,
  3,
  '[
    {"size":"Single","height":9,"price":42000}, {"size":"Single","height":10,"price":45000}, {"size":"Single","height":11,"price":48000},
    {"size":"Double","height":9,"price":58000}, {"size":"Double","height":10,"price":62000}, {"size":"Double","height":11,"price":66000},
    {"size":"Queen","height":9,"price":68000}, {"size":"Queen","height":10,"price":72000}, {"size":"Queen","height":11,"price":76000},
    {"size":"King","height":9,"price":82000}, {"size":"King","height":10,"price":87000}, {"size":"King","height":11,"price":92000}
  ]'::jsonb
),
(
  'mattress',
  'Nidikumba Ayu Spring',
  'ARYU Pocketed',
  'Pocketed Spring',
  'Individual pocketed springs for zero motion transfer, ideal for couples. Optional pillow-top for extra plush comfort.',
  TRUE,
  3,
  '[
    {"size":"Single","height":9,"price":58000}, {"size":"Single","height":10,"price":62000}, {"size":"Single","height":11,"price":66000},
    {"size":"Double","height":9,"price":78000}, {"size":"Double","height":10,"price":83000}, {"size":"Double","height":11,"price":88000},
    {"size":"Queen","height":9,"price":92000}, {"size":"Queen","height":10,"price":97000}, {"size":"Queen","height":11,"price":102000},
    {"size":"King","height":9,"price":110000}, {"size":"King","height":10,"price":116000}, {"size":"King","height":11,"price":122000}
  ]'::jsonb
),
(
  'mattress',
  'Nidikumba Ayu Hardback',
  'ARYU Sleep',
  'Hardback',
  'Firm hardback support system for orthopedic-style sleep support.',
  FALSE,
  3,
  '[
    {"size":"Single","height":9,"price":50000}, {"size":"Single","height":10,"price":53000}, {"size":"Single","height":11,"price":56000},
    {"size":"Double","height":9,"price":68000}, {"size":"Double","height":10,"price":72000}, {"size":"Double","height":11,"price":76000},
    {"size":"Queen","height":9,"price":80000}, {"size":"Queen","height":10,"price":84000}, {"size":"Queen","height":11,"price":88000},
    {"size":"King","height":9,"price":95000}, {"size":"King","height":10,"price":100000}, {"size":"King","height":11,"price":105000}
  ]'::jsonb
),
(
  'pillow',
  'Bolster Pillow',
  NULL,
  NULL,
  'Firm cylindrical support pillow. Given free (3 per mattress) or purchasable separately.',
  FALSE,
  0,
  '[{"price":2500}]'::jsonb
),
(
  'pillow',
  'Gel Pillow',
  NULL,
  NULL,
  'Cooling gel-infused pillow. Given free (3 per mattress) or purchasable separately.',
  FALSE,
  0,
  '[{"price":4500}]'::jsonb
)
ON CONFLICT DO NOTHING;
