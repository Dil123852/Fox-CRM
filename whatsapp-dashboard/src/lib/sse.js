import { BACKEND_URL } from './config';
import { getToken } from './api';

// Shared EventSource — auto-reconnects on error (browser built-in behaviour).
// EventSource can't set an Authorization header, so the staff token travels
// as a query param instead; the backend's `authenticate` middleware accepts both.
let es = null;

function getSource() {
  if (!es || es.readyState === EventSource.CLOSED) {
    es = new EventSource(`${BACKEND_URL}/api/events?token=${encodeURIComponent(getToken() || '')}`);
  }
  return es;
}

// Whether live updates are unavailable (blocked/unsupported EventSource).
// Pages still load their data over normal fetch; they just don't refresh by
// themselves.
let sseBroken = false;
export const isLiveUpdatesBroken = () => sseBroken;

/**
 * Subscribe to a named SSE event.
 * Returns an unsubscribe function — call it in useEffect cleanup.
 *
 * Supported events: 'message_insert' | 'customer_update' | 'lead_update'
 */
export function onEvent(event, callback) {
  try {
    const source = getSource();
    source.addEventListener(event, callback);
    return () => {
      try { source.removeEventListener(event, callback); } catch { /* already gone */ }
    };
  } catch (err) {
    // Never let a live-update subscription break the page that asked for it.
    sseBroken = true;
    console.warn(
      `[sse] Live updates unavailable (${err?.message || err}). ` +
      'The page will still load its data, but will not refresh automatically.'
    );
    return () => {};
  }
}

// Call on logout so a stale connection carrying the old token doesn't linger.
export function closeSource() {
  if (es) { es.close(); es = null; }
}
