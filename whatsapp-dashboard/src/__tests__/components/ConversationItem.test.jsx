import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

// Simplified ConversationItem for testing
const ConversationItem = ({ conv, isSelected, onClick }) => {
  const display = conv.customer.name || conv.customer.whatsapp_number;
  const last = conv.messages[conv.messages.length - 1];
  const preview = (last?.content || '').slice(0, 40);
  const inbound = conv.messages.filter((m) => m.direction === 'inbound').length;
  const outbound = conv.messages.filter((m) => m.direction === 'outbound').length;

  const priorityClass = {
    3: 'priority-urgent',
    2: 'priority-medium',
    1: 'priority-low',
  }[conv.customer.priority_score] || '';

  return (
    <div
      data-testid="conversation-item"
      className={`conv-item ${isSelected ? 'selected' : ''} ${priorityClass}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
    >
      <div data-testid="avatar">{display.charAt(0).toUpperCase()}</div>
      <div data-testid="display-name">{display}</div>
      <div data-testid="preview">
        {last?.direction === 'outbound' && '✓ '}
        {preview}
      </div>
      <div data-testid="message-count">{conv.messages.length}</div>
      <div data-testid="stat-inbound">{inbound} received</div>
      <div data-testid="stat-outbound">{outbound} sent</div>
    </div>
  );
};

describe('ConversationItem Component', () => {
  const baseConv = {
    customer: {
      id: 'c1',
      name: 'Kasun Silva',
      whatsapp_number: '94771234567',
      priority_score: 3,
    },
    messages: [
      { id: '1', direction: 'inbound', content: 'Hello', received_at: '2024-01-15T10:00:00Z' },
      { id: '2', direction: 'outbound', content: 'Hi! How can I help?', received_at: '2024-01-15T10:01:00Z' },
    ],
  };

  test('renders customer name when available', () => {
    render(<ConversationItem conv={baseConv} isSelected={false} onClick={() => {}} />);
    expect(screen.getByTestId('display-name')).toHaveTextContent('Kasun Silva');
  });

  test('falls back to whatsapp number when name is null', () => {
    const conv = { ...baseConv, customer: { ...baseConv.customer, name: null } };
    render(<ConversationItem conv={conv} isSelected={false} onClick={() => {}} />);
    expect(screen.getByTestId('display-name')).toHaveTextContent('94771234567');
  });

  test('shows last message preview truncated to 40 chars', () => {
    const longMsg = 'This is a very long message that exceeds forty characters in length for sure';
    const conv = {
      ...baseConv,
      messages: [{ id: '1', direction: 'inbound', content: longMsg, received_at: 'x' }],
    };
    render(<ConversationItem conv={conv} isSelected={false} onClick={() => {}} />);

    const preview = screen.getByTestId('preview').textContent;
    expect(preview.length).toBeLessThanOrEqual(42); // 40 chars + possible "✓ "
  });

  test('shows checkmark prefix when last message is outbound', () => {
    render(<ConversationItem conv={baseConv} isSelected={false} onClick={() => {}} />);
    expect(screen.getByTestId('preview')).toHaveTextContent('✓');
  });

  test('does not show checkmark when last message is inbound', () => {
    const conv = {
      ...baseConv,
      messages: [{ id: '1', direction: 'inbound', content: 'Hi', received_at: 'x' }],
    };
    render(<ConversationItem conv={conv} isSelected={false} onClick={() => {}} />);
    expect(screen.getByTestId('preview')).not.toHaveTextContent('✓');
  });

  test('displays total message count', () => {
    render(<ConversationItem conv={baseConv} isSelected={false} onClick={() => {}} />);
    expect(screen.getByTestId('message-count')).toHaveTextContent('2');
  });

  test('applies priority-urgent class for score 3', () => {
    render(<ConversationItem conv={baseConv} isSelected={false} onClick={() => {}} />);
    expect(screen.getByTestId('conversation-item')).toHaveClass('priority-urgent');
  });

  test('applies priority-medium class for score 2', () => {
    const conv = { ...baseConv, customer: { ...baseConv.customer, priority_score: 2 } };
    render(<ConversationItem conv={conv} isSelected={false} onClick={() => {}} />);
    expect(screen.getByTestId('conversation-item')).toHaveClass('priority-medium');
  });

  test('applies priority-low class for score 1', () => {
    const conv = { ...baseConv, customer: { ...baseConv.customer, priority_score: 1 } };
    render(<ConversationItem conv={conv} isSelected={false} onClick={() => {}} />);
    expect(screen.getByTestId('conversation-item')).toHaveClass('priority-low');
  });

  test('applies selected class when isSelected is true', () => {
    render(<ConversationItem conv={baseConv} isSelected={true} onClick={() => {}} />);
    expect(screen.getByTestId('conversation-item')).toHaveClass('selected');
  });

  test('calls onClick handler when clicked', () => {
    const onClick = vi.fn();
    render(<ConversationItem conv={baseConv} isSelected={false} onClick={onClick} />);

    fireEvent.click(screen.getByTestId('conversation-item'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('displays counts of inbound and outbound messages', () => {
    render(<ConversationItem conv={baseConv} isSelected={false} onClick={() => {}} />);
    expect(screen.getByTestId('stat-inbound')).toHaveTextContent('1 received');
    expect(screen.getByTestId('stat-outbound')).toHaveTextContent('1 sent');
  });

  test('shows initial letter of name in avatar', () => {
    render(<ConversationItem conv={baseConv} isSelected={false} onClick={() => {}} />);
    expect(screen.getByTestId('avatar')).toHaveTextContent('K');
  });
});
