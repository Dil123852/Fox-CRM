import { useEffect, useRef } from 'react';
import MessageBubble from './MessageBubble';

export default function ChatBody({ messages }) {
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div style={s.body}>
      {messages.map((msg, i) => (
        <MessageBubble key={msg.id} msg={msg} prevMsg={messages[i - 1]} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

const s = {
  body: {
    flex: 1, overflowY: 'auto',
    padding: '20px 60px',
    display: 'flex', flexDirection: 'column', gap: 1,
    background: '#efeae2',
    backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23d4c9b8' fill-opacity='0.25'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
  },
};
