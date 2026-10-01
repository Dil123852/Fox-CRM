import { apiFetch } from './api';
import { onEvent } from './sse';

// Click-to-call (migration 050): ask the CRM to make the CURRENT user's own
// phone (the Call Tracker app) dial a customer, and follow what happens.
//
// The number is never sent from here — the server looks it up from the
// customer — so this can only ever dial a real customer record.

// How long to wait for the phone to act before telling the agent something is
// wrong. The server's own window is 60s; a phone that received the command
// normally reports back within a second or two.
const PHONE_RESPONSE_MS = 20000;
const OFFLINE_WINDOW_MS = 60000;

// What the agent is told for each stage. `tone` drives the colour.
export const DIAL_MESSAGES = {
  sending: { text: 'Sending to your phone…', tone: 'info' },
  delivered: { text: 'Sent — waiting for your phone…', tone: 'info' },
  pending: { text: 'Your phone is offline — it will dial if it reconnects within a minute', tone: 'info' },
  dialing: { text: 'Calling on your phone', tone: 'success' },
  busy: { text: "You're already on a call", tone: 'error' },
  needs_tap: { text: 'Tap the notification on your phone to call', tone: 'info' },
  failed: { text: "Your phone couldn't place the call", tone: 'error' },
  no_response: { text: 'No response from your phone — is the Call Tracker app running?', tone: 'error' },
  expired: { text: "Your phone didn't come online — the call was not placed", tone: 'error' },
};

// Stages after which nothing more will happen for this click.
const FINAL = new Set(['dialing', 'busy', 'needs_tap', 'failed', 'no_response', 'expired', 'error']);
export const isFinalDialStage = stage => FINAL.has(stage);

/**
 * Starts a call and reports each stage to `onUpdate({ stage, message, tone })`.
 * Returns a cancel function (call it on unmount).
 */
export function startDial({ customerId, leadId }, onUpdate) {
  let requestId = null;
  let done = false;
  let timer = null;
  const early = []; // dial_status events that arrive before the POST returns

  const emit = (stage, detail) => {
    if (done) return;
    const base = DIAL_MESSAGES[stage] || { text: detail || 'Something went wrong', tone: 'error' };
    // A phone-reported failure carries its own explanation ("This phone
    // blocked the automatic call") — more useful than the generic line.
    const message = stage === 'failed' && detail ? detail : base.text;
    onUpdate({ stage, message, tone: base.tone });
    if (FINAL.has(stage)) finish();
  };

  const armTimer = (ms, stage) => {
    clearTimeout(timer);
    timer = setTimeout(() => emit(stage), ms);
  };

  const handle = data => {
    if (data.status === 'delivered') {
      emit('delivered');
      armTimer(PHONE_RESPONSE_MS, 'no_response');
    } else {
      emit(data.status, data.error);
    }
  };

  // Subscribed BEFORE the request: the server can announce "delivered" before
  // its own HTTP response reaches us, and that event must not be lost.
  const unsubscribe = onEvent('dial_status', ev => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!requestId) early.push(data);
    else if (data.requestId === requestId) handle(data);
  });

  function finish() {
    done = true;
    clearTimeout(timer);
    unsubscribe();
  }

  emit('sending');
  apiFetch('/api/dial', { method: 'POST', body: JSON.stringify({ customerId, leadId: leadId || undefined }) })
    .then(async res => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        emit('error', data.error || `Could not start the call (${res.status})`);
        return;
      }
      requestId = data.requestId;
      if (data.deviceOnline) {
        emit('delivered');
        armTimer(PHONE_RESPONSE_MS, 'no_response');
      } else {
        emit('pending');
        armTimer(OFFLINE_WINDOW_MS, 'expired');
      }
      for (const e of early.splice(0)) if (e.requestId === requestId) handle(e);
    })
    .catch(() => emit('error', 'Could not reach the server'));

  return () => {
    if (!done) finish();
  };
}
