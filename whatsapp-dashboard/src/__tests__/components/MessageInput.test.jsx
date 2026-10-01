import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import '@testing-library/jest-dom';

// Simplified MessageInput for testing
const MessageInput = ({ customerId, aiEnabled, onAutoDisabled, backendUrl = 'http://localhost:3000' }) => {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState(null);

  const handleSend = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    setStatus(null);

    try {
      const res = await fetch(`${backendUrl}/api/send-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId, message: text.trim() }),
      });
      const data = await res.json();

      if (data.success) {
        setText('');
        setStatus('sent');
        if (aiEnabled && onAutoDisabled) onAutoDisabled();
      } else {
        setStatus('error');
      }
    } catch {
      setStatus('error');
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div data-testid="message-input">
      <textarea
        data-testid="textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={sending}
        placeholder="Type a message..."
      />
      <button
        data-testid="send-button"
        onClick={handleSend}
        disabled={sending || !text.trim()}
      >
        {sending ? 'Sending...' : 'Send'}
      </button>
      {status && <span data-testid="status">{status}</span>}
    </div>
  );
};

describe('MessageInput Component', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  test('renders textarea and send button', () => {
    render(<MessageInput customerId="c1" aiEnabled={false} />);

    expect(screen.getByTestId('textarea')).toBeInTheDocument();
    expect(screen.getByTestId('send-button')).toBeInTheDocument();
  });

  test('send button is disabled when text is empty', () => {
    render(<MessageInput customerId="c1" aiEnabled={false} />);

    expect(screen.getByTestId('send-button')).toBeDisabled();
  });

  test('send button is enabled when text is entered', async () => {
    const user = userEvent.setup();
    render(<MessageInput customerId="c1" aiEnabled={false} />);

    const textarea = screen.getByTestId('textarea');
    await user.type(textarea, 'Hello');

    expect(screen.getByTestId('send-button')).not.toBeDisabled();
  });

  test('sends message on button click', async () => {
    global.fetch.mockResolvedValueOnce({
      json: async () => ({ success: true }),
    });

    const user = userEvent.setup();
    render(<MessageInput customerId="c1" aiEnabled={false} />);

    await user.type(screen.getByTestId('textarea'), 'Test message');
    await user.click(screen.getByTestId('send-button'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/send-message'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ customerId: 'c1', message: 'Test message' }),
        })
      );
    });
  });

  test('sends message on Enter key', async () => {
    global.fetch.mockResolvedValueOnce({
      json: async () => ({ success: true }),
    });

    const user = userEvent.setup();
    render(<MessageInput customerId="c1" aiEnabled={false} />);

    const textarea = screen.getByTestId('textarea');
    await user.type(textarea, 'Hello{Enter}');

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  test('does NOT send on Shift+Enter (creates newline)', async () => {
    const user = userEvent.setup();
    render(<MessageInput customerId="c1" aiEnabled={false} />);

    const textarea = screen.getByTestId('textarea');
    await user.type(textarea, 'Line 1{Shift>}{Enter}{/Shift}Line 2');

    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('clears textarea after successful send', async () => {
    global.fetch.mockResolvedValueOnce({
      json: async () => ({ success: true }),
    });

    const user = userEvent.setup();
    render(<MessageInput customerId="c1" aiEnabled={false} />);

    const textarea = screen.getByTestId('textarea');
    await user.type(textarea, 'Hello');
    await user.click(screen.getByTestId('send-button'));

    await waitFor(() => {
      expect(textarea).toHaveValue('');
    });
  });

  test('shows error status when send fails', async () => {
    global.fetch.mockResolvedValueOnce({
      json: async () => ({ success: false }),
    });

    const user = userEvent.setup();
    render(<MessageInput customerId="c1" aiEnabled={false} />);

    await user.type(screen.getByTestId('textarea'), 'Test');
    await user.click(screen.getByTestId('send-button'));

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('error');
    });
  });

  test('calls onAutoDisabled when AI was enabled and message is sent', async () => {
    global.fetch.mockResolvedValueOnce({
      json: async () => ({ success: true }),
    });

    const onAutoDisabled = vi.fn();
    const user = userEvent.setup();
    render(
      <MessageInput customerId="c1" aiEnabled={true} onAutoDisabled={onAutoDisabled} />
    );

    await user.type(screen.getByTestId('textarea'), 'Manual reply');
    await user.click(screen.getByTestId('send-button'));

    await waitFor(() => {
      expect(onAutoDisabled).toHaveBeenCalled();
    });
  });

  test('does not call onAutoDisabled when AI was already disabled', async () => {
    global.fetch.mockResolvedValueOnce({
      json: async () => ({ success: true }),
    });

    const onAutoDisabled = vi.fn();
    const user = userEvent.setup();
    render(
      <MessageInput customerId="c1" aiEnabled={false} onAutoDisabled={onAutoDisabled} />
    );

    await user.type(screen.getByTestId('textarea'), 'Reply');
    await user.click(screen.getByTestId('send-button'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    expect(onAutoDisabled).not.toHaveBeenCalled();
  });

  test('prevents double-send while in flight', async () => {
    let resolvePromise;
    global.fetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePromise = () => resolve({ json: async () => ({ success: true }) });
      })
    );

    const user = userEvent.setup();
    render(<MessageInput customerId="c1" aiEnabled={false} />);

    await user.type(screen.getByTestId('textarea'), 'Hello');
    await user.click(screen.getByTestId('send-button'));

    expect(screen.getByTestId('send-button')).toBeDisabled();

    resolvePromise();
    await waitFor(() => {
      expect(screen.getByTestId('send-button')).toBeDisabled(); // disabled because empty
    });
  });
});
