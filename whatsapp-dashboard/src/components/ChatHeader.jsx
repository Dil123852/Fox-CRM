import { Zap, Package } from 'lucide-react';
import { theme } from '../lib/theme';

export default function ChatHeader({ customer, messages, onSummary, summaryLoading, onCreateOrder, onToggleAI: _onToggleAI }) {
  const displayName = customer.name || customer.whatsapp_number;
  const inCount  = messages.filter(m => m.direction === 'inbound').length;
  const outCount = messages.length - inCount;

  return (
    <div style={s.header}>
      <div style={s.left}>
        <div style={s.avatar}>{displayName.charAt(0).toUpperCase()}</div>
        <div>
          <p style={s.name}>{displayName}</p>
          {customer.name && <p style={s.phone}>{customer.whatsapp_number}</p>}
        </div>
      </div>

      <div style={s.actions}>
        <span style={s.chip}>{inCount} received</span>
        <span style={{ ...s.chip, ...s.chipGreen }}>{outCount} sent</span>
        <button style={s.btnOutline} onClick={onCreateOrder}>
          <Package size={13} />
          Order
        </button>
        <button style={s.btnPrimary} onClick={onSummary} disabled={summaryLoading}>
          <Zap size={13} />
          {summaryLoading ? 'Generating…' : 'Summary'}
        </button>
      </div>
    </div>
  );
}

const s = {
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '12px 20px', background: theme.surface,
    borderBottom: `1px solid ${theme.border}`, flexShrink: 0,
    boxShadow: theme.shadowSm,
  },
  left: { display: 'flex', alignItems: 'center', gap: 12 },
  avatar: {
    width: 40, height: 40, borderRadius: '50%',
    background: theme.accent, color: '#fff',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontWeight: 700, fontSize: 16, flexShrink: 0,
  },
  name: { fontSize: 14, fontWeight: 700, color: theme.ink, margin: 0 },
  phone: { fontSize: 11, color: theme.inkFaint, margin: 0 },
  actions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  chip: {
    background: theme.bg, color: theme.inkSoft,
    fontSize: 11, fontWeight: 600,
    padding: '4px 9px', borderRadius: 6,
    border: `1px solid ${theme.border}`,
  },
  chipGreen: {
    background: theme.successBg, color: theme.success,
    border: 'none',
  },
  btnOutline: {
    display: 'flex', alignItems: 'center', gap: 5,
    background: theme.surface, border: `1.5px solid ${theme.border}`,
    color: theme.inkSoft, fontSize: 12, fontWeight: 600,
    padding: '6px 12px', borderRadius: 7, cursor: 'pointer',
    transition: 'all 0.12s', fontFamily: 'inherit',
  },
  btnPrimary: {
    display: 'flex', alignItems: 'center', gap: 5,
    background: theme.accent, border: 'none',
    color: '#fff', fontSize: 12, fontWeight: 600,
    padding: '7px 14px', borderRadius: 7, cursor: 'pointer',
    transition: 'opacity 0.12s', fontFamily: 'inherit',
  },
};
