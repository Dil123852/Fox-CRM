import { useState, useRef } from 'react';
import { Send, Smile, Bot, User } from 'lucide-react';
import { apiFetch } from '../lib/api';

export default function MessageInput({ customerId, aiEnabled, onToggleAI, onAutoDisabled }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState(null);
  const inputRef = useRef(null);

  const aiOn = aiEnabled !== false;

  async function send() {
    if (!text.trim() || sending) return;
    setSending(true);
    setStatus(null);
    try {
      const res = await apiFetch('/api/send-message', {
        method: 'POST',
        body: JSON.stringify({ customerId, message: text.trim() }),
      });
      const data = await res.json();
      if (data.success && data.waSent) {
        setText('');
        setStatus('sent');
        setTimeout(() => setStatus(null), 2000);
        inputRef.current.style.height = '40px';
        if (aiEnabled) onAutoDisabled?.();
      } else if (data.success && !data.waSent) {
        // Saved to the conversation record, but WhatsApp itself rejected it —
        // do NOT clear the input or show "sent". See Phase 13 item 1.
        setStatus('undelivered');
        if (aiEnabled) onAutoDisabled?.();
      } else {
        setStatus('error');
      }
    } catch {
      setStatus('error');
    }
    setSending(false);
    inputRef.current?.focus();
  }

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  return (
    <div style={s.wrap}>
      {status === 'error' && (
        <div style={s.errorBanner}>Failed to send message. Please try again.</div>
      )}
      {status === 'undelivered' && (
        <div style={s.errorBanner}>Saved, but WhatsApp did not deliver this to the customer — check their number/channel.</div>
      )}

      <div style={s.bar}>
        <button style={s.iconBtn} title="Emoji (coming soon)">
          <Smile size={20} color="#94a3b8" />
        </button>

        <textarea
          ref={inputRef}
          style={s.input}
          rows={1}
          placeholder="Type a message…"
          value={text}
          onChange={e => {
            setText(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, 100) + 'px';
          }}
          onKeyDown={handleKey}
          disabled={sending}
        />

        <button
          style={{
            ...s.aiBadge,
            background: aiOn ? '#ecfdf5' : '#f8fafc',
            border: `1.5px solid ${aiOn ? '#a7f3d0' : '#e2e8f0'}`,
            color: aiOn ? '#059669' : '#94a3b8',
          }}
          onClick={onToggleAI}
          title={aiOn ? 'AI is replying — click to take over' : 'Human mode — click to re-enable AI'}
        >
          {aiOn ? <Bot size={13} /> : <User size={13} />}
          {aiOn ? 'AI on' : 'Manual'}
        </button>

        <button
          style={{
            ...s.sendBtn,
            background: text.trim() ? '#10b981' : '#e2e8f0',
            cursor: text.trim() ? 'pointer' : 'default',
          }}
          onClick={send}
          disabled={!text.trim() || sending}
        >
          {sending
            ? <div style={s.spinner} />
            : <Send size={17} color={text.trim() ? '#fff' : '#94a3b8'} />
          }
        </button>
      </div>
    </div>
  );
}

const s = {
  wrap: {
    borderTop: '1px solid #e2e8f0',
    background: '#ffffff',
    flexShrink: 0,
  },
  errorBanner: {
    background: '#fef2f2', color: '#dc2626',
    fontSize: 12, padding: '6px 20px',
    borderBottom: '1px solid #fecaca',
  },
  bar: {
    display: 'flex', alignItems: 'flex-end',
    gap: 8, padding: '10px 16px',
  },
  iconBtn: {
    background: 'none', border: 'none', cursor: 'pointer',
    padding: 6, display: 'flex', alignItems: 'center',
    justifyContent: 'center', flexShrink: 0, marginBottom: 2,
  },
  input: {
    flex: 1, background: '#f8fafc',
    border: '1.5px solid #e2e8f0',
    borderRadius: 10, padding: '10px 14px',
    color: '#0f172a', fontSize: 13, lineHeight: 1.5,
    resize: 'none', outline: 'none', fontFamily: 'inherit',
    overflowY: 'auto', maxHeight: 100, height: 40,
    transition: 'border-color 0.15s',
  },
  aiBadge: {
    display: 'flex', alignItems: 'center', gap: 5,
    borderRadius: 8, padding: '0 10px',
    height: 40, fontSize: 12, fontWeight: 700,
    cursor: 'pointer', whiteSpace: 'nowrap',
    transition: 'all 0.15s', flexShrink: 0,
  },
  sendBtn: {
    width: 40, height: 40, borderRadius: '50%', border: 'none',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, transition: 'all 0.15s',
  },
  spinner: {
    width: 16, height: 16, borderRadius: '50%',
    border: '2px solid rgba(255,255,255,0.3)',
    borderTopColor: '#fff',
    animation: 'spin 0.8s linear infinite',
  },
};
