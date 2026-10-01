import { useEffect, useState } from 'react';
import { Tag, Users, X, Copy, Check, Pencil, Trash2, MessageSquareText } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { theme, modalBackdrop } from '../lib/theme';
import { roleAllowed } from '../lib/roles';
import { promoDiscountLabel, unscopedAppliesLabel } from '../lib/promoFormat';
import { useAuth } from '../lib/AuthContext';
import PageHeader from '../components/PageHeader';
import PromoCodeDetailModal from '../components/PromoCodeDetailModal';
import InfluencerDetailModal from '../components/InfluencerDetailModal';
import { useErrorPopup } from '../components/DialogProvider';
import { vh } from '../lib/viewport';

export default function PromoCodes({ onToast }) {
  const { staff } = useAuth();
  const [tab, setTab] = useState('codes');
  const [codes, setCodes] = useState([]);
  const [influencers, setInfluencers] = useState([]);
  const [products, setProducts] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [newCodeOpen, setNewCodeOpen] = useState(false);
  const [newInfluencerOpen, setNewInfluencerOpen] = useState(false);
  const [payouts, setPayouts] = useState({});
  const [selectedCode, setSelectedCode] = useState(null);
  const [editingCode, setEditingCode] = useState(null);
  const [deletingCode, setDeletingCode] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  useErrorPopup(deleteError, 'Could not delete the promo code');
  const [deleting, setDeleting] = useState(false);
  const [selectedInfluencer, setSelectedInfluencer] = useState(null);

  async function load() {
    setLoading(true);
    try {
      const [cRes, iRes, pRes] = await Promise.all([apiFetch('/api/promo-codes'), apiFetch('/api/influencers'), apiFetch('/api/products')]);
      const codesData = (await cRes.json()).promoCodes || [];
      const infData = (await iRes.json()).influencers || [];
      setCodes(codesData);
      setInfluencers(infData);
      setProducts((await pRes.json()).products?.filter(p => p.active) || []);
      const payoutEntries = await Promise.all(
        infData.map(async i => {
          const res = await apiFetch(`/api/influencers/${i.id}/payout`);
          const data = await res.json();
          return [i.id, data.payout];
        })
      );
      setPayouts(Object.fromEntries(payoutEntries));
    } catch (e) { console.error(e); }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function toggleActive(code) {
    const res = await apiFetch(`/api/promo-codes/${code.id}`, { method: 'PATCH', body: JSON.stringify({ active: !code.active }) });
    const data = await res.json();
    if (data.success) setCodes(prev => prev.map(c => c.id === code.id ? data.promoCode : c));
  }

  async function confirmDelete() {
    if (!deletingCode) return;
    setDeleting(true); setDeleteError(null);
    try {
      const res = await apiFetch(`/api/promo-codes/${deletingCode.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setCodes(prev => prev.filter(c => c.id !== deletingCode.id));
        setDeletingCode(null);
        onToast?.({ message: '🗑️ Promo code deleted', type: 'on' });
      } else {
        setDeleteError(data.error || 'Failed to delete');
      }
    } catch (e) { setDeleteError('Network error: ' + e.message); }
    setDeleting(false);
  }

  const filteredCodes = codes.filter(c => !search.trim() || c.code.toLowerCase().includes(search.toLowerCase()));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <PageHeader
        title="Promo Codes"
        search={tab !== 'followup' ? search : undefined} onSearch={tab !== 'followup' ? setSearch : undefined} searchPlaceholder="Search codes..."
        action={tab === 'codes' ? 'New code' : tab === 'influencers' ? 'New influencer' : undefined}
        onAction={() => tab === 'codes' ? setNewCodeOpen(true) : setNewInfluencerOpen(true)}
      />

      <div style={s.tabs}>
        <button style={{ ...s.tab, ...(tab === 'codes' ? s.tabActive : {}) }} onClick={() => setTab('codes')}>
          Codes <span style={s.tabCount}>{codes.length}</span>
        </button>
        <button style={{ ...s.tab, ...(tab === 'influencers' ? s.tabActive : {}) }} onClick={() => setTab('influencers')}>
          Influencers <span style={s.tabCount}>{influencers.length}</span>
        </button>
        {roleAllowed(staff?.role, ['admin']) && (
          <button style={{ ...s.tab, ...(tab === 'followup' ? s.tabActive : {}) }} onClick={() => setTab('followup')}>
            Follow-up promo
          </button>
        )}
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '18px 28px', background: theme.bg }}>
        {loading ? <p style={{ color: theme.inkFaint, fontSize: 13 }}>Loading...</p> : tab === 'followup' ? (
          <FollowUpPromoSettings onToast={onToast} />
        ) : tab === 'codes' ? (
          <div style={s.tableWrap}>
            <table style={s.table}>
              <thead><tr>{['Code', 'Discount', 'Applies to', 'Redemptions', 'Expires', 'Influencer', 'Active', ''].map(h => <th key={h} style={s.th}>{h}</th>)}</tr></thead>
              <tbody>
                {filteredCodes.length === 0 ? (
                  <tr><td style={s.td} colSpan={8}>No promo codes yet.</td></tr>
                ) : filteredCodes.map(c => {
                  const inf = influencers.find(i => i.id === c.influencer_id);
                  const scoped = c.eligible_product_names?.length > 0;
                  return (
                    <tr key={c.id} style={s.trClickable} onClick={() => setSelectedCode(c)}>
                      <td style={{ ...s.td, fontFamily: theme.mono, fontWeight: 700 }}><CopyableCode code={c.code} /></td>
                      <td style={s.td}>{promoDiscountLabel(c)}</td>
                      <td style={s.td} title={scoped ? c.eligible_product_names.join(', ') : ''}>
                        {scoped ? <span style={s.scopedPill}>{c.eligible_product_names.length} product{c.eligible_product_names.length > 1 ? 's' : ''}</span> : <span style={{ color: theme.inkFaint }}>{unscopedAppliesLabel(c)}</span>}
                      </td>
                      <td style={s.td}>{c.redemption_count ?? 0}{c.max_redemptions ? ` / ${c.max_redemptions}` : ''}</td>
                      <td style={s.td}>{c.expires_at ? new Date(c.expires_at).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Never'}</td>
                      <td style={s.td}>{inf?.name || '—'}</td>
                      <td style={s.td} onClick={e => e.stopPropagation()}>
                        <button style={{ ...s.statusPill, ...(c.active ? s.statusOn : s.statusOff) }} onClick={() => toggleActive(c)}>
                          {c.active ? 'Active' : 'Inactive'}
                        </button>
                      </td>
                      <td style={s.td} onClick={e => e.stopPropagation()}>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button style={s.rowIconBtn} onClick={() => setEditingCode(c)} title="Edit code"><Pencil size={13} /></button>
                          <button style={s.rowIconBtn} onClick={() => { setDeletingCode(c); setDeleteError(null); }} title="Delete code"><Trash2 size={13} /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={s.cardGrid}>
            {influencers.length === 0 ? (
              <p style={{ color: theme.inkFaint, fontSize: 13 }}>No influencers yet.</p>
            ) : influencers.map(i => {
              const p = payouts[i.id];
              return (
                <div key={i.id} style={{ ...s.infCard, ...s.infCardClickable }} onClick={() => setSelectedInfluencer(i)}>
                  <div style={s.infHead}>
                    <div style={s.infIcon}><Users size={16} color={theme.accentInk} /></div>
                    <div>
                      <p style={s.infName}>{i.name}</p>
                      <p style={s.infHandle}>{i.handle || '—'}</p>
                    </div>
                    <span style={{ ...s.statusPill, ...(i.active ? s.statusOn : s.statusOff), marginLeft: 'auto' }}>
                      {i.active ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                  <div style={s.infStats}>
                    <Stat label="Commission" value={`${i.commission_percent}%`} />
                    <Stat label="Redemptions" value={p?.total_redemptions ?? '—'} />
                    <Stat label="Linked orders" value={p?.linked_redemptions ?? '—'} />
                    <Stat label="Owed" value={p ? `LKR ${Number(p.commission_owed).toLocaleString()}` : '—'} highlight />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {newCodeOpen && (
        <NewCodeModal
          influencers={influencers}
          products={products}
          onClose={() => setNewCodeOpen(false)}
          onSaved={() => { setNewCodeOpen(false); load(); onToast?.({ message: '🏷️ Promo code created', type: 'on' }); }}
        />
      )}
      {editingCode && (
        <NewCodeModal
          influencers={influencers}
          products={products}
          editingCode={editingCode}
          onClose={() => setEditingCode(null)}
          onSaved={() => { setEditingCode(null); load(); onToast?.({ message: '✏️ Promo code updated', type: 'on' }); }}
        />
      )}
      {deletingCode && (
        <div style={s.backdrop} onClick={e => e.target === e.currentTarget && !deleting && setDeletingCode(null)}>
          <div style={s.confirmModal}>
            <p style={s.modalTitle}>Delete {deletingCode.code}?</p>
            <p style={s.confirmSub}>This permanently removes the code. This can&apos;t be undone.</p>
            <div style={s.modalFooter}>
              <button style={s.cancelBtn} onClick={() => setDeletingCode(null)} disabled={deleting}>Cancel</button>
              <button style={s.deleteBtn} onClick={confirmDelete} disabled={deleting}>{deleting ? 'Deleting...' : 'Delete code'}</button>
            </div>
          </div>
        </div>
      )}
      {newInfluencerOpen && (
        <NewInfluencerModal
          onClose={() => setNewInfluencerOpen(false)}
          onSaved={() => { setNewInfluencerOpen(false); load(); onToast?.({ message: '🤝 Influencer added', type: 'on' }); }}
        />
      )}
      {selectedCode && (
        <PromoCodeDetailModal
          code={codes.find(c => c.id === selectedCode.id) || selectedCode}
          influencer={influencers.find(i => i.id === selectedCode.influencer_id)}
          onClose={() => setSelectedCode(null)}
          onToast={onToast}
        />
      )}
      {selectedInfluencer && (
        <InfluencerDetailModal
          influencer={selectedInfluencer}
          payout={payouts[selectedInfluencer.id]}
          onClose={() => setSelectedInfluencer(null)}
        />
      )}
    </div>
  );
}

// Admin-only settings for the automated follow-up promo (migration 018) —
// one fixed image URL + caption, read by the backend scheduler every 15
// minutes to decide what to send when a lead's second call date passes
// with no resolution. Not file upload — Twilio/Meta fetch media from a
// real public URL, so staff paste a link to an already-hosted image
// (confirmed with the user) rather than uploading through this backend.
function FollowUpPromoSettings({ onToast }) {
  const [imageUrl, setImageUrl] = useState('');
  const [caption, setCaption] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    apiFetch('/api/settings/promo').then(r => r.json()).then(d => {
      setImageUrl(d.imageUrl || '');
      setCaption(d.caption || '');
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true);
    try {
      const res = await apiFetch('/api/settings/promo', {
        method: 'PATCH',
        body: JSON.stringify({ imageUrl: imageUrl.trim(), caption: caption.trim() }),
      });
      const data = await res.json();
      if (data.success) onToast?.({ message: '✅ Follow-up promo settings saved', type: 'on' });
      else onToast?.({ message: data.error || 'Failed to save', type: 'off' });
    } catch (e) { onToast?.({ message: 'Network error: ' + e.message, type: 'off' }); }
    setSaving(false);
  }

  if (loading) return <p style={{ color: theme.inkFaint, fontSize: 13 }}>Loading...</p>;

  return (
    <div style={s.followUpWrap}>
      <div style={s.followUpHead}>
        <div style={s.modalIcon}><MessageSquareText size={16} color={theme.accentInk} /></div>
        <div>
          <p style={s.followUpTitle}>Automated follow-up promo</p>
          <p style={s.followUpSub}>
            Sent once per lead, automatically, when the second call&apos;s date passes with no action.
            After that, the lead moves to a rolling weekly reminder (dashboard only, no further auto-sends).
          </p>
        </div>
      </div>

      <label style={s.fieldLabel}>Promo image URL</label>
      <input
        style={s.input} value={imageUrl}
        onChange={e => { setImageUrl(e.target.value); setImgError(false); }}
        placeholder="https://..."
      />
      <p style={s.fieldHint}>Must be a real, publicly reachable image URL — WhatsApp fetches it directly, this isn&apos;t a file upload.</p>

      {imageUrl.trim() && (
        <div style={s.previewBox}>
          {imgError ? (
            <p style={{ fontSize: 12, color: theme.high, margin: 0 }}>Couldn&apos;t load this URL as an image — double-check it&apos;s correct and publicly accessible.</p>
          ) : (
            <img src={imageUrl.trim()} alt="Promo preview" style={s.previewImg} onError={() => setImgError(true)} />
          )}
        </div>
      )}

      <label style={s.fieldLabel}>Caption</label>
      <textarea
        style={{ ...s.input, ...s.textarea }} value={caption}
        onChange={e => setCaption(e.target.value)}
        placeholder="e.g. Still deciding? Here's a limited-time offer on our mattresses..."
      />

      <button style={{ ...s.saveBtn, marginTop: 16 }} onClick={save} disabled={saving || !imageUrl.trim()}>
        {saving ? 'Saving...' : 'Save settings'}
      </button>
    </div>
  );
}

function Stat({ label, value, highlight }) {
  return (
    <div>
      <p style={s.statLabel}>{label}</p>
      <p style={{ ...s.statValue, ...(highlight ? { color: theme.accentInk } : {}) }}>{value}</p>
    </div>
  );
}

function CopyableCode({ code }) {
  const [copied, setCopied] = useState(false);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {code}
      <button
        style={s.copyBtn}
        onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
        title="Copy code"
      >
        {copied ? <Check size={12} color={theme.success} /> : <Copy size={12} />}
      </button>
    </span>
  );
}

// Used for both creating a new code (editingCode=null) and editing an
// existing one. discount_type itself is never editable once a code exists —
// see the backend PATCH route's own comment for why — so in edit mode the
// type selector is replaced with a fixed label and only the value input for
// that type is shown.
function NewCodeModal({ influencers, products, editingCode, onClose, onSaved }) {
  const isEdit = !!editingCode;
  const [code, setCode] = useState(editingCode?.code || '');
  const [discountType, setDiscountType] = useState(editingCode?.discount_type || 'percent');
  const [discountPercent, setDiscountPercent] = useState(editingCode?.discount_percent != null ? String(editingCode.discount_percent) : '');
  const [discountAmount, setDiscountAmount] = useState(editingCode?.discount_amount != null ? String(editingCode.discount_amount) : '');
  const [maxRedemptions, setMaxRedemptions] = useState(editingCode?.max_redemptions != null ? String(editingCode.max_redemptions) : '');
  const [expiresAt, setExpiresAt] = useState(editingCode?.expires_at ? editingCode.expires_at.slice(0, 10) : '');
  const [influencerId, setInfluencerId] = useState(editingCode?.influencer_id || '');
  const [eligibleProducts, setEligibleProducts] = useState(editingCode?.eligible_product_names || []);
  const [discountScope, setDiscountScope] = useState(editingCode?.discount_scope || 'order');
  const [maxUnits, setMaxUnits] = useState(editingCode?.max_units_per_order != null ? String(editingCode.max_units_per_order) : '');
  // Per bill / per mattress is fixed once the code has been redeemed (the
  // backend refuses the change) — past customers got what it said then.
  const scopeLocked = isEdit && (editingCode.redemption_count ?? 0) > 0;
  const perUnit = discountType === 'amount' && discountScope === 'per_unit';
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  useErrorPopup(error, 'Could not save the promo code');

  function toggleProduct(name) {
    setEligibleProducts(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]);
  }

  async function save() {
    setSaving(true); setError(null);
    try {
      const res = isEdit
        ? await apiFetch(`/api/promo-codes/${editingCode.id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              code: code.trim().toUpperCase(),
              ...(discountType === 'percent' ? { discount_percent: Number(discountPercent) } : { discount_amount: Number(discountAmount) }),
              max_redemptions: maxRedemptions ? Number(maxRedemptions) : null,
              expires_at: expiresAt || null,
              influencer_id: influencerId || null,
              eligible_product_names: eligibleProducts,
              ...(scopeLocked ? {} : { discount_scope: perUnit ? 'per_unit' : 'order' }),
              max_units_per_order: perUnit && maxUnits ? Number(maxUnits) : null,
            }),
          })
        : await apiFetch('/api/promo-codes', {
            method: 'POST',
            body: JSON.stringify({
              code: code.trim().toUpperCase(), discountType,
              discountPercent: discountType === 'percent' ? Number(discountPercent) : undefined,
              discountAmount: discountType === 'amount' ? Number(discountAmount) : undefined,
              maxRedemptions: maxRedemptions ? Number(maxRedemptions) : null,
              expiresAt: expiresAt || null,
              influencerId: influencerId || null,
              eligibleProductNames: eligibleProducts,
              discountScope: perUnit ? 'per_unit' : 'order',
              maxUnitsPerOrder: perUnit && maxUnits ? Number(maxUnits) : null,
            }),
          });
      const data = await res.json();
      if (data.success) onSaved(data.promoCode);
      else setError(data.error || 'Failed to save');
    } catch (e) { setError('Network error: ' + e.message); }
    setSaving(false);
  }

  return (
    <div style={s.backdrop} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={s.modal}>
        <div style={s.modalHeader}>
          <div style={s.modalHeaderLeft}>
            <div style={s.modalIcon}><Tag size={16} color={theme.accentInk} /></div>
            <p style={s.modalTitle}>{isEdit ? 'Edit promo code' : 'New promo code'}</p>
          </div>
          <button style={s.closeBtn} onClick={onClose}><X size={15} /></button>
        </div>
        <div style={s.modalBody}>
          <label style={s.fieldLabel}>Code</label>
          <input style={s.input} value={code} onChange={e => setCode(e.target.value)} placeholder="e.g. NIDI2026" />

          <label style={s.fieldLabel}>Discount type</label>
          {isEdit ? (
            <p style={s.readonlyNote}>{discountType === 'percent' ? 'Percent off' : 'Fixed amount off (LKR)'} — can&apos;t be changed once a code exists</p>
          ) : (
            <select style={s.select} value={discountType} onChange={e => setDiscountType(e.target.value)}>
              <option value="percent">Percent off</option>
              <option value="amount">Fixed amount off (LKR)</option>
            </select>
          )}

          {discountType === 'percent' ? (
            <>
              <label style={s.fieldLabel}>Discount percent</label>
              <input style={s.input} type="number" value={discountPercent} onChange={e => setDiscountPercent(e.target.value)} placeholder="10" />
            </>
          ) : (
            <>
              <label style={s.fieldLabel}>Discount amount (LKR)</label>
              <input style={s.input} type="number" value={discountAmount} onChange={e => setDiscountAmount(e.target.value)} placeholder="5000" />

              <label style={s.fieldLabel}>Applies</label>
              {scopeLocked ? (
                <p style={s.readonlyNote}>
                  {discountScope === 'per_unit' ? 'Per mattress' : 'Once per bill'} — can&apos;t be changed after the code has been used
                </p>
              ) : (
                <select style={s.select} value={discountScope} onChange={e => setDiscountScope(e.target.value)}>
                  <option value="order">Once per bill</option>
                  <option value="per_unit">Per mattress (amount × mattresses bought)</option>
                </select>
              )}
              {perUnit && (
                <>
                  <p style={s.fieldHint}>
                    {discountAmount
                      ? `2 mattresses = LKR ${(Number(discountAmount) * 2).toLocaleString()} off. `
                      : ''}
                    Pillows don&apos;t count unless you pick them under &quot;Applies to&quot; below.
                  </p>
                  <label style={s.fieldLabel}>Max mattresses per bill</label>
                  <input style={s.input} type="number" min="1" value={maxUnits} onChange={e => setMaxUnits(e.target.value)} placeholder="No limit" />
                </>
              )}
            </>
          )}

          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={s.fieldLabel}>Max redemptions</label>
              <input style={s.input} type="number" value={maxRedemptions} onChange={e => setMaxRedemptions(e.target.value)} placeholder="Unlimited" />
            </div>
            <div style={{ flex: 1 }}>
              <label style={s.fieldLabel}>Expires</label>
              <input style={s.input} type="date" value={expiresAt} onChange={e => setExpiresAt(e.target.value)} />
            </div>
          </div>

          <label style={s.fieldLabel}>Influencer (optional)</label>
          <select style={s.select} value={influencerId} onChange={e => setInfluencerId(e.target.value)}>
            <option value="">None</option>
            {influencers.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>

          <label style={s.fieldLabel}>Applies to (optional)</label>
          <p style={s.fieldHint}>
            {perUnit
              ? 'Leave everything unchecked to count every mattress. Check specific products to count only those.'
              : 'Leave everything unchecked to apply to the whole order. Check specific products to discount only those line items.'}
          </p>
          <div style={s.productChecklist}>
            {products.length === 0 ? (
              <p style={{ fontSize: 12, color: theme.inkFaint, margin: 0 }}>No active products found.</p>
            ) : products.map(p => (
              <label key={p.id} style={s.productCheckItem}>
                <input type="checkbox" checked={eligibleProducts.includes(p.name)} onChange={() => toggleProduct(p.name)} />
                {p.name}
              </label>
            ))}
          </div>

        </div>
        <div style={s.modalFooter}>
          <button style={s.cancelBtn} onClick={onClose}>Cancel</button>
          <button style={s.saveBtn} onClick={save} disabled={saving || !code.trim()}>{saving ? 'Saving...' : isEdit ? 'Save changes' : 'Create code'}</button>
        </div>
      </div>
    </div>
  );
}

function NewInfluencerModal({ onClose, onSaved }) {
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [commissionPercent, setCommissionPercent] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  useErrorPopup(error, 'Could not add the influencer');

  async function save() {
    setSaving(true); setError(null);
    try {
      const res = await apiFetch('/api/influencers', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), handle: handle.trim() || null, commissionPercent: Number(commissionPercent) }),
      });
      const data = await res.json();
      if (data.success) onSaved();
      else setError(data.error || 'Failed to save');
    } catch (e) { setError('Network error: ' + e.message); }
    setSaving(false);
  }

  return (
    <div style={s.backdrop} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={s.modal}>
        <div style={s.modalHeader}>
          <div style={s.modalHeaderLeft}>
            <div style={s.modalIcon}><Users size={16} color={theme.accentInk} /></div>
            <p style={s.modalTitle}>New influencer</p>
          </div>
          <button style={s.closeBtn} onClick={onClose}><X size={15} /></button>
        </div>
        <div style={s.modalBody}>
          <label style={s.fieldLabel}>Name</label>
          <input style={s.input} value={name} onChange={e => setName(e.target.value)} placeholder="Full name" />
          <label style={s.fieldLabel}>Handle (optional)</label>
          <input style={s.input} value={handle} onChange={e => setHandle(e.target.value)} placeholder="@handle" />
          <label style={s.fieldLabel}>Commission %</label>
          <input style={s.input} type="number" value={commissionPercent} onChange={e => setCommissionPercent(e.target.value)} placeholder="5" />
        </div>
        <div style={s.modalFooter}>
          <button style={s.cancelBtn} onClick={onClose}>Cancel</button>
          <button style={s.saveBtn} onClick={save} disabled={saving || !name.trim() || !commissionPercent}>{saving ? 'Saving...' : 'Add influencer'}</button>
        </div>
      </div>
    </div>
  );
}

const s = {
  tabs: { display: 'flex', gap: 18, padding: '0 16px', background: theme.surface, borderBottom: `1px solid ${theme.border}`, flexShrink: 0, overflowX: 'auto' },
  tab: {
    display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, padding: '9px 0 8px', cursor: 'pointer', fontFamily: 'inherit',
    whiteSpace: 'nowrap', border: 'none', background: 'none', borderBottom: '1.5px solid transparent', marginBottom: -1,
    color: theme.inkSoft, fontWeight: 400, transition: 'color 0.12s',
  },
  tabActive: { color: theme.accentInk, fontWeight: 600, borderBottomColor: theme.accent },
  tabCount: { fontSize: 11, color: theme.inkFaint },

  // Card chrome, but scrolling INSIDE it rather than `overflow: 'hidden'`.
  // Hidden clipped the rounded corners neatly and silently killed the sticky
  // header below (a sticky element needs a scrolling ancestor; hidden is not
  // one), so the header scrolled away on every long list. `auto` keeps the
  // corners and makes the header stick, matching the Pipeline.
  tableWrap: { background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: theme.radiusLg, overflow: 'auto', maxHeight: '100%' },
  // fontSize/background here rather than relying on inheritance, matching the
  // Pipeline reference (lib/tableStyles.js) so every list reads at the same
  // size. tableLayout is deliberately NOT set: these tables size their columns
  // from content, and forcing 'fixed' would need per-column widths on each.
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 10.5, background: theme.surface },
  th: { textAlign: 'left', fontSize: 8.5, fontWeight: 500, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.06em', padding: '6px 8px', borderBottom: `1px solid ${theme.border}`, background: theme.surface, position: 'sticky', top: 0, zIndex: 1, whiteSpace: 'nowrap' },
  td: { padding: '8px 8px', borderBottom: `1px solid ${theme.borderSoft}`, fontSize: 10.5, color: theme.inkSoft, verticalAlign: 'middle' },
  trClickable: { cursor: 'pointer' },
  copyBtn: { background: 'none', border: 'none', cursor: 'pointer', color: theme.inkFaint, display: 'flex', padding: 2 },
  rowIconBtn: { background: 'none', border: `1px solid ${theme.border}`, borderRadius: 7, cursor: 'pointer', color: theme.inkSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, padding: 0 },
  statusPill: { border: 'none', borderRadius: 20, padding: '3px 10px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  statusOn: { color: theme.success, background: theme.successBg },
  statusOff: { color: theme.inkFaint, background: theme.borderSoft },
  scopedPill: { fontSize: 11.5, fontWeight: 600, color: theme.accentInk, background: theme.accentSoft, borderRadius: 20, padding: '3px 10px' },

  cardGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 },
  infCard: { background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: theme.radiusLg, padding: 16 },
  infCardClickable: { cursor: 'pointer' },
  infHead: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 },
  infIcon: { width: 34, height: 34, borderRadius: 9, background: theme.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  infName: { fontSize: 14, fontWeight: 700, color: theme.ink, margin: 0 },
  infHandle: { fontSize: 12, color: theme.inkFaint, margin: 0 },
  infStats: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  statLabel: { fontSize: 10.5, fontWeight: 600, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 3px' },
  statValue: { fontSize: 14.5, fontWeight: 700, color: theme.ink, margin: 0 },

  backdrop: modalBackdrop,
  modal: { background: theme.surface, borderRadius: 16, width: '100%', maxWidth: 440, maxHeight: vh(90), overflowY: 'auto', boxShadow: theme.shadowMd },
  modalHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: `1px solid ${theme.border}` },
  modalHeaderLeft: { display: 'flex', alignItems: 'center', gap: 12 },
  modalIcon: { width: 34, height: 34, borderRadius: 9, background: theme.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  modalTitle: { fontSize: 14.5, fontWeight: 700, color: theme.ink, margin: 0 },
  closeBtn: { background: theme.borderSoft, border: 'none', cursor: 'pointer', width: 28, height: 28, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.inkSoft },
  modalBody: { padding: '16px 20px' },
  fieldLabel: { fontSize: 11, fontWeight: 700, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6, marginTop: 12 },
  readonlyNote: { fontSize: 12.5, color: theme.inkFaint, background: theme.bg, borderRadius: 8, padding: '8px 10px', margin: 0 },
  fieldHint: { fontSize: 11.5, color: theme.inkFaint, margin: '0 0 8px', lineHeight: 1.4 },
  productChecklist: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 160, overflowY: 'auto', border: `1px solid ${theme.border}`, borderRadius: 8, padding: 10, background: theme.bg },
  productCheckItem: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: theme.ink, cursor: 'pointer' },

  followUpWrap: { background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: theme.radiusLg, padding: 24, maxWidth: 560 },
  followUpHead: { display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 20 },
  followUpTitle: { fontSize: 15, fontWeight: 700, color: theme.ink, margin: 0 },
  followUpSub: { fontSize: 12.5, color: theme.inkFaint, margin: '4px 0 0', lineHeight: 1.5 },
  previewBox: { marginTop: 10, marginBottom: 4, border: `1px solid ${theme.border}`, borderRadius: 10, padding: 10, background: theme.bg },
  previewImg: { maxWidth: '100%', maxHeight: 220, borderRadius: 6, display: 'block' },
  input: { width: '100%', border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', background: theme.bg, color: theme.ink, boxSizing: 'border-box' },
  select: { width: '100%', border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', background: theme.bg, color: theme.ink },
  modalFooter: { display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 20px', borderTop: `1px solid ${theme.border}` },
  cancelBtn: { background: theme.bg, border: `1px solid ${theme.border}`, color: theme.inkSoft, fontSize: 13, fontWeight: 600, padding: '8px 18px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
  saveBtn: { background: theme.accent, border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, padding: '8px 22px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
  deleteBtn: { background: theme.high, border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, padding: '8px 22px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },

  confirmModal: { background: theme.surface, borderRadius: 16, width: '100%', maxWidth: 400, boxShadow: theme.shadowMd, padding: '20px 20px 0' },
  confirmSub: { fontSize: 12.5, color: theme.inkSoft, margin: '4px 0 16px', lineHeight: 1.5 },
};
