import { useParams, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { ArrowLeft, MessageCircle, Download, XCircle, FileText } from 'lucide-react';
import { apiFetch } from '../lib/api';
import ShowroomOrderModal from '../components/ShowroomOrderModal';
import CallDots from '../components/CallDots';
import { theme, sourceBadge } from '../lib/theme';
import { roleAllowed } from '../lib/roles';
import { useLeadItems, LeadItemsPanel } from '../components/LeadProductsPanel';
import { useAuth } from '../lib/AuthContext';
import {
  STATUS, PRIORITY, custName, downloadLeadPDF,
  ChatViewModal, CloseLeadModal, DetailPanel,
} from '../components/LeadsPage';
import DocumentPreviewModal from '../components/DocumentPreviewModal';
import CallButton from '../components/CallButton';
import { useDialog } from '../components/DialogProvider';
import { previewQuotationPDF } from '../lib/quotationPdf';

export default function LeadDetail() {
  const { id }   = useParams();
  const navigate = useNavigate();
  const { staff } = useAuth();
  const [lead, setLead]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [chatOpen, setChatOpen]     = useState(false);
  const [orderOpen, setOrderOpen]   = useState(false);
  const [closingOpen, setClosingOpen] = useState(false);
  const [salesAgents, setSalesAgents] = useState([]);
  const [quoting, setQuoting] = useState(false);
  const [quotePreview, setQuotePreview] = useState(null);
  const dialog = useDialog();

  async function fetchLead() {
    try {
      const res  = await apiFetch(`/api/leads/${id}`);
      const data = await res.json();
      setLead(data.lead || null);
    } catch (e) { console.error(e); }
    setLoading(false);
  }

  useEffect(() => { setLoading(true); fetchLead(); }, [id]);

  // The assignee dropdown (admin-only, matching PATCH /api/leads/:id's own
  // admin-only reassignment gate) needs the sales agent roster — GET
  // /api/staff is itself admin-only, so this fetch only fires for admins.
  useEffect(() => {
    if (!roleAllowed(staff?.role, ['admin'])) return;
    apiFetch('/api/staff').then(r => r.json()).then(d => {
      setSalesAgents((d.staff || []).filter(s => s.role === 'sales_agent' && s.active));
    }).catch(() => {});
  }, [staff?.role]);

  // Claims a quotation number (only ever issued once per lead — the DB
  // function is idempotent) and opens the PDF in a preview, where staff can
  // check it and then download. The number comes from the server rather than
  // being typed, so two staff quoting at once can't collide.
  //
  // Previewing DOES claim the number, since the function is idempotent per
  // lead: previewing then downloading reuses one number rather than burning
  // two. A preview that is closed without downloading keeps the number on the
  // lead, which is right — it has been quoted at that reference.
  async function createQuotation() {
    setQuoting(true);
    try {
      const res  = await apiFetch(`/api/leads/${id}/quotation`, { method: 'POST' });
      const data = await res.json();
      if (!data.success) {
        setQuoting(false);
        await dialog.alert({ title: 'Could not create the quotation', message: data.error || 'Please try again.' });
        return;
      }
      setQuotePreview(data);
      // Reflect the newly-claimed number in the header without a reload.
      setLead(prev => ({ ...prev, quotation_no: data.quotationNo }));
    } catch (err) {
      setQuoting(false);
      await dialog.alert({ title: 'Could not create the quotation', message: `Network error: ${err.message}` });
      return;
    }
    setQuoting(false);
  }

  async function patchLead(leadId, patch) {
    const res  = await apiFetch(`/api/leads/${leadId}`, { method: 'PATCH', body: JSON.stringify(patch) });
    const data = await res.json();
    if (data.success) setLead(prev => ({ ...prev, ...data.lead }));
    return data;
  }

  // Customer-level field (contact_whatsapp_number lives on the customer, not
  // the lead) — merged into the nested customers object this page renders.
  async function patchCustomer(leadObj, patch) {
    const res  = await apiFetch(`/api/customers/${leadObj.customers.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    const data = await res.json();
    if (data.success) setLead(prev => ({ ...prev, customers: { ...prev.customers, ...data.customer } }));
    return data;
  }

  async function closeLead(reason) {
    const data = await patchLead(id, { ticket_state: 'closed', closed_reason: reason });
    if (data.success) { setClosingOpen(false); navigate('/leads'); }
    return data;
  }

  // Called before the early returns below: hooks must run unconditionally.
  // Tolerates a null lead while the fetch is in flight — useLeadItems reads
  // lead?.id and simply has nothing to load yet.
  const itemsCtl = useLeadItems(lead || { id: null }, fetchLead);

  if (loading) return (
    <div style={s.center}><div className="summary-spinner" /></div>
  );

  if (!lead) return (
    <div style={s.center}>
      <p style={{ color: theme.inkFaint }}>Lead not found</p>
      <button style={s.backLink} onClick={() => navigate('/leads')}>← Back to Pipeline</button>
    </div>
  );

  const alreadyWon = lead.status === 'won';
  const st = STATUS[lead.status] || STATUS.new;
  const pri = PRIORITY[lead.priority] || PRIORITY.medium;
  const source = sourceBadge(lead.source);

  return (
    <div style={s.page}>
      <div style={s.topBar}>
        <button
          className="icon-back"
          style={s.backBtn}
          onClick={() => navigate('/leads')}
          title="Back to Pipeline"
          aria-label="Back to Pipeline"
        >
          <ArrowLeft size={18} />
        </button>
        <div style={s.topMid}>
          <div style={s.avatar} title={custName(lead)}>{custName(lead).charAt(0).toUpperCase()}</div>
          {/* Same choice as the Pipeline table's Status column, and the same
              PATCH — so the two places cannot disagree about what a status
              change does. */}
          <select
            style={{ ...s.prioritySelect, color: st.color, background: st.bg }}
            value={lead.status || 'new'}
            onChange={e => patchLead(lead.id, { status: e.target.value })}
            title="Status"
            aria-label="Lead status"
          >
            {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <select
            style={{ ...s.prioritySelect, color: pri.color, background: pri.bg }}
            value={lead.priority || 'medium'}
            onChange={e => patchLead(lead.id, { priority: e.target.value })}
            title="Priority"
          >
            {Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v.label} priority</option>)}
          </select>
          {/* Same last-calls dots and hover history as the Pipeline row. */}
          <CallDots calls={lead.recent_calls} customerId={lead.customer_id} customerName={custName(lead)} />
          {source && (
            <span style={s.sourceBadge}>
              {source.icon} {source.label}{lead.source === 'showroom' && lead.showroom_location ? ` · ${lead.showroom_location}` : ''}
            </span>
          )}
          {roleAllowed(staff?.role, ['admin']) ? (
            <select
              style={s.assigneeSelect}
              value={lead.assigned_staff_id || ''}
              onChange={e => patchLead(lead.id, { assigned_staff_id: e.target.value || null })}
              title="Assigned to"
            >
              <option value="">Unassigned</option>
              {lead.assigned_staff_id && !salesAgents.some(sa => sa.id === lead.assigned_staff_id) && (
                <option value={lead.assigned_staff_id}>{lead.assigned_staff_name || 'Currently assigned'}</option>
              )}
              {salesAgents.map(sa => <option key={sa.id} value={sa.id}>{sa.name}</option>)}
            </select>
          ) : lead.assigned_staff_name ? (
            <span style={s.sourceBadge}>👤 {lead.assigned_staff_name}</span>
          ) : null}
          {/* The quotation number lives here rather than in the Products
              section — it belongs beside the Quotation action. */}
          {lead.quotation_no && (
            <span style={s.quoteChip} title="Quotation number">
              <FileText size={11} /> {lead.quotation_no}
            </span>
          )}
        </div>
        <div style={s.actions}>
          <CallButton variant="label" customerId={lead.customer_id} leadId={lead.id} customerName={lead.customers?.name || lead.customers?.whatsapp_number} style={s.actionBtn} />
          <button style={s.actionBtn} onClick={() => setChatOpen(true)} title="View chat"><MessageCircle size={14} /> Chat</button>
          <button
            style={{ ...s.actionBtn, ...s.quoteBtn, opacity: quoting ? 0.5 : 1 }}
            onClick={() => !quoting && createQuotation()}
            disabled={quoting}
            title={lead.quotation_no
              ? `Preview quotation ${lead.quotation_no}`
              : 'Create a quotation and preview it'}
          >
            <FileText size={14} /> {quoting ? 'Preparing…' : 'Quotation'}
          </button>
          <button style={s.actionBtn} onClick={() => downloadLeadPDF(lead)} title="Download internal lead report"><Download size={14} /> PDF</button>
          <button style={{ ...s.actionBtn, ...s.closeBtn }} onClick={() => setClosingOpen(true)} title="Close lead">
            <XCircle size={14} /> Close
          </button>
        </div>
      </div>

      {/* Two columns: everything about the lead scrolls on the left, while
          the "Interested in" panel is pinned to the full height of the right
          and never scrolls — so the enquiry stays visible while staff work
          through notes, location and the follow-up schedule. */}
      <div style={s.split} className="lead-detail-split">
        <div style={s.body}>
          <DetailPanel
            lead={lead}
            onPatchLead={patchLead}
            onPatchCustomer={patchCustomer}
            itemsCtl={itemsCtl}
          />
        </div>
        <div style={s.itemsPane}>
          <LeadItemsPanel
            ctl={itemsCtl}
            onOrder={() => setOrderOpen(true)}
            orderDisabled={alreadyWon}
            orderTitle={alreadyWon ? 'Already converted to order' : 'Convert to order'}
          />
        </div>
      </div>

      {chatOpen && <ChatViewModal lead={lead} onClose={() => setChatOpen(false)} />}

      {/* Same screen as the Pipeline's convert button and the showroom walk-in
          flow — one component, so all three stay identical. */}
      {orderOpen && (
        <ShowroomOrderModal
          lead={lead}
          onClose={() => setOrderOpen(false)}
          onSaved={() => {
            // The order closed this enquiry server-side, so reflect that
            // before leaving rather than showing a stale "open" ticket if the
            // user navigates back.
            setLead(prev => ({ ...prev, status: 'won', ticket_state: 'closed' }));
            setOrderOpen(false);
            navigate('/orders');
          }}
        />
      )}

      {closingOpen && (
        <CloseLeadModal lead={lead} onClose={() => setClosingOpen(false)} onConfirm={closeLead} />
      )}

      {quotePreview && (
        <DocumentPreviewModal
          payload={quotePreview}
          render={previewQuotationPDF}
          title={quotePreview.quotationNo || 'Quotation'}
          onClose={() => setQuotePreview(null)}
        />
      )}
    </div>
  );
}

const s = {
  page:    { display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', background: theme.bg },
  center:  { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 },
  backLink:{ color: theme.accentInk, background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600 },
  topBar:  { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px', background: theme.surface, borderBottom: `1px solid ${theme.border}`, flexShrink: 0 },
  backBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, background: 'none', border: 'none', color: theme.inkSoft, cursor: 'pointer', padding: 0, borderRadius: 7, flexShrink: 0, fontFamily: 'inherit' },
  topMid:  { display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 },
  avatar:  { width: 38, height: 38, borderRadius: '50%', background: theme.accent, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 15, flexShrink: 0 },
  prioritySelect: { fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 20, flexShrink: 0, border: 'none', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' },
  assigneeSelect: { fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 20, flexShrink: 0, border: 'none', outline: 'none', cursor: 'pointer', fontFamily: 'inherit', color: theme.inkSoft, background: theme.bg },
  sourceBadge: { display: 'inline-flex', fontSize: 11, fontWeight: 600, color: theme.inkSoft, background: theme.bg, padding: '4px 10px', borderRadius: 20, flexShrink: 0 },
  quoteChip: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: theme.accentInk, background: theme.accentSoft, padding: '4px 10px', borderRadius: 20, flexShrink: 0, fontVariantNumeric: 'tabular-nums' },
  actions: { display: 'flex', gap: 6, flexShrink: 0 },
  actionBtn: { display: 'flex', alignItems: 'center', gap: 5, background: theme.bg, border: `1.5px solid ${theme.border}`, color: theme.inkSoft, fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit' },
  quoteBtn: { background: theme.accentSoft, border: 'none', color: theme.accentInk },
  closeBtn: { background: theme.highBg, border: 'none', color: theme.high },
  // Left column scrolls; the right items panel is pinned full-height.
  split:   { flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' },
  // paddingBottom: room under the last notes box when scrolled to the end, so
  // it does not sit flush against the bottom edge of the window.
  body:    { flex: 1, minWidth: 0, overflowY: 'auto', display: 'flex', justifyContent: 'center', marginBottom: 10 },
  itemsPane: { width: 290, flexShrink: 0 },
};
