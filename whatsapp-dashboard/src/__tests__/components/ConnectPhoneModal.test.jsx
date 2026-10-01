import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

// The live "device_paired" event is captured so a test can fire it.
let pairedHandler = null;
vi.mock('../../lib/sse', () => ({
  onEvent: (name, cb) => {
    if (name === 'device_paired') pairedHandler = cb;
    return () => { pairedHandler = null; };
  },
}));
const apiFetch = vi.fn();
vi.mock('../../lib/api', () => ({ apiFetch: (...a) => apiFetch(...a) }));
const toDataURL = vi.fn(async (text) => `data:image/png;base64,${btoa(text).slice(0, 8)}`);
vi.mock('qrcode', () => ({ default: { toDataURL: (...a) => toDataURL(...a) } }));
// Production shape: same-origin API (VITE_BACKEND_URL empty).
vi.mock('../../lib/config', () => ({ BACKEND_URL: '' }));
let me = { id: 'agent-1', name: 'Kasun', role: 'sales_agent' };
vi.mock('../../lib/AuthContext', () => ({ useAuth: () => ({ staff: me }) }));

import ConnectPhoneModal, { pairQrText, phoneCanUse } from '../../components/ConnectPhoneModal';

const CODE = 'A'.repeat(43);
const LIVE = 'https://crm.nidikumba.shop';
const okCode = (code = CODE, ms = 5 * 60 * 1000, server = LIVE) => ({
  ok: true,
  status: 200,
  json: async () => ({ code, expiresAt: new Date(Date.now() + ms).toISOString(), server }),
});

beforeEach(() => {
  me = { id: 'agent-1', name: 'Kasun', role: 'sales_agent' };
  apiFetch.mockReset();
  toDataURL.mockClear();
  pairedHandler = null;
});
afterEach(() => vi.useRealTimers());

async function openAndConfirm(password = 'my-pass') {
  await act(async () => { render(<ConnectPhoneModal onClose={() => {}} />); });
  fireEvent.change(screen.getByPlaceholderText('CRM password'), { target: { value: password } });
  await act(async () => { fireEvent.click(screen.getByText('Show my sign-in code')); });
}

describe('pairQrText', () => {
  it('is the exact text the Call Tracker scanner parses', () => {
    expect(pairQrText('https://crm.nidikumba.shop', CODE))
      .toBe(`nidikumba-calltracker://pair?server=https%3A%2F%2Fcrm.nidikumba.shop&code=${CODE}`);
  });
});

describe('ConnectPhoneModal', () => {
  it('asks for the password first, and makes no code until it is given', async () => {
    await act(async () => { render(<ConnectPhoneModal onClose={() => {}} />); });
    expect(screen.getByText("Confirm it's you")).toBeTruthy();
    expect(apiFetch).not.toHaveBeenCalled();
    expect(screen.queryByAltText('Sign-in QR code')).toBeNull();
  });

  it('sends the password once, then draws the QR locally with a countdown', async () => {
    apiFetch.mockResolvedValue(okCode());
    await openAndConfirm('my-pass');
    expect(apiFetch).toHaveBeenCalledWith('/api/devices/pair-codes', { method: 'POST', body: JSON.stringify({ password: 'my-pass' }) });
    expect(toDataURL.mock.calls[0][0]).toBe(pairQrText(LIVE, CODE));
    expect(screen.getByAltText('Sign-in QR code')).toBeTruthy();
    expect(screen.getByText(/Expires in/)).toBeTruthy();
  });

  it('a wrong password stays on the password step with the reason, and clears the field', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'Incorrect password. Too many wrong tries locks the account for a while.' }) });
    await openAndConfirm('nope');
    expect(screen.getByText(/Incorrect password/)).toBeTruthy();
    expect(screen.getByPlaceholderText('CRM password').value).toBe('');
    expect(toDataURL).not.toHaveBeenCalled();
  });

  it('is subscribed to the paired event before any code exists', async () => {
    let subscribedFirst = false;
    apiFetch.mockImplementation(async () => { subscribedFirst = pairedHandler !== null; return okCode(); });
    await openAndConfirm();
    expect(subscribedFirst).toBe(true);
  });

  it('turns into "Phone connected" when the phone signs in', async () => {
    apiFetch.mockResolvedValue(okCode());
    await openAndConfirm();
    act(() => pairedHandler({ data: JSON.stringify({ deviceName: 'Samsung A12' }) }));
    expect(screen.getByText('Phone connected')).toBeTruthy();
    expect(screen.getByText(/Samsung A12 is now signed in/)).toBeTruthy();
    expect(screen.queryByAltText('Sign-in QR code')).toBeNull();
  });

  it('expires, and a new code needs the password again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiFetch.mockResolvedValue(okCode(CODE, 2000));
    await openAndConfirm();
    await act(async () => { vi.advanceTimersByTime(3500); });
    expect(screen.getByText('This code has expired')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByText('Make a new code')); });
    expect(screen.getByText("Confirm it's you")).toBeTruthy();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("shows the server's own error for anything else, and lets them retry", async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 429, json: async () => ({ error: 'Too many sign-in codes. Wait a few minutes and try again.' }) });
    await openAndConfirm();
    expect(screen.getByText(/Too many sign-in codes/)).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();
  });

  it('explains, instead of showing a useless QR, when phones cannot reach the address', async () => {
    apiFetch.mockResolvedValue(okCode(CODE, 300000, null));
    await openAndConfirm();
    expect(screen.getByText("Phones can't reach this CRM address")).toBeTruthy();
    expect(screen.getByText('CALL_TRACKER_SERVER_URL')).toBeTruthy();
    expect(screen.queryByAltText('Sign-in QR code')).toBeNull();
    expect(toDataURL).not.toHaveBeenCalled();
  });
});

describe('phoneCanUse', () => {
  it('accepts a public https address, refuses http and this computer', () => {
    expect(phoneCanUse('https://crm.nidikumba.shop')).toBe(true);
    expect(phoneCanUse('https://abc123.ngrok-free.app')).toBe(true);
    expect(phoneCanUse('http://crm.nidikumba.shop')).toBe(false);
    expect(phoneCanUse('https://localhost:3000')).toBe(false);
    expect(phoneCanUse('http://localhost:5173')).toBe(false);
    expect(phoneCanUse('https://127.0.0.1')).toBe(false);
    expect(phoneCanUse('not a url')).toBe(false);
  });
});

describe('when codes are blocked — friendly, with the way out', () => {
  const inMinutes = (m) => new Date(Date.now() + m * 60000).toISOString();
  const blocked = (code, minutes = 12) => ({ ok: false, status: code === 'pair_code_limit' ? 429 : 403, json: async () => ({ code, until: inMinutes(minutes) }) });

  it('too many codes: says why, when it clears, and to ask an admin', async () => {
    apiFetch.mockResolvedValue(blocked('pair_code_limit'));
    await openAndConfirm();
    expect(screen.getByText('Too many codes for now')).toBeTruthy();
    expect(screen.getByText(/pauses after 10 in 15 minutes/)).toBeTruthy();
    expect(screen.getByText(/about 12 minutes/)).toBeTruthy();
    expect(screen.getByText(/Clear sign-in block/)).toBeTruthy();
    expect(screen.queryByText('Clear it now')).toBeNull(); // not an admin
    expect(screen.queryByText(/Too many sign-in codes\. Wait/)).toBeNull(); // the old bare text is gone
  });

  it('locked account: its own wording', async () => {
    apiFetch.mockResolvedValue(blocked('account_locked', 9));
    await openAndConfirm();
    expect(screen.getByText('Your account is locked for now')).toBeTruthy();
    expect(screen.getByText(/after 5 wrong passwords/)).toBeTruthy();
  });

  it('an admin can clear their own block right there, and goes back to the password step', async () => {
    me = { id: 'admin-1', name: 'Dilsara', role: 'admin' };
    apiFetch.mockResolvedValueOnce(blocked('pair_code_limit'));
    await openAndConfirm();
    apiFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true }) });
    await act(async () => { fireEvent.click(screen.getByText('Clear it now')); });
    expect(apiFetch).toHaveBeenLastCalledWith('/api/staff/admin-1/clear-signin-block', { method: 'POST' });
    expect(screen.getByText("Confirm it's you")).toBeTruthy();
  });

  it('a wrong password says how many tries are left', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({ code: 'wrong_password', attemptsLeft: 2 }) });
    await openAndConfirm('nope');
    expect(screen.getByText(/2 tries left before your account locks/)).toBeTruthy();
  });

  it('when the block runs out, it goes back to the password step by itself', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiFetch.mockResolvedValue({ ok: false, status: 429, json: async () => ({ code: 'pair_code_limit', until: new Date(Date.now() + 1500).toISOString() }) });
    await openAndConfirm();
    expect(screen.getByText('Too many codes for now')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(2500); });
    expect(screen.getByText("Confirm it's you")).toBeTruthy();
  });
});
