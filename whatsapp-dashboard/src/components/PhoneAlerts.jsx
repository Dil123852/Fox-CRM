import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import { roleAllowed } from '../lib/roles';
import { useMyPhoneStatus, useTeamPhoneStatus, offlineSince } from '../lib/phonePresence';
import { useDialog } from './DialogProvider';
import { OPEN_CONNECT_PHONE } from './ConnectPhoneModal';

// When a Call Tracker phone goes offline (mounted once in App, so it follows
// the user across every page and renders nothing itself):
//
//  * The phone's OWNER — the staff member signed in on that phone — gets a
//    popup, then a reminder every 15 minutes while it stays offline, and a
//    short "connected again" once it reconnects. They all share ONE popup
//    slot (a keyed popup): each replaces the one before, so a long outage
//    never leaves a pile of popups to close. Only a phone that WAS signed in counts: an
//    agent who never signed a phone in gets no popup (the Team page shows the
//    admin who hasn't).
//  * An ADMIN gets a small side notification about other people's phones —
//    in the corner, never blocking the page or taking focus, gone by itself
//    after a few seconds — so they know without it interrupting their work.

const REMIND_MS = 15 * 60 * 1000;
// One popup slot for the owner's phone status: each new one replaces the last.
const PHONE_POPUP_KEY = 'phone-status';
// Only alert once a phone has been out of touch this long (counted from its
// last check-in). A phone that dozes — Android battery saving pauses the app
// with the screen off, and some makers (Huawei, Xiaomi) do it hard — drops and
// is back within a minute; alerting on every such blip trained people to
// ignore the alert. A phone that is really off still alerts, one minute later.
export const OFFLINE_CONFIRM_MS = 60 * 1000;
const outOfTouchFor = (lastSeenAt) => (lastSeenAt ? Date.now() - new Date(lastSeenAt).getTime() : null);
const TEAM_SEEN_KEY = 'nidikumba_phone_offline_seen';

function readSeen() {
  try {
    return new Set((sessionStorage.getItem(TEAM_SEEN_KEY) || '').split(',').filter(Boolean));
  } catch {
    return new Set();
  }
}
function writeSeen(set) {
  try {
    sessionStorage.setItem(TEAM_SEEN_KEY, [...set].join(','));
  } catch {
    // Private mode etc.: an admin may just see the note again after a reload.
  }
}

export default function PhoneAlerts() {
  const { staff } = useAuth();
  const role = staff?.role;
  const isAgent = role === 'sales_agent';
  const isAdmin = roleAllowed(role, ['admin']);
  const dialog = useDialog();
  const navigate = useNavigate();

  const mine = useMyPhoneStatus(staff?.id, isAgent || isAdmin);
  const team = useTeamPhoneStatus(isAdmin);

  // ── The owner's own phone: a popup ──
  const ownOffline = mine?.status === 'offline';
  const lastOwnPopup = useRef(0); // when it last popped; 0 = not during this outage

  useEffect(() => {
    if (!ownOffline) {
      // Back online after we told them it was down: swap that popup (or any
      // queued reminder) for a short "connected again" that closes itself.
      // Same key, so it REPLACES the old one — nothing left to close by hand.
      if (lastOwnPopup.current && mine?.status === 'online') {
        dialog.alert({
          key: PHONE_POPUP_KEY,
          title: 'Your Call Tracker phone is connected again',
          message: 'Calls are reaching the CRM and the Call button works.',
          tone: 'success',
          autoCloseMs: 4000,
        });
      }
      lastOwnPopup.current = 0;
      return undefined;
    }
    function popOwn() {
      lastOwnPopup.current = Date.now();
      // Offer the QR sign-in too: a phone that was signed out (or replaced)
      // never reconnects by itself, and scanning is the quickest way back.
      // Keyed: a later outage or reminder replaces this popup instead of
      // queueing another one behind it.
      dialog.confirm({
        key: PHONE_POPUP_KEY,
        title: `Your Call Tracker phone is not connected to the CRM${mine?.lastSeenAt ? ` ${offlineSince(mine.lastSeenAt)}` : ''}`,
        message:
          "Your calls aren't reaching the CRM and the Call button won't work. Open Call Tracker on your phone and check it has internet — it reconnects by itself. If the app says it is signed out, connect it again with a QR code.",
        tone: 'error',
        confirmLabel: 'Connect my phone',
        cancelLabel: 'OK',
      }).then((connect) => {
        if (connect) window.dispatchEvent(new Event(OPEN_CONNECT_PHONE));
      });
    }
    // A new outage pops once the phone has been out of touch for
    // OFFLINE_CONFIRM_MS (a quick doze-and-reconnect never pops)…
    const gone = outOfTouchFor(mine?.lastSeenAt);
    const wait = gone === null ? OFFLINE_CONFIRM_MS : Math.max(0, OFFLINE_CONFIRM_MS - gone);
    let first = null;
    if (!lastOwnPopup.current) {
      // Already out of touch long enough: pop now, exactly as before.
      if (wait === 0) popOwn();
      else first = setTimeout(popOwn, wait);
    }
    // …and while it lasts, a reminder every 15 minutes.
    const t = setInterval(() => {
      if (lastOwnPopup.current && Date.now() - lastOwnPopup.current >= REMIND_MS) popOwn();
    }, 60 * 1000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
    // mine.lastSeenAt only feeds the wording; it must not re-trigger the popup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownOffline, dialog]);

  // ── Admin: other people's phones — a small side notification ──
  const seen = useRef(null);
  if (seen.current === null) seen.current = readSeen();

  useEffect(() => {
    if (!isAdmin || !team) return;
    // Same one-minute rule as the owner's popup: a phone that only dozed is
    // not news. The team list refreshes every minute, so a longer outage is
    // picked up on the next refresh.
    const offline = team.filter(r => {
      if (r.staff_id === staff?.id || r.status !== 'offline') return false;
      const gone = outOfTouchFor(r.last_seen_at);
      return gone === null || gone >= OFFLINE_CONFIRM_MS;
    });
    const ids = new Set(offline.map(r => r.staff_id));
    // Forget phones that came back, so the admin hears if they drop again.
    for (const id of [...seen.current]) if (!ids.has(id)) seen.current.delete(id);
    const fresh = offline.filter(r => !seen.current.has(r.staff_id));
    for (const r of fresh) seen.current.add(r.staff_id);
    writeSeen(seen.current);
    if (fresh.length === 0) return;

    // Several at once (e.g. on first load) are ONE note, not a pile.
    const note =
      fresh.length === 1
        ? {
            title: `${fresh[0].staff_name}'s phone went offline`,
            message: `Their calls aren't reaching the CRM${fresh[0].last_seen_at ? ` (${offlineSince(fresh[0].last_seen_at)})` : ''}.`,
          }
        : {
            title: `${fresh.length} phones went offline`,
            message: `${fresh.map(r => r.staff_name).join(', ')} — their calls aren't reaching the CRM.`,
          };
    dialog.notify({
      // Replaces the previous team-phone note rather than stacking beside it.
      key: 'team-phone-status',
      ...note,
      tone: 'offline',
      action: { label: 'View team', onClick: () => navigate('/team') },
    });
  }, [team, isAdmin, staff?.id, dialog, navigate]);

  return null;
}
