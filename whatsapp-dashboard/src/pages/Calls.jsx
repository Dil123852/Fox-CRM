import { useCallback, useEffect, useRef, useState } from 'react';
import { businessDay } from '../lib/businessTime';
import * as XLSX from 'xlsx';
import { useNavigate } from 'react-router-dom';
import { PhoneIncoming, PhoneOutgoing, PhoneMissed, Phone, ExternalLink, Download, Filter } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { theme } from '../lib/theme';
import { formatDuration } from '../lib/callFormat';
import { tb } from '../lib/toolbarStyles';
import PageHeader from '../components/PageHeader';
import Pagination from '../components/Pagination';
import StaffFilter, { staffFilterLabel, useStaffRoster } from '../components/StaffFilter';

// call_events.call_type real values, as sent by the Android call-tracker
// app's CallLog.TYPE mapping (whatsapp-backend/index.js POST /api/calls).
const CALL_TYPE = {
  INCOMING: { label: 'Incoming', color: theme.success, bg: theme.successBg, Icon: PhoneIncoming },
  OUTGOING: { label: 'Outgoing', color: theme.info,    bg: theme.infoBg,    Icon: PhoneOutgoing },
  MISSED:   { label: 'Missed',   color: theme.high,    bg: theme.highBg,    Icon: PhoneMissed },
};

// Exports exactly what the filters currently show — same xlsx pattern the
// Pipeline and Customers pages already use. duration/SIM go out as real
// numbers so they stay sortable in Excel; the date is split into a date and
// a time column because a single timestamp cell is awkward to filter on.
const CALL_COLS = [
  { key: 'date',     label: 'Date' },
  { key: 'time',     label: 'Time' },
  { key: 'contact',  label: 'Contact' },
  { key: 'number',   label: 'Number' },
  { key: 'type',     label: 'Type' },
  { key: 'duration', label: 'Duration' },
  { key: 'seconds',  label: 'Duration (s)' },
  { key: 'answered', label: 'Answered' },
  { key: 'sim',      label: 'SIM slot' },
  { key: 'agent',    label: 'Agent' },
  { key: 'customer', label: 'Known customer' },
];

function downloadCallsXLSX(rowsIn, meta) {
  const headers = CALL_COLS.map(c => c.label);

  const rows = rowsIn.map(c => {
    const parsed = c.occurred_at ? new Date(c.occurred_at) : null;
    // An unparseable timestamp yields a truthy Invalid Date object, so a
    // plain truthiness check would export the literal text "Invalid Date".
    const dt = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
    const secs = Number(c.duration_seconds) || 0;
    const connected = c.call_type !== 'MISSED' && secs > 0;
    return CALL_COLS.map(col => {
      switch (col.key) {
        case 'date':     return dt ? dt.toLocaleDateString('en-GB') : '';
        case 'time':     return dt ? dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
        // contact_name is what the phone's own call log had; customer_name is
        // the CRM record. Prefer the CRM name, fall back to the phone's.
        case 'contact':  return c.customer_name || c.contact_name || '';
        case 'number':   return c.raw_phone_number || '';
        // call_type is NULL on at least one real row — don't emit a blank
        // cell that looks like missing data when it's genuinely unrecorded.
        case 'type':     return c.call_type || 'Unrecorded';
        case 'duration': return formatDuration(c.duration_seconds);
        case 'seconds':  return secs;
        case 'answered': return connected ? 'Yes' : 'No';
        // Stored 0-based (raw Android slot index); the table renders
        // `SIM ${sim_slot + 1}`, so the export must add 1 too or a call
        // shown as "SIM 1" would export as 0.
        case 'sim':      return c.sim_slot != null ? Number(c.sim_slot) + 1 : '';
        case 'customer': return c.customer_id ? (c.customer_name || 'Linked') : 'Not in CRM';
        // Whose phone logged the call (migration 051). Marked when it came
        // from an older app build that only claimed an owner by typed number.
        case 'agent':    return c.staff_name ? `${c.staff_name}${c.staff_verified ? '' : ' (unverified)'}` : 'Not recorded';
        default:         return '';
      }
    });
  });

  // A one-line record of which filters produced this file, so a sheet mailed
  // to someone else isn't ambiguous about what it covers.
  const filterLine = [
    meta.typeFilter !== 'all' ? `Type: ${meta.typeFilter}` : null,
    meta.dateFrom || meta.dateTo ? `Dates: ${meta.dateFrom || 'any'} to ${meta.dateTo || 'any'}` : null,
    meta.answered !== 'all' ? `Answered: ${meta.answered}` : null,
    meta.staffFilter !== 'all' ? `Agent: ${meta.staffLabel}` : null,
    meta.search ? `Search: "${meta.search}"` : null,
  ].filter(Boolean).join('  |  ') || 'No filters — all calls';

  const ws = XLSX.utils.aoa_to_sheet([
    [`Nidikumba call log — ${rowsIn.length} call${rowsIn.length === 1 ? '' : 's'}`],
    [filterLine],
    [],
    headers,
    ...rows,
  ]);
  ws['!cols'] = CALL_COLS.map(c => ({ wch: Math.max(c.label.length + 4, 13) }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Calls');
  XLSX.writeFile(wb, `Nidikumba_Calls_${businessDay()}.xlsx`);
}

export default function Calls() {
  const [calls, setCalls] = useState([]);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  // 'all' | 'answered' | 'unanswered' — a MISSED call has no duration, and a
  // connected call that lasted 0s never really connected either, so this is
  // the distinction staff actually care about when reviewing a day's calls.
  const [answered, setAnswered] = useState('all');
  // 'all' | a staff id | 'none' — whose phone logged the call (migration
  // 051). Admins/viewers only; a sales agent's calls are scoped to their own
  // by the server (058), so for them this stays 'all' and is never shown.
  const [staffFilter, setStaffFilter] = useState('all');
  const roster = useStaffRoster();
  const [loading, setLoading] = useState(true);
  // Server-side paging state. `total` is how many rows match the CURRENT
  // filters, not how many calls exist, so the pager and the count under the
  // toolbar always describe the same set.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [total, setTotal] = useState(0);
  const [exporting, setExporting] = useState(false);
  const reqSeq = useRef(0);
  // The date range moved behind a popover (see the toolbar below), so it needs
  // its own open state and a way to dismiss without a mouse click.
  const [dateOpen, setDateOpen] = useState(false);
  const dateRef = useRef(null);
  const navigate = useNavigate();

  // Search is debounced because it now refetches; the other filters are
  // discrete choices and fire immediately.
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  // Every filter is sent to the server. Keeping them in one builder means the
  // rows on screen and the `total` the pager divides always came from the
  // same question — the old client-side filtering could not make that promise
  // once only part of the log was loaded.
  const buildQuery = useCallback(() => {
    const q = new URLSearchParams();
    if (typeFilter !== 'all') q.set('type', typeFilter);
    if (dateFrom) q.set('dateFrom', dateFrom);
    if (dateTo) q.set('dateTo', dateTo);
    if (answered !== 'all') q.set('answered', answered);
    if (staffFilter !== 'all') q.set('staffId', staffFilter);
    if (debouncedSearch.trim()) q.set('search', debouncedSearch.trim());
    return q;
  }, [typeFilter, dateFrom, dateTo, answered, staffFilter, debouncedSearch]);

  // Any filter change returns to page 1: staying on page 7 of a freshly
  // narrowed result set shows an empty table for no visible reason.
  useEffect(() => {
    setPage(1);
  }, [typeFilter, dateFrom, dateTo, answered, staffFilter, debouncedSearch]);

  useEffect(() => {
    let alive = true;
    // A slower earlier request must not overwrite a newer one's rows, or the
    // table ends up showing results for a filter already changed.
    const seq = ++reqSeq.current;
    setLoading(true);
    const q = buildQuery();
    q.set('limit', String(pageSize));
    q.set('offset', String((page - 1) * pageSize));
    apiFetch(`/api/calls?${q}`)
      .then(r => r.json())
      .then(data => {
        if (!alive || seq !== reqSeq.current) return;
        setCalls(data.calls || []);
        setTotal(data.total || 0);
      })
      .catch(e => { if (alive) console.error(e); })
      .finally(() => { if (alive && seq === reqSeq.current) setLoading(false); });
    return () => { alive = false; };
  }, [page, pageSize, buildQuery]);

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

  // No client-side filtering any more — `calls` IS the current page of the
  // server's filtered result, so filtering it again here could only ever
  // remove rows the server already decided should be shown.

  // The export must cover every call MATCHING THE FILTERS, not the 50 rows on
  // screen — a sheet that silently stopped at the page boundary would be worse
  // than no export. So it re-requests the whole matching set in one go.
  async function handleExport() {
    setExporting(true);
    try {
      const q = buildQuery();
      // The route clamps limit to 200, so walk the pages rather than asking
      // for everything at once.
      const PAGE = 200;
      const all = [];
      for (let off = 0; off < total; off += PAGE) {
        q.set('limit', String(PAGE));
        q.set('offset', String(off));
        const res = await apiFetch(`/api/calls?${q}`);
        const data = await res.json();
        const batch = data.calls || [];
        all.push(...batch);
        // Defensive: without this a total that shrinks mid-export (a new sync
        // lands) would spin forever on an empty batch.
        if (!batch.length) break;
      }
      downloadCallsXLSX(all, {
        typeFilter, dateFrom, dateTo, answered, staffFilter, search,
        staffLabel: staffFilterLabel(staffFilter, roster),
      });
    } catch (e) {
      console.error(e);
    }
    setExporting(false);
  }

  const hasFilters = typeFilter !== 'all' || dateFrom || dateTo || answered !== 'all' || staffFilter !== 'all' || search.trim();
  // Drives the dot on the filter icon: the range is hidden inside the popover,
  // so without this an active date filter would be invisible from the bar.
  const dateFilterOn = Boolean(dateFrom || dateTo);

  function clearFilters() {
    setTypeFilter('all'); setDateFrom(''); setDateTo(''); setAnswered('all'); setStaffFilter('all'); setSearch('');
  }

  const tabs = [
    { key: 'all', label: 'All' },
    { key: 'INCOMING', label: 'Incoming' },
    { key: 'OUTGOING', label: 'Outgoing' },
    { key: 'MISSED', label: 'Missed' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <PageHeader title="Call Log" search={search} onSearch={setSearch} searchPlaceholder="Search name or number..." />

      <div style={s.tabs} className="scroll-strip">
        {tabs.map(t => (
          <button key={t.key} style={{ ...s.tab, ...(typeFilter === t.key ? s.tabActive : {}) }} onClick={() => setTypeFilter(t.key)}>
            {t.label}
            <span style={s.tabCount}>{t.key === 'all' ? calls.length : calls.filter(c => c.call_type === t.key).length}</span>
          </button>
        ))}
      </div>

      {/* Toolbar in the Pipeline dialect: the date range lives behind the
          filter icon rather than taking a third of the bar to express a
          filter that is usually empty. The icon carries a dot when a range is
          actually set, so a hidden active filter can't be forgotten. */}
      <div style={tb.bar}>
        <div style={tb.wrap} ref={dateRef}>
          <button
            style={{ ...tb.tool, ...(dateFilterOn ? tb.toolOn : {}) }}
            className="pipeline-tool"
            onClick={() => setDateOpen(o => !o)}
            title={dateFilterOn ? 'Date filter is active' : 'Filter by date'}
            aria-expanded={dateOpen}
          >
            <Filter size={14} />
            {dateFilterOn && <span style={tb.toolDot} />}
          </button>

          {dateOpen && (
            <div style={tb.popover}>
              <div style={tb.popTitle}>Call date</div>
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

        {/* Answered stays in the bar: unlike the date range it is a one-click
            three-way choice staff flip constantly while reviewing a day. */}
        <div style={tb.group}>
          <label style={tb.label}>Answered</label>
          <select style={tb.select} value={answered} onChange={e => setAnswered(e.target.value)}>
            <option value="all">All</option>
            <option value="answered">Answered only</option>
            <option value="unanswered">Unanswered / missed</option>
          </select>
        </div>

        {/* Whose phone logged the call — the agent who actually made,
            received or missed it, which is not necessarily the lead's owner.
            Admins/viewers only; renders nothing for a sales agent. */}
        <StaffFilter value={staffFilter} onChange={setStaffFilter} />

        <span style={tb.resultCount}>
          {total.toLocaleString()} call{total === 1 ? '' : 's'}
          {total > pageSize && ` · showing ${((page - 1) * pageSize + 1).toLocaleString()}–${Math.min(page * pageSize, total).toLocaleString()}`}
        </span>

        {hasFilters && (
          <button style={tb.plainBtn} onClick={clearFilters}>Clear filters</button>
        )}

        <button
          style={{ ...tb.primaryBtn, opacity: total && !exporting ? 1 : 0.5 }}
          disabled={!total || exporting}
          title={total ? 'Download every call matching the current filters as an Excel file' : 'Nothing to export'}
          onClick={handleExport}
        >
          <Download size={13} /> {exporting ? 'Preparing…' : `Export (${total.toLocaleString()})`}
        </button>
      </div>

      {/* minHeight: 0 lets this shrink and scroll internally. Without it a
          flex item's min-height is auto — it refuses to shrink below its
          content, so a full table pushed the docked pager below the fold. */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '18px 28px', background: theme.bg }}>
        {loading ? <p style={{ color: theme.inkFaint, fontSize: 13 }}>Loading...</p> : (
          <div style={s.tableWrap}>
            <table style={s.table}>
              <thead>
                <tr>{['Contact', 'Number', 'Type', 'Duration', 'SIM', 'Agent', 'Date & time', ''].map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {calls.length === 0 ? (
                  <tr><td style={s.td} colSpan={8}>{hasFilters ? 'No calls match these filters.' : 'No calls synced yet.'}</td></tr>
                ) : calls.map(c => {
                  const t = CALL_TYPE[c.call_type] || { label: c.call_type || 'Unknown', color: theme.inkFaint, bg: theme.borderSoft, Icon: Phone };
                  const Icon = t.Icon;
                  return (
                    <tr key={c.id}>
                      {/* A call from someone not in the CRM and not in the
                          phone's contacts says so, rather than showing a bare
                          dash that reads like missing data. Muted, so the real
                          names in the column stay the ones that catch the eye. */}
                      <td style={s.td}>
                        {c.customer_name || c.contact_name
                          ? (c.customer_name || c.contact_name)
                          : <span style={s.unknown}>Unknown</span>}
                      </td>
                      <td style={{ ...s.td, fontFamily: theme.mono }}>{c.raw_phone_number}</td>
                      <td style={s.td}>
                        <span style={{ ...s.pill, color: t.color, background: t.bg }}>
                          <Icon size={12} /> {t.label}
                        </span>
                      </td>
                      <td style={s.td}>{formatDuration(c.duration_seconds)}</td>
                      <td style={s.td}>{c.sim_slot !== null && c.sim_slot !== undefined ? `SIM ${c.sim_slot + 1}` : '—'}</td>
                      {/* The agent whose PHONE logged this call. "unverified"
                          = an older app build that only claimed an owner by a
                          typed number; calls synced before this was recorded
                          show a dash. */}
                      <td style={s.td}>
                        {c.staff_name ? (
                          <>
                            {c.staff_name}
                            {!c.staff_verified && (
                              <span style={s.unverified} title="Sent by an older Call Tracker app that isn't signed in — the agent was matched by a typed phone number">unverified</span>
                            )}
                          </>
                        ) : '—'}
                      </td>
                      <td style={s.td}>
                        {c.occurred_at ? new Date(c.occurred_at).toLocaleString('en', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'}
                      </td>
                      <td style={s.td}>
                        {c.open_lead_id ? (
                          <button style={s.linkBtn} onClick={() => navigate(`/leads/${c.open_lead_id}`)}>
                            <ExternalLink size={12} /> Open lead
                          </button>
                        ) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* OUTSIDE the scrolling div above, deliberately. Inside it the pager
          scrolled away with the rows and only appeared once you reached the
          bottom of the page — the control for leaving the page was reachable
          only from the end of it. As a sibling it docks under the table. */}
      {!loading && (
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPage={setPage}
          onPageSize={n => { setPageSize(n); setPage(1); }}
        />
      )}
    </div>
  );
}

const s = {
  // Toolbar/filter styles now come from lib/toolbarStyles.js (`tb`), shared
  // with the Callbacks page so the two cannot drift apart.
  tabs: { display: 'flex', gap: 18, padding: '0 16px', background: theme.surface, borderBottom: `1px solid ${theme.border}`, flexShrink: 0, overflowX: 'auto' },
  tab: {
    display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, padding: '9px 0 8px', cursor: 'pointer', fontFamily: 'inherit',
    whiteSpace: 'nowrap', border: 'none', background: 'none', borderBottom: '1.5px solid transparent', marginBottom: -1,
    color: theme.inkSoft, fontWeight: 400, transition: 'color 0.12s',
  },
  tabActive: { color: theme.accentInk, fontWeight: 600, borderBottomColor: theme.accent },
  tabCount: { fontSize: 11, color: theme.inkFaint },
  // Muted so a real contact name is what stands out in the column.
  unknown: { color: theme.inkFaint },
  unverified: { marginLeft: 6, fontSize: 10, fontWeight: 600, color: theme.med, background: theme.medBg, padding: '1px 6px', borderRadius: 10 },

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
  pill: { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px', borderRadius: 20, fontSize: 11.5, fontWeight: 600 },
  linkBtn: { display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', color: theme.accentInk, fontWeight: 600, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit' },
};
