import { MessageSquare } from 'lucide-react';

export default function EmptyState() {
  return (
    <div style={s.wrap}>
      <div style={s.iconBox}>
        <MessageSquare size={32} color="#10b981" strokeWidth={1.5} />
      </div>
      <p style={s.heading}>No conversation selected</p>
      <p style={s.sub}>Choose a conversation from the sidebar to start</p>
    </div>
  );
}

const s = {
  wrap: {
    flex: 1, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: 10,
    background: '#f8fafc',
  },
  iconBox: {
    width: 64, height: 64, borderRadius: 18,
    background: '#ecfdf5', border: '1px solid #a7f3d0',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    marginBottom: 4,
  },
  heading: { fontSize: 15, fontWeight: 600, color: '#0f172a' },
  sub: { fontSize: 13, color: '#94a3b8' },
};
