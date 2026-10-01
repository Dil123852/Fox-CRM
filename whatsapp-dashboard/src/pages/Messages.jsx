import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { onEvent } from '../lib/sse';
import ConversationList from '../components/ConversationList';
import ChatPanel from '../components/ChatPanel';
import ChatOrderModal from '../components/ChatOrderModal';

export default function Messages({ onToast }) {
  const [conversations, setConversations] = useState([]);
  const [selectedId, setSelectedId]       = useState(null);
  const [search, setSearch]               = useState('');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [loading, setLoading]             = useState(true);
  const [summary, setSummary]             = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [orderModal, setOrderModal]       = useState(false);

  async function fetchAll() {
    try {
      const res  = await apiFetch('/api/messages');
      const { messages: data } = await res.json();
      if (!data) { setLoading(false); return; }

      const map = new Map();
      for (const msg of data) {
        const cid = msg.customers.id;
        if (!map.has(cid)) map.set(cid, { customer: msg.customers, messages: [] });
        map.get(cid).messages.push(msg);
      }
      const list = Array.from(map.values()).sort((a, b) => {
        const ap = a.customer.priority_score || 1;
        const bp = b.customer.priority_score || 1;
        if (bp !== ap) return bp - ap;
        return new Date(b.messages.at(-1).received_at) - new Date(a.messages.at(-1).received_at);
      });
      setConversations(list);
    } catch (err) {
      console.error(err.message);
    }
    setLoading(false);
  }

  useEffect(() => {
    // Subscribe first — see the same note in LeadsPage: live updates must
    // never be able to prevent the initial data load.
    const unsub1 = onEvent('message_insert', fetchAll);
    const unsub2 = onEvent('customer_update', fetchAll);
    fetchAll();
    return () => { unsub1(); unsub2(); };
  }, []);

  async function fetchSummary(customerId) {
    setSummary(null); setSummaryLoading(true);
    try {
      const res = await apiFetch('/api/summary', {
        method: 'POST',
        body: JSON.stringify({ customerId }),
      });
      const data = await res.json();
      setSummary(data.summary || data.error || 'No summary available.');
    } catch (err) { setSummary('Failed: ' + err.message); }
    setSummaryLoading(false);
  }

  async function toggleAI(customerId, currentValue) {
    const enabling = currentValue === false || currentValue === null;
    await apiFetch('/api/toggle-ai', {
      method: 'POST',
      body: JSON.stringify({ customerId, enabled: enabling }),
    });
    onToast({
      message: enabling ? '🤖 AI reply enabled for this chat' : '👤 Human mode — AI paused for this chat',
      type: enabling ? 'on' : 'off',
    });
  }

  const selectedConv = conversations.find(c => c.customer.id === selectedId);

  return (
    <div style={s.page}>
      <ConversationList
        conversations={conversations}
        selectedId={selectedId}
        search={search}
        onSearch={setSearch}
        priorityFilter={priorityFilter}
        onPriorityFilter={setPriorityFilter}
        onSelect={id => { setSelectedId(id); setSummary(null); }}
        loading={loading}
      />
      <ChatPanel
        conv={selectedConv}
        summary={summary}
        summaryLoading={summaryLoading}
        onSummary={fetchSummary}
        onSummaryClose={() => setSummary(null)}
        onToggleAI={toggleAI}
        onAutoDisabled={() => onToast({ message: '👤 AI auto-paused — human agent took over', type: 'off' })}
        onCreateOrder={() => setOrderModal(true)}
      />
      {orderModal && selectedConv && (
        <ChatOrderModal
          conv={selectedConv}
          onClose={() => setOrderModal(false)}
          onSaved={(order, confirmation) => onToast(
            confirmation && !confirmation.skipped && !confirmation.sent
              ? { message: '📦 Order placed — but the WhatsApp confirmation FAILED to send', type: 'off' }
              : { message: `📦 Order placed successfully${confirmation?.sent ? ' · confirmation sent' : ''}`, type: 'on' }
          )}
        />
      )}
    </div>
  );
}

const s = {
  page: { display: 'flex', flex: 1, overflow: 'hidden' },
};
