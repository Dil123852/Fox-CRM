import { describe, test, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { DialogProvider, useDialog, useErrorPopup } from '../../components/DialogProvider';

// The app's own confirm/alert dialogs, which replace window.confirm/alert.
// A tiny harness exposes useDialog() so each test can open a dialog and see
// what the awaiting caller gets back.

let api;
function Harness() {
  api = useDialog();
  return <button type="button">page button</button>;
}
const setup = () => render(<DialogProvider><Harness /></DialogProvider>);

describe('confirm', () => {
  test('resolves true when confirmed, with the given title, message and button label', async () => {
    setup();
    let result;
    act(() => { api.confirm({ title: 'Delete order #1024?', message: 'This cannot be undone.', confirmLabel: 'Delete order', tone: 'danger' }).then(r => { result = r; }); });
    const dlg = screen.getByRole('alertdialog');
    expect(dlg).toHaveTextContent('Delete order #1024?');
    expect(dlg).toHaveTextContent('This cannot be undone.');
    fireEvent.click(screen.getByRole('button', { name: 'Delete order' }));
    await act(async () => {});
    expect(result).toBe(true);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  test('Cancel, Escape and a click outside all resolve false — never confirm', async () => {
    setup();
    const results = [];
    const open = () => act(() => { api.confirm({ title: 'Sure?' }).then(r => results.push(r)); });

    open();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => {});

    open();
    fireEvent.keyDown(document, { key: 'Escape' });
    await act(async () => {});

    open();
    // the backdrop is the dialog's parent
    fireEvent.mouseDown(screen.getByRole('alertdialog').parentElement);
    await act(async () => {});

    expect(results).toEqual([false, false, false]);
  });

  test('a destructive confirm focuses Cancel, so a stray Enter cannot delete', () => {
    setup();
    act(() => { api.confirm({ title: 'Delete?', confirmLabel: 'Delete', tone: 'danger' }); });
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  test('a non-destructive confirm focuses the main button', () => {
    setup();
    act(() => { api.confirm({ title: 'Continue?', confirmLabel: 'Continue' }); });
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveFocus();
  });
});

describe('alert', () => {
  test('shows the message with an OK button and resolves when dismissed', async () => {
    setup();
    let done = false;
    act(() => { api.alert({ title: 'Could not delete the order', message: 'Order not found' }).then(() => { done = true; }); });
    const dlg = screen.getByRole('dialog');
    expect(dlg).toHaveTextContent('Could not delete the order');
    expect(dlg).toHaveTextContent('Order not found');
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await act(async () => {});
    expect(done).toBe(true);
  });

  test('accepts a plain string, like window.alert', () => {
    setup();
    act(() => { api.alert('Something broke'); });
    expect(screen.getByRole('dialog')).toHaveTextContent('Something broke');
  });
});

test('dialogs requested together are shown one after another, not stacked or lost', async () => {
  setup();
  act(() => {
    api.alert({ title: 'First' });
    api.alert({ title: 'Second' });
  });
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.getByRole('dialog')).toHaveTextContent('First');
  fireEvent.click(screen.getByRole('button', { name: 'OK' }));
  await act(async () => {});
  expect(screen.getByRole('dialog')).toHaveTextContent('Second');
});

test('focus returns to where it was once the dialog closes', async () => {
  setup();
  const pageButton = screen.getByRole('button', { name: 'page button' });
  pageButton.focus();
  act(() => { api.alert({ title: 'Heads up' }); });
  fireEvent.click(screen.getByRole('button', { name: 'OK' }));
  await act(async () => {});
  expect(pageButton).toHaveFocus();
});

describe('notices and live popups', () => {
  test('a success notice closes by itself after its delay', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup();
    act(() => { api.alert({ title: 'Order #1024 placed', tone: 'success', autoCloseMs: 4000 }); });
    expect(screen.getByRole('dialog')).toHaveTextContent('Order #1024 placed');
    await act(async () => { vi.advanceTimersByTime(4100); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  test('a live popup updates in place, and reports when the user hid it', async () => {
    setup();
    let p;
    act(() => { p = api.show({ title: 'Sending…', busy: true }); });
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true');
    act(() => p.update({ title: 'Done', busy: false }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Done');
    expect(p.isOpen).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await act(async () => {});
    expect(p.isOpen).toBe(false);
  });
});

describe('useErrorPopup (form action errors)', () => {
  function Form() {
    const [error, setError] = useState(null);
    useErrorPopup(error, 'Could not save the product');
    return (
      <>
        <button type="button" onClick={() => setError('Name is required')}>fail</button>
        <button type="button" onClick={() => setError(null)}>retry</button>
      </>
    );
  }

  test('each new error pops once, and the same error pops again after a fresh attempt', async () => {
    render(<DialogProvider><Form /></DialogProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'fail' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Could not save the product');
    expect(screen.getByRole('dialog')).toHaveTextContent('Name is required');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await act(async () => {});
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Forms clear their error when an action starts, then set it again.
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'fail' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Name is required');
  });
});

describe('side notifications (notify)', () => {
  test('appear in the corner without blocking the page or taking focus', () => {
    setup();
    const pageButton = screen.getByRole('button', { name: 'page button' });
    pageButton.focus();
    act(() => { api.notify({ title: "Nimal's phone went offline", message: 'Calls are not reaching the CRM.' }); });
    expect(screen.getByRole('status')).toHaveTextContent("Nimal's phone went offline");
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(pageButton).toHaveFocus();
  });

  test('fade out by themselves — but not while hovered', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup();
    act(() => { api.notify({ title: 'Heads up' }); });
    const card = screen.getByText('Heads up').closest('.summary-card');
    fireEvent.mouseEnter(card);
    await act(async () => { vi.advanceTimersByTime(20000); });
    expect(screen.getByText('Heads up')).toBeInTheDocument();
    fireEvent.mouseLeave(card);
    await act(async () => { vi.advanceTimersByTime(8500); });
    expect(screen.queryByText('Heads up')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  test('never pile up: at most three are shown, newest first', () => {
    setup();
    act(() => { for (let i = 1; i <= 5; i++) api.notify({ title: `Note ${i}` }); });
    const cards = screen.getAllByRole('button', { name: 'Dismiss notification' }).map(b => b.closest('.summary-card').textContent);
    expect(cards).toHaveLength(3);
    expect(cards[0]).toContain('Note 5');
  });

  test('an action button runs and dismisses the note', () => {
    setup();
    let ran = false;
    act(() => { api.notify({ title: 'Offline', action: { label: 'View team', onClick: () => { ran = true; } } }); });
    fireEvent.click(screen.getByRole('button', { name: 'View team' }));
    expect(ran).toBe(true);
    expect(screen.queryByText('Offline')).not.toBeInTheDocument();
  });
});

describe('keyed popups replace each other instead of queueing', () => {
  test('a new popup with the same key replaces the one on screen; the replaced confirm settles as false', async () => {
    setup();
    let first;
    act(() => { first = api.confirm({ key: 'phone', title: 'Phone offline since 2:46 PM', confirmLabel: 'Connect' }); });
    act(() => { api.confirm({ key: 'phone', title: 'Phone offline since 2:46 PM (reminder)', confirmLabel: 'Connect' }); });
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    expect(screen.getByRole('alertdialog')).toHaveTextContent('(reminder)');
    await expect(first).resolves.toBe(false); // never counted as "Connect"
    // Only one to close.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => {});
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('it also replaces a same-key popup still waiting in the queue, keeping its place', async () => {
    setup();
    act(() => {
      api.alert({ title: 'Unrelated error' });
      api.alert({ key: 'phone', title: 'Offline' });
      api.alert({ key: 'phone', title: 'Connected again' });
    });
    expect(screen.getByRole('dialog')).toHaveTextContent('Unrelated error');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await act(async () => {});
    expect(screen.getByRole('dialog')).toHaveTextContent('Connected again');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull(); // "Offline" was replaced, not shown later
  });

  test('popups without a key still queue exactly as before', async () => {
    setup();
    act(() => {
      api.alert({ title: 'A' });
      api.alert({ title: 'B' });
    });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await act(async () => {});
    expect(screen.getByRole('dialog')).toHaveTextContent('B');
  });

  test('a keyed side note replaces its predecessor', () => {
    setup();
    act(() => {
      api.notify({ key: 'team', title: "Nimal's phone went offline" });
      api.notify({ key: 'team', title: '2 phones went offline' });
    });
    expect(screen.getAllByRole('button', { name: 'Dismiss notification' })).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('2 phones went offline');
  });
});
