import { useEffect, useMemo, useState } from 'react';
import { RotateCcw, ChevronDown, ChevronRight, Circle } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { theme } from '../lib/theme';
import { ROLE_LABELS, ROLE_BADGE } from '../lib/roles';
import PageHeader from '../components/PageHeader';
import { useErrorPopup } from '../components/DialogProvider';

// The super_admin console. Three tabs over data that ALREADY EXISTED and had
// no UI: activity_log (migration 035), the soft-delete bin (036) and the
// session/login history (045). Nothing here computes business state — it only
// reports what was recorded.

const TABS = [
  { key: 'activity', label: 'Activity' },
  { key: 'deleted',  label: 'Deleted records' },
  { key: 'users',    label: 'Users & hours' },
];

// The soft-deletable types, matching AUDITED[...].soft in the backend. Listing
// them here rather than deriving from the /api/activity `types` payload keeps
// the bin usable even if that request fails.
const DELETABLE = [
  ['orders', 'Orders'],
  ['leads', 'Leads'],
  ['lead_items', 'Lead items'],
  ['customers', 'Customers'],
  ['products', 'Products'],
  ['promo_codes', 'Promo codes'],
  ['order_payments', 'Payments'],
];

const ACTION_BADGE = {
  INSERT:  { label: 'Created',  color: theme.success, bg: theme.successBg },
  UPDATE:  { label: 'Edited',   color: theme.info,    bg: theme.infoBg },
  DELETE:  { label: 'Deleted',  color: theme.high,    bg: theme.highBg },
  RESTORE: { label: 'Restored', color: theme.med,     bg: theme.medBg },
};

const fmtWhen = ts => {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('en', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
};

// Seconds -> "7h 20m". Whole units only: a per-day working total does not need
// second precision, and "7h 20m 14s" is harder to scan down a column.
function fmtHours(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// A jsonb value rendered for a diff cell. Objects are stringified rather than
// dropped, because a jsonb column (orders.items) IS the change being reviewed.
function fmtVal(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// One row's before -> after. activity_log.changes holds {field:{from,to}} for an
// UPDATE, but the WHOLE ROW for an INSERT/DELETE — rendering the latter as a
// diff would show every column as "— -> value", which is noise, so only an
// UPDATE gets the two-column treatment.
function ChangeDetail({ entry }) {
  const changes = entry.changes || {};
  const keys = Object.keys(changes);
  if (!keys.length) return <div style={s.detailEmpty}>No field detail recorded.</div>;

  if (entry.action !== 'UPDATE') {
    return (
      <div style={s.detailWrap}>
        <div style={s.detailNote}>
          {entry.action === 'DELETE' ? 'Values at the time of deletion' : 'Values as created'}
        </div>
        <div style={s.kvGrid}>
          {keys.map(k => (
            <div key={k} style={s.kvRow}>
              <span style={s.kvKey}>{k}</span>
              <span style={s.kvVal}>{fmtVal(changes[k])}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={s.detailWrap}>
      <div style={s.detailNote}>{keys.length} field{keys.length === 1 ? '' : 's'} changed</div>
      <table style={s.diffTable}>
        <thead>
          <tr><th style={s.diffTh}>Field</th><th style={s.diffTh}>Before</th><th style={s.diffTh}>After</th></tr>
        </thead>
        <tbody>
          {keys.map(k => (
            <tr key={k}>
              <td style={s.diffTd}><span style={s.kvKey}>{k}</span></td>
              <td style={{ ...s.diffTd, color: theme.inkFaint }}>{fmtVal(changes[k]?.from)}</td>
              <td style={{ ...s.diffTd, color: theme.ink, fontWeight: 500 }}>{fmtVal(changes[k]?.to)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RoleBadge({ role }) {
  const b = ROLE_BADGE[role] || ROLE_BADGE.viewer;
  return <span style={{ ...s.pill, color: b.color, background: b.bg }}>{ROLE_LABELS[role] || role || '—'}</span>;
}

export default function Oversight() {
  const [tab, setTab] = useState('activity');
  const [search, setSearch] = useState('');

  // Activity tab
  const [entries, setEntries] = useState([]);
  const [openRow, setOpenRow] = useState(null);
  const [actionFilter, setActionFilter] = useState('all');
  const [staffFilter, setStaffFilter] = useState('all');

  // Deleted tab
  const [delType, setDelType] = useState('orders');
  const [deleted, setDeleted] = useState([]);
  const [restoring, setRestoring] = useState(null);

  // Users tab
  const [people, setPeople] = useState({ staff: [], hours: [], logins: [], actions: [], sessionsAvailable: true });
  const [who, setWho] = useState('all');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useErrorPopup(error, 'Something went wrong');

  async function loadActivity() {
    const res = await apiFetch('/api/activity?limit=300');
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Could not load the activity feed');
    setEntries(d.entries || []);
  }

  async function loadDeleted(type) {
    const res = await apiFetch(`/api/deleted/${type}`);
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Could not load deleted records');
    setDeleted(d.records || []);
  }

  async function loadPeople() {
    const res = await apiFetch('/api/staff-activity');
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Could not load staff activity');
    setPeople(d);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        if (tab === 'activity') await loadActivity();
        if (tab === 'deleted') await loadDeleted(delType);
        if (tab === 'users') await loadPeople();
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [tab, delType]);

  async function restore(type, id) {
    setRestoring(id);
    setError('');
    try {
      const res = await apiFetch(`/api/deleted/${type}/${id}/restore`, { method: 'POST' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Restore failed');
      // Drop it from the bin immediately rather than refetching: the record is
      // no longer deleted, so it will not come back in this list anyway.
      setDeleted(rows => rows.filter(r => r.id !== id));
    } catch (e) {
      setError(e.message);
    }
    setRestoring(null);
  }

  const q = search.trim().toLowerCase();

  const shownEntries = useMemo(() => entries.filter(e => {
    if (actionFilter !== 'all' && e.action !== actionFilter) return false;
    if (staffFilter !== 'all' && e.staff_id !== staffFilter) return false;
    if (!q) return true;
    return [e.staff_name, e.label, e.table_name, e.record_id]
      .some(v => (v || '').toLowerCase().includes(q));
  }), [entries, actionFilter, staffFilter, q]);

  // Who appears in the staff filter — built from the feed itself so it only
  // ever offers people who actually did something in the window.
  const actors = useMemo(() => {
    const m = new Map();
    for (const e of entries) if (e.staff_id) m.set(e.staff_id, e.staff_name || e.staff_id);
    return [...m.entries()];
  }, [entries]);

  const shownDeleted = useMemo(() => deleted.filter(r => {
    if (!q) return true;
    return JSON.stringify(r).toLowerCase().includes(q);
  }), [deleted, q]);

  const shownHours = useMemo(
    () => (people.hours || []).filter(h => who === 'all' || h.staff_id === who),
    [people.hours, who]
  );

  const label = t => DELETABLE.find(([k]) => k === t)?.[1] || t;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <PageHeader
        title="Oversight"
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search people, records…"
      />

      <div style={s.tabs} className="app-band scroll-strip">
        {TABS.map(t => (
          <button
            key={t.key}
            style={{ ...s.tab, ...(tab === t.key ? s.tabActive : {}) }}
            onClick={() => { setTab(t.key); setOpenRow(null); }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'activity' && (
        <div style={s.filterBar} className="app-band">
          <label style={s.label}>Action</label>
          <select style={s.select} value={actionFilter} onChange={e => setActionFilter(e.target.value)}>
            <option value="all">All</option>
            {Object.entries(ACTION_BADGE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <label style={s.label}>Staff</label>
          <select style={s.select} value={staffFilter} onChange={e => setStaffFilter(e.target.value)}>
            <option value="all">Everyone</option>
            {actors.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <span style={s.count}>{shownEntries.length} of {entries.length}</span>
        </div>
      )}

      {tab === 'deleted' && (
        <div style={s.filterBar} className="app-band">
          <label style={s.label}>Type</label>
          <select style={s.select} value={delType} onChange={e => setDelType(e.target.value)}>
            {DELETABLE.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <span style={s.count}>{shownDeleted.length} deleted</span>
        </div>
      )}

      {tab === 'users' && (
        <div style={s.filterBar} className="app-band">
          <label style={s.label}>Person</label>
          <select style={s.select} value={who} onChange={e => setWho(e.target.value)}>
            <option value="all">Everyone</option>
            {(people.staff || []).map(p => (
              <option key={p.id} value={p.id}>{p.name}{p.active ? '' : ' (inactive)'}</option>
            ))}
          </select>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: '18px 28px', background: theme.bg }} className="app-band-scroll">
        {loading ? (
          <p style={s.muted}>Loading…</p>
        ) : tab === 'activity' ? (
          <div style={s.card}>
            <table style={s.table}>
              <thead>
                <tr>{['', 'When', 'Who', 'Role', 'Action', 'Record', 'Type'].map((h, i) => (
                  <th key={i} style={s.th}>{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                {shownEntries.length === 0 ? (
                  <tr><td style={s.td} colSpan={7}>Nothing recorded yet.</td></tr>
                ) : shownEntries.map(e => {
                  const a = ACTION_BADGE[e.action] || { label: e.action, color: theme.inkFaint, bg: theme.borderSoft };
                  const open = openRow === e.id;
                  return [
                    <tr key={e.id} style={s.rowClickable} onClick={() => setOpenRow(open ? null : e.id)}>
                      <td style={{ ...s.td, width: 22 }}>
                        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      </td>
                      <td style={s.td}>{fmtWhen(e.created_at)}</td>
                      {/* A write with no actor is the scheduler or a webhook,
                          not a person. Saying "System" is honest; blaming
                          whoever was last seen would not be. */}
                      <td style={{ ...s.td, color: theme.ink }}>{e.staff_name || 'System'}</td>
                      <td style={s.td}>{e.staff_role ? <RoleBadge role={e.staff_role} /> : '—'}</td>
                      <td style={s.td}><span style={{ ...s.pill, color: a.color, background: a.bg }}>{a.label}</span></td>
                      <td style={s.td}>{e.label || e.record_id}</td>
                      <td style={{ ...s.td, color: theme.inkFaint }}>{e.table_name?.replace(/_all$/, '')}</td>
                    </tr>,
                    open && (
                      <tr key={`${e.id}-d`}>
                        <td style={{ ...s.td, background: theme.bg }} colSpan={7}><ChangeDetail entry={e} /></td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
            </table>
          </div>
        ) : tab === 'deleted' ? (
          <div style={s.card}>
            <table style={s.table}>
              <thead>
                <tr>{['Record', 'Deleted', 'By', '', ''].map((h, i) => <th key={i} style={s.th}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {shownDeleted.length === 0 ? (
                  <tr><td style={s.td} colSpan={5}>No deleted {label(delType).toLowerCase()}.</td></tr>
                ) : shownDeleted.map(r => (
                  <tr key={r.id}>
                    <td style={{ ...s.td, color: theme.ink }}>
                      {r.order_number || r.name || r.code || r.customer_name || r.product_type || r.id}
                    </td>
                    <td style={s.td}>{fmtWhen(r.deleted_at)}</td>
                    <td style={s.td}>{r.deleted_by_name || 'System'}</td>
                    <td style={s.td} />
                    <td style={{ ...s.td, textAlign: 'right' }}>
                      <button
                        style={{ ...s.restoreBtn, opacity: restoring === r.id ? 0.5 : 1 }}
                        disabled={restoring === r.id}
                        onClick={() => restore(delType, r.id)}
                      >
                        <RotateCcw size={12} /> {restoring === r.id ? 'Restoring…' : 'Restore'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <>
            {!people.sessionsAvailable && (
              <div style={s.notice}>
                Session recording is not enabled on this database — run
                <code style={s.code}>migrations/045_super_admin_role.sql</code>.
                Sign-in history below still works.
              </div>
            )}

            <div style={s.sectionTitle}>Hours by day</div>
            <div style={s.card}>
              <table style={s.table}>
                <thead>
                  <tr>{['Day', 'Person', 'Role', 'Sessions', 'First seen', 'Last seen', 'Active', ''].map((h, i) => (
                    <th key={i} style={s.th}>{h}</th>
                  ))}</tr>
                </thead>
                <tbody>
                  {shownHours.length === 0 ? (
                    <tr><td style={s.td} colSpan={8}>No sessions recorded yet. Hours appear after the next sign-in.</td></tr>
                  ) : shownHours.map((h, i) => (
                    <tr key={i}>
                      <td style={s.td}>{h.day}</td>
                      <td style={{ ...s.td, color: theme.ink }}>{h.staff_name || '—'}</td>
                      <td style={s.td}>{h.staff_role ? <RoleBadge role={h.staff_role} /> : '—'}</td>
                      <td style={s.td}>{h.session_count}</td>
                      <td style={s.td}>{fmtWhen(h.first_seen)}</td>
                      <td style={s.td}>{fmtWhen(h.last_seen)}</td>
                      <td style={{ ...s.td, color: theme.ink, fontWeight: 500 }}>{fmtHours(h.active_seconds)}</td>
                      <td style={s.td}>
                        {h.currently_online && (
                          <span style={{ ...s.pill, color: theme.success, background: theme.successBg }}>
                            <Circle size={7} fill={theme.success} strokeWidth={0} /> Online
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={s.sectionTitle}>Sign-ins</div>
            <div style={s.card}>
              <table style={s.table}>
                <thead>
                  <tr>{['When', 'Person', 'Result', 'IP'].map((h, i) => <th key={i} style={s.th}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {(people.logins || []).filter(l => who === 'all' || l.staff_id === who).length === 0 ? (
                    <tr><td style={s.td} colSpan={4}>No sign-ins recorded.</td></tr>
                  ) : (people.logins || [])
                    .filter(l => who === 'all' || l.staff_id === who)
                    .map((l, i) => (
                      <tr key={i}>
                        <td style={s.td}>{fmtWhen(l.occurred_at)}</td>
                        <td style={{ ...s.td, color: theme.ink }}>{l.staff_name || '—'}</td>
                        <td style={s.td}>
                          <span style={{
                            ...s.pill,
                            color: l.event === 'login.success' ? theme.success : theme.high,
                            background: l.event === 'login.success' ? theme.successBg : theme.highBg,
                          }}>
                            {l.event === 'login.success' ? 'Signed in' : l.event.replace('login.', '')}
                          </span>
                        </td>
                        <td style={{ ...s.td, fontFamily: theme.mono }}>{l.ip || '—'}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const s = {
  tabs: { display: 'flex', gap: 18, padding: '0 16px', background: theme.surface, borderBottom: `1px solid ${theme.border}`, flexShrink: 0, overflowX: 'auto' },
  tab: {
    fontSize: 11.5, padding: '9px 0 8px', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
    border: 'none', background: 'none', borderBottom: '1.5px solid transparent', marginBottom: -1,
    color: theme.inkSoft, fontWeight: 400, transition: 'color 0.12s',
  },
  tabActive: { color: theme.accentInk, fontWeight: 600, borderBottomColor: theme.accent },

  filterBar: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 16px', background: theme.surface, borderBottom: `1px solid ${theme.border}`, flexShrink: 0, flexWrap: 'wrap' },
  label: { fontSize: 10.5, color: theme.inkSoft, whiteSpace: 'nowrap' },
  select: { background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 6, padding: '4px 7px', color: theme.ink, fontSize: 10.5, outline: 'none', fontFamily: 'inherit', cursor: 'pointer' },
  count: { marginLeft: 'auto', fontSize: 10.5, color: theme.inkFaint },

  card: { background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: theme.radiusLg, overflow: 'hidden', marginBottom: 18 },
  // fontSize/background here rather than relying on inheritance, matching the
  // Pipeline reference (lib/tableStyles.js) so every list reads at the same
  // size. tableLayout is deliberately NOT set: these tables size their columns
  // from content, and forcing 'fixed' would need per-column widths on each.
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 10.5, background: theme.surface },
  // position/top/zIndex added: this was the only main table header in the app
  // without them, so it scrolled out of view while every other page's stayed put.
  th: { textAlign: 'left', fontSize: 8.5, fontWeight: 500, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.06em', padding: '6px 8px', borderBottom: `1px solid ${theme.border}`, background: theme.surface, position: 'sticky', top: 0, zIndex: 1, whiteSpace: 'nowrap' },
  td: { padding: '8px 8px', borderBottom: `1px solid ${theme.borderSoft}`, fontSize: 10.5, color: theme.inkSoft, verticalAlign: 'middle' },
  rowClickable: { cursor: 'pointer' },
  pill: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 600 },

  sectionTitle: { fontSize: 11, fontWeight: 600, color: theme.inkSoft, margin: '0 0 8px 2px' },

  detailWrap: { padding: '4px 2px 8px' },
  detailNote: { fontSize: 10, color: theme.inkFaint, marginBottom: 6 },
  detailEmpty: { fontSize: 10.5, color: theme.inkFaint, padding: '6px 2px' },
  diffTable: { width: '100%', borderCollapse: 'collapse', background: theme.surface, border: `1px solid ${theme.borderSoft}`, borderRadius: 6 },
  diffTh: { textAlign: 'left', fontSize: 8.5, fontWeight: 500, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.06em', padding: '5px 8px', borderBottom: `1px solid ${theme.borderSoft}` },
  diffTd: { padding: '5px 8px', fontSize: 10.5, borderBottom: `1px solid ${theme.borderSoft}`, wordBreak: 'break-word', maxWidth: 320 },
  kvGrid: { display: 'flex', flexDirection: 'column', gap: 2 },
  kvRow: { display: 'flex', gap: 8, fontSize: 10.5 },
  kvKey: { fontFamily: theme.mono, fontSize: 10, color: theme.inkFaint, minWidth: 130 },
  kvVal: { color: theme.inkSoft, wordBreak: 'break-word' },

  restoreBtn: { display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, background: theme.surface, border: `1px solid ${theme.border}`, color: theme.inkSoft, fontSize: 10.5, fontWeight: 500, padding: '0 9px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit' },

  muted: { color: theme.inkFaint, fontSize: 12 },
  error: { background: theme.highBg, color: theme.high, fontSize: 11, padding: '8px 10px', borderRadius: 7, marginBottom: 12 },
  notice: { background: theme.infoBg, color: theme.info, fontSize: 11, padding: '8px 10px', borderRadius: 7, marginBottom: 12 },
  code: { fontFamily: theme.mono, fontSize: 10.5, margin: '0 4px' },
};
