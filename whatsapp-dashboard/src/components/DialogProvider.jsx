import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, WifiOff, X, XCircle } from 'lucide-react';
import { theme, modalBackdrop } from '../lib/theme';

// The CRM's popup screens. Every message the dashboard shows — confirmations,
// errors, "saved" notices, phone-status warnings, the Call button's progress —
// goes through here, instead of the browser's window.confirm()/alert()
// ("localhost:5173 says"), a bottom toast, or loose red text in a form.
//
//   const dialog = useDialog();
//
//   // Ask: resolves true / false.
//   if (!(await dialog.confirm({ title: 'Delete order #1024?', message: '…',
//                                confirmLabel: 'Delete order', tone: 'danger' }))) return;
//
//   // Tell: resolves when dismissed. autoCloseMs closes it by itself.
//   await dialog.alert({ title: 'Could not delete the order', message: err });
//   dialog.alert({ title: 'Order placed', tone: 'success', autoCloseMs: 4000 });
//
//   // Live: a popup that updates while something happens (not awaited).
//   const p = dialog.show({ title: 'Sending…', busy: true });
//   p.update({ title: 'Calling on your phone', tone: 'success', busy: false, autoCloseMs: 3000 });
//   p.close();
//
//   // Side notification: a small card in the corner that does NOT block the
//   // page or take focus, and fades out by itself. For things worth knowing but
//   // not worth interrupting someone's work for (an agent's phone going offline,
//   // told to the admin).
//   dialog.notify({ title: "Nimal's phone went offline", message: '…',
//                   action: { label: 'View team', onClick: () => navigate('/team') } });
//
// Requests made while a popup is already open are queued and shown in turn,
// never dropped or stacked on top of each other.
//
// ...unless they carry a `key`. A popup with a key REPLACES any popup with the
// same key, whether it is on screen or still waiting in the queue, instead of
// queueing behind it. For status that changes over time — "your phone is not
// connected", then "connected again" — where only the latest is true and the
// older ones would just be popups to close one by one:
//   dialog.confirm({ key: 'phone-status', title: 'Phone not connected', … });
//   dialog.alert({ key: 'phone-status', title: 'Connected again', tone: 'success', autoCloseMs: 4000 });
// A replaced popup settles as dismissed (confirm -> false, alert -> undefined).
// notify() takes a key too: the new side note replaces the old one.

const DialogContext = createContext(null);

const TONES = {
  // Destructive actions: red confirm button, and Cancel focused first so a
  // stray Enter can't delete anything.
  danger: { Icon: AlertTriangle, color: theme.high, bg: theme.highBg, confirmBg: theme.high },
  error: { Icon: XCircle, color: theme.high, bg: theme.highBg, confirmBg: theme.ink },
  warning: { Icon: AlertTriangle, color: theme.med, bg: theme.medBg, confirmBg: theme.ink },
  success: { Icon: CheckCircle2, color: theme.success, bg: theme.successBg, confirmBg: theme.success },
  info: { Icon: Info, color: theme.accentInk, bg: theme.accentSoft, confirmBg: theme.accent },
};

export function DialogProvider({ children }) {
  const [queue, setQueue] = useState([]);
  const [notes, setNotes] = useState([]);
  const nextId = useRef(0);

  const dismissNote = useCallback(id => setNotes(n => n.filter(x => x.id !== id)), []);

  const enqueue = useCallback((kind, options, resolve) => {
    const opts = typeof options === 'string' ? { message: options } : options || {};
    // A stable id per popup, so one queued behind it never re-mounts the
    // popup that is currently open (which would steal its focus).
    const id = ++nextId.current;
    const entry = { id, kind, ...opts, resolve };
    setQueue(q => {
      if (!opts.key) return [...q, entry];
      const i = q.findIndex(d => d.key === opts.key);
      if (i === -1) return [...q, entry];
      // Settle the replaced popup as dismissed. Calling resolve again (React
      // may run an updater twice) is harmless: a promise settles only once.
      const old = q[i];
      old.resolve(old.kind === 'confirm' ? false : undefined);
      // Takes the old one's place, so replacing the popup on screen keeps it
      // on screen rather than sending the new one to the back of the queue.
      return [...q.slice(0, i), entry, ...q.slice(i + 1).filter(d => d.key !== opts.key)];
    });
    return id;
  }, []);

  const api = useMemo(
    () => ({
      confirm: options => new Promise(resolve => enqueue('confirm', options, resolve)),
      alert: options => new Promise(resolve => enqueue('alert', options, resolve)),
      show: options => {
        let open = true;
        const id = enqueue('alert', options, () => {
          open = false;
        });
        return {
          update: patch => setQueue(q => q.map(d => (d.id === id ? { ...d, ...patch } : d))),
          close: () => {
            open = false;
            setQueue(q => q.filter(d => d.id !== id));
          },
          // False once the user dismissed it (e.g. pressed Hide while busy), so
          // a caller can re-surface an outcome that must not be missed.
          get isOpen() {
            return open;
          },
        };
      },
      notify: options => {
        const opts = typeof options === 'string' ? { title: options } : options || {};
        const id = ++nextId.current;
        // Newest first; never more than a few, so they cannot pile up down the
        // side of someone's screen. A keyed note replaces its predecessor.
        setNotes(n => [{ id, ...opts }, ...(opts.key ? n.filter(x => x.key !== opts.key) : n)].slice(0, MAX_NOTES));
        return id;
      },
    }),
    [enqueue]
  );

  const current = queue[0];
  // Resolve outside the state updater: updaters must stay pure (React may run
  // one twice), and this one is only about removing the popup from the queue.
  const close = useCallback((dialog, value) => {
    dialog.resolve(value);
    setQueue(q => q.filter(d => d.id !== dialog.id));
  }, []);

  return (
    <DialogContext.Provider value={api}>
      {children}
      {current && <DialogView key={current.id} dialog={current} onClose={value => close(current, value)} />}
      {notes.length > 0 && (
        // role="status" + polite: screen readers announce it without
        // interrupting, matching how it looks — present, never in the way.
        <div style={s.noteStack} role="status" aria-live="polite">
          {notes.map(n => (
            <SideNote key={n.id} note={n} onDismiss={() => dismissNote(n.id)} />
          ))}
        </div>
      )}
    </DialogContext.Provider>
  );
}

export function useDialog() {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialog() must be used inside <DialogProvider>');
  return ctx;
}

/**
 * Shows a form's action error (a failed Save / Delete / Send / load) as a
 * popup instead of red text inside the form. Pass the component's existing
 * error state; each NEW error pops once. The state itself is left alone, so
 * code that checks it keeps working.
 */
export function useErrorPopup(error, title = 'Something went wrong') {
  const dialog = useDialog();
  const shown = useRef(null);
  useEffect(() => {
    if (!error) {
      shown.current = null;
      return;
    }
    if (error === shown.current) return;
    shown.current = error;
    dialog.alert({ title, message: String(error), tone: 'error' });
  }, [error, title, dialog]);
}

const MAX_NOTES = 3;
const NOTE_MS = 8000;
const NOTE_TONES = {
  offline: { Icon: WifiOff, color: theme.med, bg: theme.medBg },
  warning: { Icon: AlertTriangle, color: theme.med, bg: theme.medBg },
  success: { Icon: CheckCircle2, color: theme.success, bg: theme.successBg },
  info: { Icon: Info, color: theme.accentInk, bg: theme.accentSoft },
};

// One side notification. Fades out after NOTE_MS, but not while the pointer
// is over it (someone reading it, or about to click its action).
function SideNote({ note, onDismiss }) {
  const tone = NOTE_TONES[note.tone] || NOTE_TONES.info;
  const Icon = tone.Icon;
  const [hover, setHover] = useState(false);

  useEffect(() => {
    if (hover) return undefined;
    const t = setTimeout(onDismiss, note.durationMs || NOTE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hover, note.durationMs]);

  return (
    <div
      style={s.note}
      className="summary-card"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div style={{ ...s.noteIcon, background: tone.bg }}>
        <Icon size={14} color={tone.color} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={s.noteTitle}>{note.title}</div>
        {note.message && <div style={s.noteMessage}>{note.message}</div>}
        {note.action && (
          <button
            type="button"
            style={s.noteAction}
            onClick={() => {
              note.action.onClick?.();
              onDismiss();
            }}
          >
            {note.action.label}
          </button>
        )}
      </div>
      <button type="button" style={s.noteClose} onClick={onDismiss} aria-label="Dismiss notification" title="Dismiss">
        <X size={13} />
      </button>
    </div>
  );
}

function DialogView({ dialog, onClose }) {
  const isConfirm = dialog.kind === 'confirm';
  const tone = TONES[dialog.tone] || (isConfirm ? TONES.info : TONES.error);
  const Icon = dialog.busy ? Loader2 : tone.Icon;
  const titleId = useId();
  const messageId = useId();
  const confirmRef = useRef(null);
  const cancelRef = useRef(null);

  const cancel = () => onClose(isConfirm ? false : undefined);
  const accept = () => onClose(isConfirm ? true : undefined);

  // Focus Cancel for a destructive confirm, the main button otherwise; and
  // give focus back to whatever had it before the popup opened.
  useEffect(() => {
    const previous = document.activeElement;
    const target = isConfirm && dialog.tone === 'danger' ? cancelRef.current : confirmRef.current;
    target?.focus();
    return () => previous?.focus?.();
  }, [isConfirm, dialog.tone]);

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // A notice that closes itself (e.g. "Order placed"). Restarts if the popup
  // is updated with a new delay, and never runs while it is still busy.
  useEffect(() => {
    if (!dialog.autoCloseMs || dialog.busy) return undefined;
    const t = setTimeout(accept, dialog.autoCloseMs);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog.autoCloseMs, dialog.busy, dialog.title]);

  return (
    <div
      style={{ ...modalBackdrop, zIndex: 1000 }}
      // Clicking outside counts as Cancel — never as confirming.
      onMouseDown={e => e.target === e.currentTarget && cancel()}
    >
      <div
        role={isConfirm ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={dialog.message ? messageId : undefined}
        aria-busy={dialog.busy ? 'true' : undefined}
        style={s.card}
        className="summary-card"
      >
        <div style={s.head}>
          <div style={{ ...s.icon, background: tone.bg }}>
            <Icon size={18} color={tone.color} style={dialog.busy ? { animation: 'spin 1s linear infinite' } : undefined} />
          </div>
          <div style={{ minWidth: 0 }}>
            <h2 id={titleId} style={s.title}>
              {dialog.title || (isConfirm ? 'Are you sure?' : 'Something went wrong')}
            </h2>
            {dialog.message && (
              <p id={messageId} style={s.message}>
                {dialog.message}
              </p>
            )}
          </div>
        </div>

        <div style={s.actions}>
          {isConfirm && (
            <button type="button" ref={cancelRef} onClick={cancel} style={s.cancelBtn}>
              {dialog.cancelLabel || 'Cancel'}
            </button>
          )}
          <button
            type="button"
            ref={confirmRef}
            onClick={accept}
            style={dialog.busy ? s.cancelBtn : { ...s.confirmBtn, background: tone.confirmBg }}
          >
            {dialog.confirmLabel || (dialog.busy ? 'Hide' : isConfirm ? 'Confirm' : 'OK')}
          </button>
        </div>
      </div>
    </div>
  );
}

const s = {
  // Bottom-right, above page content but below a real popup, and out of the
  // way of the Pipeline's pager and the page's own action buttons.
  noteStack: {
    position: 'fixed',
    right: 16,
    bottom: 16,
    zIndex: 900,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    width: 'min(320px, calc(100vw - 32px))',
    pointerEvents: 'none',
  },
  note: {
    pointerEvents: 'auto',
    display: 'flex',
    gap: 10,
    alignItems: 'flex-start',
    background: theme.surface,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radius,
    boxShadow: theme.shadowMd,
    padding: '10px 10px 10px 12px',
    fontFamily: theme.font,
  },
  noteIcon: { width: 26, height: 26, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  noteTitle: { fontSize: 12.5, fontWeight: 600, color: theme.ink, lineHeight: 1.35 },
  noteMessage: { fontSize: 11.5, color: theme.inkSoft, lineHeight: 1.4, marginTop: 2, whiteSpace: 'pre-line' },
  noteAction: {
    marginTop: 6,
    background: 'none',
    border: 'none',
    padding: 0,
    color: theme.accentInk,
    fontSize: 11.5,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    textDecoration: 'underline',
  },
  noteClose: { background: 'none', border: 'none', color: theme.inkFaint, cursor: 'pointer', padding: 2, display: 'flex', flexShrink: 0 },
  card: {
    background: theme.surface,
    borderRadius: theme.radiusLg,
    boxShadow: theme.shadowMd,
    border: `1px solid ${theme.border}`,
    width: 'min(420px, calc(100vw - 32px))',
    padding: '20px 20px 16px',
    fontFamily: theme.font,
  },
  head: { display: 'flex', gap: 14, alignItems: 'flex-start' },
  icon: { width: 36, height: 36, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  title: { margin: '2px 0 0', fontSize: 15, fontWeight: 700, color: theme.ink, lineHeight: 1.35 },
  message: { margin: '6px 0 0', fontSize: 13, color: theme.inkSoft, lineHeight: 1.5, whiteSpace: 'pre-line', overflowWrap: 'anywhere' },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20, flexWrap: 'wrap' },
  cancelBtn: {
    background: theme.surface,
    border: `1px solid ${theme.border}`,
    color: theme.ink,
    fontSize: 13,
    fontWeight: 600,
    padding: '8px 16px',
    borderRadius: 8,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  confirmBtn: {
    border: 'none',
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    padding: '8px 16px',
    borderRadius: 8,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
};
