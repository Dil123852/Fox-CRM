import { useEffect, useMemo, useState } from 'react';
import { Send, X, Image as ImageIcon, ChevronDown, ChevronRight, History } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { theme, SOURCE_BADGE, sourceBadge, modalBackdrop } from '../lib/theme';
import PageHeader from '../components/PageHeader';
import { PRIORITY, custName } from '../components/LeadsPage';
import { useErrorPopup } from '../components/DialogProvider';
import { vh } from '../lib/viewport';

const PRODUCT_FILTER_OPTS = [
  'Ayu Sleep 6', 'Nidikumba Rise', 'Nidikumba Signature', 'Nidikumba Ayu Spring',
];

export default function BulkMessages() {
  const [tab, setTab] = useState('send');
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [productFilter, setProductFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [selected, setSelected] = useState(new Set());
  const [composeOpen, setComposeOpen] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await apiFetch('/api/leads');
      const data = await res.json();
      setLeads(data.leads || []);
    } catch (e) { console.error(e); }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  const sources = useMemo(() => {
    const set = new Set(leads.map(l => l.source).filter(Boolean));
    return Array.from(set);
  }, [leads]);

  const filtered = leads.filter(l => {
    if (priorityFilter !== 'all' && (l.priority || 'medium') !== priorityFilter) return false;
    if (productFilter !== 'all' && l.product_type !== productFilter) return false;
    if (sourceFilter !== 'all' && l.source !== sourceFilter) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return custName(l).toLowerCase().includes(q) || (l.customers?.whatsapp_number || '').includes(q);
  });

  function toggle(customerId) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(customerId)) next.delete(customerId); else next.add(customerId);
      return next;
    });
  }

  function toggleAllFiltered() {
    const filteredIds = filtered.map(l => l.customers?.id).filter(Boolean);
    const allSelected = filteredIds.length > 0 && filteredIds.every(id => selected.has(id));
    setSelected(prev => {
      const next = new Set(prev);
      if (allSelected) filteredIds.forEach(id => next.delete(id));
      else filteredIds.forEach(id => next.add(id));
      return next;
    });
  }

  const selectedLeads = leads.filter(l => l.customers?.id && selected.has(l.customers.id));
  const filteredIds = filtered.map(l => l.customers?.id).filter(Boolean);
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every(id => selected.has(id));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <PageHeader
        title="Bulk Messages"
        search={tab === 'send' ? search : undefined}
        onSearch={tab === 'send' ? setSearch : undefined}
        searchPlaceholder="Search name or number..."
      />

      <div style={s.tabs} className="scroll-strip">
        <button style={{ ...s.tab, ...(tab === 'send' ? s.tabActive : {}) }} onClick={() => setTab('send')}>
          <Send size={13} /> Send
        </button>
        <button style={{ ...s.tab, ...(tab === 'history' ? s.tabActive : {}) }} onClick={() => setTab('history')}>
          <History size={13} /> History
        </button>
      </div>

      {tab === 'send' ? (
        <>
          <div style={s.filters}>
            <FilterSelect label="Priority" value={priorityFilter} onChange={setPriorityFilter}
              options={[{ value: 'all', label: 'All priorities' }, ...Object.entries(PRIORITY).map(([k, v]) => ({ value: k, label: v.label }))]} />
            <FilterSelect label="Product" value={productFilter} onChange={setProductFilter}
              options={[{ value: 'all', label: 'All products' }, ...PRODUCT_FILTER_OPTS.map(p => ({ value: p, label: p }))]} />
            <FilterSelect label="Source" value={sourceFilter} onChange={setSourceFilter}
              options={[{ value: 'all', label: 'All sources' }, ...sources.map(src => ({ value: src, label: SOURCE_BADGE[src]?.label || src }))]} />

            <div style={s.selectedInfo}>
              <span style={s.selectedCount}>{selected.size}</span> selected
            </div>
            <button
              style={{ ...s.sendBtn, opacity: selected.size === 0 ? 0.5 : 1 }}
              disabled={selected.size === 0}
              onClick={() => setComposeOpen(true)}
            >
              <Send size={14} /> Send message
            </button>
          </div>

          <div style={{ flex: 1, overflow: 'auto', padding: '18px 28px', background: theme.bg }}>
            {loading ? <p style={{ color: theme.inkFaint, fontSize: 13 }}>Loading...</p> : (
              <div style={s.tableWrap}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      <th style={{ ...s.th, width: 36 }}>
                        <input type="checkbox" checked={allFilteredSelected} onChange={toggleAllFiltered} />
                      </th>
                      {['Customer', 'Phone', 'Priority', 'Product', 'Source'].map(h => <th key={h} style={s.th}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 ? (
                      <tr><td style={s.td} colSpan={6}>No leads match these filters.</td></tr>
                    ) : filtered.map(l => {
                      const custId = l.customers?.id;
                      const pri = PRIORITY[l.priority] || PRIORITY.medium;
                      const source = sourceBadge(l.source);
                      return (
                        <tr key={l.id}>
                          <td style={s.td}>
                            <input type="checkbox" checked={!!custId && selected.has(custId)} disabled={!custId} onChange={() => custId && toggle(custId)} />
                          </td>
                          <td style={s.td}>{custName(l)}</td>
                          <td style={{ ...s.td, fontFamily: theme.mono }}>{l.customers?.whatsapp_number}</td>
                          <td style={s.td}><span style={{ ...s.pill, color: pri.color, background: pri.bg }}>{pri.label}</span></td>
                          <td style={s.td}>{l.product_type || '—'}</td>
                          <td style={s.td}>{source ? `${source.icon} ${source.label}` : (l.source || '—')}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {composeOpen && (
            <ComposeModal
              leads={selectedLeads}
              onClose={() => setComposeOpen(false)}
              onSent={() => { setComposeOpen(false); setSelected(new Set()); }}
            />
          )}
        </>
      ) : (
        <HistoryTab />
      )}
    </div>
  );
}

function FilterSelect({ label, value, onChange, options }) {
  return (
    <select style={s.filterSelect} value={value} onChange={e => onChange(e.target.value)} title={label}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function HistoryTab() {
  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch('/api/bulk-messages/history');
        const data = await res.json();
        setBatches(data.batches || []);
      } catch (e) { console.error(e); }
      setLoading(false);
    })();
  }, []);

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '18px 28px', background: theme.bg }}>
      {loading ? <p style={{ color: theme.inkFaint, fontSize: 13 }}>Loading...</p> : batches.length === 0 ? (
        <p style={{ color: theme.inkFaint, fontSize: 13 }}>No bulk messages sent yet.</p>
      ) : (
        <div style={s.historyList}>
          {batches.map(b => {
            const isOpen = expanded === b.id;
            return (
              <div key={b.id} style={s.historyCard}>
                <button style={s.historyHeader} onClick={() => setExpanded(isOpen ? null : b.id)}>
                  {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <div style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
                    <p style={s.historyMessage}>{b.message}</p>
                    <p style={s.historyMeta}>
                      {new Date(b.created_at).toLocaleString('en', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      {b.sent_by_name ? ` · by ${b.sent_by_name}` : ''}
                      {b.image_url ? ' · with image' : ''}
                    </p>
                  </div>
                  <span style={s.historyCount}>{b.sent_count}/{b.total_count} sent</span>
                </button>

                {isOpen && (
                  <div style={s.historyBody}>
                    {b.image_url && <img src={b.image_url} alt="Sent" style={s.historyImg} />}
                    <div style={s.recipientTableWrap}>
                      <table style={s.table}>
                        <thead><tr>{['Customer', 'Phone', 'Status'].map(h => <th key={h} style={s.th}>{h}</th>)}</tr></thead>
                        <tbody>
                          {b.recipients.map(r => (
                            <tr key={r.customer_id}>
                              <td style={s.td}>{r.customer_name || '—'}</td>
                              <td style={{ ...s.td, fontFamily: theme.mono }}>{r.whatsapp_number}</td>
                              <td style={s.td}>
                                <span style={{ ...s.pill, color: r.sent ? theme.success : theme.high, background: r.sent ? theme.successBg : theme.highBg }}>
                                  {r.sent ? 'Sent' : 'Failed'}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ComposeModal({ leads, onClose, onSent }) {
  const [message, setMessage] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [imgError, setImgError] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  useErrorPopup(error, 'Could not send the message');
  const [result, setResult] = useState(null);

  const customerIds = leads.map(l => l.customers?.id).filter(Boolean);

  async function send() {
    if (!message.trim()) return;
    setSending(true); setError(null);
    try {
      const res = await apiFetch('/api/bulk-messages/send', {
        method: 'POST',
        body: JSON.stringify({ customerIds, message: message.trim(), imageUrl: imageUrl.trim() || undefined }),
      });
      const data = await res.json();
      if (data.success) setResult(data);
      else setError(data.error || 'Failed to send');
    } catch (e) { setError('Network error: ' + e.message); }
    setSending(false);
  }

  return (
    <div style={s.backdrop} onClick={e => e.target === e.currentTarget && !sending && onClose()}>
      <div style={s.modal}>
        <div style={s.modalHeader}>
          <div style={s.modalHeaderLeft}>
            <div style={s.modalIcon}><Send size={16} color={theme.accentInk} /></div>
            <div>
              <p style={s.modalTitle}>Send bulk message</p>
              <p style={s.modalSub}>{leads.length} recipient{leads.length === 1 ? '' : 's'} selected</p>
            </div>
          </div>
          <button style={s.closeBtn} onClick={onClose} disabled={sending}><X size={15} /></button>
        </div>

        <div style={s.modalBody}>
          {result ? (
            <div>
              <p style={s.resultLine}>✅ Sent {result.sentCount} of {result.totalCount} messages.</p>
              {result.results.some(r => !r.sent) && (
                <p style={{ ...s.resultLine, color: theme.high }}>
                  {result.results.filter(r => !r.sent).length} failed to deliver — check their chat for details.
                </p>
              )}
            </div>
          ) : (
            <>
              <label style={s.fieldLabel}>Recipients ({leads.length})</label>
              <div style={s.recipientList}>
                {leads.map(l => (
                  <span key={l.id} style={s.recipientChip}>{custName(l)} · {l.customers?.whatsapp_number}</span>
                ))}
              </div>

              <label style={s.fieldLabel}>Message</label>
              <textarea
                style={s.textarea} value={message} onChange={e => setMessage(e.target.value)}
                placeholder="Type the message to send to all selected customers..."
                autoFocus
              />

              <label style={s.fieldLabel}>Image URL (optional)</label>
              <div style={s.imageRow}>
                <ImageIcon size={14} color={theme.inkFaint} style={{ flexShrink: 0 }} />
                <input
                  style={s.input} value={imageUrl}
                  onChange={e => { setImageUrl(e.target.value); setImgError(false); }}
                  placeholder="https://... a publicly reachable image URL"
                />
              </div>
              <p style={s.fieldHint}>Must be a real, publicly reachable image URL — WhatsApp fetches it directly, this isn&apos;t a file upload.</p>
              {imageUrl.trim() && (
                imgError
                  ? <p style={{ color: theme.high, fontSize: 12 }}>Couldn&apos;t load this URL as an image.</p>
                  : <img src={imageUrl.trim()} alt="Preview" style={s.previewImg} onError={() => setImgError(true)} />
              )}

            </>
          )}
        </div>

        <div style={s.modalFooter}>
          {result ? (
            <button style={s.saveBtn} onClick={() => onSent()}>Done</button>
          ) : (
            <>
              <button style={s.cancelBtn} onClick={onClose} disabled={sending}>Cancel</button>
              <button style={{ ...s.saveBtn, opacity: message.trim() ? 1 : 0.5 }} onClick={send} disabled={sending || !message.trim()}>
                {sending ? 'Sending...' : `Send to ${leads.length}`}
              </button>
            </>
          )}
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

  historyList: { display: 'flex', flexDirection: 'column', gap: 10 },
  historyCard: { background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: theme.radiusLg, overflow: 'hidden' },
  historyHeader: { display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '12px 16px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', color: theme.inkSoft },
  historyMessage: { fontSize: 13, color: theme.ink, margin: 0, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  historyMeta: { fontSize: 11.5, color: theme.inkFaint, margin: '2px 0 0' },
  historyCount: { fontSize: 12, fontWeight: 600, color: theme.inkSoft, flexShrink: 0, whiteSpace: 'nowrap' },
  historyBody: { padding: '0 16px 16px' },
  historyImg: { maxWidth: '100%', maxHeight: 180, borderRadius: 8, border: `1px solid ${theme.border}`, display: 'block', marginBottom: 10 },
  recipientTableWrap: { border: `1px solid ${theme.border}`, borderRadius: 10, overflow: 'hidden' },

  filters: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '12px 28px',
    background: theme.surface, borderBottom: `1px solid ${theme.border}`, flexWrap: 'wrap',
  },
  filterSelect: {
    fontSize: 12.5, fontWeight: 600, border: `1px solid ${theme.border}`, borderRadius: 8,
    padding: '7px 10px', fontFamily: 'inherit', background: theme.bg, color: theme.ink,
  },
  selectedInfo: { marginLeft: 'auto', fontSize: 12.5, color: theme.inkSoft },
  selectedCount: { fontWeight: 700, color: theme.accentInk },
  sendBtn: {
    display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, border: 'none',
    fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', background: theme.accent, color: '#fff',
  },

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
  pill: { display: 'inline-flex', alignItems: 'center', padding: '3px 10px', borderRadius: 20, fontSize: 11.5, fontWeight: 600 },

  backdrop: modalBackdrop,
  modal: { background: theme.surface, borderRadius: 16, width: '100%', maxWidth: 520, maxHeight: vh(85), display: 'flex', flexDirection: 'column', boxShadow: theme.shadowMd, overflow: 'hidden' },
  modalHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: `1px solid ${theme.border}`, flexShrink: 0 },
  modalHeaderLeft: { display: 'flex', alignItems: 'center', gap: 12 },
  modalIcon: { width: 34, height: 34, borderRadius: 9, background: theme.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  modalTitle: { fontSize: 14.5, fontWeight: 700, color: theme.ink, margin: 0 },
  modalSub: { fontSize: 12, color: theme.inkFaint, margin: 0 },
  closeBtn: { background: theme.borderSoft, border: 'none', cursor: 'pointer', width: 28, height: 28, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.inkSoft, flexShrink: 0 },
  modalBody: { padding: '16px 20px', overflowY: 'auto' },
  modalFooter: { display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 20px', borderTop: `1px solid ${theme.border}`, flexShrink: 0 },

  fieldLabel: { fontSize: 11, fontWeight: 700, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6, marginTop: 12 },
  fieldHint: { fontSize: 11, color: theme.inkFaint, margin: '4px 0 0', lineHeight: 1.4 },
  recipientList: { display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 90, overflowY: 'auto', padding: '2px 0' },
  recipientChip: { fontSize: 11.5, color: theme.inkSoft, background: theme.bg, border: `1px solid ${theme.border}`, borderRadius: 20, padding: '4px 10px' },
  textarea: { width: '100%', border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', minHeight: 90, resize: 'vertical', background: theme.bg, color: theme.ink, boxSizing: 'border-box' },
  imageRow: { display: 'flex', alignItems: 'center', gap: 8, border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '0 10px', background: theme.bg },
  input: { flex: 1, border: 'none', background: 'none', outline: 'none', padding: '8px 0', fontSize: 13, color: theme.ink, fontFamily: 'inherit' },
  previewImg: { marginTop: 8, maxWidth: '100%', maxHeight: 160, borderRadius: 8, border: `1px solid ${theme.border}`, display: 'block' },
  resultLine: { fontSize: 13, color: theme.success, fontWeight: 600, margin: '4px 0' },

  cancelBtn: { background: theme.bg, border: `1px solid ${theme.border}`, color: theme.inkSoft, fontSize: 13, fontWeight: 600, padding: '8px 18px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
  saveBtn: { background: theme.accent, border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, padding: '8px 22px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
};
