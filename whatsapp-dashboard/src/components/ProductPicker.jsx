import { useState } from 'react';
import { theme } from '../lib/theme';

// The card-based product picker from the New Showroom Order screen, made
// reusable so the lead screen can offer the same interaction: tap a size, tap
// a dimension chip, and the product is added with its catalog price already
// resolved.
//
// Deliberately a COPY of ShowroomOrderModal's own ProductCard rather than an
// extraction, because that screen places real orders and the user asked for it
// to be left untouched. The tradeoff is two implementations that could drift —
// so this file is the one to change if the picker's behaviour ever needs to
// evolve, and ShowroomOrderModal should then be pointed at it in a separate,
// separately-tested change.
//
// Variant shapes (migration 015): current catalog uses {size, dimension,
// price}; the 3 retired products use the older {size, height, price}. Both are
// handled, since a lead may still reference a discontinued product.

// A variant's second measurement, whichever key it uses. Falls back to the
// size name when a size has no dimension at all (a pillow sized only
// "Standard", say) so the chip is never rendered blank and unpickable.
function dimOf(v) {
  return v.dimension ?? v.height ?? v.size;
}

export function ProductCard({ product, onAdd, showStock = true }) {
  const available = Math.max(0, (product.stock_quantity || 0) - (product.reserved_quantity || 0));
  const sizes = [...new Set((product.variants || []).map(v => v.size))];
  const [selectedSize, setSelectedSize] = useState(sizes[0]);
  const [pillowTop, setPillowTop] = useState(false);

  // Branch on the product's real SHAPE, not its category: pillows now carry
  // proper sizes with per-dimension prices just like a mattress, so a sized
  // pillow must flow through the normal size -> dimension picker below. Only a
  // product still holding one unsized {price} variant (the two seeded pillows,
  // until staff give them sizes) gets the flat one-tap card.
  const unsized = !(product.variants || []).some(v => v.size || v.dimension || v.height);
  if (unsized) {
    const price = product.variants?.[0]?.price || 0;
    return (
      <button
        style={s.pillowCard}
        onClick={() => onAdd({
          name: product.name, bed_size: null, category: product.category, unit_price: price,
        })}
      >
        <span style={s.pillowName}>{product.name}</span>
        <span style={s.pillowPrice}>LKR {price.toLocaleString()}</span>
      </button>
    );
  }

  const dimensionOpts = (product.variants || []).filter(v => v.size === selectedSize);
  const addonPrice = Number(product.pillow_top_addon_price) || 0;

  return (
    <div style={s.productCard}>
      <p style={s.productName}>{product.name}</p>
      {showStock && available > 0 && <p style={s.stockNote}>{available} in stock</p>}
      <div style={s.sizeRow}>
        {sizes.map(sz => (
          <button
            key={sz}
            style={{ ...s.sizeChip, ...(selectedSize === sz ? s.sizeChipActive : {}) }}
            onClick={() => setSelectedSize(sz)}
          >
            {sz}
          </button>
        ))}
      </div>
      <div style={s.heightRow}>
        {dimensionOpts.map(v => (
          <button
            key={dimOf(v)}
            style={s.heightChip}
            onClick={() => onAdd({
              name: product.name,
              bed_size: dimOf(v),
              category: product.category,
              pillow_top: pillowTop,
              // The pillow-top addon is a flat amount on top of the chosen
              // dimension's price — the same real pricing rule the showroom
              // flow applies.
              unit_price: v.price + (pillowTop ? addonPrice : 0),
            })}
          >
            {dimOf(v)} · LKR {(v.price + (pillowTop ? addonPrice : 0)).toLocaleString()}
          </button>
        ))}
      </div>
      {product.has_pillow_top_option && addonPrice > 0 && (
        <label style={s.pillowTopToggle}>
          <input type="checkbox" checked={pillowTop} onChange={e => setPillowTop(e.target.checked)} />
          Pillow-top upgrade (+LKR {addonPrice.toLocaleString()})
        </label>
      )}
    </div>
  );
}

// The whole grid, so a caller only has to supply the product list.
export default function ProductPicker({ products, onAdd, showStock = true, columns }) {
  if (!products || products.length === 0) return null;
  return (
    <div style={{ ...s.grid, ...(columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : {}) }}
      className="responsive-product-grid">
      {products.map(p => (
        <ProductCard key={p.id} product={p} onAdd={onAdd} showStock={showStock} />
      ))}
    </div>
  );
}

const s = {
  grid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 },

  productCard: { border: `1px solid ${theme.border}`, borderRadius: 10, padding: 12, background: theme.bg },
  productName: { margin: 0, fontSize: 13, fontWeight: 700, color: theme.ink },
  stockNote: { margin: '2px 0 0', fontSize: 10.5, color: theme.inkFaint },

  sizeRow: { display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 8 },
  sizeChip: { fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 6, border: `1px solid ${theme.border}`, background: theme.surface, color: theme.inkSoft, cursor: 'pointer', fontFamily: 'inherit' },
  sizeChipActive: { background: theme.accentSoft, border: `1px solid ${theme.accent}`, color: theme.accentInk },

  heightRow: { display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 7 },
  heightChip: { fontSize: 11, fontWeight: 600, padding: '5px 9px', borderRadius: 6, border: `1px solid ${theme.border}`, background: theme.surface, color: theme.ink, cursor: 'pointer', fontFamily: 'inherit' },

  pillowTopToggle: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 11, color: theme.inkSoft, cursor: 'pointer' },

  pillowCard: { display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start', border: `1px solid ${theme.border}`, borderRadius: 10, padding: 12, background: theme.bg, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' },
  pillowName: { fontSize: 13, fontWeight: 700, color: theme.ink },
  pillowPrice: { fontSize: 12, fontWeight: 700, color: theme.accentInk },
};
