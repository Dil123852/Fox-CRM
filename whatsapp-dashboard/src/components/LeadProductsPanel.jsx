import { useEffect, useMemo, useState } from 'react';
import { Trash2, ShoppingBag, ShoppingCart } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { theme } from '../lib/theme';
import { formatDimension } from '../lib/format';
import ProductPicker from './ProductPicker';
import { useErrorPopup } from './DialogProvider';

// The lead screen's product selection, matching the New Showroom Order screen:
// a card grid where one tap adds a product at its catalog price, and an items
// panel listing everything the customer has asked about.
//
// Split into a hook plus two presentational parts because the two halves live
// in DIFFERENT columns of the page — the picker scrolls with the rest of the
// lead detail on the left, while LeadItemsPanel is pinned full-height on the
// right and does not scroll. Sharing state through useLeadItems keeps them in
// step without either owning the other.
//
// A lead can hold several products (migration 031's lead_items) — a customer
// comparing two mattresses used to lose one of them. leads.product_type and
// friends still mirror item 0 via trg_lead_items_sync, so the Pipeline table,
// the PDF/Excel exports, the customers-directory endpoint and the Bulk
// Messages filters keep reading the old single-product columns unchanged.

// Shared state for a lead's items: the catalog, the item list, and the three
// mutations. Both halves of the UI take this one object.
export function useLeadItems(lead, onChanged) {
  const [products, setProducts] = useState([]);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useErrorPopup(error, 'Could not update the products');

  useEffect(() => {
    let alive = true;
    apiFetch('/api/products')
      .then(r => r.json())
      .then(d => { if (alive) setProducts((d.products || []).filter(p => p.active)); })
      .catch(() => { /* picker renders nothing rather than breaking the page */ });
    return () => { alive = false; };
  }, []);

  async function loadItems() {
    // The page calls this hook before its lead has loaded, so there may be
    // no id yet — nothing to fetch, and no error to report.
    if (!lead?.id) { setLoading(false); return; }
    try {
      const res = await apiFetch(`/api/leads/${lead.id}/items`);
      const data = await res.json();
      setItems(data.items || []);
    } catch { /* leave as-is */ }
    setLoading(false);
  }
  useEffect(() => { loadItems(); }, [lead?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ProductPicker emits the showroom item shape ({name, bed_size, pillow_top,
  // unit_price}); lead_items uses product_type. Mapped here so the picker
  // stays reusable rather than knowing about leads.
  async function addItem(picked) {
    if (!lead?.id) return;
    setBusy(true); setError('');
    try {
      const res = await apiFetch(`/api/leads/${lead.id}/items`, {
        method: 'POST',
        body: JSON.stringify({
          productType: picked.name,
          bedSize: picked.bed_size || null,
          qty: 1,
          unitPrice: picked.unit_price,
          pillowTop: !!picked.pillow_top,
        }),
      });
      const data = await res.json();
      // 409 when this product+size is already on the lead — the unique index
      // is also what keeps the AI reconcile idempotent.
      if (!data.success) setError(data.error || 'Could not add that product');
      else { await loadItems(); onChanged?.(); }
    } catch (err) {
      setError('Network error: ' + err.message);
    }
    setBusy(false);
  }

  async function removeItem(itemId) {
    if (!lead?.id) return;
    setBusy(true); setError('');
    try {
      await apiFetch(`/api/leads/${lead.id}/items/${itemId}`, { method: 'DELETE' });
      await loadItems();
      onChanged?.();
    } catch (err) { setError('Network error: ' + err.message); }
    setBusy(false);
  }

  async function patchItem(itemId, patch) {
    if (!lead?.id) return;
    setBusy(true); setError('');
    try {
      await apiFetch(`/api/leads/${lead.id}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(patch),
      });
      await loadItems();
      onChanged?.();
    } catch (err) { setError('Network error: ' + err.message); }
    setBusy(false);
  }

  const total = useMemo(
    () => items.reduce((sum, it) => sum + (Number(it.unit_price) || 0) * (Number(it.qty) || 1), 0),
    [items]
  );

  return { products, items, loading, busy, error, total, addItem, removeItem, patchItem };
}

// LEFT column: the card picker. Scrolls with the rest of the lead detail.
export default function LeadProductsPanel({ ctl }) {
  const { products, addItem, error } = ctl;
  return (
    <div>
      <p style={s.sectionTitle}>Products</p>
      <p style={s.hint}>Tap a size, then a dimension — the catalog price is added automatically.</p>
      <ProductPicker products={products} onAdd={addItem} />
    </div>
  );
}

// RIGHT column: pinned full-height, deliberately NOT scrollable so the
// enquiry stays visible while staff work through the rest of the lead.
export function LeadItemsPanel({ ctl, onOrder, orderDisabled, orderTitle }) {
  const { items, loading, busy, total, removeItem, patchItem } = ctl;

  return (
    <aside style={s.itemsCol}>
      <p style={s.itemsHead}>Interested in ({items.length})</p>

      <div style={s.itemsList}>
        {loading ? null : items.length === 0 ? (
          <div style={s.empty}>
            <ShoppingBag size={20} color={theme.inkFaint} />
            <p style={s.emptyText}>Tap a product to add it here</p>
          </div>
        ) : items.map(it => (
          <div key={it.id} style={s.item}>
            <div style={s.itemTop}>
              <span style={s.itemName}>
                {it.product_type || '—'}
                {it.source === 'ai' && (
                  <span style={s.aiTag} title="Detected from the WhatsApp conversation">AI</span>
                )}
              </span>
              <button style={s.del} disabled={busy} title="Remove"
                onClick={() => removeItem(it.id)}><Trash2 size={12} /></button>
            </div>
            <p style={s.itemMeta}>
              {it.bed_size ? formatDimension(it.bed_size) : '—'}
              {it.pillow_top && <span style={s.topTag}>+ Pillow-top</span>}
            </p>
            <div style={s.itemBottom}>
              <input style={s.qty} type="number" min="1" defaultValue={it.qty ?? 1}
                disabled={busy} title="Quantity"
                onBlur={e => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && n >= 1 && n !== (it.qty ?? 1)) {
                    patchItem(it.id, { qty: Math.trunc(n) });
                  }
                }} />
              <span style={s.itemPrice}>
                {it.unit_price != null
                  ? `LKR ${(Number(it.unit_price) * (Number(it.qty) || 1)).toLocaleString()}`
                  : 'no price'}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div style={s.totals}>
        <span style={s.totalLabel}>Enquiry total</span>
        <span style={s.totalVal}>
          <span style={s.cur}>LKR</span> {total > 0 ? total.toLocaleString() : '—'}
        </span>
      </div>

      {/* Directly under the total, because converting to an order is what
          staff do with that figure — it was previously in the page header,
          away from the products it turns into an order. */}
      {onOrder && (
        <button
          style={{ ...s.orderBtn, opacity: orderDisabled ? 0.4 : 1 }}
          onClick={() => !orderDisabled && onOrder()}
          disabled={orderDisabled}
          title={orderTitle}
        >
          <ShoppingCart size={14} /> Convert to order
        </button>
      )}
    </aside>
  );
}

const s = {
  sectionTitle: { margin: 0, fontSize: 11, fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase', color: theme.accentInk },
  hint: { margin: '3px 0 10px', fontSize: 11, color: theme.inkFaint, lineHeight: 1.45 },
  error: { margin: '8px 0 0', fontSize: 11.5, fontWeight: 600, color: theme.high },

  // Full height of its column, and non-scrolling: the enquiry must stay put
  // while the left column scrolls.
  itemsCol: { height: '100%', background: theme.bg, borderLeft: `1px solid ${theme.border}`, padding: '14px 14px 16px', display: 'flex', flexDirection: 'column', gap: 9, overflow: 'hidden', boxSizing: 'border-box' },
  itemsHead: { margin: 0, fontSize: 11, fontWeight: 800, letterSpacing: 0.4, textTransform: 'uppercase', color: theme.inkFaint, flexShrink: 0 },
  // The LIST may scroll internally if a lead somehow has many products —
  // the panel itself never does, so the total stays anchored.
  itemsList: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 7 },

  item: { background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 8, padding: '8px 9px', flexShrink: 0 },
  itemTop: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6 },
  itemName: { fontSize: 12.5, fontWeight: 700, color: theme.ink, lineHeight: 1.3, display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' },
  aiTag: { fontSize: 9, fontWeight: 800, letterSpacing: 0.3, color: theme.accentInk, background: theme.accentSoft, borderRadius: 4, padding: '1px 4px' },
  itemMeta: { margin: '2px 0 0', fontSize: 11, color: theme.inkFaint, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  // Deliberately prominent: the pillow-top row is otherwise identical to the
  // plain one, and both can be on the same lead.
  topTag: { fontSize: 9.5, fontWeight: 800, letterSpacing: 0.2, color: theme.success, background: theme.successBg, borderRadius: 4, padding: '1px 5px' },
  itemBottom: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 7, paddingTop: 7, borderTop: `1px dashed ${theme.border}` },
  qty: { width: 46, background: theme.bg, border: `1.5px solid ${theme.border}`, borderRadius: 6, padding: '3px 6px', fontSize: 12, color: theme.ink, fontFamily: 'inherit', textAlign: 'center' },
  itemPrice: { fontSize: 12.5, fontWeight: 700, color: theme.ink, fontVariantNumeric: 'tabular-nums' },
  del: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, background: 'none', border: 'none', color: theme.inkFaint, cursor: 'pointer', padding: 0, flexShrink: 0 },

  empty: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '18px 8px', background: theme.surface, border: `1px dashed ${theme.border}`, borderRadius: 8 },
  emptyText: { margin: 0, fontSize: 11.5, color: theme.inkFaint, textAlign: 'center' },

  totals: { flexShrink: 0, borderTop: `1px solid ${theme.border}`, paddingTop: 9, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  totalLabel: { fontSize: 11.5, fontWeight: 700, color: theme.ink },
  totalVal: { fontSize: 16, fontWeight: 800, color: theme.ink, fontVariantNumeric: 'tabular-nums' },
  cur: { fontSize: 10.5, fontWeight: 700, color: theme.inkFaint },
  orderBtn: { flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%', marginTop: 2, background: theme.successBg, border: 'none', color: theme.success, fontSize: 12.5, fontWeight: 700, padding: '9px 12px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
};
