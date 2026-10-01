import ChatHeader from './ChatHeader';
import SummaryPanel from './SummaryPanel';
import ChatBody from './ChatBody';
import MessageInput from './MessageInput';
import EmptyState from './EmptyState';

export default function ChatPanel({ conv, summary, summaryLoading, onSummary, onSummaryClose, onToggleAI, onAutoDisabled, onCreateOrder }) {
  if (!conv) return (
    <div style={s.panel}>
      <EmptyState />
    </div>
  );

  return (
    <div style={s.panel}>
      <ChatHeader
        customer={conv.customer}
        messages={conv.messages}
        onSummary={() => onSummary(conv.customer.id)}
        summaryLoading={summaryLoading}
        onToggleAI={() => onToggleAI(conv.customer.id, conv.customer.ai_enabled)}
        onCreateOrder={onCreateOrder}
      />
      <SummaryPanel
        summary={summary}
        loading={summaryLoading}
        onClose={onSummaryClose}
      />
      <ChatBody messages={conv.messages} />
      <MessageInput
        customerId={conv.customer.id}
        aiEnabled={conv.customer.ai_enabled !== false}
        onToggleAI={() => onToggleAI(conv.customer.id, conv.customer.ai_enabled)}
        onAutoDisabled={onAutoDisabled}
      />
    </div>
  );
}

const s = {
  panel: {
    flex: 1, display: 'flex', flexDirection: 'column',
    overflow: 'hidden', background: '#efeae2',
  },
};
