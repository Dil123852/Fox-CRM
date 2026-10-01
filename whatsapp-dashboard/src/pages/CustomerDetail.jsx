import { useParams, useNavigate, Link } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, Package, ShieldCheck, Phone, Users, MessageSquare,
  Store, AlertTriangle, TrendingUp, FileText, Download,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { roleAllowed } from '../lib/roles';
import { previewQuotationPDF, quotationPayload } from '../lib/quotationPdf';
import DocumentPreviewModal from '../components/DocumentPreviewModal';
import { theme, LEAD_STATUS, ORDER_STATUS, PAYMENT_STATUS, CHANNEL_BADGE } from '../lib/theme';
import MessageBubble from '../components/MessageBubble';

// Customer 360 — the screen that replaces "look the customer up in four places".
//
// Built because converting an enquiry to an order now CLOSES that enquiry, so
// it leaves the Pipeline (which shows open tickets only). The history has to
// live somewhere, and the customer is the thing that persists: their orders,
// warranty cover, who has handled them, and their call log all outlive any one
// enquiry. A returning caller gets a fresh ticket automatically, and this page
// is where staff see everything that came before it.
//
// Layout is a summary strip over tabs rather than one long scroll: the strip
// answers "who is this and are they worth attention" at a glance, and the tabs
// keep each record type scannable instead of six sections competing for the
// same page. Counts sit in the tab labels so staff know what is there without
// opening each one.

const money = n => `LKR ${(Number(n) || 0).toLocaleString('en-LK', { minimumFractionDigits: 2 })}`;
const day = d => (d ? new Date(d).toLocaleDateString('en-LK', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const dayTime = d => (d ? new Date(d).toLocaleString('en-LK', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const mins = s => {
  const n = Number(s) || 0;
  if (n < 60) return `${n}s`;
  return `${Math.floor(n / 60)}m ${n % 60}s`;
};

export default function CustomerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('orders');
  const bottomRef = useRef(null);
  // Quotations filed under this customer (migration 054). Fetched on their
  // own because the quotation routes are narrower than this page (admin,
  // sales_agent, viewer); for other roles the tab is simply not shown.
  const { staff } = useAuth();
  const canSeeQuotes = roleAllowed(staff?.role, ['admin', 'sales_agent', 'viewer']);
  const [quotations, setQuotations] = useState([]);
  const [quotePreview, setQuotePreview] = useState(null);

  useEffect(() => {
    if (!canSeeQuotes) return undefined;
    let alive = true;
    apiFetch(`/api/quotations?customerId=${encodeURIComponent(id)}`)
      .then(r => (r.ok ? r.json() : { quotations: [] }))
      .then(d => { if (alive) setQuotations(d.quotations || []); })
      .catch(() => {});
    return () => { alive = false; };
  }, [id, canSeeQuotes]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await apiFetch(`/api/customers/${id}`);
        const json = await res.json();
        if (alive) setData(json.customer ? json : null);
      } catch {
        if (alive) setData(null);
      }
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [id]);

  // Only scroll the chat into view when the chat tab is the one showing,
  // otherwise opening the page yanks it past the summary.
  useEffect(() => {
    if (tab === 'chat') bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [tab, data]);

  if (loading) return <div style={s.center}><div className="summary-spinner" /></div>;

  if (!data) return (
    <div style={s.center}>
      <p style={{ color: theme.inkFaint }}>Customer not found</p>
      <button style={s.backLink} onClick={() => navigate('/customers')}>← Back to customers</button>
    </div>
  );

  const {
    customer, messages = [], leads = [], orders = [], warranties = [],
    serviceTickets = [], calls = [], showroomVisits = [], handledBy = [], stats = {},
  } = data;

  const channel = CHANNEL_BADGE[customer.channel] || { label: customer.channel || 'Unknown', icon: '•' };

  const TABS = [
    { key: 'orders',    label: 'Orders',     icon: Package,      count: orders.length },
    ...(canSeeQuotes ? [{ key: 'quotations', label: 'Quotations', icon: FileText, count: quotations.length }] : []),
    { key: 'warranty',  label: 'Warranty',   icon: ShieldCheck,  count: warranties.length },
    { key: 'enquiries', label: 'Enquiries',  icon: TrendingUp,   count: leads.length },
    { key: 'calls',     label: 'Calls',      icon: Phone,        count: calls.length },
    { key: 'chat',      label: 'Chat',       icon: MessageSquare, count: messages.length },
  ];

  return (
    <div style={s.page}>
      {/* ── header ── */}
      <div style={s.topBar}>
        <button style={s.backBtn} onClick={() => navigate('/customers')} title="Back to customers" aria-label="Back to customers">
          <ArrowLeft size={18} />
        </button>
        <div style={s.avatar}>{(customer.name || '?').charAt(0).toUpperCase()}</div>
        <div style={{ minWidth: 0 }}>
          <p style={s.name}>{customer.name || 'Unnamed customer'}</p>
          <p style={s.sub}>
            {customer.whatsapp_number}
            {customer.contact_whatsapp_number && customer.contact_whatsapp_number !== customer.whatsapp_number && (
              <> · WhatsApp {customer.contact_whatsapp_number}</>
            )}
            {' · '}{channel.icon} {channel.label}
          </p>
        </div>
        <div style={{ flex: 1 }} />
        {customer.is_loyalty_customer && <span style={s.loyalBadge}>★ Loyalty customer</span>}
        {stats.openEnquiries > 0 && (
          <span style={s.openBadge}>{stats.openEnquiries} open enquiry{stats.openEnquiries === 1 ? '' : 's'}</span>
        )}
      </div>

      {/* ── summary strip: the "is this worth attention" row ── */}
      <div style={s.statStrip}>
        <Stat label="Orders" value={stats.orderCount ?? 0} />
        {/* Total ordered and lifetime value are DIFFERENT numbers and are
            labelled as such: lifetime_value only moves once an order is
            delivered AND paid, so it reads 0 for a customer with real orders
            in flight. Showing only that would misrepresent the relationship. */}
        <Stat label="Total ordered" value={money(stats.totalOrdered)} />
        <Stat label="Paid" value={money(stats.totalPaid)} />
        <Stat
          label="Balance due"
          value={money(stats.balanceDue)}
          tone={stats.balanceDue > 0 ? theme.high : theme.inkSoft}
        />
        <Stat label="Lifetime value" value={money(stats.lifetimeValue)} hint="Counts delivered + paid orders only" />
        <Stat label="Enquiries" value={stats.enquiryCount ?? 0} />
        <Stat label="Active warranty" value={stats.activeWarranties ?? 0} />
      </div>

      {/* ── who has handled this customer ── */}
      {handledBy.length > 0 && (
        <div style={s.handledRow}>
          <Users size={13} color={theme.inkFaint} />
          <span style={s.handledLabel}>Handled by</span>
          {handledBy.map(h => (
            <span key={h.id} style={s.staffChip}>
              {h.name || 'Unknown'}
              <span style={s.staffRole}>{(h.role || '').replace(/_/g, ' ')}</span>
              {h.tickets > 1 && <span style={s.staffCount}>{h.tickets}</span>}
            </span>
          ))}
        </div>
      )}

      {/* ── tabs ── */}
      <div style={s.tabBar} className="scroll-strip">
        {TABS.map(t => {
          const Icon = t.icon;
          const on = tab === t.key;
          return (
            <button key={t.key} style={{ ...s.tab, ...(on ? s.tabOn : {}) }} onClick={() => setTab(t.key)}>
              <Icon size={13} /> {t.label}
              <span style={{ ...s.tabCount, ...(on ? s.tabCountOn : {}) }}>{t.count}</span>
            </button>
          );
        })}
      </div>

      <div style={s.body}>
        {tab === 'orders' && (
          orders.length === 0 ? <Empty icon={Package} text="No orders yet" />
            : orders.map(o => <OrderRow key={o.id} order={o} />)
        )}

        {tab === 'quotations' && (
          quotations.length === 0
            ? <Empty icon={FileText} text="No quotations yet — make one on the Quotations page with this customer's number" />
            : quotations.map(q => <QuotationRow key={q.id} q={q} onDownload={() => setQuotePreview(q)} />)
        )}

        {tab === 'warranty' && (
          <>
            {warranties.length === 0 && serviceTickets.length === 0 && (
              <Empty icon={ShieldCheck} text="No warranties — these are created automatically when an order is delivered and paid" />
            )}
            {warranties.map(w => <WarrantyRow key={w.id} w={w} />)}
            {serviceTickets.length > 0 && (
              <>
                <p style={s.sectionLabel}>Service tickets</p>
                {serviceTickets.map(t => <TicketRow key={t.id} t={t} />)}
              </>
            )}
          </>
        )}

        {tab === 'enquiries' && (
          leads.length === 0 ? <Empty icon={TrendingUp} text="No enquiries recorded" />
            : leads.map(l => <LeadRow key={l.id} lead={l} />)
        )}

        {tab === 'calls' && (
          <>
            {calls.length === 0 && showroomVisits.length === 0 && <Empty icon={Phone} text="No calls or showroom visits recorded" />}
            {calls.map(c => <CallRow key={c.id} c={c} />)}
            {showroomVisits.length > 0 && (
              <>
                <p style={s.sectionLabel}>Showroom visits</p>
                {showroomVisits.map(v => <VisitRow key={v.id} v={v} />)}
              </>
            )}
          </>
        )}

        {quotePreview && (
          <DocumentPreviewModal
            payload={quotationPayload(quotePreview)}
            render={previewQuotationPDF}
            title={quotePreview.quotation_no}
            onClose={() => setQuotePreview(null)}
          />
        )}

        {tab === 'chat' && (
          messages.length === 0 ? <Empty icon={MessageSquare} text="No WhatsApp messages" />
            : (
              <div style={s.chat}>
                {/* prevMsg drives the date dividers inside MessageBubble. */}
                {messages.map((m, i) => <MessageBubble key={m.id} msg={m} prevMsg={messages[i - 1]} />)}
                <div ref={bottomRef} />
              </div>
            )
        )}
      </div>
    </div>
  );
}

/* ── pieces ─────────────────────────────────────────────────────────────── */

function QuotationRow({ q, onDownload }) {
  const items = Array.isArray(q.items) ? q.items : [];
  return (
    <Link to={`/quotations?open=${q.id}`} style={s.card}>
      <div style={s.cardTop}>
        <span style={s.cardTitle}>{q.quotation_no}</span>
        {q.recreated_from_no && (
          <span style={{ ...s.pill, color: theme.inkSoft, background: theme.borderSoft }}>from {q.recreated_from_no}</span>
        )}
        <div style={{ flex: 1 }} />
        <span style={s.cardAmount}>{money(q.total_amount)}</span>
        <button
          type="button"
          style={s.rowIconBtn}
          title="Download / preview PDF"
          onClick={e => { e.preventDefault(); e.stopPropagation(); onDownload(); }}
        >
          <Download size={13} />
        </button>
      </div>
      <p style={s.cardMeta}>
        {day(q.created_at)}{q.created_by_name ? ` · by ${q.created_by_name}` : ''}
        {items.length > 0 && <> · {items.map(i => `${i.name}${i.qty > 1 ? ` ×${i.qty}` : ''}`).join(', ')}</>}
      </p>
    </Link>
  );
}

function Stat({ label, value, tone, hint }) {
  return (
    <div style={s.stat} title={hint || undefined}>
      <span style={s.statLabel}>{label}</span>
      <span style={{ ...s.statValue, ...(tone ? { color: tone } : {}) }}>{value}</span>
    </div>
  );
}

function Empty({ icon: Icon, text }) {
  return (
    <div style={s.empty}>
      <Icon size={26} color={theme.inkFaint} />
      <p style={s.emptyText}>{text}</p>
    </div>
  );
}

function OrderRow({ order }) {
  const st = ORDER_STATUS[order.status] || {};
  const pay = PAYMENT_STATUS[order.payment_status] || {};
  const balance = Number(order.balance_due) || 0;
  const items = Array.isArray(order.items) ? order.items : [];
  return (
    <Link to={`/orders?open=${order.id}`} style={s.card}>
      <div style={s.cardTop}>
        <span style={s.cardTitle}>{order.order_number}</span>
        <span style={{ ...s.pill, color: st.color, background: st.bg }}>{st.label || order.status}</span>
        <span style={{ ...s.pill, color: pay.color, background: theme.borderSoft }}>{pay.label || order.payment_status}</span>
        <div style={{ flex: 1 }} />
        <span style={s.cardAmount}>{money(order.total_amount)}</span>
      </div>
      <p style={s.cardMeta}>
        {day(order.created_at)}
        {items.length > 0 && <> · {items.map(i => `${i.name}${i.qty > 1 ? ` ×${i.qty}` : ''}`).join(', ')}</>}
      </p>
      {balance > 0 && (
        <p style={s.cardWarn}><AlertTriangle size={11} /> {money(balance)} outstanding</p>
      )}
    </Link>
  );
}

function WarrantyRow({ w }) {
  const status = w.effective_status || w.status;
  const tone = status === 'active' ? theme.success : status === 'expired' ? theme.inkFaint : theme.cancel;
  return (
    <div style={s.card}>
      <div style={s.cardTop}>
        <span style={s.cardTitle}>{w.warranty_number}</span>
        <span style={{ ...s.pill, color: tone, background: theme.borderSoft }}>{status}</span>
        <div style={{ flex: 1 }} />
        <span style={s.cardMeta}>{w.product_name}</span>
      </div>
      <p style={s.cardMeta}>
        {day(w.start_date)} → {day(w.end_date)}
        {w.days_remaining != null && status === 'active' && <> · {w.days_remaining} days left</>}
      </p>
    </div>
  );
}

function TicketRow({ t }) {
  return (
    <div style={s.card}>
      <div style={s.cardTop}>
        <span style={s.cardTitle}>{(t.issue_type || '').replace(/_/g, ' ')}</span>
        <span style={{ ...s.pill, color: theme.inkSoft, background: theme.borderSoft }}>{t.status}</span>
        <div style={{ flex: 1 }} />
        <span style={s.cardMeta}>{day(t.created_at)}</span>
      </div>
      {t.description && <p style={s.cardMeta}>{t.description}</p>}
    </div>
  );
}

function LeadRow({ lead }) {
  const st = LEAD_STATUS[lead.status] || {};
  const open = lead.ticket_state === 'open';
  return (
    <div style={{ ...s.card, ...(open ? s.cardOpen : {}) }}>
      <div style={s.cardTop}>
        <span style={{ ...s.pill, color: st.color, background: st.bg }}>{st.label || lead.status}</span>
        {open
          ? <span style={s.openTag}>OPEN</span>
          : <span style={s.closedTag}>closed {day(lead.closed_at)}</span>}
        <div style={{ flex: 1 }} />
        {lead.converted_order_number && (
          <Link to={`/orders?open=${lead.converted_order_id}`} style={s.orderLink}>{lead.converted_order_number}</Link>
        )}
      </div>
      <p style={s.cardMeta}>
        {day(lead.created_at)}
        {lead.product_type && <> · {lead.product_type}</>}
        {lead.assigned_staff_name && <> · handled by {lead.assigned_staff_name}</>}
      </p>
      {lead.closed_reason && !open && <p style={s.cardMeta}>{lead.closed_reason}</p>}
    </div>
  );
}

function CallRow({ c }) {
  const missed = c.call_type === 'MISSED';
  return (
    <div style={s.card}>
      <div style={s.cardTop}>
        <Phone size={13} color={missed ? theme.high : theme.inkFaint} />
        <span style={{ ...s.cardTitle, color: missed ? theme.high : theme.ink }}>
          {(c.call_type || 'CALL').toLowerCase()}
        </span>
        <div style={{ flex: 1 }} />
        <span style={s.cardMeta}>{dayTime(c.occurred_at)}</span>
      </div>
      <p style={s.cardMeta}>
        {c.duration_seconds > 0 ? mins(c.duration_seconds) : 'no answer'}
        {c.contact_name && <> · saved as {c.contact_name}</>}
      </p>
    </div>
  );
}

function VisitRow({ v }) {
  return (
    <div style={s.card}>
      <div style={s.cardTop}>
        <Store size={13} color={theme.inkFaint} />
        <span style={s.cardTitle}>{v.showroom_location || 'Showroom'}</span>
        <div style={{ flex: 1 }} />
        <span style={s.cardMeta}>{day(v.visited_at)}</span>
      </div>
      <p style={s.cardMeta}>
        {v.outcome || '—'}
        {v.staff_name && <> · {v.staff_name}</>}
        {v.products_shown && <> · showed {v.products_shown}</>}
      </p>
    </div>
  );
}

/* ── styles ─────────────────────────────────────────────────────────────── */

const s = {
  page: { flex: 1, display: 'flex', flexDirection: 'column', background: theme.bg, minHeight: 0 },
  center: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 },
  backLink: { color: theme.accentInk, background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600 },

  topBar: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px', background: theme.surface, borderBottom: `1px solid ${theme.border}`, flexShrink: 0 },
  backBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, background: 'none', border: 'none', color: theme.inkSoft, cursor: 'pointer', padding: 0, borderRadius: 7, flexShrink: 0 },
  avatar: { width: 40, height: 40, borderRadius: '50%', background: theme.accent, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 16, flexShrink: 0 },
  name: { margin: 0, fontSize: 16, fontWeight: 700, color: theme.ink },
  sub: { margin: '2px 0 0', fontSize: 12, color: theme.inkSoft },
  loyalBadge: { fontSize: 11, fontWeight: 700, color: theme.med, background: theme.medBg, padding: '4px 10px', borderRadius: 20 },
  openBadge: { fontSize: 11, fontWeight: 700, color: theme.info, background: theme.infoBg, padding: '4px 10px', borderRadius: 20 },

  statStrip: { display: 'flex', gap: 0, flexWrap: 'wrap', background: theme.surface, borderBottom: `1px solid ${theme.border}`, padding: '10px 20px', flexShrink: 0 },
  stat: { display: 'flex', flexDirection: 'column', gap: 2, paddingRight: 28, minWidth: 96 },
  statLabel: { fontSize: 10, fontWeight: 700, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.04em' },
  statValue: { fontSize: 15, fontWeight: 700, color: theme.ink },

  handledRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 20px', background: theme.surface, borderBottom: `1px solid ${theme.border}`, flexShrink: 0 },
  handledLabel: { fontSize: 10, fontWeight: 700, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.04em' },
  staffChip: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: theme.ink, background: theme.bg, border: `1px solid ${theme.border}`, padding: '3px 9px', borderRadius: 20 },
  staffRole: { fontSize: 10, color: theme.inkFaint, textTransform: 'capitalize' },
  staffCount: { fontSize: 10, fontWeight: 700, color: theme.inkSoft, background: theme.borderSoft, borderRadius: 10, padding: '0 5px' },

  tabBar: { display: 'flex', gap: 4, padding: '8px 20px 0', background: theme.surface, borderBottom: `1px solid ${theme.border}`, flexShrink: 0, overflowX: 'auto' },
  tab: { display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', borderBottom: '2px solid transparent', color: theme.inkSoft, fontSize: 13, fontWeight: 600, padding: '8px 12px', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  tabOn: { color: theme.accentInk, borderBottomColor: theme.accentInk },
  tabCount: { fontSize: 10, fontWeight: 700, background: theme.borderSoft, color: theme.inkSoft, borderRadius: 10, padding: '1px 6px' },
  tabCountOn: { background: theme.accentInk, color: '#fff' },

  body: { flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 },
  sectionLabel: { margin: '12px 0 2px', fontSize: 10, fontWeight: 700, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.04em' },

  card: { display: 'block', background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 10, padding: '10px 14px', textDecoration: 'none', color: 'inherit' },
  cardOpen: { borderLeft: `3px solid ${theme.info}` },
  cardTop: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  cardTitle: { fontSize: 13, fontWeight: 700, color: theme.ink },
  cardAmount: { fontSize: 14, fontWeight: 700, color: theme.ink },
  rowIconBtn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, marginLeft: 8,
    borderRadius: 6, border: `1px solid ${theme.border}`, background: theme.surface, color: theme.inkSoft, cursor: 'pointer',
  },
  cardMeta: { margin: '4px 0 0', fontSize: 12, color: theme.inkSoft },
  cardWarn: { margin: '4px 0 0', fontSize: 11, fontWeight: 600, color: theme.high, display: 'flex', alignItems: 'center', gap: 4 },

  pill: { fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 20, textTransform: 'capitalize' },
  openTag: { fontSize: 10, fontWeight: 700, color: theme.info, letterSpacing: '0.04em' },
  closedTag: { fontSize: 11, color: theme.inkFaint },
  orderLink: { fontSize: 12, fontWeight: 700, color: theme.accentInk, textDecoration: 'none' },

  empty: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '48px 20px' },
  emptyText: { margin: 0, fontSize: 13, color: theme.inkFaint, textAlign: 'center', maxWidth: 420 },

  chat: { display: 'flex', flexDirection: 'column', gap: 6 },
};
