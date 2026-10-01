import { useEffect, useRef, useState } from 'react';
import { Phone, Loader2 } from 'lucide-react';
import { useAuth } from '../lib/AuthContext';
import { roleAllowed } from '../lib/roles';
import { startDial, isFinalDialStage } from '../lib/dial';
import { theme } from '../lib/theme';
import { useDialog } from './DialogProvider';

// Roles that make calls — matches POST /api/dial's own gate.
const CALLER_ROLES = ['admin', 'sales_agent'];

// dial.js tone -> popup tone.
const POPUP_TONE = { info: 'info', success: 'success', error: 'error' };

/**
 * "Call" — makes the signed-in user's own phone (the Call Tracker app) dial
 * this customer. The phone number is looked up by the server; only the
 * customer (and optionally the lead the call is about) is sent from here.
 *
 * Progress is shown in a popup that updates live: "Sending to your phone…"
 * -> "Calling on your phone" (closes itself), or the reason it couldn't.
 *
 * variant="icon"  — 19px square for dense table rows.
 * variant="label" — a labelled button for page headers.
 */
export default function CallButton({ customerId, leadId, customerName, variant = 'icon', style }) {
  const { staff } = useAuth();
  const dialog = useDialog();
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef(null);

  useEffect(() => () => cancelRef.current?.(), []);

  if (!customerId || !roleAllowed(staff?.role, CALLER_ROLES)) return null;

  const who = customerName ? `Calling ${customerName}` : null;

  const onClick = e => {
    // Rows in some tables are themselves clickable; a call must not also
    // open the row.
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    cancelRef.current?.();

    const popup = dialog.show({ title: 'Sending to your phone…', message: who, busy: true });
    cancelRef.current = startDial({ customerId, leadId }, update => {
      const final = isFinalDialStage(update.stage);
      const tone = POPUP_TONE[update.tone] || 'info';
      if (final) setBusy(false);

      if (popup.isOpen) {
        popup.update({
          title: update.message,
          message: who,
          tone,
          busy: !final,
          // A call that started needs no reply; anything else waits for OK.
          autoCloseMs: update.stage === 'dialing' ? 3000 : undefined,
        });
      } else if (final && tone === 'error') {
        // Hidden while it was working — a failure must still be seen.
        dialog.alert({ title: update.message, message: who, tone: 'error' });
      }
    });
  };

  const Icon = busy ? Loader2 : Phone;
  const spin = busy ? { animation: 'spin 1s linear infinite' } : undefined;
  const title = customerName ? `Call ${customerName} from your phone` : 'Call from your phone';

  if (variant === 'label') {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        title={title}
        style={{ ...s.labelBtn, ...style, cursor: busy ? 'progress' : 'pointer' }}
      >
        <Icon size={14} style={spin} />
        <span>Call</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title={title}
      aria-label={title}
      className="act-ic"
      style={{ ...s.iconBtn, ...style, cursor: busy ? 'progress' : 'pointer' }}
    >
      <Icon size={11} style={spin} />
    </button>
  );
}

const s = {
  iconBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: theme.surface,
    border: `1px solid ${theme.border}`,
    color: theme.inkSoft,
    width: 19,
    height: 19,
    borderRadius: 5,
    padding: 0,
  },
  labelBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '7px 12px',
    borderRadius: 8,
    border: `1px solid ${theme.border}`,
    background: theme.surface,
    color: theme.ink,
    fontSize: 13,
    fontWeight: 500,
    fontFamily: 'inherit',
  },
};
