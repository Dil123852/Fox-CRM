import { useEffect, useMemo, useState } from 'react';
import { Boxes, AlertTriangle, Plus, Minus, Pencil, Trash2, X, Check, PackageX, Ruler } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { theme, modalBackdrop } from '../lib/theme';
import { roleAllowed } from '../lib/roles';
import PageHeader from '../components/PageHeader';
import { useAuth } from '../lib/AuthContext';
import VariantEditorModal from '../components/VariantEditorModal';
import { useErrorPopup } from '../components/DialogProvider';
import { vh } from '../lib/viewport';

// stock_status is computed server-side (GET /api/inventory) from
// available = stock_quantity - reserved_quantity vs. reorder_threshold, so
// this page and the low-stock alert can never disagree about what "low" means.
const STOCK_STATUS = {
  in_stock: { label: 'In stock', color: theme.success, bg: theme.successBg },
  low:      { label: 'Low',      color: theme.med,     bg: theme.medBg },
  out:      { label: 'Out',      color: theme.high,    bg: theme.highBg },
};

const CATEGORIES = ['mattress', 'pillow'];

// Only these roles can write — mirrors the routes' own requireRole so the UI
// never offers an action the backend would 403 (viewer gets read-only).
const CAN_EDIT = ['admin', 'inventory_manager'];

export default function Inventory({ onToast }) {
  const { staff } = useAuth();
  const canEdit = roleAllowed(staff?.role, CAN_EDIT);

  const [products, setProducts] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  useErrorPopup(error, 'Could not load the inventory');
  const [search, setSearch]     = useState('');
  const [tab, setTab]           = useState('all'); // all | low | inactive
  const [editing, setEditing]   = useState(null);  // product row, or 'new'
  const [deleting, setDeleting] = useState(null);
  const [variantsFor, setVariantsFor] = useState(null); // product whose size/price list is open
  const [busyId, setBusyId]     = useState(null);

  async function load() {
    setLoading(true); setError('');
    try {
      const res  = await apiFetch('/api/inventory');
      const data = await res.json();
      if (data.products) setProducts(data.products);
      else setError(data.error || 'Could not load inventory');
    } catch (err) {
      setError('Network error: ' + err.message);
    }
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  // Relative adjustment (POST .../adjust-stock) rather than writing an
  // absolute number, so two staff counting at once can't clobber each other.
  async function adjust(product, delta) {
    setBusyId(product.id);
    try {
      const res  = await apiFetch(`/api/products/${product.id}/adjust-stock`, {
        method: 'POST', body: JSON.stringify({ delta }),
      });
      const data = await res.json();
      if (data.success) {
        setProducts(prev => prev.map(p => p.id === product.id ? { ...p, ...recompute(data.product) } : p));
      } else {
        onToast?.({ message: data.error || 'Could not adjust stock', type: 'off' });
      }
    } catch (err) {
      onToast?.({ message: 'Network error: ' + err.message, type: 'off' });
    }
    setBusyId(null);
  }

  async function toggleActive(product) {
    setBusyId(product.id);
    try {
      const res  = await apiFetch(`/api/products/${product.id}`, {
        method: 'PATCH', body: JSON.stringify({ active: !product.active }),
      });
      const data = await res.json();
      if (data.success) {
        setProducts(prev => prev.map(p => p.id === product.id ? { ...p, ...recompute(data.product) } : p));
        onToast?.({ message: `${data.product.name} is now ${data.product.active ? 'active' : 'inactive'}`, type: 'on' });
      } else {
        onToast?.({ message: data.error || 'Could not update', type: 'off' });
      }
    } catch (err) {
      onToast?.({ message: 'Network error: ' + err.message, type: 'off' });
    }
    setBusyId(null);
  }

  async function remove(product) {
    setBusyId(product.id);
    try {
      const res  = await apiFetch(`/api/products/${product.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setProducts(prev => prev.filter(p => p.id !== product.id));
        setDeleting(null);
        onToast?.({ message: `${product.name} deleted`, type: 'on' });
      } else {
        // Surface the backend's exact block message — it explains WHY
        // (orders/warranties reference it) and what to do instead.
        setDeleting({ ...product, blockError: data.error });
      }
    } catch (err) {
      setDeleting({ ...product, blockError: 'Network error: ' + err.message });
    }
    setBusyId(null);
  }

  const lowCount = products.filter(p => p.active && p.stock_status !== 'in_stock').length;

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter(p => {
      if (tab === 'low')      { if (!p.active || p.stock_status === 'in_stock') return false; }
      if (tab === 'inactive') { if (p.active) return false; }
      if (tab === 'all')      { if (!p.active) return false; }
      if (!q) return true;
      return [p.name, p.category, p.collection, p.spring_type].filter(Boolean)
        .some(v => String(v).toLowerCase().includes(q));
    });
  }, [products, search, tab]);

  const totals = useMemo(() => {
    const active = products.filter(p => p.active);
    return {
      products: active.length,
      units:    active.reduce((sum, p) => sum + (p.stock_quantity || 0), 0),
      reserved: active.reduce((sum, p) => sum + (p.reserved_quantity || 0), 0),
      low:      lowCount,
    };
  }, [products, lowCount]);

  return (
    <div style={s.page}>
      <PageHeader
        title="Inventory"
        search={search} onSearch={setSearch} searchPlaceholder="Search product, collection, spring type..."
        action={canEdit ? 'New product' : undefined}
        onAction={canEdit ? () => setEditing('new') : undefined}
      />

      <div style={s.statRow}>
        <Stat label="Active products" value={totals.products} />
        <Stat label="Units in stock"  value={totals.units.toLocaleString()} />
        <Stat label="Reserved"        value={totals.reserved.toLocaleString()} hint="held by confirmed orders" />
        <Stat label="Need reorder"    value={totals.low} tone={totals.low > 0 ? 'warn' : undefined} />
      </div>

      <div style={s.tabs} className="scroll-strip">
        {[
          { key: 'all',      label: `Active (${products.filter(p => p.active).length})` },
          { key: 'low',      label: `Need reorder (${lowCount})` },
          { key: 'inactive', label: `Inactive (${products.filter(p => !p.active).length})` },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{ ...s.tab, ...(tab === t.key ? s.tabActive : {}) }}>{t.label}</button>
        ))}
      </div>

      {loading ? (
        <div style={s.center}><div className="summary-spinner" /><span style={s.centerText}>Loading inventory…</span></div>
      ) : error ? (
        <div style={s.center}><p style={{ color: theme.inkFaint, fontSize: 13 }}>{"Couldn't load the inventory."}</p></div>
      ) : visible.length === 0 ? (
        <div style={s.center}>
          <PackageX size={26} color={theme.inkFaint} />
          <span style={s.centerText}>{search ? 'No products match that search' : 'Nothing here'}</span>
        </div>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                {['Product', 'Category', 'Price range', 'In stock', 'Reserved', 'Available', 'Reorder at', 'Status', ''].map((h, i) => (
                  <th key={h || i} style={{ ...s.th, textAlign: i >= 3 && i <= 6 ? 'center' : 'left' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map(p => {
                const st = STOCK_STATUS[p.stock_status] || STOCK_STATUS.out;
                const busy = busyId === p.id;
                return (
                  <tr key={p.id} style={{ ...s.row, opacity: p.active ? 1 : 0.6 }}>
                    <td style={s.td}>
                      <span style={s.name}>{p.name}</span>
                      <span style={s.sub}>
                        {[p.collection, p.spring_type, `${p.variant_count} size${p.variant_count === 1 ? '' : 's'}`,
                          p.warranty_years ? `${p.warranty_years}yr warranty` : null]
                          .filter(Boolean).join(' · ')}
                      </span>
                    </td>
                    <td style={s.td}><span style={s.catPill}>{p.category}</span></td>
                    <td style={s.td}>
                      {p.price_min
                        ? Number(p.price_min) === Number(p.price_max)
                          ? `LKR ${Number(p.price_min).toLocaleString()}`
                          : `LKR ${Number(p.price_min).toLocaleString()} – ${Number(p.price_max).toLocaleString()}`
                        : '—'}
                    </td>
                    <td style={{ ...s.td, textAlign: 'center' }}>
                      {canEdit ? (
                        <div style={s.stepper}>
                          <button style={s.stepBtn} disabled={busy} title="Remove 1"
                            onClick={() => adjust(p, -1)}><Minus size={11} /></button>
                          <span style={s.stepVal}>{p.stock_quantity}</span>
                          <button style={s.stepBtn} disabled={busy} title="Add 1"
                            onClick={() => adjust(p, 1)}><Plus size={11} /></button>
                        </div>
                      ) : <span style={s.numVal}>{p.stock_quantity}</span>}
                    </td>
                    <td style={{ ...s.td, textAlign: 'center' }}>
                      <span style={{ ...s.numVal, color: p.reserved_quantity > 0 ? theme.info : theme.inkFaint }}>
                        {p.reserved_quantity}
                      </span>
                    </td>
                    <td style={{ ...s.td, textAlign: 'center' }}>
                      {/* Can legitimately be negative: reserved by a confirmed
                          order that was never stocked. Flagged rather than
                          hidden — it means stock data needs correcting. */}
                      <span style={{ ...s.numVal, fontWeight: 800, color: p.available < 0 ? theme.high : theme.ink }}
                        title={p.available < 0 ? 'More units are reserved by confirmed orders than exist in stock' : undefined}>
                        {p.available}
                      </span>
                    </td>
                    <td style={{ ...s.td, textAlign: 'center', color: theme.inkFaint }}>{p.reorder_threshold}</td>
                    <td style={s.td}>
                      <span style={{ ...s.pill, color: st.color, background: st.bg }}>{st.label}</span>
                      {!p.active && <span style={{ ...s.pill, ...s.inactivePill }}>Inactive</span>}
                    </td>
                    <td style={{ ...s.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {canEdit && (
                        <>
                          <button style={s.sizesBtn} title="Manage sizes & prices" disabled={busy}
                            onClick={() => setVariantsFor(p)}>
                            <Ruler size={12} /> Sizes
                          </button>
                          <button style={s.iconBtn} title="Edit product" disabled={busy}
                            onClick={() => setEditing(p)}><Pencil size={13} /></button>
                          <button style={s.iconBtn} title={p.active ? 'Set inactive' : 'Set active'} disabled={busy}
                            onClick={() => toggleActive(p)}>{p.active ? <X size={13} /> : <Check size={13} />}</button>
                          {/* Delete is only for a product created by
                              mistake. An inactive one is retired historical
                              data the API refuses to delete, so it isn't
                              offered here either. */}
                          {p.active && (
                            <button style={{ ...s.iconBtn, color: theme.high }} title="Delete product" disabled={busy}
                              onClick={() => setDeleting(p)}><Trash2 size={13} /></button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <ProductModal
          product={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved, wasNew) => {
            setProducts(prev => wasNew
              ? [...prev, recompute(saved)].sort(sortProducts)
              : prev.map(p => p.id === saved.id ? { ...p, ...recompute(saved) } : p));
            setEditing(null);
            onToast?.({ message: `${saved.name} ${wasNew ? 'created' : 'saved'}`, type: 'on' });
          }}
        />
      )}

      {variantsFor && (
        <VariantEditorModal
          product={variantsFor}
          onClose={() => setVariantsFor(null)}
          onSaved={(saved, opts) => {
            setProducts(prev => prev.map(p => p.id === saved.id ? { ...p, ...recompute(saved) } : p));
            // keepOpen: a live autosave, not the user finishing — leave the
            // modal open and stay quiet; its own status line reports the save.
            if (!opts?.keepOpen) {
              setVariantsFor(null);
              onToast?.({ message: `${saved.name}: ${(saved.variants || []).length} size(s) saved`, type: 'on' });
            }
          }}
        />
      )}

      {deleting && (
        <DeleteModal
          product={deleting}
          onClose={() => setDeleting(null)}
          onConfirm={() => remove(deleting)}
        />
      )}
    </div>
  );
}

// PATCH/POST /api/products return the raw product row, without the computed
// columns GET /api/inventory adds — recomputed here with the identical rules
// so a row updated in place keeps behaving like a freshly loaded one.
function recompute(p) {
  const available = (p.stock_quantity || 0) - (p.reserved_quantity || 0);
  const prices = (p.variants || []).map(v => Number(v.price)).filter(n => Number.isFinite(n));
  return {
    ...p,
    available,
    stock_status: available <= 0 ? 'out' : available <= p.reorder_threshold ? 'low' : 'in_stock',
    variant_count: (p.variants || []).length,
    price_min: prices.length ? Math.min(...prices) : null,
    price_max: prices.length ? Math.max(...prices) : null,
  };
}

// Matches GET /api/inventory's ORDER BY (active DESC, category, name).
function sortProducts(a, b) {
  if (a.active !== b.active) return a.active ? -1 : 1;
  if (a.category !== b.category) return a.category < b.category ? -1 : 1;
  return a.name.localeCompare(b.name);
}

// ─── Create / edit ────────────────────────────────────────────────────────────
function ProductModal({ product, onClose, onSaved }) {
  const isNew = !product;
  const [form, setForm] = useState({
    category:  product?.category  || 'mattress',
    name:      product?.name      || '',
    collection: product?.collection || '',
    springType: product?.spring_type || '',
    description: product?.description || '',
    hasPillowTop: !!product?.has_pillow_top_option,
    pillowTopAddonPrice: product?.pillow_top_addon_price != null ? String(Number(product.pillow_top_addon_price)) : '',
    warrantyYears: product?.warranty_years != null ? String(product.warranty_years) : '5',
    stockQuantity: product?.stock_quantity != null ? String(product.stock_quantity) : '0',
    reorderThreshold: product?.reorder_threshold != null ? String(product.reorder_threshold) : '5',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');
  useErrorPopup(error, 'Could not save the product');

  // Mattress-only attributes. A pillow has no springs, is not itself sold
  // with free pillows, and cannot carry a pillow-top layer — so these three
  // fields are hidden once the category is 'pillow' (confirmed with the
  // user). Hidden rather than merely ignored, and the values are forced to
  // their empty equivalents on save below, so switching an existing mattress
  // to 'pillow' clears them instead of leaving stale springs/addon data on
  // the row where the form no longer shows it.
  const isPillow = form.category === 'pillow';

  function set(k, v) { setForm(f => ({ ...f, [k]: v })); }

  async function save() {
    if (!form.name.trim()) { setError('Name is required'); return; }
    setSaving(true); setError('');
    try {
      const res = isNew
        ? await apiFetch('/api/products', {
            method: 'POST',
            body: JSON.stringify({
              category: form.category,
              name: form.name.trim(),
              collection: form.collection.trim() || null,
              springType: isPillow ? null : (form.springType.trim() || null),
              description: form.description.trim() || null,
              hasPillowTopOption: isPillow ? false : form.hasPillowTop,
              pillowTopAddonPrice: (!isPillow && form.hasPillowTop) ? Number(form.pillowTopAddonPrice) || 0 : null,
              warrantyYears: Number(form.warrantyYears) || 0,
              stockQuantity: Number(form.stockQuantity) || 0,
              reorderThreshold: Number(form.reorderThreshold) || 0,
              // A new product starts with no variants — prices are the
              // per-dimension list, edited where they're used rather than
              // hand-typed 21 rows deep in this form.
              variants: [],
            }),
          })
        // PATCH reads snake_case straight off req.body (unlike POST's
        // camelCase) — must match its `allowed` list exactly or the field
        // silently fails to persist.
        : await apiFetch(`/api/products/${product.id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              category: form.category,
              name: form.name.trim(),
              collection: form.collection.trim() || null,
              spring_type: isPillow ? null : (form.springType.trim() || null),
              description: form.description.trim() || null,
              has_pillow_top_option: isPillow ? false : form.hasPillowTop,
              pillow_top_addon_price: (!isPillow && form.hasPillowTop) ? Number(form.pillowTopAddonPrice) || 0 : null,
              warranty_years: Number(form.warrantyYears) || 0,
              reorder_threshold: Number(form.reorderThreshold) || 0,
              // stock_quantity is intentionally NOT sent on edit — stock
              // moves through adjust-stock (relative, race-safe, guarded
              // against dropping below reserved units), not by typing an
              // absolute number here.
            }),
          });
      const data = await res.json();
      if (data.success) onSaved(data.product, isNew);
      else setError(data.error || 'Could not save');
    } catch (err) {
      setError('Network error: ' + err.message);
    }
    setSaving(false);
  }

  return (
    <div style={m.backdrop} className="responsive-modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={m.modal} className="responsive-modal">
        <div style={m.header}>
          <div style={m.headerIcon}><Boxes size={17} color={theme.accentInk} /></div>
          <div style={{ flex: 1 }}>
            <p style={m.title}>{isNew ? 'New product' : 'Edit product'}</p>
            {!isNew && <p style={m.sub}>{product.name}</p>}
          </div>
          <button style={m.closeBtn} onClick={onClose}><X size={16} /></button>
        </div>

        <div style={m.body}>
          <div style={m.row2}>
            <F label="Category">
              <select style={m.input} value={form.category} onChange={e => set('category', e.target.value)}>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </F>
            <F label="Name" hint="Must be unique — orders and warranties are matched to products by name">
              <input style={m.input} value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Nidikumba Rise" />
            </F>
          </div>

          {/* Spring type is mattress-only, so a pillow gets Collection on its
              own instead of a half-empty two-column row. */}
          <div style={isPillow ? undefined : m.row2}>
            <F label="Collection"><input style={m.input} value={form.collection} onChange={e => set('collection', e.target.value)} placeholder="optional" /></F>
            {!isPillow && (
              <F label="Spring type"><input style={m.input} value={form.springType} onChange={e => set('springType', e.target.value)} placeholder="optional" /></F>
            )}
          </div>

          <F label="Description">
            <textarea style={{ ...m.input, minHeight: 60, resize: 'vertical' }} value={form.description}
              onChange={e => set('description', e.target.value)} placeholder="Thickness, comfort layers, etc." />
          </F>

          {/* Two fields since the per-product "Free pillows" count was removed
              (migration 039) — giveaways are now chosen per order, not per
              product, so the row is a plain two-column one for every category. */}
          <div style={m.row2}>
            <F label="Warranty (years)">
              <input style={m.input} type="number" min="0" value={form.warrantyYears} onChange={e => set('warrantyYears', e.target.value)} />
            </F>

            <F label="Reorder at" hint="Flag as low when available drops to this">
              <input style={m.input} type="number" min="0" value={form.reorderThreshold} onChange={e => set('reorderThreshold', e.target.value)} />
            </F>
          </div>

          {!isPillow && (
            <F label="Pillow top">
              <label style={m.checkRow}>
                <input type="checkbox" checked={form.hasPillowTop} onChange={e => set('hasPillowTop', e.target.checked)} />
                <span>Offer a pillow-top option</span>
              </label>
            </F>
          )}
          {!isPillow && form.hasPillowTop && (
            <F label="Pillow-top add-on price (LKR)" hint="Flat amount added on top of the chosen size's price">
              <input style={m.input} type="number" min="0" value={form.pillowTopAddonPrice}
                onChange={e => set('pillowTopAddonPrice', e.target.value)} placeholder="e.g. 25000" />
            </F>
          )}

          {isNew ? (
            <F label="Opening stock">
              <input style={m.input} type="number" min="0" value={form.stockQuantity} onChange={e => set('stockQuantity', e.target.value)} />
            </F>
          ) : (
            <p style={m.note}>
              Stock is currently <strong>{product.stock_quantity}</strong> ({product.reserved_quantity} reserved).
              Change it with the +/− controls in the table, so adjustments stay safe when two people count at once.
            </p>
          )}

          {isNew && (
            <p style={m.note}>
              Sizes and prices (the per-dimension variant list) aren&apos;t set here — a new product starts with none, so it won&apos;t
              appear as a priced option in order forms until variants are added.
            </p>
          )}

        </div>

        <div style={m.footer}>
          <button style={m.cancelBtn} onClick={onClose} disabled={saving}>Cancel</button>
          <button style={m.saveBtn} onClick={save} disabled={saving || !form.name.trim()}>
            {saving ? 'Saving…' : isNew ? 'Create product' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Delete confirmation ──────────────────────────────────────────────────────
function DeleteModal({ product, onClose, onConfirm }) {
  // reference_count comes from GET /api/inventory using the same rule the
  // DELETE route enforces, so a blocked delete is predicted here rather than
  // discovered by attempting it.
  const blocked = Number(product.reference_count) > 0;
  return (
    <div style={m.backdrop} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ ...m.modal, maxWidth: 460 }}>
        <div style={m.header}>
          <div style={{ ...m.headerIcon, background: theme.highBg }}><AlertTriangle size={17} color={theme.high} /></div>
          <div style={{ flex: 1 }}><p style={m.title}>Delete {product.name}?</p></div>
          <button style={m.closeBtn} onClick={onClose}><X size={16} /></button>
        </div>
        <div style={m.body}>
          {product.blockError ? (
            <p style={m.blockMsg}>{product.blockError}</p>
          ) : blocked ? (
            <p style={m.blockMsg}>
              This product is referenced by {product.reference_count} order/warranty record(s) and can&apos;t be deleted —
              that history must not disappear. Set it <strong>Inactive</strong> instead: it stays out of the catalog and
              order forms while past orders and warranties keep working.
            </p>
          ) : (
            <p style={{ fontSize: 13, color: theme.inkSoft, lineHeight: 1.6, margin: 0 }}>
              This permanently removes the product. It isn&apos;t referenced by any order, warranty or service ticket, so
              nothing else is affected. This can&apos;t be undone.
            </p>
          )}
        </div>
        <div style={m.footer}>
          <button style={m.cancelBtn} onClick={onClose}>{blocked || product.blockError ? 'Close' : 'Cancel'}</button>
          {!blocked && !product.blockError && (
            <button style={{ ...m.saveBtn, background: theme.high }} onClick={onConfirm}>Delete permanently</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Small bits ───────────────────────────────────────────────────────────────
function Stat({ label, value, hint, tone }) {
  return (
    <div style={s.stat}>
      <p style={s.statLabel}>{label}</p>
      <p style={{ ...s.statValue, color: tone === 'warn' ? theme.med : theme.ink }}>{value}</p>
      {hint && <p style={s.statHint}>{hint}</p>}
    </div>
  );
}

function F({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={m.label}>{label}</label>
      {children}
      {hint && <p style={m.hint}>{hint}</p>}
    </div>
  );
}

const s = {
  page: { display: 'flex', flexDirection: 'column', height: '100%', background: theme.bg, overflow: 'hidden' },

  statRow: { display: 'flex', padding: 0, background: theme.surface, borderBottom: `1px solid ${theme.border}`, flexShrink: 0 },
  stat: { flex: 1, minWidth: 0, background: theme.surface, borderRight: `1px solid ${theme.borderSoft}`, borderRadius: 0, padding: '11px 16px 13px' },
  statLabel: { margin: 0, fontSize: 10, fontWeight: 400, color: theme.inkSoft, textTransform: 'none', letterSpacing: 0, marginBottom: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  statValue: { margin: 0, fontSize: 19, fontWeight: 600, color: theme.ink, letterSpacing: '-0.02em', lineHeight: 1 },
  statHint: { margin: '4px 0 0', fontSize: 10, color: theme.inkFaint },

  tabs: { display: 'flex', gap: 18, padding: '0 16px', background: theme.surface, borderBottom: `1px solid ${theme.border}`, flexShrink: 0, overflowX: 'auto' },
  tab: { fontSize: 11.5, fontWeight: 400, padding: '9px 0 8px', cursor: 'pointer', fontFamily: 'inherit', border: 'none', background: 'none', color: theme.inkSoft, whiteSpace: 'nowrap', borderBottom: '1.5px solid transparent', marginBottom: -1, transition: 'color 0.12s' },
  tabActive: { color: theme.accentInk, fontWeight: 600, borderBottomColor: theme.accent },

  tableWrap: { flex: 1, overflow: 'auto', padding: '0 28px 24px' },
  // 'collapse' + theme.radiusLg to match every other table; this was the only
  // one using 'separate' with a hardcoded radius, which (with the duplicate
  // border on td below) drew a visibly heavier double rule between rows.
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 10.5, background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: theme.radiusLg },
  th: { textAlign: 'left', fontSize: 8.5, fontWeight: 500, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.06em', padding: '6px 8px', borderBottom: `1px solid ${theme.border}`, background: theme.surface, position: 'sticky', top: 0, zIndex: 1, whiteSpace: 'nowrap' },
  row: { borderBottom: `1px solid ${theme.borderSoft}` },
  // No borderBottom here: `row` above already draws it. Having it on both is
  // what produced the doubled rule.
  td: { padding: '8px 8px', fontSize: 10.5, color: theme.inkSoft, verticalAlign: 'middle' },
  name: { display: 'block', fontSize: 13, fontWeight: 700, color: theme.ink },
  sub: { display: 'block', fontSize: 11, color: theme.inkFaint, marginTop: 2 },
  catPill: { display: 'inline-block', fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3, color: theme.inkSoft, background: theme.borderSoft, borderRadius: 6, padding: '3px 7px' },
  numVal: { fontSize: 13, fontWeight: 700, color: theme.ink, fontVariantNumeric: 'tabular-nums' },
  pill: { display: 'inline-block', fontSize: 10.5, fontWeight: 700, borderRadius: 6, padding: '3px 8px', whiteSpace: 'nowrap' },
  inactivePill: { marginLeft: 5, color: theme.cancel, background: theme.cancelBg },

  stepper: { display: 'inline-flex', alignItems: 'center', gap: 4 },
  stepBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 21, height: 21, borderRadius: 6, border: `1px solid ${theme.border}`, background: theme.bg, color: theme.inkSoft, cursor: 'pointer', padding: 0 },
  stepVal: { minWidth: 26, textAlign: 'center', fontSize: 13, fontWeight: 800, color: theme.ink, fontVariantNumeric: 'tabular-nums' },

  sizesBtn: { display: 'inline-flex', alignItems: 'center', gap: 4, background: theme.surface, border: `1.5px solid ${theme.border}`, color: theme.inkSoft, fontSize: 11.5, fontWeight: 600, padding: '5px 9px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', marginRight: 4, whiteSpace: 'nowrap' },
  iconBtn: { background: 'none', border: 'none', color: theme.inkFaint, cursor: 'pointer', padding: 5, marginLeft: 2 },

  center: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 9 },
  centerText: { color: theme.inkFaint, fontSize: 13 },
};

const m = {
  backdrop: modalBackdrop,
  modal: { background: theme.surface, borderRadius: 16, width: '100%', maxWidth: 620, maxHeight: vh(90), display: 'flex', flexDirection: 'column', boxShadow: theme.shadowMd, overflow: 'hidden' },
  header: { display: 'flex', alignItems: 'center', gap: 11, padding: '15px 18px', borderBottom: `1px solid ${theme.border}` },
  headerIcon: { width: 34, height: 34, borderRadius: 9, background: theme.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  title: { margin: 0, fontSize: 14.5, fontWeight: 700, color: theme.ink },
  sub: { margin: 0, fontSize: 12, color: theme.inkFaint },
  closeBtn: { display: 'flex', background: theme.borderSoft, border: 'none', color: theme.inkSoft, width: 27, height: 27, borderRadius: 7, cursor: 'pointer', alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, overflowY: 'auto', padding: '16px 18px' },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  row3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 },
  label: { display: 'block', fontSize: 11, fontWeight: 600, color: theme.inkFaint, marginBottom: 4 },
  hint: { margin: '4px 0 0', fontSize: 10.5, color: theme.inkFaint, lineHeight: 1.45 },
  input: { width: '100%', background: theme.bg, border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '8px 11px', fontSize: 13, color: theme.ink, fontFamily: 'inherit', boxSizing: 'border-box' },
  checkRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: theme.inkSoft, cursor: 'pointer' },
  note: { margin: '4px 0 12px', padding: '9px 11px', borderRadius: 8, background: theme.infoBg, fontSize: 11.5, lineHeight: 1.5, color: theme.ink },
  blockMsg: { margin: 0, padding: '10px 12px', borderRadius: 8, background: theme.medBg, border: `1px solid ${theme.med}`, fontSize: 12.5, lineHeight: 1.55, color: theme.ink },
  error: { margin: '8px 0 0', fontSize: 12, fontWeight: 600, color: theme.high },
  footer: { display: 'flex', justifyContent: 'flex-end', gap: 9, padding: '13px 18px', borderTop: `1px solid ${theme.border}` },
  cancelBtn: { background: theme.surface, border: `1.5px solid ${theme.border}`, color: theme.inkSoft, fontSize: 13, fontWeight: 600, padding: '8px 15px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
  saveBtn: { background: theme.accent, border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
};
