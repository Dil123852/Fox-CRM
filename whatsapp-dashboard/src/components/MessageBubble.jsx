import { AlertTriangle } from 'lucide-react';
import { businessDay } from '../lib/businessTime';
import { formatBubbleTime, formatDateDivider } from '../utils/time';

export default function MessageBubble({ msg, prevMsg }) {
  const isOut = msg.direction === 'outbound';
  const failed = isOut && msg.delivery_failed;
  const showDate =
    !prevMsg ||
    businessDay(msg.received_at) !== businessDay(prevMsg.received_at);

  return (
    <>
      {showDate && (
        <div style={s.divider}>
          <span style={s.dividerLabel}>{formatDateDivider(msg.received_at)}</span>
        </div>
      )}
      <div style={{ ...s.row, justifyContent: isOut ? 'flex-end' : 'flex-start' }}>
        <div style={{
          ...s.bubble,
          background: failed ? '#fef2f2' : isOut ? '#d9fdd3' : '#ffffff',
          borderRadius: isOut ? '12px 2px 12px 12px' : '2px 12px 12px 12px',
          boxShadow: failed
            ? '0 0 0 1px #fecaca'
            : isOut
              ? '0 1px 2px rgba(0,0,0,0.1)'
              : '0 1px 3px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.04)',
        }}>
          <p style={s.text}>{msg.content}</p>
          {failed && msg.failure_reason && (
            <p style={s.failReason}>{msg.failure_reason}</p>
          )}
          <div style={s.foot}>
            {failed && (
              <span style={s.failedTag} title={msg.failure_reason || undefined}>
                <AlertTriangle size={10} /> Not delivered
              </span>
            )}
            <span style={s.time}>{formatBubbleTime(msg.received_at)}</span>
            {isOut && !failed && <span style={s.tick}>✓✓</span>}
          </div>
        </div>
      </div>
    </>
  );
}

const s = {
  divider: { display: 'flex', justifyContent: 'center', margin: '16px 0 10px' },
  dividerLabel: {
    background: 'rgba(255,255,255,0.85)',
    color: '#64748b', fontSize: 11, fontWeight: 500,
    padding: '4px 12px', borderRadius: 12,
    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
  },
  row: { display: 'flex', marginBottom: 3 },
  bubble: { maxWidth: '68%', padding: '8px 12px 5px' },
  text: { fontSize: 13, color: '#0f172a', lineHeight: 1.55, margin: 0, wordBreak: 'break-word' },
  foot: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, marginTop: 3 },
  time: { fontSize: 10, color: '#94a3b8' },
  tick: { fontSize: 11, color: '#10b981' },
  failReason: { margin: '6px 0 0', fontSize: 10.5, lineHeight: 1.45, color: '#B0432E', background: '#FAECE8', border: '1px solid #F0C9C0', borderRadius: 6, padding: '5px 7px' },
  failedTag: { display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, fontWeight: 600, color: '#dc2626' },
};
