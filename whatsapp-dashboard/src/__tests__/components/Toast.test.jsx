import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useEffect, useState } from 'react';
import '@testing-library/jest-dom';

// Simplified Toast component for testing
const Toast = ({ message, type = 'info', duration = 3000, onDone }) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (message) {
      setVisible(true);
      const timer = setTimeout(() => {
        setVisible(false);
        if (onDone) onDone();
      }, duration);
      return () => clearTimeout(timer);
    }
  }, [message, duration, onDone]);

  if (!message || !visible) return null;

  return (
    <div data-testid="toast" className={`toast toast-${type}`}>
      {message}
    </div>
  );
};

describe('Toast Component', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  test('does not render when message is empty', () => {
    render(<Toast message="" />);
    expect(screen.queryByTestId('toast')).not.toBeInTheDocument();
  });

  test('renders message when provided', () => {
    render(<Toast message="Success!" />);
    expect(screen.getByTestId('toast')).toHaveTextContent('Success!');
  });

  test('applies correct type class', () => {
    render(<Toast message="Error" type="error" />);
    expect(screen.getByTestId('toast')).toHaveClass('toast-error');
  });

  test('defaults to info type when no type provided', () => {
    render(<Toast message="Info" />);
    expect(screen.getByTestId('toast')).toHaveClass('toast-info');
  });

  test('hides after duration and calls onDone', () => {
    const onDone = vi.fn();
    render(<Toast message="Hello" duration={1000} onDone={onDone} />);

    expect(screen.getByTestId('toast')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.queryByTestId('toast')).not.toBeInTheDocument();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test('supports success type', () => {
    render(<Toast message="Done" type="success" />);
    expect(screen.getByTestId('toast')).toHaveClass('toast-success');
  });
});
