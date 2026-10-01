import { useEffect, useMemo, useRef, useState } from 'react';
import { businessDay } from '../lib/businessTime';
import * as XLSX from 'xlsx';
import { useNavigate } from 'react-router-dom';
import { PhoneMissed, CheckCircle2, Clock, ExternalLink, Download, Filter } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { theme } from '../lib/theme';
import { roleAllowed } from '../lib/roles';
import { formatDuration, localDay } from '../lib/callFormat';
import { tb } from '../lib/toolbarStyles';
import { useAuth } from '../lib/AuthContext';
import PageHeader from '../components/PageHeader';
import CallButton from '../components/CallButton';
import StaffFilter, { staffFilterLabel, useStaffRoster } from '../components/StaffFilter';

// v_missed_call_callbacks.callback_status (migration 043) — two values only.
// Deliberately NOT reusing Calls.jsx's CALL_TYPE: that maps call_events.call_type
// (incoming/outgoing/missed), a different vocabulary. This is the callback's own
// state, which is why it has its own icons and colours.
const CALLBACK_STATUS = {
  pending: { label: 'Pending', color: theme.high,    bg: theme.highBg,    Icon: Clock },
  done:    { label: 'Done',    color: theme.success, bg: theme.successBg, Icon: CheckCircle2 },
};

const DEFAULT_THRESHOLD = 15;

// Whole-unit elapsed time. Reported ONLY for a completed callback, where it is
// a fact about what happened — never for a pending row, which would imply a
// deadline this feature deliberately does not have.
function formatElapsed(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return '—';
  if (s < 60) return `${Math.floor(s)}s`;
  const mins = Math.floor(s / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return mins % 60 ? `${hrs}h ${mins % 60}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return hrs % 24 ? `${days}d ${hrs % 24}h` : `${days}d`;
}

function formatWhen(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Same export shape as the Calls page: durations go out as real numbers in a
// parallel "(s)" column so Excel can sort them, and every timestamp is guarded
// before use so an unparseable value never exports the text "Invalid Date".
const CALLBACK_COLS = [
  { key: 'number',       label: 'Number' },
  { key: 'contact',      label: 'Contact' },
  { key: 'missed',       label: 'Missed calls' },
  { key: 'firstMiss',    label: 'First miss' },
  { key: 'lastMissDate', label: 'Latest miss (date)' },
  { key: 'lastMissTime', label: 'Latest miss (time)' },
  { key: 'missedOn',     label: 'Missed on (agent)' },
  { key: 'status',       label: 'Status' },
  { key: 'backDate',     label: 'Called back (date)' },
  { key: 'backTime',     label: 'Called back (time)' },
  { key: 'backBy',       label: 'Called back by' },
  { key: 'backDuration', label: 'Callback duration' },
  { key: 'backSeconds',  label: 'Callback duration (s)' },
  { key: 'elapsed',      label: 'Time to callback' },
  { key: 'customer',     label: 'Known customer' },
];

function downloadCallbacksXLSX(rowsIn, meta) {
  const headers = CALLBACK_COLS.map(c => c.label);

  const safeDate = ts => {
    if (!ts) return null;
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  const rows = rowsIn.map(r => {
    const miss = safeDate(r.latest_missed_at);
    const first = safeDate(r.first_missed_at);
    const back = safeDate(r.called_back_at);
    const backSecs = Number(r.callback_duration_seconds);
    return CALLBACK_COLS.map(col => {
      switch (col.key) {
        case 'number':       return r.raw_phone_number || r.phone_canon || '';
        case 'contact':      return r.customer_name || r.contact_name || '';
        case 'missed':       return Number(r.missed_count) || 0;
        case 'firstMiss':    return first ? first.toLocaleDateString('en-GB') : '';
        case 'lastMissDate': return miss ? miss.toLocaleDateString('en-GB') : '';
        case 'lastMissTime': return miss ? miss.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
        // Whose phone (migration 051); blank for calls synced before it.
        case 'missedOn':     return r.missed_on_staff_name || '';
        case 'backBy':       return r.called_back_at ? (r.called_back_by_name || '') : '';
        case 'status':       return CALLBACK_STATUS[r.callback_status]?.label || r.callback_status || '';
        case 'backDate':     return back ? back.toLocaleDateString('en-GB') : '';
        case 'backTime':     return back ? back.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
        case 'backDuration': return r.called_back_at ? formatDuration(r.callback_duration_seconds) : '';
        // Guarded on called_back_at, not on the number: Number(null) is 0, not
        // NaN, so a bare isFinite check exported a pending row as "0" — which
        // reads as a 0-second callback rather than no callback at all.
        case 'backSeconds':  return r.called_back_at && Number.isFinite(backSecs) ? backSecs : '';
        case 'elapsed':      return r.called_back_at ? formatElapsed(r.time_to_callback_seconds) : '';
        case 'customer':     return r.customer_id ? (r.customer_name || 'Linked') : 'Not in CRM';
        default:             return '';
      }
    });
  });

  const pendingCount = rowsIn.filter(r => r.callback_status === 'pending').length;

  // A one-line record of which filters produced this file, plus the threshold
  // the statuses were computed under — without it a sheet mailed to someone
  // else is ambiguous about what "Done" even meant.
  const filterLine = [
    meta.statusFilter !== 'all' ? `Status: ${meta.statusFilter}` : null,
    meta.dateFrom || meta.dateTo ? `Latest miss: ${meta.dateFrom || 'any'} to ${meta.dateTo || 'any'}` : null,
    meta.staffFilter !== 'all' ? `Missed on: ${meta.staffLabel}` : null,
    meta.search ? `Search: "${meta.search}"` : null,
    `Callback counts over ${meta.threshold}s`,
  ].filter(Boolean).join('  |  ');

  const ws = XLSX.utils.aoa_to_sheet([
    [`Nidikumba missed-call callbacks — ${rowsIn.length} number${rowsIn.length === 1 ? '' : 's'}, ${pendingCount} pending`],
    [filterLine],
    [],
    headers,
    ...rows,
  ]);
  ws['!cols'] = CALLBACK_COLS.map(c => ({ wch: Math.max(c.label.length + 4, 13) }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Callbacks');
  XLSX.writeFile(wb, `Nidikumba_Callbacks_${businessDay()}.xlsx`);
}

export default function CallbackTracker() {
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  // 'all' | a staff id | 'none' — whose phone the miss rang on (058).
  // Admins/viewers only; the server gives a sales agent only their own misses.
  const [staffFilter, setStaffFilter] = useState('all');
  const roster = useStaffRoster();
  const [loading, setLoading] = useState(true);
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [thresholdDraft, setThresholdDraft] = useState(String(DEFAULT_THRESHOLD));
  const [savingThreshold, setSavingThreshold] = useState(false);
  const [thresholdError, setThresholdError] = useState('');
  // The date range moved behind a popover (see the toolbar below), so it needs
  // its own open state and a way to dismiss without a mouse click.
  const [dateOpen, setDateOpen] = useState(false);
  const dateRef = useRef(null);
  const navigate = useNavigate();
  const { staff } = useAuth();
  const isAdmin = roleAllowed(staff?.role, ['admin']);

  async function load(agent = staffFilter) {
    setLoading(true);
    try {
      const q = agent !== 'all' ? `?staffId=${encodeURIComponent(agent)}` : '';
      const res = await apiFetch(`/api/calls/callbacks${q}`);
      const data = await res.json();
      const list = data.callbacks || [];
      setRows(list);
      // The view reports the threshold it actually applied. Trust that over a
      // separate settings read so the header can never claim one number while
      // the statuses below were computed under another.
      if (list.length && Number.isFinite(Number(list[0].threshold_seconds))) {
        const applied = Number(list[0].threshold_seconds);
        setThreshold(applied);
        setThresholdDraft(String(applied));
      }
    } catch (e) { console.error(e); }
    setLoading(false);
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(staffFilter); }, [staffFilter]);

  // Dismiss the date popover on an outside click or Escape. The popover holds
  // focusable inputs, so a keyboard user needs a way out that isn't a click.
  useEffect(() => {
    if (!dateOpen) return;
    function onClickOutside(e) {
      if (dateRef.current && !dateRef.current.contains(e.target)) setDateOpen(false);
    }
    function onKey(e) { if (e.key === 'Escape') setDateOpen(false); }
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [dateOpen]);

  // Only admins can read this endpoint; it is the fallback for when the list is
  // empty and therefore carries no threshold_seconds of its own.
  useEffect(() => {
    if (!isAdmin) return;
    apiFetch('/api/settings/callback-threshold')
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!d || !Number.isFinite(Number(d.seconds))) return;
        setThreshold(Number(d.seconds));
        setThresholdDraft(String(Number(d.seconds)));
      })
      .catch(() => {});
  }, [isAdmin]);

  const draftValid = /^\d+$/.test(thresholdDraft) && Number(thresholdDraft) <= 3600;
  const draftChanged = draftValid && Number(thresholdDraft) !== threshold;

  async function saveThreshold() {
    if (!draftChanged) return;
    setSavingThreshold(true);
    setThresholdError('');
    try {
      const res = await apiFetch('/api/settings/callback-threshold', {
        method: 'PATCH',
        body: JSON.stringify({ seconds: Number(thresholdDraft) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setThresholdError(body.error || 'Could not save');
        setThresholdDraft(String(threshold));   // revert; leave the table alone
        return;
      }
      setThreshold(Number(thresholdDraft));
      await load();                             // statuses re-evaluate immediately
    } catch {
      setThresholdError('Could not reach the server');
      setThresholdDraft(String(threshold));
    } finally {
      setSavingThreshold(false);
    }
  }

  const filtered = useMemo(() => rows.filter(r => {
    if (statusFilter !== 'all' && r.callback_status !== statusFilter) return false;

    // Ranged on the LATEST miss, on the local calendar day (see localDay), so
    // the table and the export can never disagree about which day a miss was.
    if (dateFrom || dateTo) {
      const d = localDay(r.latest_missed_at);
      if (!d) return false;
      if (dateFrom && d < dateFrom) return false;
      if (dateTo && d > dateTo) return false;
    }

    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (r.customer_name || '').toLowerCase().includes(q)
      || (r.contact_name || '').toLowerCase().includes(q)
      || (r.raw_phone_number || '').toLowerCase().includes(q)
      || (r.phone_canon || '').toLowerCase().includes(q);
  }), [rows, statusFilter, dateFrom, dateTo, search]);

  const hasFilters = statusFilter !== 'all' || dateFrom || dateTo || staffFilter !== 'all' || search.trim();
  // Drives the dot on the filter icon: the range is hidden inside the popover,
  // so without this an active date filter would be invisible from the bar.
  const dateFilterOn = Boolean(dateFrom || dateTo);

  function clearFilters() {
    setStatusFilter('all'); setDateFrom(''); setDateTo(''); setStaffFilter('all'); setSearch('');
  }

  const tabs = [
    { key: 'all', label: 'All' },
    { key: 'pending', label: 'Pending' },
    { key: 'done', label: 'Done' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <PageHeader title="Callback Tracker" search={search} onSearch={setSearch} searchPlaceholder="Search name or number..." />

      <div style={s.tabs} className="scroll-strip">
        {tabs.map(t => (
          <button key={t.key} style={{ ...s.tab, ...(statusFilter === t.key ? s.tabActive : {}) }} onClick={() => setStatusFilter(t.key)}>
            {t.label}
            <span style={s.tabCount}>{t.key === 'all' ? rows.length : rows.filter(r => r.callback_status === t.key).length}</span>
          </button>
        ))}
      </div>

      {/* Toolbar in the Pipeline dialect. The date range moved behind the
          filter icon; the threshold control deliberately stays in the bar,
          because it IS the definition of the Pending/Done column being read —
          hiding it inside a popover would mean hunting for why a row says
          Pending. */}
      <div style={tb.bar}>
        <div style={tb.wrap} ref={dateRef}>
          <button
            style={{ ...tb.tool, ...(dateFilterOn ? tb.toolOn : {}) }}
            className="pipeline-tool"
            onClick={() => setDateOpen(o => !o)}
            title={dateFilterOn ? 'Missed-date filter is active' : 'Filter by missed date'}
            aria-expanded={dateOpen}
          >
            <Filter size={14} />
            {dateFilterOn && <span style={tb.toolDot} />}
          </button>

          {dateOpen && (
            <div style={tb.popover}>
              <div style={tb.popTitle}>Missed date</div>
              <label style={tb.popRow}>
                <span style={tb.popLabel}>From</span>
                <input style={tb.dateInput} type="date" value={dateFrom}
                  max={dateTo || undefined} onChange={e => setDateFrom(e.target.value)} />
              </label>
              <label style={tb.popRow}>
                <span style={tb.popLabel}>To</span>
                <input style={tb.dateInput} type="date" value={dateTo}
                  min={dateFrom || undefined} onChange={e => setDateTo(e.target.value)} />
              </label>
              <div style={tb.popFoot}>
                <button
                  style={{ ...tb.popClear, opacity: dateFilterOn ? 1 : 0.45, cursor: dateFilterOn ? 'pointer' : 'default' }}
                  disabled={!dateFilterOn}
                  onClick={() => { setDateFrom(''); setDateTo(''); }}
                >
                  Clear
                </button>
                <button style={tb.popDone} onClick={() => setDateOpen(false)}>Done</button>
              </div>
            </div>
          )}
        </div>

        {isAdmin ? (
          <div style={tb.group} title="An outgoing call must last longer than this to count as a callback">
            <label style={tb.label}>Callback counts over</label>
            <input
              style={{ ...tb.select, width: 52, ...(draftValid ? {} : { borderColor: theme.high }) }}
              type="number" min="0" max="3600" value={thresholdDraft}
              onChange={e => { setThresholdDraft(e.target.value); setThresholdError(''); }}
            />
            <span style={tb.label}>s</span>
            <button
              style={{ ...tb.plainBtn, opacity: draftChanged && !savingThreshold ? 1 : 0.5, cursor: draftChanged && !savingThreshold ? 'pointer' : 'default' }}
              disabled={!draftChanged || savingThreshold}
              onClick={saveThreshold}
            >
              {savingThreshold ? 'Saving…' : 'Save'}
            </button>
            {thresholdError && <span style={s.thresholdError}>{thresholdError}</span>}
          </div>
        ) : (
          <span style={tb.label} title="An outgoing call must last longer than this to count as a callback">
            Callback counts over {threshold}s
          </span>
        )}

        {/* Whose phone the miss rang on. Renders nothing for a sales agent. */}
        <StaffFilter value={staffFilter} onChange={setStaffFilter} label="Missed on" />

        <span style={tb.resultCount}>
          {filtered.length} of {rows.length} number{rows.length === 1 ? '' : 's'}
        </span>

        {hasFilters && <button style={tb.plainBtn} onClick={clearFilters}>Clear filters</button>}

        <button
          style={{ ...tb.primaryBtn, opacity: filtered.length ? 1 : 0.5 }}
          disabled={!filtered.length}
          title={filtered.length ? 'Download the callbacks shown below as an Excel file' : 'Nothing to export'}
          onClick={() => downloadCallbacksXLSX(filtered, {
            statusFilter, dateFrom, dateTo, search, threshold,
            staffFilter, staffLabel: staffFilterLabel(staffFilter, roster),
          })}
        >
          <Download size={13} /> Export ({filtered.length})
        </button>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '18px 28px', background: theme.bg }}>
        {loading ? <p style={{ color: theme.inkFaint, fontSize: 13 }}>Loading...</p> : (
          <div style={s.tableWrap}>
            <table style={s.table}>
              <thead>
                <tr>{['Contact', 'Number', 'Missed', 'Latest miss', 'Status', 'Called back', 'Time to callback', ''].map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td style={s.td} colSpan={8}>No missed calls yet.</td></tr>
                ) : filtered.map(r => {
                  const st = CALLBACK_STATUS[r.callback_status]
                    || { label: r.callback_status || 'Unknown', color: theme.inkFaint, bg: theme.borderSoft, Icon: PhoneMissed };
                  const Icon = st.Icon;
                  // COUNT(*) is bigint, which pg serializes as a STRING — so this
                  // must be coerced before comparing, or '3' > 1 never fires.
                  const missed = Number(r.missed_count) || 0;
                  return (
                    // One row per agent + number since 058, so the number
                    // alone is no longer unique.
                    <tr key={`${r.missed_on_staff_id || 'none'}:${r.phone_canon}`}>
                      <td style={s.td}>{r.customer_name || r.contact_name || '—'}</td>
                      <td style={{ ...s.td, fontFamily: theme.mono }}>{r.raw_phone_number || r.phone_canon}</td>
                      <td style={s.td}>
                        {missed > 1
                          ? <span style={{ ...s.pill, color: theme.high, background: theme.highBg }}>missed {missed}×</span>
                          : missed}
                      </td>
                      <td style={s.td}>
                        {formatWhen(r.latest_missed_at)}
                        {/* Whose phone it rang on (migration 051). */}
                        {r.missed_on_staff_name && <div style={s.subline}>on {`${r.missed_on_staff_name}'s`} phone</div>}
                      </td>
                      <td style={s.td}>
                        <span style={{ ...s.pill, color: st.color, background: st.bg }}>
                          <Icon size={12} /> {st.label}
                        </span>
                      </td>
                      <td style={s.td}>
                        {r.called_back_at
                          ? `${formatWhen(r.called_back_at)} · ${formatDuration(r.callback_duration_seconds)}`
                          : '—'}
                        {/* Any agent's call closes a miss; this says whose. */}
                        {r.called_back_at && r.called_back_by_name && <div style={s.subline}>by {r.called_back_by_name}</div>}
                      </td>
                      <td style={s.td}>{r.called_back_at ? formatElapsed(r.time_to_callback_seconds) : '—'}</td>
                      <td style={s.td}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {/* Customer only, no lead: this is the team's shared
                              call-back list, and the open lead may be another
                              agent's call lead, which POST /api/dial would
                              (rightly) refuse to dial through for a sales agent. */}
                          <CallButton customerId={r.customer_id} customerName={r.customer_name || r.contact_name || r.raw_phone_number} />
                          {r.open_lead_id ? (
                            <button style={s.linkBtn} onClick={() => navigate(`/leads/${r.open_lead_id}`)}>
                              <ExternalLink size={12} /> Open lead
                            </button>
                          ) : (!r.customer_id && '—')}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

const s = {
  // Toolbar/filter styles now come from lib/toolbarStyles.js (`tb`), shared
  // with the Call Log page so the two cannot drift apart. Only the inline
  // validation message stays local — it has no Pipeline counterpart.
  thresholdError: { fontSize: 10.5, color: theme.high },
  tabs: { display: 'flex', gap: 18, padding: '0 16px', background: theme.surface, borderBottom: `1px solid ${theme.border}`, flexShrink: 0, overflowX: 'auto' },
  tab: {
    display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, padding: '9px 0 8px', cursor: 'pointer', fontFamily: 'inherit',
    whiteSpace: 'nowrap', border: 'none', background: 'none', borderBottom: '1.5px solid transparent', marginBottom: -1,
    color: theme.inkSoft, fontWeight: 400, transition: 'color 0.12s',
  },
  tabActive: { color: theme.accentInk, fontWeight: 600, borderBottomColor: theme.accent },
  tabCount: { fontSize: 11, color: theme.inkFaint },

  // Card chrome, but scrolling INSIDE it rather than `overflow: 'hidden'`.
  // Hidden clipped the rounded corners neatly and silently killed the sticky
  // header below (a sticky element needs a scrolling ancestor; hidden is not
  // one), so the header scrolled away on every long list. `auto` keeps the
  // corners and makes the header stick, matching the Pipeline.
  tableWrap: { background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: theme.radiusLg, overflow: 'auto', maxHeight: '100%' },
  // fontSize/background here rather than relying on inheritance, matching the
  // Pipeline reference (lib/tableStyles.js) so every list reads at the same
  // size. tableLayout is deliberately NOT set: these tables size their columns
  // from content, and forcing 'fixed' would need per-column widths on each.
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 10.5, background: theme.surface },
  th: { textAlign: 'left', fontSize: 8.5, fontWeight: 500, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.06em', padding: '6px 8px', borderBottom: `1px solid ${theme.border}`, background: theme.surface, position: 'sticky', top: 0, zIndex: 1, whiteSpace: 'nowrap' },
  td: { padding: '8px 8px', borderBottom: `1px solid ${theme.borderSoft}`, fontSize: 10.5, color: theme.inkSoft, verticalAlign: 'middle' },
  subline: { fontSize: 10, color: theme.inkFaint, marginTop: 2 },
  pill: { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px', borderRadius: 20, fontSize: 11.5, fontWeight: 600 },
  linkBtn: { display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', color: theme.accentInk, fontWeight: 600, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit' },
};
