import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { businessDay, addDays } from '../lib/businessTime';
import { createPortal } from 'react-dom';
import { PhoneIncoming, PhoneOutgoing, PhoneMissed } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { theme } from '../lib/theme';
import { formatDuration } from '../lib/callFormat';

// "Last calls" dots for a lead (Pipeline table and lead page header), with a
// hover card listing the customer's recent call history.
//
// `calls` is the lead's recent_calls from GET /api/leads(/:id) — the newest
// three, already scoped by the server to what this person may see. The card
// fetches a longer list from GET /api/calls?customerId=, which applies the
// same scope, so a sales agent never sees another agent's calls here.
//
// Colours are soft pastels of red (missed), green (outgoing) and blue
// (incoming) so a column of them reads calmly beside the rest of the table.
// An outgoing call that never connected (0s) is a ring with no fill.

const HISTORY_LIMIT = 10;

export const CALL_KIND = {
  MISSED:   { label: 'Missed',   fill: '#F4C7BE', ring: '#E3A194', ink: theme.high,    soft: theme.highBg,    Icon: PhoneMissed },
  OUTGOING: { label: 'Outgoing', fill: '#C6E4CD', ring: '#93C7A1', ink: theme.success, soft: theme.successBg, Icon: PhoneOutgoing },
  INCOMING: { label: 'Incoming', fill: '#C9D9F1', ring: '#98B4DE', ink: theme.info,    soft: theme.infoBg,    Icon: PhoneIncoming },
};

// A short-lived cache so moving the pointer back and forth over a row does
// not refetch every time. Entries expire after 30s so a call synced a minute
// ago still shows up. Keyed by WHO is logged in as well as the customer: the
// server scopes what each person may see, and without the viewer in the key
// a sales agent signing in on the same tab right after an admin would be
// shown the admin's cached (every agent's) history.
const cache = new Map();
const CACHE_MS = 30_000;

function fetchHistory(viewerId, customerId) {
  const key = `${viewerId || 'anon'}:${customerId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const promise = apiFetch(`/api/calls?customerId=${encodeURIComponent(customerId)}&limit=${HISTORY_LIMIT}`)
    .then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    // Keep only this customer's rows. A backend that predates the
    // customerId filter ignores it and returns the whole call log — without
    // this every lead's card would show the same (other people's) calls.
    .then(data => {
      const all = data.calls || [];
      const calls = all.filter(c => c.customer_id === customerId);
      return { calls, total: calls.length === all.length ? (data.total ?? calls.length) : calls.length };
    })
    .catch(err => {
      cache.delete(key);
      throw err;
    });
  cache.set(key, { at: Date.now(), promise });
  return promise;
}

function whenLabel(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const day = businessDay(d);
  const today = businessDay();
  const time = d.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' });
  if (day === today) return `Today, ${time}`;
  if (day === addDays(today, -1)) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString('en', { day: 'numeric', month: 'short' })}, ${time}`;
}

function durationLabel(type, seconds) {
  if (type === 'MISSED') return 'Missed';
  return Number(seconds) > 0 ? formatDuration(seconds) : 'No answer';
}

function Dot({ call, size = 8 }) {
  const k = CALL_KIND[call.type];
  const hollow = call.type === 'OUTGOING' && !(Number(call.duration) > 0);
  return (
    <span
      style={{
        width: size, height: size, borderRadius: '50%', flexShrink: 0, boxSizing: 'border-box',
        background: hollow ? 'transparent' : k.fill,
        border: `1.5px solid ${k.ring}`,
      }}
    />
  );
}

export default function CallDots({ calls, customerId, customerName }) {
  const list = (Array.isArray(calls) ? calls : []).filter(c => CALL_KIND[c.type]).slice(0, 3);
  const triggerRef = useRef(null);
  const [open, setOpen] = useState(false);
  const openTimer = useRef(null);
  const closeTimer = useRef(null);

  const clearTimers = () => { clearTimeout(openTimer.current); clearTimeout(closeTimer.current); };
  const show = useCallback(() => {
    clearTimeout(closeTimer.current);
    openTimer.current = setTimeout(() => setOpen(true), 180);
  }, []);
  const hide = useCallback(() => {
    clearTimeout(openTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 160);
  }, []);
  useEffect(() => clearTimers, []);

  if (list.length === 0) return <span style={s.none}>—</span>;

  return (
    <>
      <span
        ref={triggerRef}
        style={{ ...s.pill, ...(open ? s.pillOpen : null) }}
        tabIndex={0}
        role="button"
        aria-label={`Call history${customerName ? ` for ${customerName}` : ''}`}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={() => setOpen(true)}
        onBlur={hide}
        onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}
      >
        {list.map((c, i) => <Dot key={`${c.at}-${i}`} call={c} />)}
      </span>
      {open && customerId && (
        <HistoryCard
          anchor={triggerRef.current}
          customerId={customerId}
          customerName={customerName}
          onEnter={() => clearTimeout(closeTimer.current)}
          onLeave={hide}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

const CARD_W = 300;

function HistoryCard({ anchor, customerId, customerName, onEnter, onLeave, onClose }) {
  const [state, setState] = useState({ loading: true, calls: [], total: 0, error: null });
  const [pos, setPos] = useState(null);
  const cardRef = useRef(null);
  const { staff } = useAuth();
  const viewerId = staff?.id;

  useEffect(() => {
    let alive = true;
    fetchHistory(viewerId, customerId)
      .then(d => { if (alive) setState({ loading: false, calls: d.calls, total: d.total, error: null }); })
      .catch(() => { if (alive) setState({ loading: false, calls: [], total: 0, error: 'Could not load call history' }); });
    return () => { alive = false; };
  }, [viewerId, customerId]);

  // Placed under the dots, flipped above when there is no room below, and
  // kept inside the window horizontally. Recomputed when the content height
  // changes (loading -> rows).
  useLayoutEffect(() => {
    if (!anchor || !cardRef.current) return;
    const r = anchor.getBoundingClientRect();
    const h = cardRef.current.offsetHeight;
    const below = r.bottom + 8;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - 8 - h) : below;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - CARD_W / 2), window.innerWidth - CARD_W - 8);
    setPos({ top, left });
  }, [anchor, state]);

  // The card is fixed-position, so it would float away from its row on
  // scroll — close it instead. Scrolling the card's own list is not that.
  useEffect(() => {
    const close = e => {
      if (e.type === 'scroll' && cardRef.current && cardRef.current.contains(e.target)) return;
      onClose();
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [onClose]);

  const counts = state.calls.reduce((acc, c) => ({ ...acc, [c.call_type]: (acc[c.call_type] || 0) + 1 }), {});

  return createPortal(
    <div
      ref={cardRef}
      role="dialog"
      aria-label="Call history"
      style={{ ...s.card, top: pos?.top ?? -9999, left: pos?.left ?? -9999, opacity: pos ? 1 : 0 }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div style={s.head}>
        <div style={{ minWidth: 0 }}>
          <div style={s.title}>Call history</div>
          {customerName && <div style={s.sub}>{customerName}</div>}
        </div>
        {!state.loading && !state.error && state.calls.length > 0 && (
          <div style={s.summary}>
            {Object.keys(CALL_KIND).filter(k => counts[k]).map(k => (
              <span key={k} style={{ ...s.count, color: CALL_KIND[k].ink, background: CALL_KIND[k].soft }}>
                {counts[k]} {CALL_KIND[k].label.toLowerCase()}
              </span>
            ))}
          </div>
        )}
      </div>

      {state.loading ? (
        <div style={s.list}>
          {[0, 1, 2].map(i => <div key={i} style={s.skeleton} />)}
        </div>
      ) : state.error ? (
        <div style={s.empty}>{state.error}</div>
      ) : state.calls.length === 0 ? (
        <div style={s.empty}>No calls recorded</div>
      ) : (
        <div style={s.list}>
          {state.calls.map(c => {
            const k = CALL_KIND[c.call_type];
            if (!k) return null;
            const Icon = k.Icon;
            const connected = c.call_type !== 'MISSED' && Number(c.duration_seconds) > 0;
            return (
              <div key={c.id} style={s.row}>
                <span style={{ ...s.icon, color: k.ink, background: k.soft }}><Icon size={12} strokeWidth={2} /></span>
                <div style={s.rowMain}>
                  <div style={s.rowType}>{k.label}</div>
                  <div style={s.rowMeta}>{whenLabel(c.occurred_at)}{c.staff_name ? ` · ${c.staff_name}` : ''}</div>
                </div>
                <span style={{ ...s.dur, color: connected ? theme.ink : theme.inkFaint }}>
                  {durationLabel(c.call_type, c.duration_seconds)}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {!state.loading && state.total > state.calls.length && (
        <div style={s.foot}>Latest {state.calls.length} of {state.total} calls</div>
      )}
    </div>,
    document.body
  );
}

const s = {
  none: { color: theme.inkFaint, fontSize: 12 },
  pill: {
    display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 7px', borderRadius: 999,
    background: theme.bg, border: `1px solid ${theme.borderSoft}`, cursor: 'default', outline: 'none',
    transition: 'border-color 0.15s, background 0.15s',
  },
  pillOpen: { background: theme.surface, borderColor: theme.border },
  card: {
    position: 'fixed', zIndex: 400, width: CARD_W, boxSizing: 'border-box',
    background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: theme.radius,
    boxShadow: theme.shadowMd, fontFamily: theme.font, transition: 'opacity 0.12s',
  },
  head: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, padding: '10px 12px 8px', borderBottom: `1px solid ${theme.borderSoft}` },
  title: { fontSize: 11.5, fontWeight: 600, color: theme.ink },
  sub: { fontSize: 10.5, color: theme.inkFaint, marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  summary: { display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: 'flex-end' },
  count: { fontSize: 9.5, fontWeight: 500, padding: '2px 6px', borderRadius: 999, whiteSpace: 'nowrap' },
  list: { padding: '4px 0', maxHeight: 300, overflowY: 'auto' },
  row: { display: 'flex', alignItems: 'center', gap: 9, padding: '6px 12px' },
  icon: { width: 22, height: 22, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  rowMain: { flex: 1, minWidth: 0 },
  rowType: { fontSize: 11.5, fontWeight: 500, color: theme.ink },
  rowMeta: { fontSize: 10.5, color: theme.inkFaint, marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  dur: { fontSize: 11, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  skeleton: { height: 22, margin: '6px 12px', borderRadius: 6, background: theme.borderSoft },
  empty: { padding: '14px 12px', fontSize: 11.5, color: theme.inkFaint },
  foot: { padding: '7px 12px 9px', fontSize: 10, color: theme.inkFaint, borderTop: `1px solid ${theme.borderSoft}` },
};
