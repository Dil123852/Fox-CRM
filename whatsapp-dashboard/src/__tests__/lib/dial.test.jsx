import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// The real dial.js and CallButton, with only the network (apiFetch) and the
// live-event channel (onEvent) replaced — so what's tested is the actual
// stage logic the agent sees, including its timing and event filtering.

const listeners = [];
let respond; // resolves the pending POST /api/dial

vi.mock('../../lib/sse', () => ({
  onEvent: vi.fn((event, cb) => {
    const entry = { event, cb };
    listeners.push(entry);
    return () => listeners.splice(listeners.indexOf(entry), 1);
  }),
}));

vi.mock('../../lib/api', () => ({
  apiFetch: vi.fn(
    () =>
      new Promise(resolve => {
        respond = (status, body) => resolve({ ok: status < 400, status, json: async () => body });
      })
  ),
}));

let mockRole = 'sales_agent';
vi.mock('../../lib/AuthContext', () => ({ useAuth: () => ({ staff: { role: mockRole } }) }));

import { startDial } from '../../lib/dial';
import { apiFetch } from '../../lib/api';
import CallButton from '../../components/CallButton';
import { DialogProvider } from '../../components/DialogProvider';

const withPopups = ui => <DialogProvider>{ui}</DialogProvider>;

/** Deliver a dial_status SSE event to every subscriber. */
function push(data) {
  for (const l of [...listeners]) if (l.event === 'dial_status') l.cb({ data: JSON.stringify(data) });
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('startDial', () => {
  let updates;
  beforeEach(() => {
    vi.useFakeTimers();
    listeners.length = 0;
    updates = [];
  });
  afterEach(() => vi.useRealTimers());

  const stages = () => updates.map(u => u.stage);

  test('sends only the customer and lead — never a phone number', async () => {
    startDial({ customerId: 'c1', leadId: 'l1' }, u => updates.push(u));
    const [path, opts] = apiFetch.mock.calls.at(-1);
    expect(path).toBe('/api/dial');
    expect(JSON.parse(opts.body)).toEqual({ customerId: 'c1', leadId: 'l1' });
  });

  test('online phone: sending → delivered → dialing, ignoring other requests', async () => {
    startDial({ customerId: 'c1' }, u => updates.push(u));
    respond(200, { requestId: 'r1', deviceOnline: true, status: 'delivered' });
    await flush();

    push({ requestId: 'someone-else', status: 'failed', error: 'not mine' });
    push({ requestId: 'r1', status: 'dialing' });

    expect(stages()).toEqual(['sending', 'delivered', 'dialing']);
    expect(updates.at(-1).message).toBe('Calling on your phone');
    expect(listeners).toHaveLength(0); // unsubscribed once final
  });

  test('an event that beats the HTTP response is not lost', async () => {
    startDial({ customerId: 'c1' }, u => updates.push(u));
    push({ requestId: 'r1', status: 'dialing' }); // before the POST resolves
    respond(200, { requestId: 'r1', deviceOnline: true });
    await flush();
    expect(stages()).toContain('dialing');
  });

  test("offline phone: pending, then 'expired' after the server's 60s window", async () => {
    startDial({ customerId: 'c1' }, u => updates.push(u));
    respond(200, { requestId: 'r1', deviceOnline: false, status: 'pending' });
    await flush();
    expect(stages()).toEqual(['sending', 'pending']);

    act(() => vi.advanceTimersByTime(60000));
    expect(stages().at(-1)).toBe('expired');
  });

  test('a phone that received the command but never reports back is flagged', async () => {
    startDial({ customerId: 'c1' }, u => updates.push(u));
    respond(200, { requestId: 'r1', deviceOnline: true });
    await flush();
    act(() => vi.advanceTimersByTime(20000));
    expect(stages().at(-1)).toBe('no_response');
  });

  test("the phone's own failure reason is shown", async () => {
    startDial({ customerId: 'c1' }, u => updates.push(u));
    respond(200, { requestId: 'r1', deviceOnline: true });
    await flush();
    push({ requestId: 'r1', status: 'failed', error: 'This phone blocked the automatic call' });
    expect(updates.at(-1)).toMatchObject({ stage: 'failed', message: 'This phone blocked the automatic call', tone: 'error' });
  });

  test("the server's refusal (no phone paired) is shown as-is", async () => {
    startDial({ customerId: 'c1' }, u => updates.push(u));
    respond(409, { code: 'NO_DEVICE', error: 'No phone paired. Sign in on the Call Tracker app on your phone first.' });
    await flush();
    expect(updates.at(-1)).toMatchObject({ stage: 'error', tone: 'error' });
    expect(updates.at(-1).message).toMatch(/No phone paired/);
    expect(listeners).toHaveLength(0);
  });

  test('cancelling stops listening', () => {
    const cancel = startDial({ customerId: 'c1' }, u => updates.push(u));
    expect(listeners).toHaveLength(1);
    cancel();
    expect(listeners).toHaveLength(0);
  });
});

describe('CallButton', () => {
  beforeEach(() => {
    listeners.length = 0;
    mockRole = 'sales_agent';
  });

  test('is hidden from roles that do not make calls', () => {
    mockRole = 'viewer';
    const { container } = render(withPopups(<CallButton customerId="c1" />));
    expect(container).toBeEmptyDOMElement();
  });

  test('is hidden when there is no customer to call', () => {
    const { container } = render(withPopups(<CallButton customerId={null} />));
    expect(container).toBeEmptyDOMElement();
  });

  test('shows each stage in a popup that updates live, naming the customer', async () => {
    render(withPopups(<CallButton customerId="c1" leadId="l1" customerName="Chaminda" />));
    fireEvent.click(screen.getByRole('button', { name: 'Call Chaminda from your phone' }));
    const popup = () => screen.getByRole('dialog');
    expect(popup()).toHaveTextContent('Sending to your phone…');
    expect(popup()).toHaveTextContent('Calling Chaminda');
    expect(popup()).toHaveAttribute('aria-busy', 'true');

    respond(200, { requestId: 'r9', deviceOnline: true });
    await flush();
    act(() => push({ requestId: 'r9', status: 'busy' }));
    expect(popup()).toHaveTextContent("You're already on a call");
    expect(popup()).not.toHaveAttribute('aria-busy');
    // One popup, updated in place — not a new one per stage.
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  test('a successful call closes its popup by itself', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(withPopups(<CallButton customerId="c1" />));
    fireEvent.click(screen.getByRole('button'));
    respond(200, { requestId: 'r10', deviceOnline: true });
    await flush();
    act(() => push({ requestId: 'r10', status: 'dialing' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Calling on your phone');
    await act(async () => { vi.advanceTimersByTime(3500); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  test('hiding the popup while it works still surfaces a failure', async () => {
    render(withPopups(<CallButton customerId="c1" />));
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    respond(409, { code: 'NO_DEVICE', error: 'No phone paired. Sign in on the Call Tracker app on your phone first.' });
    await flush();
    expect(screen.getByRole('dialog')).toHaveTextContent('No phone paired');
  });

  test('a click inside a clickable table row does not also trigger the row', () => {
    const onRow = vi.fn();
    render(withPopups(
      <div onClick={onRow}>
        <CallButton customerId="c1" />
      </div>
    ));
    fireEvent.click(screen.getByRole('button'));
    expect(onRow).not.toHaveBeenCalled();
  });
});
