import { useEffect, useMemo, useRef, useState } from 'react';
import { Ruler, Plus, Trash2, X, AlertTriangle, ChevronDown, ChevronRight, Check } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { theme, modalBackdrop } from '../lib/theme';
import { vh } from '../lib/viewport';

// Size/price list editor for one product — opened from the Inventory page's
// "Sizes" button, deliberately separate from the edit-product form (a mattress
// has 21 options; that does not belong inside a details form).
//
// TWO-STEP MODEL, matching how the data is really shaped: a product has a few
// named SIZES (Single/Double/Queen/King/Extra Large), and each size has
// several DIMENSION + PRICE options under it. So this editor is size groups
// that own their rows — name the size first, then add dimensions and prices
// inside it. The previous flat list made the size a property of each row,
// which is backwards: it meant retyping "Queen" on four rows, and a new
// product's very first row had nowhere to put a size at all.
//
// TWO VARIANT SHAPES EXIST IN REAL DATA and both must keep working:
//   current catalog -> {size, dimension, price}  (dimension = WxL in inches)
//   3 retired rows  -> {size, height, price}     (height = spring thickness)
// The product's existing key is detected once and preserved on every row
// written back, so editing a legacy product never silently rewrites its rows
// into the new shape — order forms read v.dimension directly.
//
// Pillows are edited with this SAME two-step model (confirmed with the user):
// they have real named sizes with per-dimension prices, exactly like a
// mattress, so there is no pillow-specific view here any more. The one thing
// preserved is the older single {price}-only shape that the two seeded pillows
// still use — those load as one unnamed group and keep saving as a price-only
// variant until staff give them real sizes, so nothing is invented for them
// and neither pillow stops being orderable in the meantime.

const SIZE_ORDER = ['Single', 'Double', 'Queen', 'King', 'Extra Large'];

function detectDimKey(variants) {
  if (variants.some(v => v.height !== undefined && v.dimension === undefined)) return 'height';
  return 'dimension';
}

let uid = 0;
const nextId = () => `v${Date.now().toString(36)}${uid++}`;

// Saved variants -> size groups, preserving the order they appear in. Groups
// and rows carry their own ids so renaming a size never remounts its inputs
// (which would drop focus mid-typing).
function buildGroups(variants, dimKey) {
  const order = [];
  const byName = new Map();
  for (const v of variants || []) {
    const name = (v.size ?? '').toString();
    if (!byName.has(name)) { byName.set(name, { _id: nextId(), name, rows: [] }); order.push(name); }
    byName.get(name).rows.push({
      _id: nextId(),
      dim: ((dimKey === 'height' ? v.height : v.dimension) ?? '').toString(),
      price: v.price != null ? String(v.price) : '',
    });
  }
  return order.map(n => byName.get(n));
}

export default function VariantEditorModal({ product, onClose, onSaved }) {
  const dimKey = useMemo(() => detectDimKey(product.variants || []), [product.variants]);
  const dimLabel = dimKey === 'height' ? 'Thickness' : 'Dimension';

  // Whether this product ARRIVED as a single unsized {price} row (the shape
  // the two seeded pillows still use). Decided from the PRODUCT's saved
  // variants, never from what is currently typed — inferring a shape from
  // empty inputs was a real bug that made a new product's first row
  // impossible to fill in. It is no longer keyed on the category: a pillow
  // gets the full size editor like any mattress. This only stays true while
  // the row is still genuinely unsized, so the moment staff type a size the
  // payload below writes a normal sized variant instead.
  const startedUnsized = (product.variants || []).length === 1
    && !(product.variants || []).some(v => v.size || v.dimension || v.height);

  const [groups, setGroups] = useState(() => buildGroups(product.variants, dimKey));
  const [collapsed, setCollapsed] = useState({});
  const [addingSize, setAddingSize] = useState(false);
  const [newSizeName, setNewSizeName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [bulk, setBulk] = useState('');
  // Live-save status, so the button itself says whether the current state is
  // in the database: 'saved' (nothing pending) | 'dirty' (edits not yet
  // written) | 'saving' | 'error'. Starts 'saved' because what's on screen
  // is exactly what was loaded.
  const [status, setStatus] = useState('saved');
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const saveTimer = useRef(null);
  const saveSeq = useRef(0);

  const usedNames = groups.map(g => g.name.trim().toLowerCase());
  const suggestions = SIZE_ORDER.filter(sz => !usedNames.includes(sz.toLowerCase()));

  // ── step 1: the size group ──────────────────────────────────────────────
  function addSize(name) {
    const clean = (name || '').trim();
    if (!clean) { setError('Enter a size name'); return; }
    if (usedNames.includes(clean.toLowerCase())) { setError(`"${clean}" is already in the list`); return; }
    // A new size opens with one empty dimension+price row ready to fill —
    // that is the point of the two-step flow.
    setGroups(prev => [...prev, { _id: nextId(), name: clean, rows: [{ _id: nextId(), dim: '', price: '' }] }]);
    setNewSizeName('');
    setAddingSize(false);
    setError('');
  }
  function renameSize(gid, name) {
    setGroups(prev => prev.map(g => g._id === gid ? { ...g, name } : g));
    setError('');
  }
  function removeSize(gid) {
    setGroups(prev => prev.filter(g => g._id !== gid));
    setError('');
  }

  // ── step 2: dimensions + prices inside a size ───────────────────────────
  function addRow(gid) {
    setGroups(prev => prev.map(g => g._id === gid ? { ...g, rows: [...g.rows, { _id: nextId(), dim: '', price: '' }] } : g));
    setError('');
  }
  function updateRow(gid, rid, field, value) {
    setGroups(prev => prev.map(g => g._id !== gid ? g : {
      ...g, rows: g.rows.map(r => r._id === rid ? { ...r, [field]: value } : r),
    }));
    setError('');
  }
  function removeRow(gid, rid) {
    setGroups(prev => prev.map(g => g._id !== gid ? g : { ...g, rows: g.rows.filter(r => r._id !== rid) }));
    setError('');
  }
  // One price across every dimension of a size — the common real edit
  // ("Queen went up by 2,000") without retyping four rows.
  function setGroupPrice(gid, value) {
    const price = String(value).trim();
    if (!price) return;
    setGroups(prev => prev.map(g => g._id !== gid ? g : { ...g, rows: g.rows.map(r => ({ ...r, price })) }));
  }

  // ── validation, mirroring the backend so Save is blocked before a 400 ───
  const dupeNames = useMemo(() => {
    const seen = new Map(); const bad = new Set();
    groups.forEach(g => {
      const k = g.name.trim().toLowerCase();
      if (!k) return;
      if (seen.has(k)) { bad.add(g._id); bad.add(seen.get(k)); } else seen.set(k, g._id);
    });
    return bad;
  }, [groups]);

  const dupeRows = useMemo(() => {
    const bad = new Set();
    groups.forEach(g => {
      const seen = new Map();
      g.rows.forEach(r => {
        const k = r.dim.trim().toLowerCase();
        if (seen.has(k)) { bad.add(r._id); bad.add(seen.get(k)); } else seen.set(k, r._id);
      });
    });
    return bad;
  }, [groups]);

  const badRows = useMemo(() => {
    const bad = new Set();
    groups.forEach(g => g.rows.forEach(r => {
      const ok = r.price !== '' && Number.isFinite(Number(r.price)) && Number(r.price) >= 0;
      if (!ok) bad.add(r._id);
    }));
    return bad;
  }, [groups]);

  const emptyGroups = useMemo(
    () => new Set(groups.filter(g => !g.name.trim() || g.rows.length === 0).map(g => g._id)),
    [groups]
  );

  const totalRows = groups.reduce((n, g) => n + g.rows.length, 0);
  // One uniform rule — a pillow is validated exactly like a mattress. The
  // single exception is a product that arrived unsized and is still unsized:
  // its one group legitimately has no name, so the "every group needs a name"
  // rule would otherwise make an untouched seeded pillow unsavable.
  const stillUnsized = startedUnsized && groups.length === 1
    && !groups[0].name.trim() && groups[0].rows.length === 1 && !groups[0].rows[0].dim.trim();
  const canSave = totalRows > 0 && dupeNames.size === 0 && dupeRows.size === 0 && badRows.size === 0
    && (stillUnsized || emptyGroups.size === 0);

  const allPrices = groups.flatMap(g => g.rows.map(r => Number(r.price)).filter(n => Number.isFinite(n)));
  const priceMin = allPrices.length ? Math.min(...allPrices) : null;
  const priceMax = allPrices.length ? Math.max(...allPrices) : null;

  // Paste a real price list: "size dimension price" per line, grouped by size
  // automatically — what this editor most needs, versus typing 21 rows.
  function applyBulk() {
    const lines = bulk.split('\n').map(l => l.trim()).filter(Boolean);
    const order = []; const byName = new Map();
    for (const line of lines) {
      const parts = line.split(/[\s,\t]+/).filter(Boolean);
      if (parts.length < 3) continue;
      const price = parts[parts.length - 1].replace(/[^0-9.]/g, '');
      const dim = parts[parts.length - 2];
      const name = parts.slice(0, parts.length - 2).join(' ');
      if (!price || !Number.isFinite(Number(price)) || !name) continue;
      if (!byName.has(name)) { byName.set(name, { _id: nextId(), name, rows: [] }); order.push(name); }
      byName.get(name).rows.push({ _id: nextId(), dim, price });
    }
    if (order.length === 0) {
      setError('Could not read any rows. Use one per line: size dimension price (e.g. "Queen 84x60 51200")');
      return;
    }
    setGroups(order.map(n => byName.get(n)));
    setBulk(''); setError('');
  }

  // Serialize current state into the API payload. Also the dirty-tracking
  // key: if this string matches what was last written, there is nothing to
  // save (so reopening or a no-op edit never fires a request).
  const payload = useMemo(() => {
    // A product still in its original unsized shape writes back the same
    // price-only variant it came with (the backend allows this only as a
    // single-variant product), so opening a seeded pillow and closing it
    // never rewrites its shape. Everything else — including that same
    // pillow the moment a size is typed — writes normal sized rows.
    const variants = stillUnsized
      ? (groups[0].rows[0].price === '' ? [] : [{ price: Number(groups[0].rows[0].price) }])
      : groups.flatMap(g => g.rows.map(r => {
          const out = { size: g.name.trim(), price: Number(r.price) };
          if (r.dim.trim()) out[dimKey] = r.dim.trim();
          return out;
        }));
    return JSON.stringify(variants);
  }, [groups, stillUnsized, dimKey]);

  const savedPayload = useRef(payload);

  // Live save: debounced so typing a price doesn't fire a request per
  // keystroke, and only ever when the current state is actually valid —
  // a half-typed row must not be written, and must not look "saved" either.
  useEffect(() => {
    if (payload === savedPayload.current) { setStatus('saved'); return; }
    if (!canSave) { setStatus('dirty'); return; }
    setStatus('dirty');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void persist(); }, 900);
    return () => clearTimeout(saveTimer.current);
  }, [payload, canSave]); // eslint-disable-line react-hooks/exhaustive-deps

  // Flush a pending debounce on unmount so closing the modal right after an
  // edit doesn't silently drop it.
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  async function persist() {
    if (!canSave) return;
    const mine = ++saveSeq.current;
    const sending = payload;
    setSaving(true); setStatus('saving'); setError('');
    try {
      const res = await apiFetch(`/api/products/${product.id}/variants`, {
        method: 'PUT', body: JSON.stringify({ variants: JSON.parse(sending) }),
      });
      const data = await res.json();
      // A newer save started while this one was in flight — its result wins.
      if (mine !== saveSeq.current) return;
      if (data.success) {
        savedPayload.current = sending;
        setStatus(sending === payload ? 'saved' : 'dirty');
        setLastSavedAt(new Date());
        onSaved(data.product, { keepOpen: true });
      } else {
        setStatus('error');
        setError(data.error || 'Could not save');
      }
    } catch (err) {
      if (mine !== saveSeq.current) return;
      setStatus('error');
      setError(
        err.message === 'Failed to fetch'
          ? 'Could not reach the server. Check that the backend is running, then press Retry.'
          : 'Network error: ' + err.message
      );
    }
    setSaving(false);
  }

  function saveNow() {
    clearTimeout(saveTimer.current);
    if (!canSave) {
      if (emptyGroups.size > 0)      setError(`Every size needs a name and at least one ${dimLabel.toLowerCase()} + price.`);
      else if (dupeNames.size > 0)   setError('Two sizes have the same name.');
      else if (dupeRows.size > 0)    setError(`A size lists the same ${dimLabel.toLowerCase()} twice.`);
      else if (badRows.size > 0)     setError('Every row needs a valid price.');
      else                           setError('Add at least one size.');
      return;
    }
    void persist();
  }

  return (
    <div style={s.backdrop} className="responsive-modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={s.modal} className="responsive-modal">
        <div style={s.header}>
          <div style={s.headerIcon}><Ruler size={17} color={theme.accentInk} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={s.title}>Sizes &amp; prices</p>
            <p style={s.sub}>{product.name}</p>
          </div>
          <button style={s.closeBtn} onClick={onClose}><X size={16} /></button>
        </div>

        <div style={s.summaryBar}>
          {stillUnsized ? <span>single price, no sizes yet</span> : (
            <>
              <span><strong>{groups.length}</strong> size{groups.length === 1 ? '' : 's'}</span>
              <span><strong>{totalRows}</strong> option{totalRows === 1 ? '' : 's'}</span>
            </>
          )}
          {priceMin != null && (
            <span>{priceMin === priceMax
              ? `LKR ${priceMin.toLocaleString()}`
              : `LKR ${priceMin.toLocaleString()} – ${priceMax.toLocaleString()}`}</span>
          )}
          {dimKey === 'height' && (
            <span style={s.legacyTag} title="This product uses the older thickness-based shape; it is preserved as-is">
              legacy thickness format
            </span>
          )}
        </div>

        <div style={s.body}>
          {stillUnsized && (
            <p style={s.hint}>
              This product still has one price and no sizes. Add a size below to
              give it real size and {dimLabel.toLowerCase()} options — its current
              single price keeps working until you do.
            </p>
          )}
          {(
            <>
              {groups.length === 0 && !addingSize && (
                <div style={s.empty}>
                  <p style={s.emptyText}>
                    No sizes yet. Add a size first (Single, Queen, King…), then add its {dimLabel.toLowerCase()}s and prices.
                    This product won&apos;t appear as a priced option in order forms until at least one is added.
                  </p>
                </div>
              )}

              {groups.map(g => {
                const isCollapsed = collapsed[g._id];
                const nameBad = dupeNames.has(g._id) || !g.name.trim();
                return (
                  <div key={g._id} style={{ ...s.group, ...(emptyGroups.has(g._id) ? s.groupBad : {}) }}>
                    <div style={s.groupHead}>
                      <button style={s.chev} onClick={() => setCollapsed(c => ({ ...c, [g._id]: !c[g._id] }))}
                        title={isCollapsed ? 'Show options' : 'Hide options'}>
                        {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                      </button>
                      {/* The size name belongs to the GROUP — edited once here,
                          not retyped on every dimension row. */}
                      <input style={{ ...s.sizeInput, ...(nameBad ? s.inputBad : {}) }} value={g.name}
                        onChange={e => renameSize(g._id, e.target.value)} placeholder="Size name" />
                      <span style={s.groupCount}>
                        {g.rows.length} {dimLabel.toLowerCase()}{g.rows.length === 1 ? '' : 's'}
                      </span>
                      <input style={s.groupPriceInput} type="number" min="0" placeholder="set all"
                        onKeyDown={e => { if (e.key === 'Enter') { setGroupPrice(g._id, e.currentTarget.value); e.currentTarget.value = ''; } }}
                        onBlur={e => { setGroupPrice(g._id, e.target.value); e.target.value = ''; }}
                        title={`Apply one price to every ${dimLabel.toLowerCase()} of this size`} />
                      <button style={s.groupDel} onClick={() => removeSize(g._id)} title="Remove this size">
                        <Trash2 size={13} />
                      </button>
                    </div>

                    {!isCollapsed && (
                      <>
                        {g.rows.length > 0 && (
                          <div style={s.rowHead}>
                            <span style={{ flex: 1 }}>{dimLabel} (in)</span>
                            <span style={{ flex: 1, textAlign: 'right' }}>Price (LKR)</span>
                            <span style={{ width: 28 }} />
                          </div>
                        )}
                        {g.rows.map(r => {
                          const bad = badRows.has(r._id) || dupeRows.has(r._id);
                          return (
                            <div key={r._id} style={s.row}>
                              <input style={{ ...s.input, flex: 1, ...(bad ? s.inputBad : {}) }} value={r.dim}
                                onChange={e => updateRow(g._id, r._id, 'dim', e.target.value)}
                                placeholder={dimKey === 'height' ? '10' : '84x60'} />
                              <input style={{ ...s.input, flex: 1, textAlign: 'right', ...(bad ? s.inputBad : {}) }}
                                type="number" min="0" value={r.price}
                                onChange={e => updateRow(g._id, r._id, 'price', e.target.value)} placeholder="0" />
                              <button style={s.delBtn} onClick={() => removeRow(g._id, r._id)} title="Remove">
                                <Trash2 size={13} />
                              </button>
                            </div>
                          );
                        })}
                        <button style={s.addRowBtn} onClick={() => addRow(g._id)}>
                          <Plus size={12} /> Add {dimLabel.toLowerCase()} &amp; price
                        </button>
                      </>
                    )}
                  </div>
                );
              })}

              {/* Step 1 of the flow: name the size, then its rows appear. */}
              {addingSize ? (
                <div style={s.newSizeBox}>
                  <label style={s.label}>New size name</label>
                  <div style={s.newSizeRow}>
                    <input style={{ ...s.input, flex: 1 }} autoFocus value={newSizeName}
                      onChange={e => { setNewSizeName(e.target.value); setError(''); }}
                      onKeyDown={e => {
                        if (e.key === 'Enter') addSize(newSizeName);
                        if (e.key === 'Escape') { setAddingSize(false); setNewSizeName(''); }
                      }}
                      placeholder="e.g. Queen" />
                    <button style={s.primarySm} onClick={() => addSize(newSizeName)}>Add size</button>
                    <button style={s.cancelSm} onClick={() => { setAddingSize(false); setNewSizeName(''); }}>Cancel</button>
                  </div>
                  {suggestions.length > 0 && (
                    <div style={s.chips}>
                      <span style={s.chipsLabel}>Standard:</span>
                      {suggestions.map(sz => (
                        <button key={sz} style={s.chip} onClick={() => addSize(sz)}>{sz}</button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <button style={s.addSizeBtn} onClick={() => setAddingSize(true)}>
                  <Plus size={14} /> {groups.length === 0 ? 'Add first size' : 'Add another size'}
                </button>
              )}

              {(dupeNames.size > 0 || dupeRows.size > 0) && (
                <p style={s.warn}>
                  <AlertTriangle size={13} />
                  {dupeNames.size > 0
                    ? 'Two sizes have the same name.'
                    : `A size lists the same ${dimLabel.toLowerCase()} twice — the customer would see one option at two prices.`}
                </p>
              )}

              <details style={s.bulkWrap}>
                <summary style={s.bulkSummary}>Paste a price list</summary>
                <p style={s.hint}>
                  One per line as <code>size dimension price</code> (e.g. <code>Queen 84x60 51200</code>).
                  Sizes are grouped automatically. This <strong>replaces</strong> everything above.
                </p>
                <textarea style={s.bulkInput} value={bulk} onChange={e => setBulk(e.target.value)}
                  placeholder={'Single 72x36 39700\nSingle 84x36 45100\nQueen 84x60 51200'} />
                <button style={s.bulkBtn} onClick={applyBulk} disabled={!bulk.trim()}>Replace all</button>
              </details>
            </>
          )}

          {error && <p style={s.error}>{error}</p>}
        </div>

        <div style={s.footer}>
          {/* Live status, so it's never ambiguous whether what's on screen is
              in the database. Changes are written automatically ~1s after
              typing stops; the button doubles as "save now" / "retry". */}
          <div style={s.statusWrap}>
            {status === 'saving' ? (
              <span style={{ ...s.status, color: theme.inkSoft }}>
                <span className="summary-spinner" style={s.statusSpinner} /> Saving…
              </span>
            ) : status === 'error' ? (
              <span style={{ ...s.status, color: theme.high }}><AlertTriangle size={12} /> Not saved</span>
            ) : status === 'dirty' ? (
              <span style={{ ...s.status, color: theme.med }}>
                <span style={{ ...s.dot, background: theme.med }} />
                {canSave ? 'Unsaved changes' : 'Finish the highlighted rows'}
              </span>
            ) : (
              <span style={{ ...s.status, color: theme.success }}>
                <Check size={12} /> Saved{lastSavedAt ? ` · ${lastSavedAt.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })}` : ''}
              </span>
            )}
          </div>
          <button style={s.cancelBtn} onClick={onClose} disabled={saving}>
            {status === 'saved' ? 'Close' : 'Cancel'}
          </button>
          <button
            style={{ ...s.saveBtn, ...(status === 'error' ? s.retryBtn : {}), opacity: saving || (status === 'saved' && !canSave) ? 0.5 : 1 }}
            onClick={saveNow} disabled={saving}
          >
            {status === 'saving' ? 'Saving…'
              : status === 'error' ? 'Retry save'
              : status === 'dirty' ? 'Save now'
              : stillUnsized ? 'Saved' : `Saved · ${totalRows} option${totalRows === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

const s = {
  // zIndex above the default 300: this modal opens on top of Inventory's own.
  backdrop: { ...modalBackdrop, zIndex: 320 },
  modal: { background: theme.surface, borderRadius: 16, width: '100%', maxWidth: 620, maxHeight: vh(92), display: 'flex', flexDirection: 'column', boxShadow: theme.shadowMd, overflow: 'hidden' },

  header: { display: 'flex', alignItems: 'center', gap: 11, padding: '15px 18px', borderBottom: `1px solid ${theme.border}` },
  headerIcon: { width: 34, height: 34, borderRadius: 9, background: theme.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  title: { margin: 0, fontSize: 14.5, fontWeight: 700, color: theme.ink },
  sub: { margin: 0, fontSize: 12, color: theme.inkFaint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  closeBtn: { display: 'flex', background: theme.borderSoft, border: 'none', color: theme.inkSoft, width: 27, height: 27, borderRadius: 7, cursor: 'pointer', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },

  summaryBar: { display: 'flex', alignItems: 'center', gap: 14, padding: '9px 18px', background: theme.bg, borderBottom: `1px solid ${theme.border}`, fontSize: 12, color: theme.inkSoft, flexWrap: 'wrap', flexShrink: 0 },
  legacyTag: { fontSize: 10.5, fontWeight: 700, color: theme.med, background: theme.medBg, borderRadius: 6, padding: '2px 7px' },

  body: { flex: 1, overflowY: 'auto', padding: '14px 18px' },

  group: { marginBottom: 12, border: `1px solid ${theme.border}`, borderRadius: 10, overflow: 'hidden' },
  groupBad: { borderColor: theme.med },
  groupHead: { display: 'flex', alignItems: 'center', gap: 7, padding: '8px 10px', background: theme.bg, borderBottom: `1px solid ${theme.border}` },
  chev: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, border: 'none', background: 'none', color: theme.inkSoft, cursor: 'pointer', padding: 0, flexShrink: 0 },
  sizeInput: { width: 130, flexShrink: 0, background: theme.surface, border: `1.5px solid ${theme.border}`, borderRadius: 7, padding: '6px 9px', fontSize: 12.5, fontWeight: 700, color: theme.ink, fontFamily: 'inherit', boxSizing: 'border-box' },
  groupCount: { flex: 1, fontSize: 11, color: theme.inkFaint, whiteSpace: 'nowrap', overflow: 'hidden' },
  groupPriceInput: { width: 80, flexShrink: 0, background: theme.surface, border: `1.5px solid ${theme.border}`, borderRadius: 7, padding: '5px 8px', fontSize: 11.5, color: theme.ink, fontFamily: 'inherit', textAlign: 'right', boxSizing: 'border-box' },
  groupDel: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, background: 'none', border: 'none', color: theme.inkFaint, cursor: 'pointer', padding: 0, flexShrink: 0 },

  rowHead: { display: 'flex', gap: 8, padding: '7px 11px 2px', fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: theme.inkFaint },
  row: { display: 'flex', gap: 8, alignItems: 'center', padding: '4px 11px' },
  input: { background: theme.bg, border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '7px 10px', fontSize: 12.5, color: theme.ink, fontFamily: 'inherit', minWidth: 0, boxSizing: 'border-box', width: '100%' },
  inputBad: { borderColor: theme.high, background: theme.highBg },
  delBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, background: 'none', border: 'none', color: theme.inkFaint, cursor: 'pointer', padding: 0, flexShrink: 0 },
  addRowBtn: { display: 'inline-flex', alignItems: 'center', gap: 5, margin: '6px 11px 10px', background: theme.surface, border: `1.5px dashed ${theme.border}`, color: theme.inkSoft, fontSize: 11.5, fontWeight: 600, padding: '6px 11px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit' },

  addSizeBtn: { display: 'inline-flex', alignItems: 'center', gap: 6, background: theme.accentSoft, border: `1.5px solid ${theme.accent}`, color: theme.accentInk, fontSize: 12.5, fontWeight: 700, padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
  newSizeBox: { border: `1.5px solid ${theme.accent}`, background: theme.accentSoft, borderRadius: 10, padding: '11px 12px' },
  newSizeRow: { display: 'flex', gap: 7, alignItems: 'center' },
  primarySm: { background: theme.accent, border: 'none', color: '#fff', fontSize: 12, fontWeight: 700, padding: '7px 13px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  cancelSm: { background: theme.surface, border: `1.5px solid ${theme.border}`, color: theme.inkSoft, fontSize: 12, fontWeight: 600, padding: '7px 11px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  chips: { display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', marginTop: 9 },
  chipsLabel: { fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: theme.inkFaint },
  chip: { background: theme.surface, border: `1px solid ${theme.border}`, color: theme.inkSoft, fontSize: 11.5, fontWeight: 600, padding: '4px 10px', borderRadius: 20, cursor: 'pointer', fontFamily: 'inherit' },

  empty: { padding: '18px 4px 14px', textAlign: 'center' },
  emptyText: { margin: '0 auto', fontSize: 12.5, color: theme.inkFaint, lineHeight: 1.6, maxWidth: 400 },

  label: { display: 'block', fontSize: 11, fontWeight: 600, color: theme.inkFaint, marginBottom: 4 },
  hint: { margin: '6px 0 0', fontSize: 11, color: theme.inkFaint, lineHeight: 1.5 },

  warn: { display: 'flex', alignItems: 'center', gap: 6, margin: '10px 0 0', padding: '8px 10px', borderRadius: 8, background: theme.medBg, border: `1px solid ${theme.med}`, fontSize: 11.5, lineHeight: 1.5, color: theme.ink },

  bulkWrap: { marginTop: 14, borderTop: `1px solid ${theme.border}`, paddingTop: 12 },
  bulkSummary: { fontSize: 12, fontWeight: 700, color: theme.accentInk, cursor: 'pointer' },
  bulkInput: { width: '100%', minHeight: 78, marginTop: 8, background: theme.bg, border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '8px 10px', fontSize: 12, fontFamily: theme.mono, color: theme.ink, boxSizing: 'border-box', resize: 'vertical' },
  bulkBtn: { marginTop: 7, background: theme.surface, border: `1.5px solid ${theme.border}`, color: theme.inkSoft, fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },

  error: { margin: '10px 0 0', fontSize: 12, fontWeight: 600, color: theme.high, lineHeight: 1.5 },

  footer: { display: 'flex', alignItems: 'center', gap: 9, padding: '12px 18px', borderTop: `1px solid ${theme.border}`, flexShrink: 0 },
  footerNote: { flex: 1, fontSize: 11, color: theme.inkFaint, lineHeight: 1.4 },
  statusWrap: { flex: 1, minWidth: 0 },
  status: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700 },
  statusSpinner: { width: 11, height: 11, borderWidth: 2 },
  dot: { width: 7, height: 7, borderRadius: '50%', display: 'inline-block' },
  retryBtn: { background: theme.high },
  cancelBtn: { background: theme.surface, border: `1.5px solid ${theme.border}`, color: theme.inkSoft, fontSize: 13, fontWeight: 600, padding: '8px 15px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  saveBtn: { background: theme.accent, border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
};
