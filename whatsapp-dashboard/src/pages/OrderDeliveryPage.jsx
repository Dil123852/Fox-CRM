import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Truck, CheckCircle, Banknote } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { theme, ORDER_STATUS, PAYMENT_STATUS, modalBackdrop } from '../lib/theme';
import { isCOD, labelFor } from '../lib/deliveryMethod';
import { useErrorPopup } from '../components/DialogProvider';

const STATUS_OPTIONS = Object.keys(ORDER_STATUS);

// A dedicated, read-mostly order page for delivery_coordinator — confirmed
// with the user this replaces the shared OrderDetailModal for this role
// specifically (every other role keeps that modal unchanged). Deliberately
// narrower than the modal: no Payment section at all, order items shown
// read-only with full detail, no delete action, and only status +
// delivery date + delivery address are editable — mirrors the backend's
// own tightened PATCH /api/orders/:id role split exactly, so this page
// never offers an edit the backend would 403 on.
export default function OrderDeliveryPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  useErrorPopup(error, 'Something went wrong with this order');
  const [deliveryDate, setDeliveryDate] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [deliverConfirm, setDeliverConfirm] = useState(false);
  const [deliverNote, setDeliverNote] = useState('');

  async function fetchOrder() {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/orders/${id}`);
      const data = await res.json();
      if (data.order) {
        setOrder(data.order);
        setDeliveryDate(data.order.delivery_date ? data.order.delivery_date.slice(0, 10) : '');
        setDeliveryAddress(data.order.delivery_address || '');
      } else {
        setError(data.error || 'Order not found');
      }
    } catch (e) { setError('Network error: ' + e.message); }
    setLoading(false);
  }

  useEffect(() => { fetchOrder(); }, [id]);

  async function patch(body) {
    setSaving(true); setError(null);
    try {
      const res = await apiFetch(`/api/orders/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      const data = await res.json();
      if (data.success) setOrder(data.order);
      else setError(data.error || 'Update failed');
    } catch (e) { setError('Network error: ' + e.message); }
    setSaving(false);
  }

  function handleStatusSelect(newStatus) {
    if (newStatus === 'delivered') { setDeliverNote(''); setDeliverConfirm(true); }
    else patch({ status: newStatus });
  }

  function confirmDelivery() {
    if (!deliverNote.trim()) return;
    patch({ status: 'delivered', delivery_confirmation_note: deliverNote.trim() });
    setDeliverConfirm(false);
  }

  function saveDeliveryDetails() {
    patch({
      delivery_date: deliveryDate || null,
      delivery_address: deliveryAddress.trim() || null,
    });
  }

  if (loading) return (
    <div style={s.center}><p style={{ color: theme.inkFaint, fontSize: 13 }}>Loading...</p></div>
  );
  if (!order) return (
    <div style={s.center}><p style={{ color: theme.inkFaint, fontSize: 13 }}>{"Couldn't load this order."}</p></div>
  );

  const detailsChanged = deliveryDate !== (order.delivery_date ? order.delivery_date.slice(0, 10) : '')
    || deliveryAddress.trim() !== (order.delivery_address || '');
  const cod = isCOD(order.delivery_method);

  return (
    <div style={s.page}>
      <div style={s.header}>
        <button style={s.backBtn} onClick={() => navigate('/orders')}><ArrowLeft size={16} /> Back to Orders</button>
        <div style={s.headerMain}>
          <div style={s.headerIcon}><Truck size={18} color={theme.accentInk} /></div>
          <div>
            <p style={s.headerOrderNum}>Order #{order.order_number}</p>
            <p style={s.headerDate}>{new Date(order.created_at).toLocaleString('en', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
          </div>
        </div>
      </div>

      <div style={s.body}>

        <div style={s.controlRow}>
          <ControlBlock label="Order Status">
            <select
              style={{ ...s.select, color: ORDER_STATUS[order.status]?.color || theme.inkSoft, background: ORDER_STATUS[order.status]?.bg || theme.bg }}
              value={order.status} onChange={e => handleStatusSelect(e.target.value)} disabled={saving}
            >
              {STATUS_OPTIONS.map(o => <option key={o} value={o}>{ORDER_STATUS[o].label}</option>)}
            </select>
          </ControlBlock>
          <ControlBlock label="Payment">
            <span style={{ ...s.paymentPill, color: PAYMENT_STATUS[order.payment_status]?.color || theme.inkSoft, background: theme.borderSoft }}>
              {PAYMENT_STATUS[order.payment_status]?.label || order.payment_status || 'Pending'}
            </span>
          </ControlBlock>
          <ControlBlock label="Total">
            <p style={s.totalAmt}>{order.currency} {(order.total_amount || 0).toLocaleString('en', { minimumFractionDigits: 2 })}</p>
          </ControlBlock>
        </div>

        <div style={s.topGrid}>
          <Card title="Customer">
            <InfoRow label="Name" value={order.customer_name || order.customers?.name || '—'} />
            <InfoRow label="Phone" value={order.customer_phone || order.customers?.whatsapp_number || '—'} />
          </Card>

          <Card title={cod ? 'Delivery & Payment' : 'Delivery'}>
            {/* Cash on Delivery is stated up front here — this is the person
                who actually collects the money, so the amount to collect is
                the first thing in the card, not buried in a payment field
                this role can't even see. */}
            {cod && (
              <div style={s.codBox}>
                <div style={s.codHead}>
                  <Banknote size={15} color={theme.success} />
                  <span>Cash on Delivery</span>
                </div>
                <p style={s.codAmount}>
                  {order.payment_status === 'paid' ? 'Collected' : 'Collect'} {order.currency} {(order.total_amount || 0).toLocaleString('en', { minimumFractionDigits: 2 })}
                </p>
                <p style={s.codNote}>
                  {order.payment_status === 'paid'
                    ? 'Payment received in cash on handover.'
                    : 'Collect this amount in cash from the customer at handover, then mark the order Delivered — that records the payment as received.'}
                </p>
              </div>
            )}
            <div style={s.row2}>
              <Field label="Delivery date">
                <input style={s.input} type="date" value={deliveryDate} onChange={e => setDeliveryDate(e.target.value)} disabled={saving} />
              </Field>
              <Field label="Delivery address">
                <input style={s.input} value={deliveryAddress} onChange={e => setDeliveryAddress(e.target.value)} placeholder="Delivery address" disabled={saving} />
              </Field>
            </div>
            {detailsChanged && (
              <button style={s.saveBtn} onClick={saveDeliveryDetails} disabled={saving}>
                {saving ? 'Saving...' : 'Save delivery details'}
              </button>
            )}
            <InfoRow label="Method" value={labelFor(order.delivery_method)} />
            {order.delivery_confirmation_note && (
              <div style={s.confirmedNote}>
                <CheckCircle size={13} color={theme.success} />
                <span>{order.delivery_confirmation_note}</span>
              </div>
            )}
          </Card>
        </div>

        <Card title="Order Items">
          {(order.items || []).length === 0 ? (
            <p style={{ color: theme.inkFaint, fontSize: 13 }}>No items recorded</p>
          ) : (
            <table style={s.itemsTable}>
              <thead>
                <tr>{['Product', 'Bed Size', 'Scale', 'Qty', 'Unit Price', 'Subtotal'].map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {order.items.map((it, i) => {
                  const label = it.product ? it.product.replace(' Mattress', '') : (it.name || '—');
                  const sub = (parseFloat(it.unit_price) || 0) * (parseInt(it.qty) || 1);
                  return (
                    <tr key={i}>
                      <td style={s.td}>{label}</td>
                      <td style={{ ...s.td, textAlign: 'center' }}>{it.bed_size || '—'}</td>
                      <td style={{ ...s.td, textAlign: 'center' }}>{it.scale ? `${it.scale}"` : '—'}</td>
                      <td style={{ ...s.td, textAlign: 'center' }}>{it.qty || 1}</td>
                      <td style={{ ...s.td, textAlign: 'right' }}>{(parseFloat(it.unit_price) || 0).toLocaleString('en', { minimumFractionDigits: 2 })}</td>
                      <td style={{ ...s.td, textAlign: 'right', color: theme.success, fontWeight: 700 }}>{sub.toLocaleString('en', { minimumFractionDigits: 2 })}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {order.special_requirements && (
            <div style={s.specialReq}>
              <p style={s.specialReqLabel}>Special requirements</p>
              <p style={s.specialReqText}>{order.special_requirements}</p>
            </div>
          )}
        </Card>
      </div>

      {deliverConfirm && (
        <div style={s.backdrop} onClick={e => e.target === e.currentTarget && setDeliverConfirm(false)}>
          <div style={s.confirmModal}>
            <p style={s.modalTitle}>Confirm delivery — #{order.order_number}</p>
            <p style={s.modalSub}>Marking an order delivered requires a confirmation note (enforced by the database).</p>
            <label style={s.modalLabel}>Delivery confirmation note</label>
            <textarea
              style={s.modalTextarea}
              value={deliverNote}
              onChange={e => setDeliverNote(e.target.value)}
              placeholder="e.g. Delivered to customer at the address, signed for by receptionist"
              autoFocus
            />
            <div style={s.modalActions}>
              <button style={s.cancelBtn} onClick={() => setDeliverConfirm(false)} disabled={saving}>Cancel</button>
              <button style={{ ...s.confirmBtn, opacity: deliverNote.trim() ? 1 : 0.5 }} onClick={confirmDelivery} disabled={saving || !deliverNote.trim()}>
                {saving ? 'Saving...' : 'Confirm delivery'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ControlBlock({ label, children }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
    <span style={s.blockLabel}>{label}</span>
    {children}
  </div>;
}
function Card({ title, children }) {
  return <div style={s.card}>
    <p style={s.cardTitle}>{title}</p>
    {children}
  </div>;
}
function Field({ label, children }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
    <label style={s.fieldLabel}>{label}</label>
    {children}
  </div>;
}
function InfoRow({ label, value }) {
  return <div style={s.infoRow}>
    <span style={{ fontSize: 13, color: theme.inkFaint }}>{label}</span>
    <span style={{ fontSize: 13, color: theme.ink, fontWeight: 500 }}>{value}</span>
  </div>;
}

const s = {
  page: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: theme.bg },
  center: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' },

  header: { background: theme.surface, borderBottom: `1px solid ${theme.border}`, padding: '16px 32px', flexShrink: 0 },
  backBtn: { display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: theme.inkSoft, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', padding: 0, marginBottom: 12 },
  headerMain: { display: 'flex', alignItems: 'center', gap: 12 },
  headerIcon: { width: 38, height: 38, borderRadius: 10, background: theme.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  headerOrderNum: { fontSize: 17, fontWeight: 700, color: theme.ink, margin: 0 },
  headerDate: { fontSize: 12, color: theme.inkFaint, margin: '2px 0 0' },

  body: { flex: 1, overflowY: 'auto', padding: '24px 32px', width: '100%', boxSizing: 'border-box' },
  errorText: { color: theme.high, fontSize: 13, marginBottom: 12 },
  topGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 14 },

  controlRow: { display: 'flex', gap: 24, marginBottom: 18, alignItems: 'flex-end' },
  blockLabel: { fontSize: 10, fontWeight: 700, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.05em' },
  select: { border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer', outline: 'none', fontFamily: 'inherit' },
  codBox: { marginBottom: 14, padding: '12px 14px', borderRadius: 10, background: theme.successBg, border: `1.5px solid ${theme.success}` },
  codHead: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 800, letterSpacing: 0.4, textTransform: 'uppercase', color: theme.success },
  codAmount: { margin: '6px 0 0', fontSize: 22, fontWeight: 800, color: theme.ink },
  codNote: { margin: '4px 0 0', fontSize: 12, lineHeight: 1.5, color: theme.inkSoft },
  paymentPill: { display: 'inline-flex', alignItems: 'center', borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 700, border: `1.5px solid ${theme.border}` },
  totalAmt: { fontSize: 20, fontWeight: 800, color: theme.success, margin: 0 },

  card: { background: theme.surface, borderRadius: theme.radius, padding: '16px 18px', marginBottom: 14, border: `1px solid ${theme.border}` },
  cardTitle: { fontSize: 11, fontWeight: 700, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12, marginTop: 0 },
  infoRow: { display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: `1px solid ${theme.borderSoft}` },

  itemsTable: { width: '100%', borderCollapse: 'collapse' },
  th: { textAlign: 'left', fontSize: 8.5, fontWeight: 500, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.06em', padding: '6px 8px', borderBottom: `1px solid ${theme.border}`, background: theme.surface, position: 'sticky', top: 0, zIndex: 1, whiteSpace: 'nowrap' },
  td: { padding: '8px 8px', borderBottom: `1px solid ${theme.borderSoft}`, fontSize: 10.5, color: theme.inkSoft, verticalAlign: 'middle' },
  specialReq: { marginTop: 12, background: theme.bg, borderRadius: 8, padding: '10px 12px' },
  specialReqLabel: { fontSize: 10, fontWeight: 700, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 4px' },
  specialReqText: { fontSize: 13, color: theme.inkSoft, margin: 0, lineHeight: 1.5 },

  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  fieldLabel: { fontSize: 11, fontWeight: 600, color: theme.inkFaint },
  input: { background: theme.bg, border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '8px 10px', color: theme.ink, fontSize: 13, width: '100%', fontFamily: 'inherit', boxSizing: 'border-box' },
  saveBtn: { marginTop: 14, background: theme.accent, border: 'none', color: '#fff', fontSize: 12.5, fontWeight: 700, padding: '8px 18px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
  confirmedNote: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 14, background: theme.successBg, borderRadius: 8, padding: '8px 12px', fontSize: 12.5, color: theme.success, fontWeight: 600 },

  backdrop: modalBackdrop,
  confirmModal: { background: theme.surface, borderRadius: 16, width: '100%', maxWidth: 440, boxShadow: theme.shadowMd, padding: 20 },
  modalTitle: { fontSize: 14.5, fontWeight: 700, color: theme.ink, margin: 0 },
  modalSub: { fontSize: 12.5, color: theme.inkSoft, margin: '4px 0 12px', lineHeight: 1.5 },
  modalLabel: { fontSize: 11, fontWeight: 700, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 },
  modalTextarea: { width: '100%', border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', minHeight: 70, resize: 'vertical', background: theme.bg, color: theme.ink, boxSizing: 'border-box' },
  modalActions: { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 },
  cancelBtn: { background: theme.bg, border: `1px solid ${theme.border}`, color: theme.inkSoft, fontSize: 12.5, fontWeight: 600, padding: '7px 14px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
  confirmBtn: { background: theme.accent, border: 'none', color: '#fff', fontSize: 12.5, fontWeight: 700, padding: '7px 16px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
};
