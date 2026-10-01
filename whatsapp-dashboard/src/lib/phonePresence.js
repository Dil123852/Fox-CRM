import { useCallback, useEffect, useRef, useState } from 'react';
import { businessDay } from './businessTime';
import { apiFetch } from './api';
import { onEvent } from './sse';

// Is each agent's Call Tracker phone connected to the CRM? (See the backend's
// devicePresence.) Both hooks refetch the moment the server broadcasts a
// `device_status` change, and every minute as a safety net in case a live
// event was missed while the page's own connection was reconnecting.
const REFRESH_MS = 60 * 1000;
// Right after a server restart phones report 'unknown' for ~45s while they
// reconnect; look again once that window has passed.
const UNKNOWN_RECHECK_MS = 50 * 1000;

function usePresence(path, enabled, shouldRefetch) {
  const [data, setData] = useState(null);
  const timer = useRef(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(path);
      if (res.ok) setData(await res.json());
    } catch {
      // Keep the last known state; the next event or tick retries.
    }
  }, [path]);

  useEffect(() => {
    if (!enabled) return undefined;
    load();
    const every = setInterval(load, REFRESH_MS);
    const unsubscribe = onEvent('device_status', ev => {
      let e;
      try {
        e = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!shouldRefetch(e)) return;
      // Coalesce a burst (several phones reconnecting at once) into one fetch.
      clearTimeout(timer.current);
      timer.current = setTimeout(load, 300);
    });
    return () => {
      clearInterval(every);
      clearTimeout(timer.current);
      unsubscribe();
    };
  }, [enabled, load, shouldRefetch]);

  return [data, load];
}

/**
 * The signed-in user's own phone:
 * { status: 'online' | 'offline' | 'unknown' | 'not_paired', lastSeenAt, ... }
 */
export function useMyPhoneStatus(staffId, enabled) {
  const mine = useCallback(e => e.staffId === staffId, [staffId]);
  const [data, load] = usePresence('/api/devices/me', enabled && Boolean(staffId), mine);

  useEffect(() => {
    if (data?.status !== 'unknown') return undefined;
    const t = setTimeout(load, UNKNOWN_RECHECK_MS);
    return () => clearTimeout(t);
  }, [data?.status, load]);

  return data;
}

const anyChange = () => true;

/** Every sales agent's phone (admin only): [{ staff_id, staff_name, status, last_seen_at, ... }]. */
export function useTeamPhoneStatus(enabled) {
  const [data] = usePresence('/api/devices/status', enabled, anyChange);
  return Array.isArray(data) ? data : null;
}

/** "since 10:42" today, "since 23 Sep, 10:42" earlier. */
export function offlineSince(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' });
  const sameDay = businessDay(d) === businessDay();
  return sameDay ? `since ${time}` : `since ${d.toLocaleDateString('en', { day: 'numeric', month: 'short' })}, ${time}`;
}
