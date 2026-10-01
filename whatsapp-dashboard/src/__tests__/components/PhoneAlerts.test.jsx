import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// The real PhoneAlerts, phonePresence hooks and popup (DialogProvider); only
// the network (apiFetch), the live-event channel (onEvent) and the signed-in
// user are replaced.

const listeners = [];
let responses; // path -> JSON body

vi.mock('../../lib/sse', () => ({
  onEvent: vi.fn((event, cb) => {
    const entry = { event, cb };
    listeners.push(entry);
    return () => listeners.splice(listeners.indexOf(entry), 1);
  }),
}));
vi.mock('../../lib/api', () => ({
  apiFetch: vi.fn(async path => ({ ok: true, json: async () => responses[path] })),
}));
let mockStaff;
vi.mock('../../lib/AuthContext', () => ({ useAuth: () => ({ staff: mockStaff }) }));

import PhoneAlerts from '../../components/PhoneAlerts';
import { DialogProvider } from '../../components/DialogProvider';
import { apiFetch } from '../../lib/api';

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
// A phone that has been out of touch for a while (past the one-minute rule),
// vs one that dropped just now.
const minutesAgo = m => new Date(Date.now() - m * 60 * 1000).toISOString();
const LONG_GONE = minutesAgo(5);
const push = data => {
  for (const l of [...listeners]) if (l.event === 'device_status') l.cb({ data: JSON.stringify(data) });
};
const renderAlerts = () =>
  render(
    <MemoryRouter initialEntries={['/leads']}>
      <DialogProvider>
        <PhoneAlerts />
        <Routes>
          <Route path="/leads" element={<p>pipeline page</p>} />
          <Route path="/team" element={<p>team page</p>} />
        </Routes>
      </DialogProvider>
    </MemoryRouter>
  );
const popup = () => screen.queryByRole('dialog') || screen.queryByRole('alertdialog');
// The admin's side notification lives in a polite live region, not a popup.
const sideNote = () => screen.queryByRole('status');

beforeEach(() => {
  listeners.length = 0;
  apiFetch.mockClear();
  sessionStorage.clear();
  mockStaff = { id: 'agent-1', role: 'sales_agent' };
});
afterEach(() => vi.useRealTimers());

describe('sales agent', () => {
  test('gets a popup when their phone is offline', async () => {
    responses = { '/api/devices/me': { status: 'offline', lastSeenAt: LONG_GONE } };
    renderAlerts();
    await flush();
    expect(popup()).toHaveTextContent(/Your Call Tracker phone is not connected to the CRM since/);
    expect(popup()).toHaveTextContent(/Call button won't work/);
  });

  test('gets NO popup when they never signed a phone in — only a connected phone going offline counts', async () => {
    responses = { '/api/devices/me': { status: 'not_paired' } };
    renderAlerts();
    await flush();
    expect(popup()).toBeNull();
  });

  test('gets nothing while the phone is online, or just after a server restart', async () => {
    responses = { '/api/devices/me': { status: 'online' } };
    const first = renderAlerts();
    await flush();
    expect(popup()).toBeNull();
    first.unmount();

    responses = { '/api/devices/me': { status: 'unknown' } };
    renderAlerts();
    await flush();
    expect(popup()).toBeNull();
  });

  test('is told once per disconnection — not again on every refresh — then reminded after 15 minutes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    responses = { '/api/devices/me': { status: 'offline', lastSeenAt: LONG_GONE } };
    renderAlerts();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await flush();
    expect(popup()).toBeNull();

    // The hook refetches every minute; still offline -> no new popup yet.
    await act(async () => { vi.advanceTimersByTime(5 * 60 * 1000); });
    await flush();
    expect(popup()).toBeNull();

    await act(async () => { vi.advanceTimersByTime(11 * 60 * 1000); });
    await flush();
    expect(popup()).toHaveTextContent('not connected to the CRM');
  });

  test('a reconnect ends it; dropping again pops again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    responses = { '/api/devices/me': { status: 'offline', lastSeenAt: LONG_GONE } };
    renderAlerts();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));

    responses = { '/api/devices/me': { status: 'online' } };
    act(() => push({ staffId: 'agent-1', online: true }));
    await act(async () => { vi.advanceTimersByTime(400); });
    await flush();
    // The "not connected" popup is gone; only the self-closing "connected again" shows.
    expect(popup()).toHaveTextContent('connected again');
    await act(async () => { vi.advanceTimersByTime(4500); });
    await flush();
    expect(popup()).toBeNull();

    responses = { '/api/devices/me': { status: 'offline', lastSeenAt: LONG_GONE } };
    act(() => push({ staffId: 'agent-1', online: false }));
    await act(async () => { vi.advanceTimersByTime(400); });
    await flush();
    expect(popup()).toHaveTextContent('not connected to the CRM');
  });
});

describe('one popup slot: a long outage never leaves a pile to close', () => {
  const dialogs = () => [...screen.queryAllByRole('alertdialog'), ...screen.queryAllByRole('dialog')];

  test('the 15-minute reminder replaces the unanswered popup instead of queueing a second one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    responses = { '/api/devices/me': { status: 'offline', lastSeenAt: LONG_GONE } };
    renderAlerts();
    await flush();
    expect(dialogs()).toHaveLength(1);
    // Left unanswered for over an hour: several reminders fire.
    await act(async () => { vi.advanceTimersByTime(65 * 60 * 1000); });
    await flush();
    expect(dialogs()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await flush();
    expect(dialogs()).toHaveLength(0); // one click and it is gone — no backlog
  });

  test('reconnecting swaps the "not connected" popup for "connected again", which closes by itself', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    responses = { '/api/devices/me': { status: 'offline', lastSeenAt: LONG_GONE } };
    renderAlerts();
    await flush();
    expect(popup()).toHaveTextContent('not connected to the CRM');

    responses = { '/api/devices/me': { status: 'online' } };
    act(() => push({ staffId: 'agent-1', online: true }));
    await act(async () => { vi.advanceTimersByTime(400); });
    await flush();
    expect(dialogs()).toHaveLength(1);
    expect(popup()).toHaveTextContent('connected again');
    expect(popup()).not.toHaveTextContent('not connected');

    await act(async () => { vi.advanceTimersByTime(4500); });
    await flush();
    expect(dialogs()).toHaveLength(0);
  });

  test('no "connected again" for a blip that never raised an alert', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    responses = { '/api/devices/me': { status: 'offline', lastSeenAt: new Date().toISOString() } };
    renderAlerts();
    await flush();
    responses = { '/api/devices/me': { status: 'online' } };
    act(() => push({ staffId: 'agent-1', online: true }));
    await act(async () => { vi.advanceTimersByTime(400); });
    await flush();
    expect(dialogs()).toHaveLength(0);
  });
});

describe('a phone that only dozed (the Huawei case)', () => {
  test('a drop that is seconds old does not pop; it pops once the phone has been gone a minute', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    responses = { '/api/devices/me': { status: 'offline', lastSeenAt: new Date().toISOString() } };
    renderAlerts();
    await flush();
    expect(popup()).toBeNull();
    await act(async () => { vi.advanceTimersByTime(61 * 1000); });
    await flush();
    expect(popup()).toHaveTextContent('not connected to the CRM');
  });

  test('back online within the minute: never pops at all', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    responses = { '/api/devices/me': { status: 'offline', lastSeenAt: new Date().toISOString() } };
    renderAlerts();
    await flush();
    responses = { '/api/devices/me': { status: 'online' } };
    act(() => push({ staffId: 'agent-1', online: true }));
    await act(async () => { vi.advanceTimersByTime(400); });
    await flush();
    await act(async () => { vi.advanceTimersByTime(90 * 1000); });
    await flush();
    expect(popup()).toBeNull();
  });

  test("admins get no side note for another agent's phone that dropped seconds ago", async () => {
    mockStaff = { id: 'admin-1', role: 'admin' };
    responses = {
      '/api/devices/me': { status: 'not_paired' },
      '/api/devices/status': [{ staff_id: 'a9', staff_name: 'Ruwan', status: 'offline', last_seen_at: new Date().toISOString() }],
    };
    renderAlerts();
    await flush();
    expect(sideNote()).toBeNull();
  });
});

describe('admin', () => {
  beforeEach(() => {
    mockStaff = { id: 'admin-1', role: 'admin' };
  });

  const team = [
    { staff_id: 'a1', staff_name: 'Nimal', status: 'offline', last_seen_at: LONG_GONE },
    { staff_id: 'a2', staff_name: 'Kasun', status: 'not_paired' },
    { staff_id: 'a3', staff_name: 'Sunil', status: 'online' },
  ];

  test("gets a small side note — not a popup — when an agent's phone goes offline", async () => {
    responses = { '/api/devices/me': { status: 'not_paired' }, '/api/devices/status': team };
    renderAlerts();
    await flush();
    expect(popup()).toBeNull(); // nothing blocks the admin's page
    expect(sideNote()).toHaveTextContent("Nimal's phone went offline");
    expect(sideNote()).toHaveTextContent("Their calls aren't reaching the CRM");
    // Kasun never signed a phone in, so there is nothing that "went offline".
    expect(sideNote()).not.toHaveTextContent('Kasun');
    expect(sideNote()).not.toHaveTextContent('Sunil');
    // The page underneath stays usable, and focus is not taken.
    expect(screen.getByText('pipeline page')).toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
  });

  test("the note's View team link opens the Team page", async () => {
    responses = { '/api/devices/me': { status: 'not_paired' }, '/api/devices/status': team };
    renderAlerts();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'View team' }));
    await flush();
    expect(screen.getByText('team page')).toBeInTheDocument();
    expect(sideNote()).toBeNull();
  });

  test('the note goes away by itself', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    responses = { '/api/devices/me': { status: 'not_paired' }, '/api/devices/status': team };
    renderAlerts();
    await flush();
    expect(sideNote()).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(8500); });
    expect(sideNote()).toBeNull();
  });

  test('several phones going offline together are ONE note, not a pile', async () => {
    responses = {
      '/api/devices/me': { status: 'not_paired' },
      '/api/devices/status': team.map(r => ({ ...r, status: 'offline' })),
    };
    renderAlerts();
    await flush();
    expect(sideNote()).toHaveTextContent('3 phones went offline');
    expect(sideNote()).toHaveTextContent('Nimal, Kasun, Sunil');
    expect(screen.getAllByRole('button', { name: 'Dismiss notification' })).toHaveLength(1);
  });

  test('is not told again about the same phone (even after a reload), only when another one drops', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    responses = { '/api/devices/me': { status: 'not_paired' }, '/api/devices/status': team };
    const first = renderAlerts();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    first.unmount();

    renderAlerts(); // a reload: same phone still offline -> no new note
    await flush();
    expect(sideNote()).toBeNull();

    responses['/api/devices/status'] = team.map(r => (r.staff_id === 'a3' ? { ...r, status: 'offline' } : r));
    act(() => push({ staffId: 'a3', online: false }));
    await act(async () => { vi.advanceTimersByTime(400); });
    await flush();
    expect(sideNote()).toHaveTextContent("Sunil's phone went offline");
  });

  test('an admin who owns a phone gets the full popup for THEIR phone', async () => {
    responses = { '/api/devices/me': { status: 'offline', lastSeenAt: LONG_GONE }, '/api/devices/status': [] };
    renderAlerts();
    await flush();
    expect(popup()).toHaveTextContent('Your Call Tracker phone is not connected');
  });
});

test('roles that do not use a phone get nothing and fetch nothing', async () => {
  mockStaff = { id: 'v1', role: 'viewer' };
  renderAlerts();
  await flush();
  expect(popup()).toBeNull();
  expect(apiFetch).not.toHaveBeenCalled();
});
