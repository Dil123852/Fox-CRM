import { useEffect, useState } from 'react';
import { X, Users, Link2 } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { theme, modalBackdrop } from '../lib/theme';
import { vh } from '../lib/viewport';

export default function InfluencerDetailModal({ influencer, payout, onClose }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    apiFetch(`/api/influencers/${influencer.id}/orders`)
      .then(r => r.json())
      .then(d => setOrders(d.orders || []))
      .catch(() => setOrders([]))
      .finally(() => setLoading(false));
  }, [influencer.id]);

  const linkedOrders = orders.filter(o => o.order_id);
  const unlinkedRedemptions = orders.filter(o => !o.order_id);

  return (
    <div style={s.backdrop} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={s.modal}>
        <div style={s.header}>
          <div style={s.headerLeft}>
            <div style={s.icon}><Users size={16} color={theme.accentInk} /></div>
            <div>
              <p style={s.title}>{influencer.name}</p>
              <p style={s.subtitle}>{influencer.handle || 'No handle'} · {influencer.commission_percent}% commission</p>
            </div>
          </div>
          <button style={s.closeBtn} onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        <div style={s.body}>
          <div style={s.summaryRow}>
            <SummaryStat label="Total redemptions" value={payout?.total_redemptions ?? '—'} />
            <SummaryStat label="Linked to an order" value={payout?.linked_redemptions ?? '—'} />
            <SummaryStat label="Revenue attributed" value={payout ? `LKR ${Number(payout.linked_revenue).toLocaleString()}` : '—'} />
            <SummaryStat label="Commission owed" value={payout ? `LKR ${Number(payout.commission_owed).toLocaleString()}` : '—'} highlight />
          </div>

          <p style={s.sectionTitle}>Orders placed with their codes</p>
          {loading ? (
            <p style={{ color: theme.inkFaint, fontSize: 13 }}>Loading...</p>
          ) : linkedOrders.length === 0 ? (
            <p style={{ color: theme.inkFaint, fontSize: 13 }}>No redemptions have been linked to an order yet.</p>
          ) : (
            <div style={s.tableWrap}>
              <table style={s.table}>
                <thead>
                  <tr>{['Order', 'Code', 'Customer', 'Order Total', 'Commission', 'Status', 'Date'].map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {linkedOrders.map(o => (
                    <tr key={o.redemption_id}>
                      <td style={{ ...s.td, fontFamily: theme.mono, fontWeight: 700 }}>#{o.order_number}</td>
                      <td style={{ ...s.td, fontFamily: theme.mono }}>{o.promo_code}</td>
                      <td style={s.td}>{o.customer_name || <span style={{ color: theme.inkFaint }}>Not on file</span>}</td>
                      <td style={s.td}>LKR {Number(o.order_total).toLocaleString()}</td>
                      <td style={{ ...s.td, color: theme.success, fontWeight: 700 }}>LKR {Number(o.commission).toLocaleString()}</td>
                      <td style={s.td}>{o.order_status}</td>
                      <td style={s.td}>{new Date(o.order_created_at).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td style={s.footTd} colSpan={4}>Total commission owed</td>
                    <td style={{ ...s.footTd, color: theme.success, fontWeight: 800 }}>
                      LKR {linkedOrders.reduce((sum, o) => sum + Number(o.commission), 0).toLocaleString()}
                    </td>
                    <td style={s.footTd} colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {unlinkedRedemptions.length > 0 && (
            <>
              <p style={{ ...s.sectionTitle, marginTop: 20 }}>
                Redeemed but not yet linked to an order ({unlinkedRedemptions.length})
              </p>
              <div style={s.tableWrap}>
                <table style={s.table}>
                  <thead>
                    <tr>{['Code', 'Phone', 'Discount', 'Redeemed'].map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {unlinkedRedemptions.map(o => (
                      <tr key={o.redemption_id}>
                        <td style={{ ...s.td, fontFamily: theme.mono }}>{o.promo_code}</td>
                        <td style={{ ...s.td, fontFamily: theme.mono }}>{o.redeemed_phone}</td>
                        <td style={s.td}>LKR {Number(o.discount_applied).toLocaleString()}</td>
                        <td style={s.td}>{new Date(o.redeemed_at).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p style={s.hint}>
                <Link2 size={11} style={{ display: 'inline', verticalAlign: -1 }} /> Link a redemption to an order from the promo code&apos;s own detail view to count it toward commission.
              </p>
            </>
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

const s = {
  backdrop: modalBackdrop,
  modal: { background: theme.surface, borderRadius: 16, width: '100%', maxWidth: 820, maxHeight: vh(90), display: 'flex', flexDirection: 'column', boxShadow: theme.shadowMd, overflow: 'hidden' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '16px 20px', borderBottom: `1px solid ${theme.border}`, flexShrink: 0 },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 12 },
  icon: { width: 34, height: 34, borderRadius: 9, background: theme.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  title: { fontSize: 16, fontWeight: 800, color: theme.ink, margin: 0 },
  subtitle: { fontSize: 12, color: theme.inkFaint, margin: '2px 0 0' },
  closeBtn: { background: theme.borderSoft, border: 'none', cursor: 'pointer', width: 30, height: 30, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.inkSoft, flexShrink: 0 },

  body: { flex: 1, overflowY: 'auto', padding: 24 },
  summaryRow: { display: 'flex', gap: 24, marginBottom: 20, paddingBottom: 16, borderBottom: `1px solid ${theme.border}`, flexWrap: 'wrap' },
  statLabel: { fontSize: 10.5, fontWeight: 600, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 3px' },
  statValue: { fontSize: 14, fontWeight: 700, color: theme.ink, margin: 0 },

  sectionTitle: { fontSize: 12, fontWeight: 700, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 10px' },

  tableWrap: { border: `1px solid ${theme.border}`, borderRadius: theme.radius, overflow: 'hidden', overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { textAlign: 'left', fontSize: 11, fontWeight: 600, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.05em', padding: '9px 14px', borderBottom: `1px solid ${theme.border}`, background: theme.bg, whiteSpace: 'nowrap' },
  td: { padding: '10px 14px', borderBottom: `1px solid ${theme.borderSoft}`, fontSize: 13, color: theme.ink, whiteSpace: 'nowrap' },
  footTd: { padding: '10px 14px', fontSize: 12.5, fontWeight: 700, color: theme.inkSoft, background: theme.bg },

  hint: { fontSize: 11.5, color: theme.inkFaint, margin: '8px 0 0', lineHeight: 1.5 },
};
