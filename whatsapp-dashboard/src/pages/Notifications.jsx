import { useNavigate } from 'react-router-dom';
import { BadgePercent, Bell, CheckCheck } from 'lucide-react';
import { theme } from '../lib/theme';
import { useNotifications } from '../lib/notifications';
import PageHeader from '../components/PageHeader';

// The stored list of the signed-in staff member's notifications (migration
// 053). Today these are custom discounts given by non-admins, so the page is
// linked for admins only — but the API only ever returns the caller's own, so
// nothing here depends on the role.
function formatWhen(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const KIND_ICON = { custom_discount: BadgePercent };

export default function Notifications() {
  const { items, unread, loading, markRead, markAllRead } = useNotifications(true);
  const navigate = useNavigate();

  function open(n) {
    if (!n.read_at) markRead(n.id);
    if (n.order_id) navigate(`/orders?open=${n.order_id}`);
    else if (n.quotation_id) navigate(`/quotations?open=${n.quotation_id}`);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <PageHeader title="Notifications" count={unread > 0 ? `${unread} unread` : undefined}>
        {unread > 0 && (
          <button style={s.markAll} onClick={markAllRead}>
            <CheckCheck size={13} /> Mark all read
          </button>
        )}
      </PageHeader>

      <div style={s.body}>
        {loading ? (
          <p style={s.empty}>Loading…</p>
        ) : items.length === 0 ? (
          <div style={s.emptyBox}>
            <Bell size={22} color={theme.inkFaint} />
            <p style={s.empty}>No notifications yet. You will be told here when a sales agent gives a custom discount.</p>
          </div>
        ) : (
          <ul style={s.list}>
            {items.map(n => {
              const Icon = KIND_ICON[n.kind] || Bell;
              const isUnread = !n.read_at;
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    style={{ ...s.row, ...(isUnread ? s.rowUnread : {}) }}
                    onClick={() => open(n)}
                    title={n.order_id ? 'Open the order' : n.quotation_id ? 'Open the quotation' : undefined}
                  >
                    <span style={{ ...s.icon, ...(isUnread ? s.iconUnread : {}) }}>
                      <Icon size={15} />
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ ...s.title, fontWeight: isUnread ? 650 : 500 }}>{n.title}</span>
                      {n.body && <span style={s.text}>{n.body}</span>}
                      <span style={s.when}>
                        {formatWhen(n.created_at)}
                        {n.order_id && !n.order_number && ' · order deleted'}
                        {n.quotation_id && !n.quotation_no && ' · quotation removed'}
                      </span>
                    </span>
                    {isUnread && <span style={s.dot} aria-label="Unread" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

const s = {
  body: { flex: 1, overflowY: 'auto', padding: 16 },
  list: { listStyle: 'none', margin: '0 auto', padding: 0, maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 8 },
  row: {
    width: '100%', display: 'flex', alignItems: 'flex-start', gap: 12, textAlign: 'left',
    background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: theme.radius,
    padding: '12px 14px', cursor: 'pointer', fontFamily: 'inherit', boxShadow: theme.shadowSm,
  },
  rowUnread: { borderColor: theme.med, background: theme.medBg },
  icon: {
    width: 30, height: 30, borderRadius: 8, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: theme.borderSoft, color: theme.inkSoft,
  },
  iconUnread: { background: theme.surface, color: theme.med },
  title: { display: 'block', fontSize: 13, color: theme.ink, lineHeight: 1.4 },
  text: { display: 'block', fontSize: 12.5, color: theme.inkSoft, lineHeight: 1.45, marginTop: 2, overflowWrap: 'anywhere' },
  when: { display: 'block', fontSize: 11, color: theme.inkFaint, marginTop: 4 },
  dot: { width: 8, height: 8, borderRadius: '50%', background: theme.med, flexShrink: 0, marginTop: 6 },
  markAll: {
    display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 10px', borderRadius: 7,
    border: `1px solid ${theme.border}`, background: theme.surface, color: theme.ink, fontSize: 12,
    fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
  },
  emptyBox: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '48px 16px' },
  empty: { fontSize: 13, color: theme.inkSoft, textAlign: 'center', maxWidth: 360, margin: 0 },
};
