import { useEffect, useState } from 'react';
import { ShieldCheck, AlertTriangle, X } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { theme, modalBackdrop } from '../lib/theme';
import PageHeader from '../components/PageHeader';
import { useErrorPopup } from '../components/DialogProvider';

const WARRANTY_STATUS = {
  active:  { label: 'Active',  color: theme.success, bg: theme.successBg },
  expired: { label: 'Expired', color: theme.cancel,  bg: theme.cancelBg },
  voided:  { label: 'Voided',  color: theme.high,    bg: theme.highBg },
};

const TICKET_STATUS = {
  open:        { label: 'Open',        color: theme.high,    bg: theme.highBg },
  in_progress: { label: 'In progress', color: theme.med,     bg: theme.medBg },
  resolved:    { label: 'Resolved',    color: theme.success, bg: theme.successBg },
  closed:      { label: 'Closed',      color: theme.cancel,  bg: theme.cancelBg },
};

const ISSUE_TYPES = [
  { value: 'warranty_claim',   label: 'Warranty claim' },
  { value: 'defect',           label: 'Defect' },
  { value: 'delivery_damage',  label: 'Delivery damage' },
  { value: 'general_complaint', label: 'General complaint' },
];

export default function Warranty({ onToast }) {
  const [tab, setTab] = useState('warranties');
  const [warranties, setWarranties] = useState([]);
  const [tickets, setTickets] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [newTicketFor, setNewTicketFor] = useState(null); // warranty row

  async function load() {
    setLoading(true);
    try {
      const [wRes, tRes] = await Promise.all([apiFetch('/api/warranties'), apiFetch('/api/service-tickets')]);
      setWarranties((await wRes.json()).warranties || []);
      setTickets((await tRes.json()).serviceTickets || []);
    } catch (e) { console.error(e); }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  const filteredWarranties = warranties.filter(w =>
    !search.trim() || w.product_name?.toLowerCase().includes(search.toLowerCase()) || w.warranty_number?.toLowerCase().includes(search.toLowerCase())
  );

  async function updateTicket(id, patch) {
    const res = await apiFetch(`/api/service-tickets/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    const data = await res.json();
    if (data.success) setTickets(prev => prev.map(t => t.id === id ? data.serviceTicket : t));
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <PageHeader title="Warranty & Service" search={search} onSearch={setSearch} searchPlaceholder="Search warranties..." />

      <div style={s.tabs}>
        <button style={{ ...s.tab, ...(tab === 'warranties' ? s.tabActive : {}) }} onClick={() => setTab('warranties')}>
          Warranties <span style={s.tabCount}>{warranties.length}</span>
        </button>
        <button style={{ ...s.tab, ...(tab === 'tickets' ? s.tabActive : {}) }} onClick={() => setTab('tickets')}>
          Service Tickets <span style={s.tabCount}>{tickets.length}</span>
        </button>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '18px 28px', background: theme.bg }}>
        {loading ? <p style={{ color: theme.inkFaint, fontSize: 13 }}>Loading...</p> : tab === 'warranties' ? (
          <div style={s.tableWrap}>
            <table style={s.table}>
              <thead><tr>{['Warranty #', 'Product', 'Status', 'Start', 'End', 'Days left', ''].map(h => <th key={h} style={s.th}>{h}</th>)}</tr></thead>
              <tbody>
                {filteredWarranties.length === 0 ? (
                  <tr><td style={s.td} colSpan={7}>No warranties yet.</td></tr>
                ) : filteredWarranties.map(w => {
                  const st = WARRANTY_STATUS[w.effective_status] || WARRANTY_STATUS.active;
                  return (
                    <tr key={w.id}>
                      <td style={{ ...s.td, fontFamily: theme.mono, fontWeight: 600 }}>{w.warranty_number}</td>
                      <td style={s.td}>{w.product_name}</td>
                      <td style={s.td}><Pill label={st.label} color={st.color} bg={st.bg} /></td>
                      <td style={s.td}>{new Date(w.start_date).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                      <td style={s.td}>{new Date(w.end_date).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                      <td style={s.td}>{w.days_remaining}</td>
                      <td style={s.td}>
                        <button style={s.linkBtn} onClick={() => setNewTicketFor(w)}>File ticket</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={s.tableWrap}>
            <table style={s.table}>
              <thead><tr>{['Issue', 'Status', 'Priority', 'Warranty valid', 'Description', 'Created'].map(h => <th key={h} style={s.th}>{h}</th>)}</tr></thead>
              <tbody>
                {tickets.length === 0 ? (
                  <tr><td style={s.td} colSpan={6}>No service tickets yet.</td></tr>
                ) : tickets.map(t => {
                  return (
                    <tr key={t.id}>
                      <td style={s.td}>{ISSUE_TYPES.find(i => i.value === t.issue_type)?.label || t.issue_type}</td>
                      <td style={s.td}>
                        <select style={s.inlineSelect} value={t.status} onChange={e => updateTicket(t.id, { status: e.target.value })}>
                          {Object.keys(TICKET_STATUS).map(k => <option key={k} value={k}>{TICKET_STATUS[k].label}</option>)}
                        </select>
                      </td>
                      <td style={s.td}>
                        {t.priority === 'high'
                          ? <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: theme.high, fontWeight: 600 }}><AlertTriangle size={12} /> High</span>
                          : 'Normal'}
                      </td>
                      <td style={s.td}>{t.warranty_valid === null ? '—' : t.warranty_valid ? 'Yes' : 'No'}</td>
                      <td style={{ ...s.td, maxWidth: 220 }}>{t.description || '—'}</td>
                      <td style={s.td}>{new Date(t.created_at).toLocaleDateString('en', { day: 'numeric', month: 'short' })}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {newTicketFor && (
        <NewTicketModal
          warranty={newTicketFor}
          onClose={() => setNewTicketFor(null)}
          onSaved={() => { setNewTicketFor(null); load(); onToast?.({ message: '🎫 Service ticket filed', type: 'on' }); }}
        />
      )}
    </div>
  );
}

function Pill({ label, color, bg }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', padding: '3px 10px', borderRadius: 20, fontSize: 11.5, fontWeight: 600, color, background: bg }}>{label}</span>;
}

function NewTicketModal({ warranty, onClose, onSaved }) {
  const [issueType, setIssueType] = useState('warranty_claim');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  useErrorPopup(error, 'Could not file the service ticket');

  async function save() {
    setSaving(true); setError(null);
    try {
      const res = await apiFetch('/api/service-tickets', {
        method: 'POST',
        body: JSON.stringify({
          orderId: warranty.order_id, customerId: warranty.customer_id,
          productId: warranty.product_id, warrantyId: warranty.id,
          issueType, description: description || null,
        }),
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
            <div style={s.modalIcon}><ShieldCheck size={16} color={theme.accentInk} /></div>
            <div>
              <p style={s.modalTitle}>File a service ticket</p>
              <p style={s.modalSub}>{warranty.product_name} · {warranty.warranty_number}</p>
            </div>
          </div>
          <button style={s.closeBtn} onClick={onClose}><X size={15} /></button>
        </div>
        <div style={s.modalBody}>
          <label style={s.fieldLabel}>Issue type</label>
          <select style={s.select} value={issueType} onChange={e => setIssueType(e.target.value)}>
            {ISSUE_TYPES.map(i => <option key={i.value} value={i.value}>{i.label}</option>)}
          </select>
          <label style={s.fieldLabel}>Description</label>
          <textarea style={s.textarea} value={description} onChange={e => setDescription(e.target.value)} placeholder="What's the issue?" />
        </div>
        <div style={s.modalFooter}>
          <button style={s.cancelBtn} onClick={onClose}>Cancel</button>
          <button style={s.saveBtn} onClick={save} disabled={saving}>{saving ? 'Saving...' : 'File ticket'}</button>
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
  linkBtn: { background: 'none', border: 'none', color: theme.accentInk, fontWeight: 600, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit' },
  inlineSelect: { fontSize: 12.5, fontWeight: 600, border: `1px solid ${theme.border}`, borderRadius: 6, padding: '4px 8px', fontFamily: 'inherit', background: theme.surface, color: theme.ink },

  backdrop: modalBackdrop,
  modal: { background: theme.surface, borderRadius: 16, width: '100%', maxWidth: 440, boxShadow: theme.shadowMd, overflow: 'hidden' },
  modalHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: `1px solid ${theme.border}` },
  modalHeaderLeft: { display: 'flex', alignItems: 'center', gap: 12 },
  modalIcon: { width: 34, height: 34, borderRadius: 9, background: theme.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  modalTitle: { fontSize: 14.5, fontWeight: 700, color: theme.ink, margin: 0 },
  modalSub: { fontSize: 12, color: theme.inkFaint, margin: 0 },
  closeBtn: { background: theme.borderSoft, border: 'none', cursor: 'pointer', width: 28, height: 28, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.inkSoft },
  modalBody: { padding: '16px 20px' },
  fieldLabel: { fontSize: 11, fontWeight: 700, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6, marginTop: 12 },
  select: { width: '100%', border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', background: theme.bg, color: theme.ink },
  textarea: { width: '100%', border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', minHeight: 70, resize: 'vertical', background: theme.bg, color: theme.ink },
  modalFooter: { display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 20px', borderTop: `1px solid ${theme.border}` },
  cancelBtn: { background: theme.bg, border: `1px solid ${theme.border}`, color: theme.inkSoft, fontSize: 13, fontWeight: 600, padding: '8px 18px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
  saveBtn: { background: theme.accent, border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, padding: '8px 22px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
};
