import { useEffect, useRef, useState } from 'react';
import { X, Store, Check } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { theme, modalBackdrop } from '../lib/theme';
import { useErrorPopup } from './DialogProvider';
import { vh } from '../lib/viewport';

const OUTCOMES = [
  { value: 'browsing', label: 'Browsing' },
  { value: 'interested', label: 'Interested' },
  { value: 'ordered', label: 'Ordered' },
  { value: 'not_interested', label: 'Not interested' },
];

// Quick-entry log for a walk-in customer's showroom visit — deliberately a
// small modal, not a full page. Distinct from ShowroomOrderModal (which
// places an actual order); this just records "someone came in and looked."
export default function LogVisitModal({ onClose, onSaved }) {
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [matchedCustomer, setMatchedCustomer] = useState(null);
  const [searchResults, setSearchResults] = useState([]);
  const searchTimer = useRef(null);

  const [showroomLocation, setShowroomLocation] = useState('');
  const [productsShown, setProductsShown] = useState('');
  const [outcome, setOutcome] = useState('interested');
  const [notes, setNotes] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  useErrorPopup(error, 'Could not log the visit');

  useEffect(() => {
    clearTimeout(searchTimer.current);
    if (phone.trim().length < 3) { setSearchResults([]); return; }
    searchTimer.current = setTimeout(async () => {
      try {
        const res = await apiFetch(`/api/customers?search=${encodeURIComponent(phone.trim())}`);
        const data = await res.json();
        setSearchResults(data.customers || []);
      } catch { /* ignore */ }
    }, 350);
    return () => clearTimeout(searchTimer.current);
  }, [phone]);

  function pickMatch(customer) {
    setMatchedCustomer(customer);
    setPhone(customer.whatsapp_number);
    setName(customer.name || '');
    setSearchResults([]);
  }

  function onPhoneChange(v) {
    setPhone(v);
    if (matchedCustomer && v !== matchedCustomer.whatsapp_number) setMatchedCustomer(null);
  }

  const canSubmit = phone.trim().length > 0 && showroomLocation.trim().length > 0 && !saving;

  async function submit() {
    if (!canSubmit) return;
    setSaving(true); setError(null);
    try {
      if (name.trim() && (!matchedCustomer || !matchedCustomer.name)) {
        await apiFetch('/api/customers', {
          method: 'POST',
          body: JSON.stringify({ phone: phone.trim(), name: name.trim() }),
        });
      }
      const res = await apiFetch('/api/showroom-visits', {
        method: 'POST',
        body: JSON.stringify({
          phone: phone.trim(),
          showroomLocation: showroomLocation.trim(),
          productsShown: productsShown.trim() || null,
          outcome,
          notes: notes.trim() || null,
        }),
      });
      const data = await res.json();
      if (data.success) { onSaved?.(data.visit); onClose(); }
      else setError(data.error || 'Failed to log visit');
    } catch (err) {
      setError('Network error: ' + err.message);
    }
    setSaving(false);
  }

  return (
    <div className="responsive-modal-backdrop" style={s.backdrop} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="responsive-modal" style={s.modal}>
        <div style={s.header}>
          <div style={s.headerLeft}>
            <div style={s.headerIcon}><Store size={17} color={theme.accentInk} /></div>
            <div>
              <p style={s.headerTitle}>Log Showroom Visit</p>
              <p style={s.headerSub}>Quick entry — a few seconds, not a full form</p>
            </div>
          </div>
          <button style={s.closeBtn} onClick={onClose}><X size={16} /></button>
        </div>

        <div style={s.body}>
          <label style={s.fieldLabel}>Phone number</label>
          <div style={{ position: 'relative', marginBottom: 12 }}>
            <input style={s.input} value={phone} onChange={e => onPhoneChange(e.target.value)} placeholder="94771234567" autoFocus />
            {matchedCustomer && <span style={s.matchTag}><Check size={11} /> Existing</span>}
            {searchResults.length > 0 && (
              <div style={s.dropdown}>
                {searchResults.map(c => (
                  <button key={c.id} style={s.dropdownItem} onClick={() => pickMatch(c)}>
                    <span style={{ fontWeight: 600 }}>{c.name || c.whatsapp_number}</span>
                    <span style={{ color: theme.inkFaint, fontSize: 11.5 }}>{c.whatsapp_number}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <label style={s.fieldLabel}>Name</label>
          <input style={{ ...s.input, marginBottom: 12 }} value={name} onChange={e => setName(e.target.value)} placeholder="Customer name (optional)" />

          <label style={s.fieldLabel}>Showroom location</label>
          <input style={{ ...s.input, marginBottom: 12 }} value={showroomLocation} onChange={e => setShowroomLocation(e.target.value)} placeholder="e.g. Colombo showroom" />

          <label style={s.fieldLabel}>Product(s) shown</label>
          <input style={{ ...s.input, marginBottom: 12 }} value={productsShown} onChange={e => setProductsShown(e.target.value)} placeholder="e.g. Nidikumba Ayu Spring, 78x60" />

          <label style={s.fieldLabel}>Outcome</label>
          <div style={s.pills}>
            {OUTCOMES.map(o => (
              <button key={o.value} style={{ ...s.pill, ...(outcome === o.value ? s.pillActive : {}) }} onClick={() => setOutcome(o.value)}>{o.label}</button>
            ))}
          </div>

          <label style={{ ...s.fieldLabel, marginTop: 12 }}>Notes</label>
          <textarea style={{ ...s.input, ...s.textarea }} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional" />

        </div>

        <div style={s.footer}>
          <button style={s.cancelBtn} onClick={onClose} disabled={saving}>Cancel</button>
          <button style={{ ...s.saveBtn, opacity: canSubmit ? 1 : 0.5 }} onClick={submit} disabled={!canSubmit}>
            {saving ? 'Saving...' : 'Log visit'}
          </button>
        </div>
      </div>
    </div>
  );
}

const s = {
  backdrop: modalBackdrop,
  modal: { background: theme.surface, borderRadius: 16, width: '100%', maxWidth: 440, maxHeight: vh(90), display: 'flex', flexDirection: 'column', boxShadow: theme.shadowMd, overflow: 'hidden' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: `1px solid ${theme.border}`, flexShrink: 0 },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 12 },
  headerIcon: { width: 38, height: 38, borderRadius: 10, background: theme.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  headerTitle: { fontSize: 15, fontWeight: 700, color: theme.ink, margin: 0 },
  headerSub: { fontSize: 12, color: theme.inkFaint, margin: 0 },
  closeBtn: { background: theme.borderSoft, border: 'none', cursor: 'pointer', width: 30, height: 30, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.inkSoft, flexShrink: 0 },
  body: { flex: 1, overflowY: 'auto', padding: '18px 20px' },
  fieldLabel: { fontSize: 11, fontWeight: 700, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 },
  input: { width: '100%', background: theme.bg, border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '9px 12px', color: theme.ink, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' },
  textarea: { resize: 'vertical', minHeight: 60, lineHeight: 1.5 },
  matchTag: { position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', display: 'flex', alignItems: 'center', gap: 3, fontSize: 10.5, fontWeight: 700, color: theme.success, background: theme.successBg, padding: '2px 7px', borderRadius: 10 },
  dropdown: { position: 'absolute', top: '110%', left: 0, right: 0, background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 10, boxShadow: theme.shadowMd, zIndex: 10, overflow: 'hidden', maxHeight: 160, overflowY: 'auto' },
  dropdownItem: { display: 'flex', flexDirection: 'column', gap: 1, width: '100%', textAlign: 'left', padding: '8px 12px', background: 'none', border: 'none', borderBottom: `1px solid ${theme.borderSoft}`, cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' },
  pills: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  pill: { background: theme.bg, border: `1.5px solid ${theme.border}`, color: theme.inkSoft, fontSize: 12, fontWeight: 600, padding: '6px 13px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit' },
  pillActive: { background: theme.accentSoft, border: `1.5px solid ${theme.accent}`, color: theme.accentInk },
  footer: { display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 20px', borderTop: `1px solid ${theme.border}`, flexShrink: 0 },
  cancelBtn: { background: theme.bg, border: `1px solid ${theme.border}`, color: theme.inkSoft, fontSize: 13, fontWeight: 600, padding: '8px 18px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
  saveBtn: { background: theme.accent, border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, padding: '8px 22px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
};
