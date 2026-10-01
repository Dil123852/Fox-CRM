import { formatSidebarTime } from '../utils/time';
import { theme } from '../lib/theme';

const PRIORITY_CLASS = { 3: 'priority-urgent', 2: 'priority-medium', 1: 'priority-low' };

export default function ConversationItem({ conv, isSelected, onClick }) {
  const last = conv.messages.at(-1);
  const displayName = conv.customer.name || conv.customer.whatsapp_number;
  const inCount  = conv.messages.filter(m => m.direction === 'inbound').length;
  const outCount = conv.messages.length - inCount;
  const priorityClass = PRIORITY_CLASS[conv.customer.priority_score] || 'priority-low';

  return (
    <div
      onClick={onClick}
      style={{
        ...s.item,
        background: isSelected ? theme.accentSoft : theme.surface,
        borderLeft: isSelected ? `3px solid ${theme.accent}` : '3px solid transparent',
      }}
    >
      <div style={s.avatar} className={priorityClass}>
        {displayName.charAt(0).toUpperCase()}
      </div>

      <div style={s.body}>
        <div style={s.row}>
          <span style={s.name}>{displayName}</span>
          <span style={s.time}>{formatSidebarTime(last.received_at)}</span>
        </div>
        <div style={s.row}>
          <span style={s.preview}>
            {last.direction === 'outbound' && <span style={s.tick}>✓ </span>}
            {last.content.length > 40 ? last.content.slice(0, 40) + '…' : last.content}
          </span>
          <span style={s.count}>{conv.messages.length}</span>
        </div>
        <div style={s.stats}>
          <span style={s.statChip}>{inCount} received</span>
          <span style={{ ...s.statChip, color: theme.success, background: theme.successBg, border: 'none' }}>{outCount} sent</span>
        </div>
      </div>
    </div>
  );
}

const s = {
  item: {
    display: 'flex', alignItems: 'flex-start',
    padding: '12px 16px', cursor: 'pointer',
    borderBottom: `1px solid ${theme.borderSoft}`, gap: 12,
    transition: 'background 0.1s',
  },
  avatar: {
    width: 44, height: 44, borderRadius: '50%',
    background: theme.accent, color: '#fff',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontWeight: 700, fontSize: 18, flexShrink: 0,
  },
  body: { flex: 1, minWidth: 0 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 },
  name: { fontSize: 14, fontWeight: 600, color: theme.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  time: { fontSize: 11, color: theme.inkFaint, flexShrink: 0, marginLeft: 8 },
  preview: { fontSize: 12, color: theme.inkSoft, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
  tick: { color: theme.success },
  count: {
    background: theme.accent, color: '#fff',
    borderRadius: 10, padding: '1px 6px',
    fontSize: 10, fontWeight: 700, marginLeft: 8, flexShrink: 0,
  },
  stats: { display: 'flex', gap: 4, marginTop: 3 },
  statChip: {
    fontSize: 10, color: theme.inkSoft,
    background: theme.bg, border: `1px solid ${theme.border}`,
    padding: '1px 6px', borderRadius: 4, fontWeight: 500,
  },
};
