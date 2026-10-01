import { describe, test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

// Simplified MessageBubble component for testing
const MessageBubble = ({ msg, prevMsg }) => {
  const isOutbound = msg.direction === 'outbound';
  const showAvatar = !prevMsg || prevMsg.direction !== msg.direction;

  return (
    <div
      data-testid="message-bubble"
      className={isOutbound ? 'message-outbound' : 'message-inbound'}
    >
      {showAvatar && <div data-testid="avatar">{isOutbound ? 'You' : 'Customer'}</div>}
      <div data-testid="message-content">{msg.content}</div>
      <span data-testid="message-time">{msg.received_at}</span>
    </div>
  );
};

describe('MessageBubble Component', () => {
  test('renders message content', () => {
    const msg = {
      id: '1',
      content: 'Hello, I need a mattress',
      direction: 'inbound',
      received_at: '2024-01-15T10:00:00Z',
    };

    render(<MessageBubble msg={msg} prevMsg={null} />);

    expect(screen.getByTestId('message-content')).toHaveTextContent('Hello, I need a mattress');
  });

  test('applies outbound class for outbound messages', () => {
    const msg = {
      id: '1',
      content: 'Sure, what size?',
      direction: 'outbound',
      received_at: '2024-01-15T10:01:00Z',
    };

    render(<MessageBubble msg={msg} prevMsg={null} />);

    expect(screen.getByTestId('message-bubble')).toHaveClass('message-outbound');
  });

  test('applies inbound class for inbound messages', () => {
    const msg = {
      id: '1',
      content: 'Hello',
      direction: 'inbound',
      received_at: '2024-01-15T10:00:00Z',
    };

    render(<MessageBubble msg={msg} prevMsg={null} />);

    expect(screen.getByTestId('message-bubble')).toHaveClass('message-inbound');
  });

  test('shows avatar when previous message is from different direction', () => {
    const prevMsg = { direction: 'inbound' };
    const msg = {
      id: '2',
      content: 'Yes',
      direction: 'outbound',
      received_at: '2024-01-15T10:01:00Z',
    };

    render(<MessageBubble msg={msg} prevMsg={prevMsg} />);

    expect(screen.getByTestId('avatar')).toBeInTheDocument();
  });

  test('hides avatar when previous message is from same direction', () => {
    const prevMsg = { direction: 'outbound' };
    const msg = {
      id: '2',
      content: 'Yes',
      direction: 'outbound',
      received_at: '2024-01-15T10:01:00Z',
    };

    render(<MessageBubble msg={msg} prevMsg={prevMsg} />);

    expect(screen.queryByTestId('avatar')).not.toBeInTheDocument();
  });

  test('renders timestamp', () => {
    const msg = {
      id: '1',
      content: 'Test',
      direction: 'inbound',
      received_at: '2024-01-15T10:00:00Z',
    };

    render(<MessageBubble msg={msg} prevMsg={null} />);

    expect(screen.getByTestId('message-time')).toHaveTextContent('2024-01-15T10:00:00Z');
  });
});
