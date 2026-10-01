import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Package, Search, X, Plus, ChevronRight, Store } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { theme, ORDER_STATUS, PAYMENT_STATUS } from '../lib/theme';
import { roleAllowed, seesAllAgents } from '../lib/roles';
import ShowroomOrderModal from './ShowroomOrderModal';
import OrderDetailModal from './OrderDetailModal';
import LogVisitModal from './LogVisitModal';
import DocumentPreviewModal from './DocumentPreviewModal';
import { useDialog } from './DialogProvider';
import { previewInvoicePDF } from '../lib/invoicePdf';
import StaffFilter from './StaffFilter';

const STATUS_OPTIONS = Object.keys(ORDER_STATUS);
// Matches POST /api/orders and POST /api/showroom-visits, both
// requireRole('admin', 'sales_agent') — hide the entry points for roles
// whose click would just 403.
const CAN_CREATE_ORDER = ['admin', 'sales_agent'];

export default function OrdersPage({ onToast }) {
  const { staff } = useAuth();
  const navigate = useNavigate();
  const [orders,    setOrders]    = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [selectedId,setSelectedId]= useState(null);
  const [saving,    setSaving]    = useState(false);
  const [search,    setSearch]    = useState('');
  const [statusTab, setStatusTab] = useState('all');
  const [showroomModalOpen, setShowroomModalOpen] = useState(false);
  const [logVisitOpen, setLogVisitOpen] = useState(false);
  const [invoice, setInvoice] = useState(null);
  // 'all' | a staff id | 'none' — who placed the order (058). Admins/viewers
  // only; the server gives a sales agent just their own orders.
  const [placedBy, setPlacedBy] = useState('all');
  const showPlacedBy = seesAllAgents(staff?.role);
  const dialog = useDialog();

  async function fetchOrders(agent = placedBy) {
    setLoading(true);
    try {
      const q = agent !== 'all' ? `?placedBy=${encodeURIComponent(agent)}` : '';
      const res = await apiFetch(`/api/orders${q}`);
      const data = await res.json();
      setOrders(data.orders || []);
    } catch (err) { console.error(err); }
    setLoading(false);
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchOrders(placedBy); }, [placedBy]);

  // Deep link from the Customer 360 page (/orders?open=<id>), so "see the
  // order behind this enquiry" lands on the order itself rather than on a list
  // the user then has to search. The parameter is cleared once consumed so a
  // refresh or a later close does not keep reopening the same order.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const open = searchParams.get('open');
    if (!open) return;
    setSelectedId(open);
    searchParams.delete('open');
    setSearchParams(searchParams, { replace: true });
  }, [searchParams, setSearchParams]);

  const selected = orders.find(o => o.id === selectedId);

  // A deep-linked order may not be in the loaded list (an admin's agent
  // filter is narrowing it), so fetch it on its own. The server answers 404
  // for an order this person may not see, which closes it again.
  useEffect(() => {
    if (!selectedId || loading || selected) return;
    let alive = true;
    apiFetch(`/api/orders/${encodeURIComponent(selectedId)}`)
      .then(res => (res.ok ? res.json() : null))
      .then(async data => {
        if (!alive) return;
        if (data?.order) {
          setOrders(prev => (prev.some(o => o.id === data.order.id) ? prev : [data.order, ...prev]));
        } else {
          setSelectedId(null);
          await dialog.alert({ title: 'Order not available', message: 'This order was not found, or it is not one of yours.' });
        }
      })
      .catch(err => console.error(err));
    return () => { alive = false; };
  }, [selectedId, loading, selected, dialog]);

  const filtered = orders.filter(o => {
    if (statusTab !== 'all' && o.status !== statusTab) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    const name  = (o.customer_name || o.customers?.name  || '').toLowerCase();
    const phone = (o.customer_phone|| o.customers?.whatsapp_number || '').toLowerCase();
    const num   = String(o.order_number || '');
    const addr  = (o.delivery_address || '').toLowerCase();
    return name.includes(q) || phone.includes(q) || num.includes(q) || addr.includes(q);
  });

  async function update(id, patch) {
    setSaving(true);
    const res = await apiFetch(`/api/orders/${id}`, {
      method: 'PATCH', body: JSON.stringify(patch),
    });
    const data = await res.json();
    setSaving(false);
    if (data.success) setOrders(prev => prev.map(o => o.id === id ? { ...o, ...data.order } : o));
    else await dialog.alert({ title: 'Could not update the order', message: data.error || 'Please try again.' });
  }

  async function del(id) {
    const order = orders.find(o => o.id === id);
    const ok = await dialog.confirm({
      title: order?.order_number ? `Delete order #${order.order_number}?` : 'Delete this order?',
      message: "The order is removed from the Orders list, and any promo code usage and warranties tied to it are undone.",
      confirmLabel: 'Delete order',
      tone: 'danger',
    });
    if (!ok) return;
    setSaving(true);
    const res = await apiFetch(`/api/orders/${id}`, { method: 'DELETE' });
    setSaving(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      await dialog.alert({ title: 'Could not delete the order', message: data.error || 'Please try again.' });
      return;
    }
    setOrders(prev => prev.filter(o => o.id !== id));
    if (selectedId === id) setSelectedId(null);
  }

  function handleShowroomOrderSaved(order, confirmation) {
    setOrders(prev => [order, ...prev]);
    setSelectedId(order.id);
    setStatusTab('all');
    // Say whether the customer's WhatsApp confirmation actually went out.
    // A failed send is called out explicitly (type 'off') rather than
    // swallowed — the order is placed either way, but staff need to know the
    // customer was never asked to verify it.
    const note = confirmation?.skipped ? ''
      : confirmation?.sent ? ' · confirmation sent'
      : ' · confirmation FAILED to send';
    onToast?.({
      message: `📦 Order #${order.order_number} placed${note}`,
      type: confirmation && !confirmation.skipped && !confirmation.sent ? 'off' : 'on',
    });
  }

  // The invoice needs more than the orders list carries: the customer's full
  // record, the advances recorded against the order, and the free-pillow
  // count computed server-side (GET /api/orders/:id/invoice), so that the
  // document and any reconciliation use the same figures.
  async function openInvoice(order) {
    try {
      const res = await apiFetch(`/api/orders/${order.id}/invoice`);
      const data = await res.json();
      if (!data.success) {
        await dialog.alert({ title: 'Could not prepare the invoice', message: data.error || 'Please try again.' });
        return;
      }
      setInvoice({ ...data, invoiceNo: order.order_number });
    } catch (err) {
      await dialog.alert({ title: 'Could not prepare the invoice', message: `Network error: ${err.message}` });
    }
  }

  return (
    <div style={s.page}>
      <div style={s.header}>
        <span style={s.title}>Orders</span>
        <span style={s.badge}>{filtered.length}{filtered.length !== orders.length ? `/${orders.length}` : ''}</span>
        <div style={s.searchWrap}>
          <Search size={14} color={theme.inkFaint} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
          {/* autoComplete off: otherwise the browser fills the phone number
              just typed into the order form into this box once it closes. */}
          <input
            style={s.searchInput}
            name="orders-filter"
            type="search"
            data-1p-ignore="true"
            data-lpignore="true"
            data-bwignore="true"
            autoComplete="off"
            spellCheck={false}
            placeholder="Name, phone, order #…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && <button style={s.clearBtn} onClick={() => setSearch('')}><X size={11} /></button>}
        </div>
        {/* Renders nothing for a sales agent — their list is already only theirs. */}
        <StaffFilter value={placedBy} onChange={setPlacedBy} label="Placed by" noneLabel="Unknown (placed before tracking)" />
        {roleAllowed(staff?.role, CAN_CREATE_ORDER) && (
          <>
            <button style={s.logVisitBtn} onClick={() => setLogVisitOpen(true)} title="Log a showroom visit">
              <Store size={14} strokeWidth={2.5} /> Log visit
            </button>
            <button style={s.newOrderBtn} onClick={() => setShowroomModalOpen(true)} title="Place a new showroom order (walk-in customer)">
              <Plus size={14} strokeWidth={2.5} />
              <span>New</span>
              <span className="btn-long-label">&nbsp;Showroom Order</span>
            </button>
          </>
        )}
      </div>

      <div style={s.statusTabs} className="scroll-strip">
        {['all', ...STATUS_OPTIONS].map(key => {
          const st = ORDER_STATUS[key];
          const active = statusTab === key;
          return (
            // Underline strip, as on every other tab row. The per-status tint
            // is kept on the ACTIVE label (st.color) rather than dropped, so a
            // selected "Cancelled" still reads differently from "Delivered".
            <button key={key} style={{
              ...s.statusTab,
              color:             active ? (st?.color || theme.accentInk) : theme.inkSoft,
              fontWeight:        active ? 600 : 400,
              borderBottomColor: active ? (st?.color || theme.accent) : 'transparent',
            }} onClick={() => setStatusTab(key)}>
              {key === 'all' ? 'All' : st?.label}
            </button>
          );
        })}
      </div>

      <div style={s.tableWrap}>
        {loading ? (
          <div style={s.center}>Loading orders…</div>
        ) : filtered.length === 0 ? (
          <div style={s.center}>
            <Package size={32} color={theme.border} strokeWidth={1.2} />
            <p style={{ color: theme.inkFaint, fontSize: 13, marginTop: 10 }}>
              {orders.length === 0 ? 'No orders yet' : 'No results'}
            </p>
            {orders.length === 0 && <p style={{ color: theme.inkFaint, fontSize: 12 }}>Create one from the Pipeline, or place a showroom order above</p>}
            {search && <button style={s.clearSearchBtn} onClick={() => { setSearch(''); setStatusTab('all'); }}>Clear filters</button>}
          </div>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>{['Order #', 'Customer', ...(showPlacedBy ? ['Placed by'] : []), 'Items', 'Total', 'Status', 'Payment', 'Date', ''].map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {filtered.map(o => {
                const st = ORDER_STATUS[o.status];
                const pt = PAYMENT_STATUS[o.payment_status];
                const itemCount = (o.items || []).filter(i => i.product || i.name).length;
                return (
                  <tr key={o.id} className="orders-row" style={s.row} onClick={() => staff?.role === 'delivery_coordinator' ? navigate(`/orders/${o.id}/delivery`) : setSelectedId(o.id)}>
                    <td style={{ ...s.td, fontFamily: theme.mono, fontWeight: 700, color: theme.inkSoft }}>#{o.order_number}</td>
                    <td style={s.td}>
                      <div style={s.custName}>{o.customer_name || o.customers?.name || 'Unknown'}</div>
                      <div style={s.custPhone}>{o.customer_phone || o.customers?.whatsapp_number || '—'}</div>
                    </td>
                    {showPlacedBy && (
                      <td style={s.td}>
                        {o.placed_by_name
                          ? <div style={s.custName}>{o.placed_by_name}</div>
                          : <div style={s.custPhone}>Unknown</div>}
                        {/* Orders before 058 record no placer; the lead's
                            agent is the best available answer. */}
                        {!o.placed_by_name && o.lead_staff_name && <div style={s.custPhone}>lead: {o.lead_staff_name}</div>}
                      </td>
                    )}
                    <td style={s.td}>{itemCount} item{itemCount === 1 ? '' : 's'}</td>
                    <td style={{ ...s.td, fontWeight: 700, color: theme.success }}>{o.currency} {(o.total_amount || 0).toLocaleString('en', { minimumFractionDigits: 2 })}</td>
                    <td style={s.td}><Pill label={st?.label || o.status} color={st?.color} bg={st?.bg} /></td>
                    <td style={s.td}><Pill label={pt?.label || o.payment_status} color={pt?.color} bg={theme.borderSoft} /></td>
                    <td style={{ ...s.td, color: theme.inkFaint }}>{new Date(o.created_at).toLocaleDateString('en', { day: 'numeric', month: 'short' })}</td>
                    <td style={{ ...s.td, width: 20 }}><ChevronRight size={15} color={theme.inkFaint} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {selected && (
        <OrderDetailModal
          order={selected}
          role={staff?.role}
          saving={saving}
          onClose={() => setSelectedId(null)}
          onSave={update}
          onDelete={del}
          onInvoice={openInvoice}
        />
      )}

      {invoice && (
        <DocumentPreviewModal
          payload={invoice}
          render={previewInvoicePDF}
          title={`Invoice ${invoice.invoiceNo || ''}`.trim()}
          onClose={() => setInvoice(null)}
        />
      )}

      {showroomModalOpen && (
        <ShowroomOrderModal
          onClose={() => setShowroomModalOpen(false)}
          onSaved={handleShowroomOrderSaved}
        />
      )}

      {logVisitOpen && (
        <LogVisitModal
          onClose={() => setLogVisitOpen(false)}
          onSaved={() => onToast?.({ message: '🏬 Showroom visit logged', type: 'on' })}
        />
      )}
    </div>
  );
}

function Pill({ label, color, bg }) {
  return <span style={{ display: 'inline-flex', fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 20, color: color || theme.inkSoft, background: bg || theme.borderSoft }}>{label}</span>;
}

const s = {
  page: { display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', background: theme.bg },
  header: { display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', height: 44, boxSizing: 'border-box', borderBottom: `1px solid ${theme.border}`, background: theme.surface, flexShrink: 0 },
  title: { fontSize: 14.5, fontWeight: 600, color: theme.ink, letterSpacing: '-0.01em', whiteSpace: 'nowrap' },
  badge: { color: theme.inkFaint, fontSize: 11, fontWeight: 500 },
  searchWrap: { position: 'relative', marginLeft: 'auto', width: 178 },
  searchInput: { width: '100%', height: 26, background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 7, padding: '0 26px 0 27px', color: theme.ink, fontSize: 11, outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' },
  clearBtn: { position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: theme.borderSoft, border: 'none', borderRadius: 4, width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: theme.inkSoft },
  newOrderBtn: { display: 'flex', alignItems: 'center', gap: 5, height: 26, background: theme.accent, border: `1px solid ${theme.accent}`, color: '#fff', fontSize: 10.5, fontWeight: 500, padding: '0 10px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', boxShadow: '0 1px 2px rgba(13,148,136,0.35)' },
  logVisitBtn: { display: 'flex', alignItems: 'center', gap: 5, background: theme.surface, border: `1.5px solid ${theme.border}`, color: theme.inkSoft, fontSize: 13, fontWeight: 600, padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },

  statusTabs: { display: 'flex', gap: 18, padding: '0 16px', borderBottom: `1px solid ${theme.border}`, background: theme.surface, flexShrink: 0, overflowX: 'auto' },
  statusTab: { fontSize: 11.5, fontWeight: 400, padding: '9px 0 8px', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', border: 'none', background: 'none', borderBottom: '1.5px solid transparent', marginBottom: -1, transition: 'color 0.12s' },

  tableWrap: { flex: 1, overflow: 'auto', padding: '18px 28px' },
  center: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 24px', gap: 4, color: theme.inkFaint, fontSize: 13 },
  clearSearchBtn: { marginTop: 10, background: 'none', border: `1px solid ${theme.border}`, color: theme.inkSoft, fontSize: 11, padding: '5px 12px', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit' },

  // `overflow: 'hidden'` removed: on the TABLE it clipped nothing useful and
  // broke the sticky header below, which needs the scrolling ancestor
  // (tableWrap) to be the one that clips. fontSize matches the Pipeline.
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 10.5, background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: theme.radiusLg },
  th: { textAlign: 'left', fontSize: 8.5, fontWeight: 500, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.06em', padding: '6px 8px', borderBottom: `1px solid ${theme.border}`, background: theme.surface, position: 'sticky', top: 0, zIndex: 1, whiteSpace: 'nowrap' },
  row: { cursor: 'pointer' },
  td: { padding: '8px 8px', borderBottom: `1px solid ${theme.borderSoft}`, fontSize: 10.5, color: theme.inkSoft, verticalAlign: 'middle' },
  custName: { fontWeight: 600 },
  custPhone: { fontSize: 11.5, color: theme.inkFaint, fontFamily: theme.mono, marginTop: 1 },
};
