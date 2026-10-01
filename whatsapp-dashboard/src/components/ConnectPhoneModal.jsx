import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { X, Smartphone, RefreshCw, CheckCircle2, Lock, Clock, ShieldCheck } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { roleAllowed } from '../lib/roles';
import { BACKEND_URL } from '../lib/config';
import { onEvent } from '../lib/sse';
import { theme, modalBackdrop } from '../lib/theme';

// "Connect my phone" — signs the logged-in agent's Call Tracker phone in by
// QR instead of typing a password on the phone (migration 056).
//
// The code comes from POST /api/devices/pair-codes and is for the person
// logged in here, nobody else. It works once and for 5 minutes; making a new
// one voids the old. The server asks for the CRM password first (security
// review, confirmed with the user): a logged-in session alone — a stolen
// session token, or a PC left logged in — must not be able to put a phone on
// this account. The password is sent once and never kept in state. The QR is drawn in this browser by the `qrcode` package —
// the code is never sent to an outside QR service.
//
// The QR's text is what the app's scanner parses (PairQr.kt):
// nidikumba-calltracker://pair?server=<API address>&code=<code>.
//
// Which address goes in: the server's CALL_TRACKER_SERVER_URL when set (an
// https tunnel for local testing), otherwise the API this page talks to —
// in production that is this page's own origin (nginx serves both), locally
// it is VITE_BACKEND_URL (http://localhost:3000). A phone can only use an
// https address that is not "localhost", so anything else gets an
// explanation instead of a QR that could never work. The release app
// additionally only accepts its allowlist (crm.nidikumba.shop).

// Any screen can open the window (the sidebar owns it):
//   window.dispatchEvent(new Event(OPEN_CONNECT_PHONE))
export const OPEN_CONNECT_PHONE = 'nidikumba:connect-phone';

/** The address the phone should call, before the server's override. */
export function apiBase() {
  return /^https?:\/\//i.test(BACKEND_URL || '') ? BACKEND_URL.replace(/\/+$/, '') : window.location.origin;
}

/** Can a phone on the network use this address? https, and not this PC. */
export function phoneCanUse(server) {
  try {
    const u = new URL(server);
    return u.protocol === 'https:' && !/^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(u.hostname);
  } catch {
    return false;
  }
}

export function pairQrText(origin, code) {
  return `nidikumba-calltracker://pair?server=${encodeURIComponent(origin)}&code=${encodeURIComponent(code)}`;
}

// "2:45 PM" and "about 12 minutes" for a block that ends at [until] (ms).
const clockTime = (until) => new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function roughly(ms) {
  const m = Math.max(1, Math.ceil(ms / 60000));
  return m === 1 ? 'about a minute' : `about ${m} minutes`;
}

const fmt = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export default function ConnectPhoneModal({ onClose }) {
  // password | loading | ready | expired | unreachable | blocked | connected | error
  const [state, setState] = useState({ status: 'password' });
  const { staff } = useAuth();
  const isAdmin = roleAllowed(staff?.role, ['admin']);
  const [clearing, setClearing] = useState(false);
  const [password, setPassword] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);

  // Every new code needs the password again — a QR left open cannot be
  // refreshed by whoever sits down at the PC later.
  const askPassword = useCallback((error = null) => {
    setPassword('');
    setState({ status: 'password', error });
  }, []);

  const makeCode = useCallback(async (pw) => {
    setState({ status: 'loading' });
    try {
      const res = await apiFetch('/api/devices/pair-codes', {
        method: 'POST',
        body: JSON.stringify({ password: pw }),
      });
      const data = await res.json().catch(() => ({}));
      if (!alive.current) return;
      // Too many codes, or the account is locked after wrong passwords: a
      // calm explanation with the time it clears, instead of a bare error.
      if (data.code === 'pair_code_limit' || data.code === 'account_locked') {
        const until = data.until ? new Date(data.until).getTime() : Date.now() + 15 * 60000;
        setNow(Date.now()); // so "about N minutes" is right from the first frame
        setState({ status: 'blocked', kind: data.code === 'account_locked' ? 'locked' : 'limit', until });
        return;
      }
      // Wrong password (403) or missing (400): back to the password step.
      if (res.status === 403 || res.status === 400) {
        const left = data.attemptsLeft;
        askPassword(
          data.code === 'wrong_password' && Number.isInteger(left)
            ? `Incorrect password — ${left} ${left === 1 ? 'try' : 'tries'} left before your account locks for 15 minutes.`
            : data.error || 'Incorrect password'
        );
        return;
      }
      if (!res.ok) throw new Error(data.error || 'Could not make a sign-in code');
      const server = data.server || apiBase();
      if (!phoneCanUse(server)) {
        if (alive.current) setState({ status: 'unreachable', server });
        return;
      }
      const image = await QRCode.toDataURL(pairQrText(server, data.code), {
        errorCorrectionLevel: 'M', margin: 2, width: 260,
      });
      if (alive.current) setState({ status: 'ready', image, expiresAt: new Date(data.expiresAt).getTime() });
    } catch (err) {
      if (alive.current) setState({ status: 'error', error: err.message });
    }
  }, [askPassword]);

  useEffect(() => {
    alive.current = true;
    // Subscribe BEFORE asking for the code, so a very fast scan cannot land
    // before we are listening (same ordering as CallButton).
    const off = onEvent('device_paired', (e) => {
      let d = {};
      try { d = JSON.parse(e.data); } catch { /* ignore */ }
      if (alive.current) setState({ status: 'connected', deviceName: d.deviceName });
    });
    return () => { alive.current = false; off(); };
  }, []);

  function submitPassword(e) {
    e.preventDefault();
    if (!password) return;
    const pw = password;
    setPassword(''); // not kept once sent
    makeCode(pw);
  }

  useEffect(() => {
    if (state.status !== 'ready' && state.status !== 'blocked') return undefined;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (state.status === 'ready' && n >= state.expiresAt) setState((s) => (s.status === 'ready' ? { status: 'expired' } : s));
      // A block that has run out needs no action: straight back to the password.
      if (state.status === 'blocked' && n >= state.until) setState((s) => (s.status === 'blocked' ? { status: 'password' } : s));
    }, 1000);
    return () => clearInterval(t);
  }, [state]);

  // An admin blocked on their OWN account can clear it here; everyone else is
  // pointed at User Management.
  async function clearOwnBlock() {
    setClearing(true);
    try {
      const res = await apiFetch(`/api/staff/${staff.id}/clear-signin-block`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not clear it');
      if (alive.current) askPassword();
    } catch (err) {
      if (alive.current) setState((s) => ({ ...s, clearError: err.message }));
    } finally {
      if (alive.current) setClearing(false);
    }
  }

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div style={modalBackdrop} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={s.modal} role="dialog" aria-label="Connect my phone">
        <div style={s.header}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={s.icon}><Smartphone size={16} color={theme.accentInk} /></div>
            <div>
              <p style={s.title}>Connect my phone</p>
              <p style={s.sub}>Sign the Call Tracker app in — nothing to type on the phone</p>
            </div>
          </div>
          <button style={s.closeBtn} onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        <div style={s.body}>
          {state.status === 'connected' ? (
            <div style={s.done}>
              <CheckCircle2 size={42} color={theme.success} />
              <p style={s.doneTitle}>Phone connected</p>
              <p style={s.doneText}>
                {state.deviceName ? `${state.deviceName} is` : 'Your phone is'} now signed in and syncing calls.
                Any phone signed in before is signed out.
              </p>
              <button style={s.primary} onClick={onClose}>Done</button>
            </div>
          ) : state.status === 'blocked' ? (
            <div style={s.blocked}>
              <div style={s.blockedIcon}><Clock size={20} color={theme.med} /></div>
              <p style={s.pwTitle}>{state.kind === 'locked' ? 'Your account is locked for now' : 'Too many codes for now'}</p>
              <p style={s.pwText}>
                {state.kind === 'locked'
                  ? 'For your safety, the account locks for a while after 5 wrong passwords.'
                  : 'For your safety, making sign-in codes pauses after 10 in 15 minutes.'}
                {' '}You can try again at <strong>{clockTime(state.until)}</strong> ({roughly(state.until - now)}).
              </p>
              <div style={s.hintBox}>
                <ShieldCheck size={15} color={theme.accentInk} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>
                  {isAdmin
                    ? 'You are an admin, so you can clear this now.'
                    : <>Need it sooner? Ask an admin to open <strong>User Management</strong> and press <strong>Clear sign-in block</strong> next to your name.</>}
                </span>
              </div>
              {state.clearError && <p style={s.pwError}>{state.clearError}</p>}
              {isAdmin ? (
                <button style={{ ...s.primary, opacity: clearing ? 0.6 : 1 }} onClick={clearOwnBlock} disabled={clearing}>
                  {clearing ? 'Clearing…' : 'Clear it now'}
                </button>
              ) : (
                <button style={s.secondary} onClick={onClose}>Close</button>
              )}
            </div>
          ) : state.status === 'password' ? (
            <form style={s.pwForm} onSubmit={submitPassword}>
              <div style={s.pwIcon}><Lock size={18} color={theme.accentInk} /></div>
              <p style={s.pwTitle}>Confirm it&apos;s you</p>
              <p style={s.pwText}>
                Enter your CRM password to make a one-time sign-in code for your phone.
                You won&apos;t need to type anything on the phone.
              </p>
              {/* The username for this password, hidden. Without it the
                  browser's password manager pairs the password with whatever
                  text box it finds (often a search box), then autofills that
                  box with a phone number and password fields with the password. */}
              <input
                type="text"
                name="username"
                autoComplete="username"
                value={staff?.phone || ''}
                readOnly
                hidden
              />
              <input
                style={s.pwInput}
                type="password"
                name="current-password"
                autoComplete="current-password"
                placeholder="CRM password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
              />
              {state.error && <p style={s.pwError}>{state.error}</p>}
              <button type="submit" style={{ ...s.primary, opacity: password ? 1 : 0.5 }} disabled={!password}>
                Show my sign-in code
              </button>
            </form>
          ) : (
            <>
              <div style={s.qrBox}>
                {state.status === 'ready' && <img src={state.image} alt="Sign-in QR code" width={260} height={260} style={s.qr} />}
                {state.status === 'loading' && <div className="summary-spinner" />}
                {state.status === 'expired' && (
                  <div style={s.overlay}>
                    <p style={s.overlayText}>This code has expired</p>
                    <button style={s.primary} onClick={() => askPassword()}><RefreshCw size={13} /> Make a new code</button>
                  </div>
                )}
                {state.status === 'unreachable' && (
                  <div style={s.overlay}>
                    <p style={{ ...s.overlayText, color: theme.high }}>Phones can&apos;t reach this CRM address</p>
                    <p style={s.unreachText}>
                      <code style={s.code}>{state.server}</code> is only reachable from this computer
                      {state.server.startsWith('http:') ? ', and phones need https' : ''}.
                      Use the live CRM, or for testing set <code style={s.code}>CALL_TRACKER_SERVER_URL</code> in
                      the backend&apos;s .env to an https tunnel (e.g. ngrok) and restart it.
                    </p>
                  </div>
                )}
                {state.status === 'error' && (
                  <div style={s.overlay}>
                    <p style={{ ...s.overlayText, color: theme.high }}>{state.error}</p>
                    <button style={s.primary} onClick={() => askPassword()}><RefreshCw size={13} /> Try again</button>
                  </div>
                )}
              </div>
              {state.status === 'ready' && (
                <p style={s.timer}>
                  Expires in <strong>{fmt(state.expiresAt - now)}</strong> · works once
                  <button style={s.link} onClick={() => askPassword()}>New code</button>
                </p>
              )}
              <ol style={s.steps}>
                <li>Open <strong>Call Tracker</strong> on your phone.</li>
                <li>Tap <strong>Scan QR to sign in</strong> and point it at this code.</li>
                <li>Allow the permissions it asks for. Syncing starts by itself.</li>
              </ol>
              <p style={s.warn}>Don&apos;t share or photograph this code — for 5 minutes it signs a phone in as you.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const s = {
  modal: { background: theme.surface, borderRadius: 16, width: '100%', maxWidth: 420, boxShadow: theme.shadowMd, overflow: 'hidden', fontFamily: theme.font },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: `1px solid ${theme.border}`, gap: 12 },
  icon: { width: 32, height: 32, borderRadius: 9, background: theme.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  title: { margin: 0, fontSize: 14, fontWeight: 700, color: theme.ink },
  sub: { margin: '2px 0 0', fontSize: 11.5, color: theme.inkFaint },
  closeBtn: { background: theme.borderSoft, border: 'none', cursor: 'pointer', width: 32, height: 32, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.inkSoft },
  body: { padding: '18px 22px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center' },
  qrBox: { position: 'relative', width: 260, height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${theme.border}`, borderRadius: 12, background: '#fff' },
  qr: { display: 'block', borderRadius: 12 },
  overlay: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: 16, textAlign: 'center' },
  overlayText: { margin: 0, fontSize: 13, fontWeight: 600, color: theme.ink },
  unreachText: { margin: 0, fontSize: 11.5, color: theme.inkSoft, lineHeight: 1.5 },
  code: { fontFamily: theme.mono, fontSize: 10.5, background: theme.borderSoft, padding: '1px 4px', borderRadius: 4, wordBreak: 'break-all' },
  timer: { margin: '10px 0 0', fontSize: 12, color: theme.inkSoft, display: 'flex', alignItems: 'center', gap: 8 },
  link: { background: 'none', border: 'none', color: theme.accentInk, fontWeight: 600, fontSize: 12, cursor: 'pointer', padding: 0, fontFamily: 'inherit' },
  steps: { margin: '16px 0 0', paddingLeft: 18, fontSize: 12.5, color: theme.inkSoft, lineHeight: 1.7, alignSelf: 'stretch' },
  warn: { margin: '12px 0 0', fontSize: 11, color: theme.inkFaint, alignSelf: 'stretch', lineHeight: 1.45 },
  primary: { display: 'inline-flex', alignItems: 'center', gap: 6, background: theme.accent, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  blocked: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, alignSelf: 'stretch', textAlign: 'center' },
  blockedIcon: { width: 44, height: 44, borderRadius: 14, background: theme.medBg, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  hintBox: { display: 'flex', gap: 8, alignItems: 'flex-start', textAlign: 'left', alignSelf: 'stretch', background: theme.accentSoft, color: theme.accentInk, borderRadius: 10, padding: '10px 12px', fontSize: 12, lineHeight: 1.5 },
  secondary: { background: theme.surface, color: theme.ink, border: `1px solid ${theme.border}`, borderRadius: 8, padding: '8px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  pwForm: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, alignSelf: 'stretch', textAlign: 'center' },
  pwIcon: { width: 40, height: 40, borderRadius: 12, background: theme.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  pwTitle: { margin: 0, fontSize: 15, fontWeight: 700, color: theme.ink },
  pwText: { margin: 0, fontSize: 12.5, color: theme.inkSoft, lineHeight: 1.5 },
  pwInput: { width: '100%', boxSizing: 'border-box', background: theme.bg, border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '10px 12px', fontSize: 14, color: theme.ink, fontFamily: 'inherit' },
  pwError: { margin: 0, fontSize: 12, fontWeight: 600, color: theme.high },
  done: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '12px 0', textAlign: 'center' },
  doneTitle: { margin: 0, fontSize: 16, fontWeight: 700, color: theme.ink },
  doneText: { margin: '0 0 8px', fontSize: 12.5, color: theme.inkSoft, lineHeight: 1.5 },
};
