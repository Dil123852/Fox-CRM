-- Real catalog swap, confirmed directly with the user against a real price
-- list ("The Natural Choice Pvt Ltd — Price List Nidikumba Spring Mattress -
-- Kurunagala promotion"). Retires the old 3-product catalog (Bonnel Spring,
-- Nidikumba Ayu Spring, Nidikumba Ayu Hardback) in favor of 4 new products
-- (Ayu Sleep 6, Nidikumba Rise, Nidikumba Signature, Nidikumba Ayu Spring —
-- note the name IS reused for the new lineup).
--
-- The variants shape changes from {size, height, price} (height = spring
-- thickness in inches, a real per-variant choice under the old catalog) to
-- {size, dimension, price} (dimension = exact WxL in inches, e.g. "72x36" —
-- the real per-variant choice now, since each new product has exactly one
-- fixed thickness). "Extra Large" is a genuine 5th size category confirmed
-- present with real prices in the source price list, added alongside the
-- originally-confirmed Single/Double/Queen/King.
--
-- ── Critical safety note — read before ever reusing a product name again ──
-- Two triggers match order line items to a product by `name` with NO
-- `active` filter and NO LIMIT/ORDER BY: handle_order_stock_reservation
-- (`UPDATE products ... WHERE name = v_name`, no LIMIT — a duplicate name
-- means BOTH rows get their stock silently mutated) and
-- handle_order_completed_warranty (`SELECT ... INTO ... WHERE name = v_name`
-- — a duplicate name means an ARBITRARY row's warranty_years gets used).
-- `products.name` has no UNIQUE constraint anywhere in this schema. Simply
-- setting an old row `active=false` while keeping its name is NOT enough to
-- avoid this — the old "Nidikumba Ayu Spring" row is renamed below
-- specifically to prevent colliding with the new product of the same name.
--
-- Apply with:
--   docker exec -i crm-postgres psql -U crm -d crm < migrations/015_new_product_catalog.sql

ALTER TABLE products ADD COLUMN IF NOT EXISTS pillow_top_addon_price NUMERIC(10,2);

-- Retire the old catalog. The Ayu Spring name is reused by a new product
-- below, so that one row is renamed (not just deactivated) to avoid the
-- name-collision hazard described above. The other two aren't reused, so a
-- plain deactivation is enough. Historical orders/warranties are unaffected:
-- order line items store the product name as a plain string snapshot at
-- order time (not a live join), and warranties.product_id is a stable FK to
-- these same (still-existing, just renamed/inactive) rows.
UPDATE products SET active = false
  WHERE name IN ('Bonnel Spring', 'Nidikumba Ayu Hardback');
UPDATE products SET active = false, name = 'Nidikumba Ayu Spring (Discontinued)'
  WHERE name = 'Nidikumba Ayu Spring';

INSERT INTO products (category, name, collection, spring_type, description, has_pillow_top_option, free_pillows_included, warranty_years, pillow_top_addon_price, variants)
VALUES
  ('mattress', 'Ayu Sleep 6', 'Ayu Sleep', 'Foam',
   'Therapeutic 6" firm foam mattress built for back pain relief — no pillow top, no soft comfort layer, just firm direct support that keeps the spine aligned.',
   FALSE, 0, 12, NULL,
   '[{"size":"Single","dimension":"72x36","price":28500},{"size":"Single","dimension":"75x36","price":29400},{"size":"Single","dimension":"78x36","price":30400},{"size":"Single","dimension":"84x36","price":32800},{"size":"Double","dimension":"72x48","price":36200},{"size":"Double","dimension":"75x48","price":37800},{"size":"Double","dimension":"78x48","price":39100},{"size":"Double","dimension":"84x48","price":42100},{"size":"Queen","dimension":"72x60","price":44300},{"size":"Queen","dimension":"75x60","price":45800},{"size":"Queen","dimension":"78x60","price":47500},{"size":"Queen","dimension":"84x60","price":51200},{"size":"King","dimension":"72x72","price":52400},{"size":"King","dimension":"75x72","price":54100},{"size":"King","dimension":"78x72","price":56700},{"size":"King","dimension":"72x84","price":59400},{"size":"Extra Large","dimension":"75x78","price":58000},{"size":"Extra Large","dimension":"78x78","price":61800},{"size":"Extra Large","dimension":"84x75","price":63900},{"size":"Extra Large","dimension":"84x78","price":65400},{"size":"Extra Large","dimension":"84x84","price":70300}]'::jsonb),

  ('mattress', 'Nidikumba Rise', 'Rise', 'Continuous Spring',
   '8.5" continuous-spring mattress — a cost-efficient coil construction, firmer than the Signature, aimed at budget-conscious customers who still need real back support. Optional pillow-top upgrade available.',
   TRUE, 4, 12, 25000,
   '[{"size":"Single","dimension":"72x36","price":39700},{"size":"Single","dimension":"75x36","price":42300},{"size":"Single","dimension":"78x36","price":43600},{"size":"Single","dimension":"84x36","price":45100},{"size":"Double","dimension":"72x48","price":47000},{"size":"Double","dimension":"75x48","price":48100},{"size":"Double","dimension":"78x48","price":49100},{"size":"Double","dimension":"84x48","price":50800},{"size":"Queen","dimension":"72x60","price":52100},{"size":"Queen","dimension":"75x60","price":53800},{"size":"Queen","dimension":"78x60","price":54900},{"size":"Queen","dimension":"84x60","price":61500},{"size":"King","dimension":"72x72","price":62600},{"size":"King","dimension":"75x72","price":63400},{"size":"King","dimension":"78x72","price":64900},{"size":"King","dimension":"72x84","price":69500},{"size":"Extra Large","dimension":"75x78","price":67800},{"size":"Extra Large","dimension":"78x78","price":70700},{"size":"Extra Large","dimension":"84x75","price":74700},{"size":"Extra Large","dimension":"84x78","price":76600},{"size":"Extra Large","dimension":"84x84","price":82800}]'::jsonb),

  ('mattress', 'Nidikumba Signature', 'Signature', 'Bonnell Spring',
   '10.5" classic Bonnell-spring innerspring mattress with a bouncy, responsive feel. Optional pillow-top upgrade available.',
   TRUE, 4, 12, 25000,
   '[{"size":"Single","dimension":"72x36","price":47500},{"size":"Single","dimension":"75x36","price":49800},{"size":"Single","dimension":"78x36","price":50800},{"size":"Single","dimension":"84x36","price":53300},{"size":"Double","dimension":"72x48","price":55200},{"size":"Double","dimension":"75x48","price":56800},{"size":"Double","dimension":"78x48","price":58100},{"size":"Double","dimension":"84x48","price":59400},{"size":"Queen","dimension":"72x60","price":62100},{"size":"Queen","dimension":"75x60","price":66400},{"size":"Queen","dimension":"78x60","price":67400},{"size":"Queen","dimension":"84x60","price":70000},{"size":"King","dimension":"72x72","price":72600},{"size":"King","dimension":"75x72","price":73900},{"size":"King","dimension":"78x72","price":75500},{"size":"King","dimension":"72x84","price":82400},{"size":"Extra Large","dimension":"75x78","price":78800},{"size":"Extra Large","dimension":"78x78","price":83600},{"size":"Extra Large","dimension":"84x75","price":85800},{"size":"Extra Large","dimension":"84x78","price":87700},{"size":"Extra Large","dimension":"84x84","price":96100}]'::jsonb),

  ('mattress', 'Nidikumba Ayu Spring', 'Ayu Pocketed', 'Pocket Spring',
   '8.5" pocket-spring mattress — the flagship of the range, with individually-wrapped coils for superior motion isolation, contouring, and orthopedic support. Positioned as the premium/luxury option. Optional pillow-top upgrade available.',
   TRUE, 4, 12, 25000,
   '[{"size":"Single","dimension":"72x36","price":50500},{"size":"Single","dimension":"75x36","price":52500},{"size":"Single","dimension":"78x36","price":54300},{"size":"Single","dimension":"84x36","price":60500},{"size":"Double","dimension":"72x48","price":62700},{"size":"Double","dimension":"75x48","price":65700},{"size":"Double","dimension":"78x48","price":67700},{"size":"Double","dimension":"84x48","price":70500},{"size":"Queen","dimension":"72x60","price":74500},{"size":"Queen","dimension":"75x60","price":77700},{"size":"Queen","dimension":"78x60","price":80800},{"size":"Queen","dimension":"84x60","price":86500},{"size":"King","dimension":"72x72","price":87500},{"size":"King","dimension":"75x72","price":93500},{"size":"King","dimension":"78x72","price":97500},{"size":"King","dimension":"72x84","price":101500},{"size":"Extra Large","dimension":"75x78","price":99500},{"size":"Extra Large","dimension":"78x78","price":107000},{"size":"Extra Large","dimension":"84x75","price":114000},{"size":"Extra Large","dimension":"84x78","price":116700},{"size":"Extra Large","dimension":"84x84","price":124000}]'::jsonb);
