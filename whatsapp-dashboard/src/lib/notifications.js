import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from './api';
import { onEvent } from './sse';

// Staff notifications (migration 053) — today only admins receive any: a
// custom discount given on an order by a non-admin. Stored server-side, so an
// admin who was offline still sees them; pushed live over SSE as a
// 'notification' event to just the recipients.
//
// Several components read them at once (the sidebar badge, the page, the live
// corner note). Rather than a global store, each hook instance fetches its
// own copy and a window event tells the others to refetch after a change, so
// marking one read on the page also clears the sidebar badge.

const CHANGED = 'nidikumba:notifications-changed';
const announce = () => window.dispatchEvent(new Event(CHANGED));

export function useNotifications(enabled = true) {
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(enabled);

  const load = useCallback(() => {
    if (!enabled) return;
    apiFetch('/api/notifications')
      .then(r => r.json())
      .then(d => {
        setItems(d.notifications || []);
        setUnread(d.unread || 0);
      })
      // The bell is informational: an unreachable list must not break a page.
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    // Subscribe before fetching, so an event arriving mid-load is not missed.
    const off = onEvent('notification', load);
    window.addEventListener(CHANGED, load);
    load();
    return () => {
      off();
      window.removeEventListener(CHANGED, load);
    };
  }, [enabled, load]);

  const markRead = useCallback(async id => {
    setItems(list => list.map(n => (n.id === id && !n.read_at ? { ...n, read_at: new Date().toISOString() } : n)));
    try {
      await apiFetch(`/api/notifications/${id}/read`, { method: 'POST' });
    } finally {
      announce();
    }
  }, []);

  const markAllRead = useCallback(async () => {
    const now = new Date().toISOString();
    setItems(list => list.map(n => (n.read_at ? n : { ...n, read_at: now })));
    setUnread(0);
    try {
      await apiFetch('/api/notifications/read-all', { method: 'POST' });
    } finally {
      announce();
    }
  }, []);

  return { items, unread, loading, markRead, markAllRead, reload: load };
}
