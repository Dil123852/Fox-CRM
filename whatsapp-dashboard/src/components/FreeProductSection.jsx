import { useState } from 'react';
import { Gift, Trash2, Plus, X } from 'lucide-react';
import { theme } from '../lib/theme';
import { formatDimension, variantValue } from '../lib/format';
import { isFreeItem, makeFreeItem, lineTotal, freeValue, productTally } from '../lib/orderItems';

// The Free Product section, shared by every order screen. Offers PILLOWS only
// — a mattress is never given away.
//
// WHAT IT IS FOR (confirmed with the user): the free-pillow offer is negotiated
// per customer, not fixed. Staff add the paid items normally, then pick the
// giveaway here — "6 bolster pillows, 4 of them free" is entered as a paid line
// of 2... or a paid line of 6 and a free line of 4, whichever way the agent
// thinks about it. The tally below each product makes the real outcome visible
// either way, so a slip is obvious before the order is placed.
//
// The picker deliberately mirrors the paid product picker: product card, size
// chips, then a dimension+price button. Staff should not have to learn a second
// interaction for the same job, and a free item is a real catalog product with
// a real price — that price is what the invoice shows as the value given away.
//
// Free lines are stored with a NEGATIVE unit_price and free: true (see
// lib/orderItems.js). They cost the customer nothing: totals come from
// paidSubtotal/orderTotal, never from summing every line's signed price.

export default function FreeProductSection({ products, items, onChange }) {
  const [picking, setPicking] = useState(false);

  const freeLines = (items || []).filter(isFreeItem);
  const totalGiven = freeValue(items);

  // Pillows only (confirmed with the user): the giveaway is a pillow offer, and
  // a mattress is never given away. Filtered here rather than at each call site
  // so no order screen can accidentally offer one.
  const giftable = (products || []).filter(p => p.category === 'pillow');

  function addFree(line) {
    onChange([...(items || []), line]);
    setPicking(false);
  }

  function removeAt(index) {
    const target = freeLines[index];
    onChange((items || []).filter(i => i !== target));
  }

  function setQty(index, qty) {
    const target = freeLines[index];
    const n = Math.max(1, Number(qty) || 1);
    onChange((items || []).map(i => (i === target ? { ...i, qty: n } : i)));
  }

  return (
    <div style={s.wrap}>
      <div style={s.head}>
        <Gift size={14} color={theme.success} />
        <span style={s.title}>Free pillows</span>
        {freeLines.length > 0 && (
          <span style={s.givenPill}>{`LKR ${totalGiven.toLocaleString()} given`}</span>
        )}
        <div style={{ flex: 1 }} />
        {!picking && (
          <button type="button" style={s.addBtn} onClick={() => setPicking(true)}>
            <Plus size={12} /> Add free pillow
          </button>
        )}
      </div>

      {freeLines.length === 0 && !picking && (
        <p style={s.hint}>
          No free pillows on this order. Add one here to include it free — it is
          billed at its catalog price and then deducted, so the customer sees the
          value of the gift.
        </p>
      )}

      {freeLines.map((line, i) => {
        const tally = productTally(items, line.name);
        return (
          <div key={`${line.name}-${line.bed_size}-${i}`} style={s.line}>
            <span style={s.freeTag}>FREE</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <p style={s.lineName}>
                {line.name}
                {line.bed_size && <span style={s.lineDim}> · {formatDimension(line.bed_size)}</span>}
              </p>
              {/* The point of the tally: staff entered two separate lines, so
                  show what the customer actually receives in total. */}
              {tally.paid > 0 && (
                <p style={s.lineTally}>
                  {tally.total} on this order — {tally.paid} paid + {tally.free} free
                </p>
              )}
            </div>
            <input
              style={s.qty}
              type="number"
              min="1"
              value={line.qty}
              onChange={e => setQty(i, e.target.value)}
              aria-label={`Free quantity of ${line.name}`}
            />
            {/* The gift's worth, shown positive (stored negative) — it is labelled
                FREE and is not charged, so a minus sign here read as a refund. */}
            <span style={s.lineValue}>{`LKR ${Math.abs(lineTotal(line)).toLocaleString()}`}</span>
            <button type="button" style={s.removeBtn} onClick={() => removeAt(i)} aria-label="Remove free item">
              <Trash2 size={13} />
            </button>
          </div>
        );
      })}

      {picking && (
        <div style={s.picker}>
          <div style={s.pickerHead}>
            <span style={s.pickerTitle}>Pick the pillow to give free</span>
            <button type="button" style={s.closePick} onClick={() => setPicking(false)} aria-label="Cancel">
              <X size={14} />
            </button>
          </div>
          <div style={s.grid}>
            {giftable.length === 0 ? (
              <p style={s.hint}>No pillows in the catalog to give away.</p>
            ) : giftable.map(p => (
              <FreeProductCard key={p.id} product={p} onPick={addFree} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// One product in the picker. Same shape as the paid picker — size chips, then a
// dimension+price button — because a free item is chosen exactly the way a paid
// one is; only the sign of the stored price differs.
function FreeProductCard({ product, onPick }) {
  const variants = product.variants || [];
  // A product whose single variant carries no size at all (the older pillow
  // shape) has nothing to choose, so it is one tap.
  const unsized = variants.length === 1 && !variantValue(variants[0]);
  const sizes = [...new Set(variants.map(v => v.size).filter(Boolean))];
  const [size, setSize] = useState(sizes[0]);

  if (unsized) {
    const price = Number(variants[0]?.price) || 0;
    return (
      <button
        type="button"
        style={s.card}
        onClick={() => onPick(makeFreeItem({ name: product.name, qty: 1, unitPrice: price, category: product.category }))}
      >
        <span style={s.cardName}>{product.name}</span>
        <span style={s.cardPrice}>{`LKR ${price.toLocaleString()}`}</span>
      </button>
    );
  }

  const options = variants.filter(v => v.size === size);

  return (
    <div style={s.card}>
      <span style={s.cardName}>{product.name}</span>
      {sizes.length > 1 && (
        <div style={s.chipRow}>
          {sizes.map(sz => (
            <button
              key={sz}
              type="button"
              style={{ ...s.sizeChip, ...(sz === size ? s.sizeChipOn : {}) }}
              onClick={() => setSize(sz)}
            >
              {sz}
            </button>
          ))}
        </div>
      )}
      <div style={s.chipRow}>
        {options.map(v => {
          // A size may legitimately have no dimension, so fall back to the size
          // name rather than rendering a blank, unpickable chip.
          const dim = variantValue(v);
          const label = dim ? formatDimension(dim) : v.size;
          return (
            <button
              key={label}
              type="button"
              style={s.optChip}
              onClick={() => onPick(makeFreeItem({
                name: product.name,
                bedSize: dim || v.size,
                qty: 1,
                unitPrice: Number(v.price) || 0,
                category: product.category,
              }))}
            >
              {label} · {`LKR ${(Number(v.price) || 0).toLocaleString()}`}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const s = {
  wrap: { border: `1px dashed ${theme.border}`, borderRadius: 10, padding: 12, background: theme.bg, display: 'flex', flexDirection: 'column', gap: 8 },
  head: { display: 'flex', alignItems: 'center', gap: 8 },
  title: { fontSize: 12, fontWeight: 700, color: theme.ink, textTransform: 'uppercase', letterSpacing: '0.04em' },
  givenPill: { fontSize: 10, fontWeight: 700, color: theme.success, background: theme.successBg, padding: '2px 8px', borderRadius: 20 },
  addBtn: { display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: `1.5px solid ${theme.border}`, color: theme.inkSoft, fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit' },
  hint: { margin: 0, fontSize: 11, color: theme.inkFaint, lineHeight: 1.5 },

  line: { display: 'flex', alignItems: 'center', gap: 8, background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 8, padding: '6px 10px' },
  freeTag: { fontSize: 9, fontWeight: 800, color: theme.success, background: theme.successBg, padding: '2px 6px', borderRadius: 4, letterSpacing: '0.06em', flexShrink: 0 },
  lineName: { margin: 0, fontSize: 12, fontWeight: 600, color: theme.ink },
  lineDim: { fontWeight: 400, color: theme.inkSoft },
  lineTally: { margin: '2px 0 0', fontSize: 10, color: theme.inkFaint },
  qty: { width: 52, textAlign: 'center', border: `1.5px solid ${theme.border}`, borderRadius: 7, padding: '4px 6px', fontSize: 12, fontFamily: 'inherit', color: theme.ink, background: theme.surface },
  lineValue: { fontSize: 12, fontWeight: 700, color: theme.success, minWidth: 78, textAlign: 'right' },
  removeBtn: { background: 'none', border: 'none', color: theme.inkFaint, cursor: 'pointer', padding: 2, display: 'flex' },

  picker: { border: `1px solid ${theme.border}`, borderRadius: 8, background: theme.surface, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 },
  pickerHead: { display: 'flex', alignItems: 'center' },
  pickerTitle: { flex: 1, fontSize: 11, fontWeight: 700, color: theme.inkSoft, textTransform: 'uppercase', letterSpacing: '0.04em' },
  closePick: { background: 'none', border: 'none', color: theme.inkFaint, cursor: 'pointer', padding: 2, display: 'flex' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 8 },

  card: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6, border: `1px solid ${theme.border}`, borderRadius: 8, padding: 10, background: theme.surface, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', width: '100%' },
  cardName: { fontSize: 12, fontWeight: 700, color: theme.ink },
  cardPrice: { fontSize: 12, fontWeight: 700, color: theme.accentInk },
  chipRow: { display: 'flex', flexWrap: 'wrap', gap: 5 },
  sizeChip: { fontSize: 10, fontWeight: 700, padding: '3px 9px', borderRadius: 6, border: `1.5px solid ${theme.border}`, background: theme.surface, color: theme.inkSoft, cursor: 'pointer', fontFamily: 'inherit' },
  sizeChipOn: { borderColor: theme.accentInk, color: theme.accentInk, background: theme.bg },
  optChip: { fontSize: 11, fontWeight: 600, padding: '4px 9px', borderRadius: 6, border: `1px solid ${theme.border}`, background: theme.bg, color: theme.ink, cursor: 'pointer', fontFamily: 'inherit' },
};
