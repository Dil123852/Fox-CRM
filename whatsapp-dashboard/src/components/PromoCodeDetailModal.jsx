import { useEffect, useState } from 'react';
import { X, Tag, Link2 } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { theme, modalBackdrop } from '../lib/theme';
import { promoDiscountLabel, unscopedAppliesLabel } from '../lib/promoFormat';
import { vh } from '../lib/viewport';

// readOnly (the sales-agent view, PromoCodesView.jsx): no Link-order action —
// that route is admin/finance only — and no influencer, whose commission terms
// are not a sales agent's business.
export default function PromoCodeDetailModal({ code, influencer, readOnly = false, onClose, onToast }) {
  const [redemptions, setRedemptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [linkingId, setLinkingId] = useState(null);

  async function load() {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/promo-codes/${code.id}/redemptions`);
      const data = await res.json();
      setRedemptions(data.redemptions || []);
    } catch (e) { console.error(e); }
    setLoading(false);
  }

  useEffect(() => { load(); }, [code.id]);

  async function linkOrder(redemptionId, orderId) {
    try {
      const res = await apiFetch(`/api/promo-codes/redemptions/${redemptionId}`, {
        method: 'PATCH',
        body: JSON.stringify({ orderId }),
      });
      const data = await res.json();
      if (data.success) {
        onToast?.({ message: '🔗 Redemption linked to order', type: 'on' });
        load();
      } else {
        onToast?.({ message: data.error || 'Failed to link order', type: 'off' });
      }
    } catch (e) {
      onToast?.({ message: 'Network error: ' + e.message, type: 'off' });
    }
    setLinkingId(null);
  }

  const discountLabel = promoDiscountLabel(code);

  return (
    <div style={s.backdrop} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={s.modal}>
        <div style={s.header}>
          <div style={s.headerLeft}>
            <div style={s.icon}><Tag size={16} color={theme.accentInk} /></div>
            <div>
              <p style={s.title}>{code.code}</p>
              <p style={s.subtitle}>{discountLabel} · {code.redemption_count ?? 0}{code.max_redemptions ? ` / ${code.max_redemptions}` : ''} redeemed</p>
            </div>
          </div>
          <button style={s.closeBtn} onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        <div style={s.body}>
          <div style={s.summaryRow}>
            <SummaryStat label="Expires" value={code.expires_at ? new Date(code.expires_at).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Never'} />
            {!readOnly && <SummaryStat label="Influencer" value={influencer?.name || '—'} />}
            <SummaryStat label="Status" value={code.active ? 'Active' : 'Inactive'} highlight={code.active} />
            <SummaryStat label="Applies to" value={code.eligible_product_names?.length > 0 ? code.eligible_product_names.join(', ') : unscopedAppliesLabel(code)} />
          </div>

          <p style={s.sectionTitle}>Redemptions</p>

          {loading ? (
            <p style={{ color: theme.inkFaint, fontSize: 13 }}>Loading...</p>
          ) : redemptions.length === 0 ? (
            <p style={{ color: theme.inkFaint, fontSize: 13 }}>No one has redeemed this code yet.</p>
          ) : (
            <div style={s.tableWrap}>
              <table style={s.table}>
                <thead>
                  <tr>{['Customer', 'Phone', 'Discount', 'Redeemed', 'Order'].map(h => <th key={h} style={{ ...s.th, ...(h === 'Order' ? { minWidth: 200 } : {}) }}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {redemptions.map(r => (
                    <tr key={r.id}>
                      <td style={s.td}>{r.customer_name || <span style={{ color: theme.inkFaint }}>Not on file</span>}</td>
                      <td style={{ ...s.td, fontFamily: theme.mono }}>{r.redeemed_phone}</td>
                      <td style={s.td}>LKR {Number(r.discount_applied).toLocaleString()}</td>
                      <td style={s.td}>{new Date(r.redeemed_at).toLocaleString('en', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                      <td style={s.td}>
                        {r.order_id ? (
                          <span style={s.linkedPill}>
                            <Link2 size={11} /> LKR {Number(r.order_total).toLocaleString()} ({r.order_status})
                          </span>
                        ) : readOnly ? (
                          <span style={{ color: theme.inkFaint }}>Not linked</span>
                        ) : linkingId === r.id ? (
                          <OrderPicker
                            phone={r.redeemed_phone}
                            onPick={orderId => linkOrder(r.id, orderId)}
                            onCancel={() => setLinkingId(null)}
                          />
                        ) : (
                          <button style={s.linkBtn} onClick={() => setLinkingId(r.id)}>Link order</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryStat({ label, value, highlight }) {
  return (
    <div>
      <p style={s.statLabel}>{label}</p>
      <p style={{ ...s.statValue, ...(highlight ? { color: theme.success } : {}) }}>{value}</p>
    </div>
  );
}

function OrderPicker({ phone, onPick, onCancel }) {
  const [orders, setOrders] = useState(null);

  useEffect(() => {
    apiFetch('/api/orders').then(res => res.json()).then(data => {
      const matches = (data.orders || []).filter(o => o.customers?.whatsapp_number === phone);
      setOrders(matches);
    }).catch(() => setOrders([]));
  }, [phone]);

  if (orders === null) return <span style={{ fontSize: 12, color: theme.inkFaint }}>Loading orders...</span>;
  if (orders.length === 0) return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: theme.inkFaint }}>
      No orders found for this phone
      <button style={s.cancelPickBtn} onClick={onCancel}>Cancel</button>
    </span>
  );

  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <select style={s.pickerSelect} defaultValue="" onChange={e => e.target.value && onPick(e.target.value)}>
        <option value="" disabled>Select order...</option>
        {orders.map(o => (
          <option key={o.id} value={o.id}>#{o.order_number} · LKR {Number(o.total_amount).toLocaleString()} · {o.status}</option>
        ))}
      </select>
      <button style={s.cancelPickBtn} onClick={onCancel}>Cancel</button>
    </span>
  );
}

const s = {
  backdrop: modalBackdrop,
  modal: { background: theme.surface, borderRadius: 16, width: '100%', maxWidth: 720, maxHeight: vh(90), display: 'flex', flexDirection: 'column', boxShadow: theme.shadowMd, overflow: 'hidden' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '16px 20px', borderBottom: `1px solid ${theme.border}`, flexShrink: 0 },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 12 },
  icon: { width: 34, height: 34, borderRadius: 9, background: theme.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  title: { fontSize: 16, fontWeight: 800, color: theme.ink, margin: 0, fontFamily: theme.mono },
  subtitle: { fontSize: 12, color: theme.inkFaint, margin: '2px 0 0' },
  closeBtn: { background: theme.borderSoft, border: 'none', cursor: 'pointer', width: 30, height: 30, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.inkSoft, flexShrink: 0 },

  body: { flex: 1, overflowY: 'auto', padding: 24 },
  summaryRow: { display: 'flex', gap: 24, marginBottom: 20, paddingBottom: 16, borderBottom: `1px solid ${theme.border}` },
  statLabel: { fontSize: 10.5, fontWeight: 600, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 3px' },
  statValue: { fontSize: 14, fontWeight: 700, color: theme.ink, margin: 0 },

  sectionTitle: { fontSize: 12, fontWeight: 700, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 10px' },

  tableWrap: { border: `1px solid ${theme.border}`, borderRadius: theme.radius, overflow: 'hidden' },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { textAlign: 'left', fontSize: 11, fontWeight: 600, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.05em', padding: '9px 14px', borderBottom: `1px solid ${theme.border}`, background: theme.bg },
  td: { padding: '10px 14px', borderBottom: `1px solid ${theme.borderSoft}`, fontSize: 13, color: theme.ink },

  linkedPill: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 600, color: theme.success, background: theme.successBg, borderRadius: 20, padding: '3px 10px' },
  linkBtn: { background: 'none', border: `1px solid ${theme.border}`, color: theme.accentInk, fontSize: 11.5, fontWeight: 600, padding: '4px 10px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit' },
  pickerSelect: { border: `1.5px solid ${theme.border}`, borderRadius: 7, padding: '4px 8px', fontSize: 12, fontFamily: 'inherit', background: theme.bg, color: theme.ink },
  cancelPickBtn: { background: 'none', border: 'none', color: theme.inkFaint, fontSize: 11.5, cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline' },
};
