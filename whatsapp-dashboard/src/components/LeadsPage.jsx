import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  PhoneCall, MessageCircle, X, Inbox, ChevronRight,
  Download, FileSpreadsheet, ShoppingCart, XCircle,
  Share2, Upload, Filter, ArrowUpDown, Rows3, List, LayoutGrid, Plus, Check,
  // The stat tiles' trend direction. AlertTriangle/Trophy/Phone went with the
  // icon badges these replaced; Inbox is still used by the empty state.
  ArrowUpRight, ArrowDownRight,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { onEvent } from '../lib/sse';
import LeadProductsPanel from './LeadProductsPanel';
import CallButton from './CallButton';
import CallDots from './CallDots';
import ShowroomOrderModal from './ShowroomOrderModal';
import { useAuth } from '../lib/AuthContext';
import { theme, SOURCE_BADGE, sourceBadge, modalBackdrop } from '../lib/theme';
import { roleAllowed } from '../lib/roles';
import Pagination from './Pagination';
import { useErrorPopup } from './DialogProvider';
import { vh } from '../lib/viewport';
import { localDay } from '../lib/callFormat';
import { businessDay, addDays } from '../lib/businessTime';

// ─── Constants ────────────────────────────────────────────────────────────────

// 'showroom' retired as a pipeline status (Phase 15) — it's a source/origin
// concept now (leads.source / showroom_visits), not a stage a lead passes
// through. A showroom-originated lead moves New → Quotation → Follow up →
// Won like any other; see the source badge below for where it came from.
// 'not_answered' is a manual call outcome (customer didn't pick up), set by
// staff from the dropdown — the AI never extracts it (analyzeConversation
// only ever sets 'won'/'lost'), and it is not terminal: a lead sitting here
// still counts as open for follow-ups, overdue and today's-calls.
export const STATUS = {
  new:            { label: 'New',       color: theme.low,       bg: theme.lowBg },
  quotation_sent: { label: 'Quotation', color: theme.info,      bg: theme.infoBg },
  follow_up:      { label: 'Follow up', color: theme.med,       bg: theme.medBg },
  not_answered:   { label: 'Not Answered', color: theme.high,  bg: theme.highBg },
  won:            { label: 'Won',       color: theme.success,   bg: theme.successBg },
  lost:           { label: 'Lost',      color: theme.cancel,    bg: theme.cancelBg },
};

// Per-lead priority (migration 019) — distinct from customers.priority_label
// (the AI-driven chat/SLA priority elsewhere in this app); staff-editable
// directly on the Pipeline table via a dropdown, one value per ticket.
export const PRIORITY = {
  high:   { label: 'High',   color: theme.high, bg: theme.highBg },
  medium: { label: 'Medium', color: theme.med,  bg: theme.medBg },
  low:    { label: 'Low',    color: theme.low,  bg: theme.lowBg },
};

// Sort options behind the toolbar's sort icon. `get` returns a comparable
// value per lead; `numeric` ones compare with subtraction, the rest with
// localeCompare so names sort case- and accent-correctly.
//
// Status and Priority deliberately rank by their POSITION in the STATUS /
// PRIORITY maps above, not alphabetically: those maps are already written in
// meaningful order (pipeline stage; high -> low), so "sort by priority" puts
// High first rather than between Low and Medium.
const STATUS_RANK   = Object.keys(STATUS);
const PRIORITY_RANK = Object.keys(PRIORITY);

export const SORT_OPTIONS = [
  { key: 'created',   label: 'Created date', numeric: false, get: l => l.created_at || '' },
  { key: 'name',      label: 'Name',         numeric: false, get: l => (l.customers?.name || '').toLowerCase() },
  { key: 'followup',  label: 'Follow-up',    numeric: false, get: l => nextFollowUp(l)?.date || '' },
  { key: 'status',    label: 'Status',       numeric: true,  get: l => STATUS_RANK.indexOf(l.status) },
  { key: 'priority',  label: 'Priority',     numeric: true,  get: l => PRIORITY_RANK.indexOf(l.priority || 'medium') },
];

// Sorts a copy, never the caller's array. A lead missing the sort field always
// falls to the BOTTOM regardless of direction -- blanks floating to the top of
// a descending sort is the classic way a sorted table looks broken.
export function sortLeads(leads, sortKey, sortDir) {
  const opt = SORT_OPTIONS.find(o => o.key === sortKey);
  if (!opt) return leads;
  const dir = sortDir === 'asc' ? 1 : -1;
  const empty = v => v === '' || v === null || v === undefined || (opt.numeric && v < 0);
  return [...leads].sort((a, b) => {
    const va = opt.get(a), vb = opt.get(b);
    if (empty(va) && empty(vb)) return 0;
    if (empty(va)) return 1;
    if (empty(vb)) return -1;
    return (opt.numeric ? va - vb : String(va).localeCompare(String(vb))) * dir;
  });
}

// Next scheduled follow-up (replaces the old plain next_contact_date-only
// column) — looks across the whole automated follow-up schedule (migration
// 018/020: follow_up_1/2_date, week_1..4_date) plus the manual
// next_contact_date, and surfaces whichever is soonest so the Pipeline table
// reflects the real schedule instead of just the one manual field. A skipped
// (_done) call date is excluded; week_N dates have no completion flag of
// their own (per CLAUDE.md, they're a standing reminder, not a task to
// check off) so any that's set is a candidate. Ties broken by schedule order
// (first call before second before weekly) since that's the natural
// sequence a customer moves through.
const FOLLOW_UP_STAGES = [
  { key: 'next_contact_date', label: 'Manual' },
  { key: 'follow_up_1_date',  label: 'First call',  doneKey: 'follow_up_1_done' },
  { key: 'follow_up_2_date',  label: 'Second call', doneKey: 'follow_up_2_done' },
  { key: 'week_1_date',       label: 'Week 1' },
  { key: 'week_2_date',       label: 'Week 2' },
  { key: 'week_3_date',       label: 'Week 3' },
  { key: 'week_4_date',       label: 'Week 4' },
];

function nextFollowUp(lead) {
  const candidates = FOLLOW_UP_STAGES
    .filter(stage => lead[stage.key] && !(stage.doneKey && lead[stage.doneKey]))
    .map(stage => ({ ...stage, date: lead[stage.key].slice(0, 10) }));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.date.localeCompare(b.date));
  return candidates[0];
}


// products.variants stores dimensions as "84x36" (width x length, inches).
// Displayed with a real multiplication sign and a unit so it reads as a
// measurement rather than a code. Anything not in WxH form is shown as-is
// (legacy/nominal values like "Queen" appear in historical lead data).
// The value that identifies one variant in the size dropdown, and what gets
// stored in leads.bed_size / the order line. Normally the exact dimension;
// falls back to the size name for a variant that has no dimension at all
// (a pillow sized only "Standard", say) so the option is never valueless —
// an empty value would collide with the placeholder option and leave the
// price unresolvable.
// ─── Helpers ──────────────────────────────────────────────────────────────────

// Sri Lanka calendar day, not the UTC one (toISOString() is still "yesterday"
// before 05:30 in Sri Lanka) nor the viewer's computer's (lib/businessTime.js).
const today      = () => localDay(Date.now());
export const custName = l => l.customers?.name || l.customers?.whatsapp_number || '—';
// The comparison period behind each stat tile's trend figure: a "today"
// metric is compared with yesterday. Derived the same way as today() so both
// agree on what a day boundary is. The month boundaries that used to live here
// went with the client-side "won" maths — Postgres now does that windowing in
// GET /api/leads/won-stats, so a second definition of "this month" here could
// only drift from it.
// (`yesterday` lived here for the previous-period tile figures. Those are now
// counted in GET /api/leads/stats alongside today's, for the same reason the
// month boundaries moved — one definition of a day boundary, in one place.)

// Percentage change from a previous period, as a display-ready descriptor.
//
// The zero-baseline case is why this returns an object rather than a number:
// going from 0 to 3 is not "+300%" or "+Infinity%", it is simply new activity,
// so it reads as "+3 vs yesterday" instead of a percentage that implies a
// ratio nothing was divided by. 0 -> 0 is "No change", not "0%", so an idle
// metric does not look like a measured flat result.
function trend(current, previous, periodLabel) {
  const cur = Number(current) || 0;
  const prev = Number(previous) || 0;
  if (cur === prev) return { text: `No change vs ${periodLabel}`, dir: 'flat' };
  if (prev === 0) {
    const d = cur - prev;
    return { text: `${d > 0 ? '+' : ''}${d} vs ${periodLabel}`, dir: d > 0 ? 'up' : 'down' };
  }
  const pct = Math.round(((cur - prev) / prev) * 100);
  return { text: `${pct > 0 ? '+' : ''}${pct}% vs ${periodLabel}`, dir: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat' };
}

// SLA badge — same convention as PipelineBoard.jsx (Phase 15.2): green with
// time remaining if on track, amber under 1h, red once is_overdue flips true.
function slaBadge(lead) {
  if (!lead.sla_deadline) return null;
  const diffMs = new Date(lead.sla_deadline).getTime() - Date.now();
  const absMins = Math.round(Math.abs(diffMs) / 60000);
  const fmt = mins => {
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  };
  if (lead.is_overdue) return { label: `Overdue ${fmt(absMins)}`, color: theme.high, bg: theme.highBg };
  if (diffMs < 60 * 60 * 1000) return { label: `${fmt(absMins)} left`, color: theme.med, bg: theme.medBg };
  return { label: `${fmt(absMins)} left`, color: theme.success, bg: theme.successBg };
}

// ─── PDF export (single lead) ─────────────────────────────────────────────────

// jsPDF, its autotable plugin and xlsx are loaded ON DEMAND rather than
// imported at the top of this file. They are by far the heaviest dependencies
// in the app, and statically importing them here put all three into the main
// bundle — so every visitor downloaded a PDF engine and a spreadsheet writer
// just to LOOK at the pipeline, before the table could render. They are only
// needed when someone actually clicks Export, which is rare compared with
// opening the page.
//
// Async as a result: both callers already await or fire-and-forget, and the
// dynamic import is cached by the browser after the first use.
export async function downloadLeadPDF(lead) {
  const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'), import('jspdf-autotable'),
  ]);
  const doc  = new jsPDF({ unit: 'mm', format: 'a4' });
  const n    = lead.customers?.name || lead.customers?.whatsapp_number || '—';
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  doc.setFillColor(51, 48, 122);
  doc.rect(0, 0, 210, 30, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(20);
  doc.setFont('helvetica', 'bold');
  doc.text('NIDIKUMBA CRM', 14, 13);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text('Customer Lead Report', 14, 21);
  doc.text(`Generated: ${date}`, 196, 21, { align: 'right' });

  doc.setTextColor(15, 23, 42);
  doc.setFontSize(15);
  doc.setFont('helvetica', 'bold');
  doc.text(n, 14, 42);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 116, 139);
  if (lead.customers?.whatsapp_number && lead.customers.whatsapp_number !== n) {
    doc.text(lead.customers.whatsapp_number, 14, 49);
  }

  const tOpts = {
    styles:       { cellPadding: 3.5, fontSize: 9, textColor: [51, 65, 85] },
    columnStyles: { 0: { fontStyle: 'bold', cellWidth: 52, fillColor: [248, 250, 252] } },
    theme: 'grid',
  };

  autoTable(doc, {
    ...tOpts, startY: 55,
    head: [['Customer Information', '']],
    body: [
      ['Full Name',        n],
      ['Contact Number',   lead.customers?.whatsapp_number || '—'],
      ['Location',         lead.location         || '—'],
      ['Delivery Address', lead.delivery_address || '—'],
      ['Source',           SOURCE_BADGE[lead.source]?.label || lead.source || '—'],
    ],
    headStyles: { fillColor: [238, 237, 247], textColor: [42, 39, 100], fontStyle: 'bold', fontSize: 9 },
  });

  autoTable(doc, {
    ...tOpts, startY: doc.lastAutoTable.finalY + 7,
    head: [['Product Details', '']],
    body: [
      ['Product Type',      lead.product_type?.replace(' Mattress', '') || '—'],
      ['Bed Size',          lead.bed_size   || '—'],
      ['Quantity',          lead.qty        != null ? String(lead.qty) : '—'],
      ['Unit Price',        lead.unit_price != null ? `LKR ${Number(lead.unit_price).toLocaleString()}` : '—'],
    ],
    headStyles: { fillColor: [234, 240, 249], textColor: [55, 99, 168], fontStyle: 'bold', fontSize: 9 },
  });

  autoTable(doc, {
    ...tOpts, startY: doc.lastAutoTable.finalY + 7,
    head: [['Pipeline Status', '']],
    body: [
      ['Status',            STATUS[lead.status]?.label || lead.status || '—'],
      ['Category',          lead.category      || '—'],
      ['Quotation Number',  lead.quotation_no  || '—'],
      ['Next Contact Date', lead.next_contact_date || '—'],
      ['Assigned To',       lead.assigned_staff_name || '—'],
    ],
    headStyles: { fillColor: [251, 240, 223], textColor: [200, 125, 27], fontStyle: 'bold', fontSize: 9 },
  });

  const noteRows = [
    ['First Call',  lead.first_call  ],
    ['Second Call', lead.second_call ],
    ['Week 01',     lead.week_01     ],
    ['Week 02',     lead.week_02     ],
    ['Week 03',     lead.week_03     ],
    ['Week 04',     lead.week_04     ],
  ].filter(([, v]) => v);

  autoTable(doc, {
    ...tOpts, startY: doc.lastAutoTable.finalY + 7,
    head: [['Follow-up Notes', '']],
    body: noteRows.length ? noteRows : [['No notes recorded yet', '']],
    headStyles: { fillColor: [245, 243, 255], textColor: [124, 58, 237], fontStyle: 'bold', fontSize: 9 },
    columnStyles: { 0: { fontStyle: 'bold', cellWidth: 52, fillColor: [248, 250, 252] }, 1: { cellWidth: 'auto' } },
    bodyStyles: { ...tOpts.styles, minCellHeight: 8 },
  });

  const pages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(7.5);
    doc.setTextColor(148, 163, 184);
    doc.text('Nidikumba CRM — Confidential', 14, 288);
    doc.text(`Page ${i} of ${pages}`, 196, 288, { align: 'right' });
  }

  const safe = n.replace(/[^a-zA-Z0-9]/g, '_');
  doc.save(`Nidikumba_Lead_${safe}_${businessDay()}.pdf`);
}

// ─── XLSX export (full filtered table) ───────────────────────────────────────

const XLSX_COLS = [
  { key: 'date', label: 'Date' }, { key: 'status', label: 'Status' }, { key: 'name', label: 'Customer Name' },
  { key: 'phone', label: 'Contact No.' }, { key: 'source', label: 'Source' }, { key: 'location', label: 'Location' },
  { key: 'delivery_address', label: 'Delivery Addr' }, { key: 'product_type', label: 'Product' },
  { key: 'bed_size', label: 'Bed Size' }, { key: 'scale', label: 'Scale' }, { key: 'qty', label: 'Qty' },
  { key: 'unit_price', label: 'Unit Price' }, { key: 'category', label: 'Category' },
  { key: 'quotation_no', label: 'Quotation No' }, { key: 'next_contact_date', label: 'Next Contact' },
  { key: 'assigned_staff_name', label: 'Assigned To' }, { key: 'priority', label: 'Priority' },
  { key: 'first_call', label: 'First Call' }, { key: 'second_call', label: 'Second Call' },
  { key: 'week_01', label: 'Week 01' }, { key: 'week_02', label: 'Week 02' },
  { key: 'week_03', label: 'Week 03' }, { key: 'week_04', label: 'Week 04' },
];

// Async for the same reason as downloadLeadPDF above: the xlsx library is
// loaded only when an export is actually requested, keeping it out of the
// bundle every visitor downloads to view the page. Called from an onClick,
// which does not need the returned promise.
async function downloadXLSX(leads) {
  const XLSX = await import('xlsx');
  const headers = XLSX_COLS.map(c => c.label);

  const rows = leads.map(l => XLSX_COLS.map(col => {
    if (col.key === 'date')         return new Date(l.created_at).toLocaleDateString('en-GB');
    if (col.key === 'status')       return STATUS[l.status]?.label || l.status || '';
    if (col.key === 'name')         return l.customers?.name || '';
    if (col.key === 'phone')        return l.customers?.whatsapp_number || '';
    if (col.key === 'source')       return SOURCE_BADGE[l.source]?.label || l.source || '';
    if (col.key === 'priority')     return PRIORITY[l.priority]?.label || l.priority || '';
    if (col.key === 'product_type') return l.product_type?.replace(' Mattress', '') || '';
    if (col.key === 'scale')        return l.scale ? `${l.scale}"` : '';
    if (col.key === 'unit_price')   return l.unit_price != null ? Number(l.unit_price) : '';
    if (col.key === 'qty')          return l.qty        != null ? Number(l.qty)        : '';
    return l[col.key] != null ? l[col.key] : '';
  }));

  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols'] = XLSX_COLS.map(c => ({ wch: Math.max(c.label.length + 4, 14) }));
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let C = range.s.c; C <= range.e.c; C++) {
    const cell = ws[XLSX.utils.encode_cell({ r: 0, c: C })];
    if (cell) cell.s = { font: { bold: true } };
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Pipeline');
  XLSX.writeFile(wb, `Nidikumba_Pipeline_${businessDay()}.xlsx`);
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function LeadsPage() {
  const navigate = useNavigate();
  const [leads,     setLeads]     = useState([]);
  // Closed tickets, fetched separately and used ONLY by the "Won this month"
  // stat — a won lead is a closed ticket, so it is absent from `leads` above.
  // Deliberately not merged into `leads`: that array drives the Pipeline table,
  // which must keep showing open tickets only.
  // Just the two counts the "Won" tile needs, from GET /api/leads/won-stats.
  // This replaced holding the whole closed-ticket list in memory (see
  // fetchLeads) — closed tickets only ever accumulate, so that list grew
  // without bound while the page used it for nothing but these two numbers.
  const [wonStats, setWonStats] = useState({ thisMonth: 0, lastMonth: 0, daily: {} });
  const [loading,   setLoading]   = useState(true);
  const [statusTab, setStatusTab] = useState('all');
  const [search,    setSearch]    = useState('');
  const [dateFrom,  setDateFrom]  = useState('');
  const [dateTo,    setDateTo]    = useState('');
  // Default: newest first, which is what the table showed before sorting
  // existed (GET /api/leads returns created_at DESC).
  const [sortKey,   setSortKey]   = useState('created');
  const [sortDir,   setSortDir]   = useState('desc');
  const [chatLead,  setChatLead]  = useState(null);
  const [orderLead, setOrderLead] = useState(null);
  const [todaysCallsOnly, setTodaysCallsOnly] = useState(false);
  const [closingLead, setClosingLead] = useState(null);
  // Server-side paging. `total` counts rows matching the CURRENT filters;
  // `stats` is computed over the whole pipeline regardless of them, because a
  // tile reading "Overdue: 172" answers "how much work is there", not "how
  // much is on this page".
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [srvStats, setSrvStats] = useState(null);
  const reqSeq = useRef(0);

  // Search refetches now, so it is debounced; every other control is a
  // discrete choice and fires immediately.
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  async function fetchLeads() {
    try {
      // TWO REQUESTS, deliberately. GET /api/leads defaults to
      // ticket_state='open', and converting a lead to an order CLOSES its
      // ticket (POST /api/orders sets status='won', ticket_state='closed').
      // So every won lead is absent from the open list — which meant the "Won
      // this month" tile could only ever read 0, however many sales had
      // actually been made. Confirmed against real data: 8 won leads in the
      // database, 0 reaching the browser.
      //
      // The second request used to be the whole closed-ticket list
      // (?ticketState=closed), which the browser then filtered down to two
      // integers. Closed tickets accumulate forever while open ones do not, so
      // that payload grew every week and was the largest cost of opening this
      // page. It is now a COUNT done in Postgres. `leads` still holds only the
      // open tickets, so the table, tabs, filters and counts are unchanged.
      // THREE REQUESTS. The page query carries the filters, the sort and the
      // page; /leads/stats carries the tiles and tab counts over the whole
      // pipeline; /leads/won-stats carries the two "won" figures, which live
      // on closed tickets the open list never contains.
      const seq = ++reqSeq.current;
      const q = new URLSearchParams();
      if (statusTab !== 'all') q.set('status', statusTab);
      if (debouncedSearch.trim()) q.set('search', debouncedSearch.trim());
      if (dateFrom) q.set('dateFrom', dateFrom);
      if (dateTo) q.set('dateTo', dateTo);
      if (todaysCallsOnly) q.set('todaysCalls', 'true');
      q.set('sort', sortKey);
      q.set('dir', sortDir);
      q.set('limit', String(pageSize));
      q.set('offset', String((page - 1) * pageSize));

      const [openRes, statsRes, wonRes] = await Promise.all([
        apiFetch(`/api/leads?${q}`),
        // Neither of these may fail the page: the table comes from the list
        // above, and a failed tile should cost the tile, not the Pipeline.
        apiFetch('/api/leads/stats').catch(() => null),
        apiFetch('/api/leads/won-stats').catch(() => null),
      ]);
      const data = await openRes.json();
      // A slower earlier request must not overwrite a newer one's rows.
      if (seq !== reqSeq.current) return;
      setLeads(data.leads || []);
      setTotal(data.total || 0);

      if (statsRes && statsRes.ok) setSrvStats(await statsRes.json());

      if (wonRes && wonRes.ok) {
        const won = await wonRes.json();
        setWonStats({
          thisMonth: won.thisMonth || 0,
          lastMonth: won.lastMonth || 0,
          daily: won.daily || {},
        });
      }
    } catch (e) { console.error(e); }
    setLoading(false);
  }

  // The export must cover every lead MATCHING THE FILTERS, not the page on
  // screen — a spreadsheet that silently stopped at the page boundary would be
  // worse than no export at all. limit=0 asks the route for the whole matching
  // set in one request.
  async function exportAllMatching() {
    try {
      const q = new URLSearchParams();
      if (statusTab !== 'all') q.set('status', statusTab);
      if (debouncedSearch.trim()) q.set('search', debouncedSearch.trim());
      if (dateFrom) q.set('dateFrom', dateFrom);
      if (dateTo) q.set('dateTo', dateTo);
      if (todaysCallsOnly) q.set('todaysCalls', 'true');
      q.set('sort', sortKey);
      q.set('dir', sortDir);
      q.set('limit', '0');
      const res = await apiFetch(`/api/leads?${q}`);
      const data = await res.json();
      downloadXLSX(data.leads || []);
    } catch (e) {
      console.error(e);
    }
  }

  // Any filter or sort change returns to page 1 — staying on page 8 of a
  // freshly narrowed result shows an empty table for no visible reason.
  useEffect(() => {
    setPage(1);
  }, [statusTab, debouncedSearch, dateFrom, dateTo, todaysCallsOnly, sortKey, sortDir]);

  useEffect(() => {
    // Subscribe first so nothing can sit between the effect starting and the
    // data fetch. Live updates are an enhancement — onEvent never throws
    // (see lib/sse.js), so a blocked EventSource can't stop the load.
    //
    // lead_update arrives in BURSTS, not one at a time. POST /api/calls
    // broadcasts one lead_update per touched customer, so a phone syncing 40
    // new calls fires 40 events back to back — and this handler used to run a
    // full refetch (three requests) on each one. That was 120 requests for a
    // single sync, every one of them re-running the same query and the last
    // one overwriting the rest. The page spent the burst rebuilding itself
    // instead of showing the new leads, which is exactly the "mobile app is
    // fine but the dashboard lags" symptom.
    //
    // Coalesced: a burst schedules ONE refetch shortly after the last event,
    // so N events cost one round trip rather than N. The delay is short enough
    // to still read as live and long enough for a sync to land whole.
    let burst = null;
    const onLeadUpdate = () => {
      clearTimeout(burst);
      burst = setTimeout(fetchLeads, 400);
    };
    const unsub = onEvent('lead_update', onLeadUpdate);
    fetchLeads();
    return () => {
      clearTimeout(burst);
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, statusTab, debouncedSearch, dateFrom, dateTo, todaysCallsOnly, sortKey, sortDir]);

  async function patchLead(leadId, patch) {
    const res  = await apiFetch(`/api/leads/${leadId}`, { method: 'PATCH', body: JSON.stringify(patch) });
    const data = await res.json();
    if (data.success) setLeads(prev => prev.map(l => l.id === leadId ? { ...l, ...data.lead } : l));
    return data;
  }

  async function patchCustomerName(lead, name) {
    await apiFetch(`/api/customers/${lead.customers.id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
    setLeads(prev => prev.map(l => l.id === lead.id ? { ...l, customers: { ...l.customers, name } } : l));
  }

  // Closing removes the ticket from Pipeline entirely (ticket_state='closed'
  // filters it out server-side) — the customer record itself is untouched
  // and permanent, only this one ticket stops showing here.
  async function closeLead(leadId, reason) {
    const data = await patchLead(leadId, { ticket_state: 'closed', closed_reason: reason });
    if (data.success) {
      setLeads(prev => prev.filter(l => l.id !== leadId));
      setClosingLead(null);
    }
    return data;
  }

  // ── figures ────────────────────────────────────────────────────────────────
  // All of these come from GET /api/leads/stats, which counts over the WHOLE
  // pipeline in Postgres. They were derived here from the loaded array, which
  // was correct only while the browser held every open lead; once the table is
  // paginated the same code would report "Overdue: 3" meaning "overdue among
  // the 50 rows on screen" — a number that reads as a total and is not one.
  //
  // `stats` is null until the first response lands, so every read falls back to
  // 0 rather than rendering NaN.
  const stats = {
    newToday:    srvStats?.new_today ?? 0,
    followToday: srvStats?.follow_today ?? 0,
    overdue:     srvStats?.overdue ?? 0,
    wonMonth:    wonStats.thisMonth,
  };

  // The same measurements one period earlier, so each tile can show a trend.
  //
  // `overdue` is the one that cannot be recomputed honestly: it depends on
  // which leads were still open at that past moment, and a lead closed since
  // then is no longer in this dataset. It is measured as the backlog dated
  // before yesterday — the same question asked one day earlier.
  const prevStats = {
    newToday:    srvStats?.new_yesterday ?? 0,
    followToday: srvStats?.follow_yesterday ?? 0,
    overdue:     srvStats?.overdue_yesterday ?? 0,
    wonMonth:    wonStats.lastMonth,
  };

  // 7-day series behind each tile's sparkline.
  //
  // Only `newLeads` is a real per-day server series (stats.daily, which uses
  // generate_series so an empty day is a true zero rather than a gap). The
  // follow-up and overdue sparklines were bucketed from the loaded array and
  // would now describe one page, so they are dropped to a flat series rather
  // than drawn from a partial set — a wrong trend line is worse than none.
  const series = (() => {
    const days = Array.from({ length: 7 }, (_, i) => {
      return addDays(businessDay(), -(6 - i));
    });
    const dailyMap = {};
    for (const row of srvStats?.daily || []) dailyMap[String(row.day).slice(0, 10)] = row.n;
    return {
      newLeads:  days.map(day => dailyMap[day] || 0),
      followUps: days.map(() => 0),
      overdue:   days.map(() => 0),
      won:       days.map(day => wonStats.daily?.[day] || 0),
    };
  })();

  // How many leads have a call due today, across the whole pipeline — the
  // count on the "Today's calls" toggle. The filtering itself happens in SQL
  // (?todaysCalls=true); this is only the badge.
  const callsTodayCount = srvStats?.calls_today ?? 0;

  // `leads` IS the current page of the server's filtered, sorted result, so it
  // is rendered as-is. Filtering or sorting it again here could only remove or
  // reorder rows the server already decided on.
  const filtered = leads;

  return (
    <div style={p.page}>
      {/* Topbar — reference design, left to right: title + count, then
          Auto Assign / Today Call / Share Lead on the right. Auto-assign and
          Today's calls are the real existing controls, restyled to the
          reference's plain .btn; Share Lead has no backend and is inert (see
          the note on its handler). */}
      <header style={p.topbar}>
        <div style={p.title}>
          Leads<span style={p.titleCount}>{total.toLocaleString()}</span>
        </div>
        <div style={p.topRight}>
          <AutoAssignToggle />
          <button
            style={{ ...p.btn, ...(todaysCallsOnly ? p.btnActive : {}) }} className="pipeline-btn"
            onClick={() => setTodaysCallsOnly(v => !v)}
            title="Show only leads with a call scheduled for today"
          >
            <PhoneCall size={12} />
            Today Call
            {callsTodayCount > 0 && (
              <span style={{ ...p.btnBadge, ...(todaysCallsOnly ? { background: '#fff', color: theme.accentInk } : {}) }}>
                {callsTodayCount}
              </span>
            )}
          </button>
          {/* Not wired: there is no share/export-link endpoint. Rendered to
              match the reference layout; clicking it deliberately does
              nothing rather than pretending to succeed. */}
          <button style={p.btnPrimary} className="pipeline-btn-primary" disabled title="Sharing a lead is not available yet">
            <Share2 size={12} />
            Share Lead
          </button>
        </div>
      </header>

      <StatsBar stats={stats} prevStats={prevStats} series={series} />
      <FilterBar statusTab={statusTab} onStatus={setStatusTab} search={search} onSearch={setSearch}
        dateFrom={dateFrom} dateTo={dateTo} onDateFrom={setDateFrom} onDateTo={setDateTo}
        onExportXLSX={exportAllMatching}
        sortKey={sortKey} sortDir={sortDir} onSortKey={setSortKey} onSortDir={setSortDir} />

      {loading ? (
        <div style={p.center}>
          <div className="summary-spinner" />
          <span style={{ color: theme.inkFaint, marginTop: 10, fontSize: 13 }}>Loading pipeline…</span>
        </div>
      ) : filtered.length === 0 ? (
        <div style={p.center}>
          <div style={p.emptyIcon}><Inbox size={28} color={theme.accentInk} strokeWidth={1.5} /></div>
          <p style={p.emptyTitle}>No leads found</p>
          <p style={p.emptySub}>Leads appear automatically when customers message via WhatsApp</p>
        </div>
      ) : (
        <LeadsTable
          leads={filtered} today={today()}
          onPatchLead={patchLead} onPatchName={patchCustomerName}
          onChat={setChatLead} onDownloadPDF={downloadLeadPDF} onOrder={setOrderLead}
          onCloseLead={setClosingLead}
          // Remounts the table on a page change, which resets its scroll to
          // the top — landing on page 3 already scrolled halfway down reads as
          // a glitch. Keyed on `page` only, so an SSE refetch of the same page
          // keeps the reader where they were.
          key={page}
          // Rendered INSIDE the table's scroll container, after the last row,
          // so it scrolls into view with the end of the list rather than
          // holding a strip of every screen.
          footer={
            total > 0 ? (
              <Pagination
                page={page} pageSize={pageSize} total={total}
                onPage={setPage}
                onPageSize={n => { setPageSize(n); setPage(1); }}
                // 20 is the default here, so it has to be one of the options
                // or the selector would open showing a size the table is not
                // using.
                pageSizes={[20, 50, 100, 200]}
              />
            ) : null
          }
        />
      )}
      {closingLead && (
        <CloseLeadModal lead={closingLead} onClose={() => setClosingLead(null)} onConfirm={reason => closeLead(closingLead.id, reason)} />
      )}

      {chatLead && <ChatViewModal lead={chatLead} onClose={() => setChatLead(null)} />}

      {/* The SAME screen the showroom walk-in flow uses, given the enquiry so it
          opens prefilled. Deliberately not a second convert-specific modal:
          one component means the multi-item cart, the free-pillow section and
          the delivery options can never differ between the two paths. */}
      {orderLead && (
        <ShowroomOrderModal
          lead={orderLead}
          onClose={() => setOrderLead(null)}
          onSaved={() => {
            // POST /api/orders closed this enquiry (it was sent leadId), and
            // this list shows open tickets only — so drop the row rather than
            // updating it, matching what a refetch would return. Its history
            // stays on the customer's page, and the customer's next contact
            // opens a fresh enquiry by itself.
            setLeads(prev => prev.filter(l => l.id !== orderLead.id));
            setOrderLead(null);
            navigate('/orders');
          }}
        />
      )}
    </div>
  );
}

// ─── Stats Bar ────────────────────────────────────────────────────────────────

// The reference's sparkline, drawn from REAL data (see buildSeries) rather
// than the mockup's hardcoded numbers — an invented trend line on a business
// dashboard would be read as fact. A flat series (every bucket equal, which is
// the common case on a small pipeline) draws a straight mid-line instead of
// dividing by a zero range.
function Spark({ points, color }) {
  const w = 68, h = 24;
  if (!points || points.length < 2) return null;
  const max = Math.max(...points), min = Math.min(...points);
  const range = max - min;
  // Inset by half the stroke on every side so the line can never be clipped by
  // the svg box at the top or bottom of its range.
  const pad = 3;
  const d = points.map((v, i) => {
    const x = pad + (i / (points.length - 1)) * (w - pad * 2);
    const y = range === 0 ? h / 2 : h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} fill="none"
      style={{ flexShrink: 0, display: 'block', overflow: 'visible' }} aria-hidden="true">
      <polyline points={d} stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StatsBar({ stats, prevStats = {}, series }) {
  // `good` is per-metric, not universal: more new leads is good, more OVERDUE
  // follow-ups is not. Without it a rising overdue backlog would render in the
  // same green as a rising win count and read as progress.
  const cards = [
    { label: 'New leads today',    value: stats.newToday,    prev: prevStats.newToday,    period: 'yesterday',  good: 'up',   color: theme.success, pts: series.newLeads },
    { label: 'Follow-ups today',   value: stats.followToday, prev: prevStats.followToday, period: 'yesterday',  good: 'up',   color: theme.info,    pts: series.followUps },
    { label: 'Overdue follow-ups', value: stats.overdue,     prev: prevStats.overdue,     period: 'yesterday',  good: 'down', color: theme.high,    pts: series.overdue },
    { label: 'Won this month',     value: stats.wonMonth,    prev: prevStats.wonMonth,    period: 'last month', good: 'up',   color: theme.med,     pts: series.won },
  ];
  return (
    <div style={sb.bar}>
      {cards.map((c, i) => {
        const tr = trend(c.value, c.prev, c.period);
        // A flat trend stays neutral grey — colouring "no change" either way
        // would imply a direction that did not happen.
        const trColor = tr.dir === 'flat'
          ? theme.inkFaint
          : tr.dir === c.good ? theme.success : theme.high;
        const Arrow = tr.dir === 'up' ? ArrowUpRight : tr.dir === 'down' ? ArrowDownRight : null;
        return (
          <div key={i} style={sb.card}>
            <div style={sb.left}>
              <div style={sb.label}>{c.label}</div>
              <div style={sb.valueRow}>
                <span style={sb.value}>{c.value}</span>
              </div>
              <div style={{ ...sb.trend, color: trColor }}>
                {Arrow && <Arrow size={11} strokeWidth={2.4} />}
                {tr.text}
              </div>
            </div>
            <Spark points={c.pts} color={c.color} />
          </div>
        );
      })}
    </div>
  );
}
// Flattened to the reference design: the metric name sits above a large plain
// number, with the icon demoted to a small tinted square on the right. The
// number is no longer tinted per-metric — colour now only marks the icon, so a
// row of four figures reads as one scale rather than four unrelated ones.
const sb = {
  bar:      { display: 'flex', background: theme.surface, borderBottom: `1px solid ${theme.border}`, flexShrink: 0 },
  // align-items:flex-start + the sparkline's own align-self, matching the
  // reference's .stat (label top-left, figure below, trend line at the right).
  card:     { flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '11px 14px 13px', borderRight: `1px solid ${theme.borderSoft}`, minWidth: 0 },
  left:     { minWidth: 0, flex: 1 },
  label:    { fontSize: 10, color: theme.inkSoft, marginBottom: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  valueRow: { display: 'flex', alignItems: 'center', gap: 7 },
  value:    { fontSize: 19, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1, color: theme.ink },
  // Replaces the old iconBox. Sits under the figure rather than beside it: the
  // text runs to ~18 characters ("No change vs last month"), which would push
  // the sparkline off a narrow tile if it shared the value's row.
  trend:    { display: 'flex', alignItems: 'center', gap: 3, marginTop: 6, fontSize: 10, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
};


// ─── Filter Bar ───────────────────────────────────────────────────────────────

// Auto-assign and Today's calls used to live in this bar's right-hand group;
// they now sit in the page topbar (reference design), so this component is
// purely search / date range / count / export.
function FilterBar({ statusTab, onStatus, search, onSearch, dateFrom, dateTo, onDateFrom, onDateTo, onExportXLSX, sortKey, sortDir, onSortKey, onSortDir }) {
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef(null);
  const dateFilterOn = Boolean(dateFrom || dateTo);
  const [sortOpen, setSortOpen] = useState(false);
  const sortRef = useRef(null);
  // 'created' desc is the default, so only a change from that counts as an
  // active sort worth marking on the icon.
  const sortOn = !(sortKey === 'created' && sortDir === 'desc');

  // Close on an outside click or Escape — same pattern as the Customers page's
  // column menu. Escape matters here because the popover holds focusable date
  // inputs, so a keyboard user needs a way out that isn't a mouse click.
  useEffect(() => {
    if (!filterOpen && !sortOpen) return;
    function onClickOutside(e) {
      if (filterRef.current && !filterRef.current.contains(e.target)) setFilterOpen(false);
      if (sortRef.current && !sortRef.current.contains(e.target)) setSortOpen(false);
    }
    function onKey(e) { if (e.key === 'Escape') { setFilterOpen(false); setSortOpen(false); } }
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [filterOpen, sortOpen]);

  // Two stacked rows, matching the reference design: status tabs as an
  // underline strip, then a separate toolbar. Same props, same handlers — the
  // tabs simply moved out of the toolbar row so neither has to wrap.
  return (
    <>
      <div style={fb.tabs} className="scroll-strip">
        {['all', ...Object.keys(STATUS)].map(key => {
          const cfg    = STATUS[key];
          const active = statusTab === key;
          return (
            <button key={key} style={{
              ...fb.tab,
              color:             active ? theme.accentInk : theme.inkSoft,
              fontWeight:        active ? 600 : 400,
              borderBottomColor: active ? theme.accent : 'transparent',
            }} onClick={() => onStatus(key)}>
              {key === 'all' ? 'All leads' : cfg.label}
            </button>
          );
        })}
      </div>
      {/* Toolbar — reference layout: search, then the three icon tools, then a
          right-hand group holding the list/grid segment and
          Import / Export / Add Lead. The date range stays (it is real and has
          nowhere else to go); the icon tools, Import and Add Lead are inert
          placeholders, marked as such on each control. */}
      <div style={fb.bar}>
        <div style={fb.searchWrap}>
          <Search size={12} color={theme.inkFaint} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)' }} />
          {/* autoComplete off: the browser would otherwise fill a phone
              number typed into an order form into this box. */}
          <input style={fb.searchInput} name="pipeline-filter" type="search" autoComplete="off" data-1p-ignore="true" data-lpignore="true" data-bwignore="true" spellCheck={false} placeholder="Search" value={search} onChange={e => onSearch(e.target.value)} />
        </div>

        {/* The created-date range moved off the toolbar and behind this icon:
            two always-visible date inputs took a third of the bar to express a
            filter that is usually empty. The icon carries a dot when a range is
            actually set, so a hidden active filter can't be forgotten. */}
        <div style={fb.filterWrap} ref={filterRef}>
          <button
            style={{ ...fb.tool, ...(dateFilterOn ? fb.toolOn : {}) }}
            className="pipeline-tool"
            onClick={() => setFilterOpen(o => !o)}
            title={dateFilterOn ? 'Created-date filter is active' : 'Filter by created date'}
            aria-expanded={filterOpen}
          >
            <Filter size={14} />
            {dateFilterOn && <span style={fb.toolDot} />}
          </button>

          {filterOpen && (
            <div style={fb.popover}>
              <div style={fb.popTitle}>Created date</div>
              <label style={fb.popRow}>
                <span style={fb.popLabel}>From</span>
                <input style={fb.dateInput} type="date" value={dateFrom}
                  max={dateTo || undefined}
                  onChange={e => onDateFrom(e.target.value)} />
              </label>
              <label style={fb.popRow}>
                <span style={fb.popLabel}>To</span>
                <input style={fb.dateInput} type="date" value={dateTo}
                  min={dateFrom || undefined}
                  onChange={e => onDateTo(e.target.value)} />
              </label>
              <div style={fb.popFoot}>
                <button
                  style={{ ...fb.popClear, opacity: dateFilterOn ? 1 : 0.45, cursor: dateFilterOn ? 'pointer' : 'default' }}
                  disabled={!dateFilterOn}
                  onClick={() => { onDateFrom(''); onDateTo(''); }}
                >
                  Clear
                </button>
                <button style={fb.popDone} onClick={() => setFilterOpen(false)}>Done</button>
              </div>
            </div>
          )}
        </div>

        {/* Sort, previously an inert placeholder. Opening it from the icon
            keeps the toolbar short; the alternative, clickable column headers,
            would not have matched the reference's header row. */}
        <div style={fb.filterWrap} ref={sortRef}>
          <button
            style={{ ...fb.tool, ...(sortOn ? fb.toolOn : {}) }}
            className="pipeline-tool"
            onClick={() => setSortOpen(o => !o)}
            title={sortOn ? `Sorted by ${SORT_OPTIONS.find(o => o.key === sortKey)?.label}` : 'Sort leads'}
            aria-expanded={sortOpen}
          >
            <ArrowUpDown size={14} />
            {sortOn && <span style={fb.toolDot} />}
          </button>

          {sortOpen && (
            <div style={fb.popover}>
              <div style={fb.popTitle}>Sort by</div>
              {SORT_OPTIONS.map(opt => (
                <button
                  key={opt.key}
                  style={{ ...fb.sortRow, ...(sortKey === opt.key ? fb.sortRowOn : {}) }}
                  onClick={() => onSortKey(opt.key)}
                >
                  {opt.label}
                  {sortKey === opt.key && <Check size={12} />}
                </button>
              ))}
              <div style={fb.popFoot}>
                <button
                  style={{ ...fb.popClear, ...(sortDir === 'asc' ? fb.dirOn : {}), cursor: 'pointer' }}
                  onClick={() => onSortDir('asc')}
                >
                  Ascending
                </button>
                <button
                  style={{ ...fb.popClear, ...(sortDir === 'desc' ? fb.dirOn : {}), cursor: 'pointer' }}
                  onClick={() => onSortDir('desc')}
                >
                  Descending
                </button>
              </div>
            </div>
          )}
        </div>
        <span style={fb.tool} className="pipeline-tool" title="Grouping is not available yet"><Rows3 size={14} /></span>

        <div style={fb.right}>
          <div style={fb.seg}>
            <span style={{ ...fb.tool, ...fb.toolOn }} title="Table view"><List size={14} /></span>
            <span style={fb.tool} className="pipeline-tool" title="Board view is not available yet"><LayoutGrid size={14} /></span>
          </div>
          <button style={fb.plainBtn} className="pipeline-btn" disabled title="Importing leads is not available yet">
            <Upload size={12} /> Import
          </button>
          <button style={fb.plainBtn} className="pipeline-btn" onClick={onExportXLSX} title="Download table as Excel">
            <FileSpreadsheet size={12} />
            <span>Export</span>
          </button>
          {/* Not wired: there is no POST /api/leads. A lead is created by the
              customer messaging in, by a synced call, or by a logged showroom
              visit — never by hand today. */}
          <button style={fb.primaryBtn} className="pipeline-btn-primary" disabled title="Leads are created automatically from WhatsApp, calls and showroom visits">
            <Plus size={12} /> Add Lead
          </button>
        </div>
      </div>
    </>
  );
}

// 15.3 — a global on/off switch for round-robin lead assignment. Admin only,
// matching GET/PATCH /api/settings/auto-assign's own role gate.
function AutoAssignToggle() {
  const { staff } = useAuth();
  const [enabled, setEnabled] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!roleAllowed(staff?.role, ['admin'])) return;
    apiFetch('/api/settings/auto-assign').then(r => r.json()).then(d => setEnabled(d.enabled)).catch(() => {});
  }, [staff?.role]);

  if (!roleAllowed(staff?.role, ['admin']) || enabled === null) return null;

  async function toggle() {
    setSaving(true);
    const next = !enabled;
    setEnabled(next);
    try {
      const res = await apiFetch('/api/settings/auto-assign', {
        method: 'PATCH', body: JSON.stringify({ enabled: next }),
      });
      const data = await res.json();
      if (!data.success) setEnabled(!next);
    } catch { setEnabled(!next); }
    setSaving(false);
  }

  return (
    <button style={fb.autoAssign} onClick={toggle} disabled={saving} title="Toggle round-robin auto-assignment for new tickets">
      <span style={{ ...fb.switchTrack, background: enabled ? theme.success : theme.border }}>
        <span style={{ ...fb.switchThumb, transform: enabled ? 'translateX(11px)' : 'translateX(0)' }} />
      </span>
      Auto-assign {enabled ? 'on' : 'off'}
    </button>
  );
}
// Reference-design filter chrome: `tabs` is now its own underline strip above
// `bar` (they used to share one flex row), and every control dropped to the
// smaller, lighter button language — hairline borders, 7px radius, 10.5px type.
const fb = {
  tabs:        { display: 'flex', gap: 18, padding: '0 16px', background: theme.surface, borderBottom: `1px solid ${theme.border}`, flexShrink: 0, overflowX: 'auto' },
  tab:         { fontSize: 11.5, padding: '9px 0 8px', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', border: 'none', background: 'none', borderBottom: '1.5px solid transparent', marginBottom: -1, transition: 'color 0.12s' },
  bar:         { display: 'flex', alignItems: 'center', padding: '9px 16px', background: theme.surface, borderBottom: `1px solid ${theme.border}`, flexShrink: 0, gap: 8, flexWrap: 'wrap' },
  right:       { display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' },
  searchWrap:  { position: 'relative' },
  searchInput: { background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 7, padding: '6px 9px 6px 27px', color: theme.ink, fontSize: 11, outline: 'none', width: 178, fontFamily: 'inherit', boxSizing: 'border-box' },
  dateInput:   { flex: 1, minWidth: 0, background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 6, padding: '4px 7px', color: theme.ink, fontSize: 10.5, outline: 'none', fontFamily: 'inherit' },
  // .tool / .seg from the reference: bare icon affordances, not buttons.
  tool:        { color: theme.inkFaint, display: 'flex', cursor: 'pointer', padding: 2, background: 'none', border: 'none', position: 'relative' },
  toolOn:      { color: theme.accentInk },
  // A dot on the icon when a range is set, so an active filter hidden inside
  // the popover is still visible from the toolbar.
  toolDot:     { position: 'absolute', top: 0, right: 0, width: 5, height: 5, borderRadius: '50%', background: theme.accent },
  filterWrap:  { position: 'relative', display: 'flex' },
  popover: {
    position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 40,
    background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 9,
    boxShadow: theme.shadowMd, padding: 10, width: 194,
  },
  popTitle:    { fontSize: 9, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: theme.inkFaint, marginBottom: 8 },
  popRow:      { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 },
  popLabel:    { fontSize: 10.5, color: theme.inkSoft, width: 30, flexShrink: 0 },
  popFoot:     { display: 'flex', alignItems: 'center', gap: 6, marginTop: 9, paddingTop: 9, borderTop: `1px solid ${theme.borderSoft}` },
  popClear:    { flex: 1, background: theme.surface, border: `1px solid ${theme.border}`, color: theme.inkSoft, fontSize: 10.5, fontWeight: 500, padding: '5px 0', borderRadius: 6, fontFamily: 'inherit' },
  popDone:     { flex: 1, background: theme.accent, border: `1px solid ${theme.accent}`, color: '#fff', fontSize: 10.5, fontWeight: 500, padding: '5px 0', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit' },
  sortRow:     { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, background: 'none', border: 'none', color: theme.inkSoft, fontSize: 11, fontWeight: 400, padding: '5px 7px', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' },
  sortRowOn:   { background: theme.accentSoft, color: theme.accentInk, fontWeight: 500 },
  dirOn:       { background: theme.accentSoft, borderColor: theme.accent, color: theme.accentInk, fontWeight: 600 },
  seg:         { display: 'flex', alignItems: 'center', gap: 8, marginRight: 2 },
  // .btn and .btn.primary from the reference, 25px tall with a hairline border.
  plainBtn:    { height: 25, display: 'flex', alignItems: 'center', gap: 5, background: theme.surface, border: `1px solid ${theme.border}`, color: theme.inkSoft, fontSize: 10.5, fontWeight: 500, padding: '0 9px', borderRadius: 7, cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit' },
  primaryBtn:  { height: 25, display: 'flex', alignItems: 'center', gap: 5, background: theme.accent, border: `1px solid ${theme.accent}`, color: '#fff', fontSize: 10.5, fontWeight: 500, padding: '0 9px', borderRadius: 7, cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit', boxShadow: '0 1px 2px rgba(13,148,136,0.35)' },
  autoAssign:  { display: 'flex', alignItems: 'center', gap: 6, background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 7, padding: '5px 10px', fontSize: 11, fontWeight: 500, color: theme.inkSoft, cursor: 'pointer', fontFamily: 'inherit' },
  switchTrack: { position: 'relative', width: 26, height: 15, borderRadius: 10, flexShrink: 0, transition: 'background 0.15s' },
  switchThumb: { position: 'absolute', top: 2, left: 2, width: 11, height: 11, borderRadius: '50%', background: '#fff', transition: 'transform 0.15s' },
};

// ─── Leads Table (modern: primary row + expandable detail panel) ────────────

function LeadsTable({ leads, today, onPatchLead, onPatchName, onChat, onDownloadPDF, onOrder, onCloseLead, footer }) {
  const navigate = useNavigate();

  return (
    <div style={lt.wrap}>
      <table style={{ ...lt.table, ...lt.tableFit }} className="leads-table">
        <thead>
          <tr>
            <th style={{ ...lt.th, width: 30 }} />
            <th style={{ ...lt.th, width: 128 }}>Phone Number</th>
            <th style={{ ...lt.th, width: 150 }}>Name</th>
            <th style={{ ...lt.th, width: 118 }}>Source</th>
            <th style={{ ...lt.th, width: 160 }}>Product</th>
            <th style={{ ...lt.th, width: 140 }}>Follow-up</th>
            <th style={{ ...lt.th, width: 82 }} title="Last 3 calls, newest first — red: missed, green: outgoing, blue: incoming. Hover for the call history.">Last calls</th>
            <th style={{ ...lt.th, width: 136 }}>Assigned / SLA</th>
            <th style={{ ...lt.th, width: 124 }}>Status</th>
            <th style={{ ...lt.th, width: 106 }}>Priority</th>
            <th style={{ ...lt.th, width: 130, textAlign: 'center' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {leads.map(l => (
            <LeadRow key={l.id} lead={l} today={today}
              onOpenDetail={() => navigate(`/leads/${l.id}`)}
              onPatchLead={onPatchLead} onPatchName={onPatchName}
              onChat={onChat} onDownloadPDF={onDownloadPDF} onOrder={onOrder} onCloseLead={onCloseLead}
            />
          ))}
        </tbody>
      </table>
      {/* Inside the scroll container, after the last row — so the pager simply
          follows the table and comes into view as you reach the end of the
          list. No scroll listener, no visibility state: the browser's own
          scrolling is the mechanism. */}
      {footer}
    </div>
  );
}

function LeadRow({ lead, today, onOpenDetail, onPatchLead, onPatchName, onChat, onDownloadPDF, onOrder, onCloseLead }) {
  const alreadyWon = lead.status === 'won';
  const st = STATUS[lead.status] || STATUS.new;
  const pri = PRIORITY[lead.priority] || PRIORITY.medium;
  const source = sourceBadge(lead.source);
  const sla = slaBadge(lead);
  const [editingName, setEditingName] = useState(false);
  const [nameVal, setNameVal] = useState(lead.customers?.name || '');

  const productSummary = [lead.product_type?.replace(' Mattress', ''), lead.bed_size]
    .filter(Boolean).join(' · ');
  const nextUp = nextFollowUp(lead);

  return (
    <>
      {/* No inline background: an inline declaration outranks the stylesheet,
          so it silently killed the .leads-table row-hover tint. The table
          itself is already on theme.surface, so the row inherits white. */}
      <tr style={lt.row}>
        <td style={{ ...lt.td, textAlign: 'center' }}>
          <button style={lt.expandBtn} className="expand-btn" onClick={onOpenDetail} title="Open lead details">
            <ChevronRight size={12} />
          </button>
        </td>
        <td style={{ ...lt.td, ...lt.phoneCell }}>
          {lead.customers?.whatsapp_number || <span style={lt.dash}>—</span>}
        </td>
        <td style={lt.td}>
          {editingName ? (
            <input
              style={lt.nameInput} autoFocus value={nameVal}
              onChange={e => setNameVal(e.target.value)}
              onBlur={() => { setEditingName(false); if (nameVal !== (lead.customers?.name || '')) onPatchName(lead, nameVal || null); }}
              onKeyDown={e => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') { setNameVal(lead.customers?.name || ''); setEditingName(false); }
              }}
            />
          ) : (
            <div onClick={() => setEditingName(true)} style={{ cursor: 'text' }} title="Click to edit name">
              <div style={lt.custName}>{lead.customers?.name || <span style={lt.dash}>Add name</span>}</div>
            </div>
          )}
        </td>
        <td style={lt.td}>
          {source ? (
            <span style={lt.sourceBadge} title={lead.source}>
              {source.label}{lead.source === 'showroom' && lead.showroom_location ? ` · ${lead.showroom_location}` : ''}
            </span>
          ) : <span style={lt.dash}>—</span>}
        </td>
        <td style={lt.td}>
          {productSummary ? <span style={lt.productText}>{productSummary}</span> : <span style={lt.dash}>Add in details</span>}
        </td>
        <td style={lt.td}>
          {nextUp ? (
            <div>
              <div style={lt.followUpStage}>{nextUp.label}</div>
              <div style={{
                fontSize: 10.5, fontWeight: 600,
                color: nextUp.date < today ? theme.high : nextUp.date === today ? theme.med : theme.ink,
              }}>
                {new Date(nextUp.date).toLocaleDateString('en', { day: 'numeric', month: 'short' })}
                {nextUp.date < today ? ' · Overdue' : nextUp.date === today ? ' · Today' : ''}
              </div>
            </div>
          ) : <span style={lt.dash}>No follow-up scheduled</span>}
        </td>
        <td style={lt.td}>
          <CallDots calls={lead.recent_calls} customerId={lead.customer_id} customerName={lead.customers?.name || lead.customers?.whatsapp_number} />
        </td>
        <td style={lt.td}>
          {lead.assigned_staff_name && (
            <div style={lt.assignee}>
              <span style={lt.assigneeAvatar}>{lead.assigned_staff_name.charAt(0).toUpperCase()}</span>
              {lead.assigned_staff_name.split(' ')[0]}
            </div>
          )}
          {sla && <span style={{ ...lt.slaBadge, color: sla.color, background: sla.bg }}>{sla.label}</span>}
          {!lead.assigned_staff_name && !sla && <span style={lt.dash}>—</span>}
        </td>
        <td style={lt.td}>
          <select
            style={{ ...lt.statusSelect, color: st.color, background: st.bg, borderColor: st.color + '33' }}
            value={lead.status}
            onChange={e => onPatchLead(lead.id, { status: e.target.value })}
          >
            {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </td>
        <td style={lt.td}>
          <select
            style={{ ...lt.statusSelect, color: pri.color, background: pri.bg, borderColor: pri.color + '33' }}
            value={lead.priority || 'medium'}
            onChange={e => onPatchLead(lead.id, { priority: e.target.value })}
          >
            {Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </td>
        <td style={{ ...lt.td, textAlign: 'center' }}>
          <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
            <CallButton customerId={lead.customers?.id} leadId={lead.id} customerName={lead.customers?.name || lead.customers?.whatsapp_number} />
            <button style={lt.chatBtn} className="act-ic" onClick={() => onChat(lead)} title="View chat"><MessageCircle size={11} /></button>
            <button style={lt.pdfBtn} className="act-ic" onClick={() => onDownloadPDF(lead)} title="Download PDF"><Download size={11} /></button>
            <button
              style={{ ...lt.orderBtn, opacity: alreadyWon ? 0.4 : 1 }}
              className="act-ic"
              onClick={() => !alreadyWon && onOrder(lead)}
              title={alreadyWon ? 'Already converted to order' : 'Convert to order'}
            >
              <ShoppingCart size={11} />
            </button>
            <button style={lt.closeBtn} className="act-ic danger" onClick={() => onCloseLead(lead)} title="Close lead">
              <XCircle size={11} />
            </button>
          </div>
        </td>
      </tr>
    </>
  );
}

// ─── Expandable detail panel — everything beyond the primary columns ────────

export function DetailPanel({ lead, onPatchLead, onPatchCustomer, itemsCtl }) {
  const [local, setLocal] = useState(lead);
  useEffect(() => { setLocal(lead); }, [lead]);

  // Customer name is edited here but lives on the customer record, so it is
  // tracked separately from `local` (which mirrors the LEAD row).
  const [custNameLocal, setCustNameLocal] = useState(lead.customers?.name || '');
  useEffect(() => { setCustNameLocal(lead.customers?.name || ''); }, [lead.customers?.name]);

  function set(field, value) { setLocal(prev => ({ ...prev, [field]: value })); }
  function commit(field, value) {
    if (value === (lead[field] ?? '')) return;
    onPatchLead(lead.id, { [field]: value === '' ? null : value });
  }

  // A call-originated lead: customers.channel='call'. Checked on the channel
  // rather than leads.source because two source strings mean "call" —
  // 'Call tracker app' (current) and 'Dialog call' (the retired webhook
  // integration, still present on real historical rows).
  const isCallLead = lead.customers?.channel === 'call';
  const [waNumber, setWaNumber] = useState(lead.customers?.contact_whatsapp_number || '');
  const [waError,  setWaError]  = useState('');
  const [waSaved,  setWaSaved]  = useState(false);
  useEffect(() => {
    setWaNumber(lead.customers?.contact_whatsapp_number || '');
    setWaError(''); setWaSaved(false);
  }, [lead.customers?.contact_whatsapp_number]);

  async function commitWhatsApp() {
    const raw = waNumber.trim();
    const current = lead.customers?.contact_whatsapp_number || '';
    // Compare on digits so re-blurring a saved '077 123 4567' isn't treated
    // as a change against the stored '0771234567'.
    if (raw.replace(/[^0-9]/g, '') === current) { setWaError(''); return; }
    if (raw !== '' && (raw.replace(/[^0-9]/g, '').length < 9 || raw.replace(/[^0-9]/g, '').length > 15)) {
      setWaError('Enter 9-15 digits'); setWaSaved(false); return;
    }
    const data = await onPatchCustomer?.(lead, { contact_whatsapp_number: raw });
    if (data && !data.success) { setWaError(data.error || 'Could not save'); setWaSaved(false); return; }
    setWaError(''); setWaSaved(raw !== '');
  }

  return (
    <div style={dp.wrap}>
      {/* Customer — moved out of the page header so name and phone are
          editable in place rather than being read-only chrome at the top.
          Name writes to the CUSTOMER record (shared across all their
          tickets), which is why it goes through onPatchCustomer rather than
          onPatchLead. The number is read-only: it is the customer's identity
          key that every channel dedups on (see migration 030) — changing it
          here would silently split or merge customer records. A call lead
          whose number has no WhatsApp is handled by the separate "WhatsApp
          contact" section below. */}
      <div style={dp.section}>
        <p style={dp.sectionTitle}>Customer</p>
        <div style={dp.grid2}>
          <Field label="Name">
            <input
              style={dp.input}
              value={custNameLocal}
              placeholder="Add name"
              onChange={e => setCustNameLocal(e.target.value)}
              onBlur={e => {
                const v = e.target.value.trim();
                if (v !== (lead.customers?.name || '')) {
                  onPatchCustomer?.(lead, { name: v || null });
                }
              }}
            />
          </Field>
          <Field label="Phone number">
            <input
              style={{ ...dp.input, background: theme.bg, color: theme.inkSoft, fontFamily: theme.mono }}
              value={lead.customers?.whatsapp_number || ''}
              readOnly
              title="The customer's identity number — every channel matches on it, so it is not editable here"
            />
          </Field>
        </div>
      </div>

      {/* Products — the New Showroom Order card picker plus a right-side
          items panel, replacing the old two-dropdown single-product form.
          A lead can hold several products now (migration 031): a customer
          comparing two mattresses no longer loses one of them. Quotation No.
          moved below since it is paperwork, not product selection. */}
      <div style={dp.section}>
        <LeadProductsPanel ctl={itemsCtl} />
      </div>

      <div style={dp.section}>
        <p style={dp.sectionTitle}>Call notes</p>

        <div style={dp.noteRow}>
          <textarea
            style={dp.noteBox}
            value={local.follow_up_notes || ''}
            onChange={e => set('follow_up_notes', e.target.value)}
            onBlur={e => commit('follow_up_notes', e.target.value)}
            placeholder="Anything worth knowing on the next contact — preferred call time, who else is deciding, delivery constraints…"
          />
        </div>
      </div>

      <div style={dp.section}>
        <p style={dp.sectionTitle}>Location</p>
        <div style={dp.grid2}>
          <Field label="Location">
            <input style={dp.input} value={local.location || ''} onChange={e => set('location', e.target.value)} onBlur={e => commit('location', e.target.value)} />
          </Field>
          <Field label="Delivery address">
            <input style={dp.input} value={local.delivery_address || ''} onChange={e => set('delivery_address', e.target.value)} onBlur={e => commit('delivery_address', e.target.value)} />
          </Field>
        </div>
      </div>
      {isCallLead && (
        <div style={dp.section}>
          <p style={dp.sectionTitle}>WhatsApp contact</p>
          <p style={dp.sectionHint}>
            This lead came from a phone call, so the number above is the one they called from — it may not be on WhatsApp.
            Record their WhatsApp number here and all automated messages (order confirmations, follow-up promos, campaigns) will go to it instead.
          </p>
          <div style={dp.grid2}>
            <Field label="Called from">
              <input style={{ ...dp.input, background: theme.bg, color: theme.inkFaint }}
                value={lead.customers?.whatsapp_number || ''} readOnly />
            </Field>
            <Field label="WhatsApp number">
              <input style={dp.input} inputMode="tel"
                placeholder="Enter WhatsApp Number"
                value={waNumber}
                onChange={e => { setWaNumber(e.target.value); setWaError(''); }}
                onBlur={commitWhatsApp} />
              {waError
                ? <p style={dp.waError}>{waError}</p>
                : waSaved
                  ? <p style={dp.waSaved}>Saved — messages will go to this number</p>
                  : null}
            </Field>
          </div>
        </div>
      )}

      <div style={dp.section}>
        <p style={dp.sectionTitle}>Follow-up schedule</p>
        <div style={dp.grid2}>
          <Field label="First call">
            <div style={dp.dateRow}>
              <input style={dp.input} type="date" value={local.follow_up_1_date ? local.follow_up_1_date.slice(0, 10) : ''} onChange={e => set('follow_up_1_date', e.target.value)} onBlur={e => commit('follow_up_1_date', e.target.value)} />
              <label style={dp.doneCheck}>
                <input type="checkbox" checked={!!local.follow_up_1_done} onChange={e => { set('follow_up_1_done', e.target.checked); onPatchLead(lead.id, { follow_up_1_done: e.target.checked }); }} />
                Done
              </label>
            </div>
            <textarea
              style={dp.callNoteBox}
              value={local.first_call || ''}
              onChange={e => set('first_call', e.target.value)}
              onBlur={e => commit('first_call', e.target.value)}
              placeholder="What the customer said on this call — requirement, budget, room size, objections…"
            />
          </Field>
          <Field label="Second call">
            <div style={dp.dateRow}>
              <input style={dp.input} type="date" value={local.follow_up_2_date ? local.follow_up_2_date.slice(0, 10) : ''} onChange={e => set('follow_up_2_date', e.target.value)} onBlur={e => commit('follow_up_2_date', e.target.value)} />
              <label style={dp.doneCheck}>
                <input type="checkbox" checked={!!local.follow_up_2_done} onChange={e => { set('follow_up_2_done', e.target.checked); onPatchLead(lead.id, { follow_up_2_done: e.target.checked }); }} />
                Done
              </label>
            </div>
            <textarea
              style={dp.callNoteBox}
              value={local.second_call || ''}
              onChange={e => set('second_call', e.target.value)}
              onBlur={e => commit('second_call', e.target.value)}
              placeholder="What changed since the first call — decision, new questions, who else is involved…"
            />
          </Field>
        </div>
        {local.promo_sent_at && (
          <p style={dp.promoSentNote}>✓ Automated promo sent {new Date(local.promo_sent_at).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' })}</p>
        )}

        {local.follow_up_2_done && (
          <div style={{ marginTop: 12 }}>
            <p style={dp.sectionSubtitle}>Weekly follow-ups</p>
            <div style={dp.grid4}>
              {[1, 2, 3, 4].map(n => {
                const dateKey = `week_${n}_date`;
                const sentKey = `week_${n}_sent_at`;
                const noteKey = `week_0${n}`;
                return (
                  <Field key={n} label={`Week ${n}`}>
                    <input
                      style={dp.input} type="date"
                      value={local[dateKey] ? local[dateKey].slice(0, 10) : ''}
                      onChange={e => set(dateKey, e.target.value)}
                      onBlur={e => commit(dateKey, e.target.value)}
                    />
                    {local[sentKey] && (
                      <p style={dp.weekSentNote}>✓ Sent {new Date(local[sentKey]).toLocaleDateString('en', { day: 'numeric', month: 'short' })}</p>
                    )}
                    <textarea style={{ ...dp.textarea, marginTop: 6 }} value={local[noteKey] || ''} onChange={e => set(noteKey, e.target.value)} onBlur={e => commit(noteKey, e.target.value)} placeholder="Notes…" />
                  </Field>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Closing a ticket takes it off the Pipeline entirely — the customer
// record is permanent and untouched, only this one ticket stops showing.
// A reason is required so admins can see why on the Team page's
// closed-leads monitoring section.
export function CloseLeadModal({ lead, onClose, onConfirm }) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  useErrorPopup(error, 'Could not close the lead');

  async function confirm() {
    if (!reason.trim()) return;
    setSaving(true); setError(null);
    const data = await onConfirm(reason.trim());
    if (!data?.success) { setError(data?.error || 'Failed to close lead'); setSaving(false); }
  }

  return (
    <div style={clm.backdrop} onClick={e => e.target === e.currentTarget && !saving && onClose()}>
      <div style={clm.modal}>
        <div style={clm.header}>
          <div style={clm.headerIcon}><XCircle size={16} color={theme.high} /></div>
          <div style={{ flex: 1 }}>
            <p style={clm.title}>Close lead</p>
            <p style={clm.sub}>{custName(lead)} · {lead.customers?.whatsapp_number}</p>
          </div>
          <button style={clm.closeBtn} onClick={onClose} disabled={saving}><X size={15} /></button>
        </div>
        <div style={clm.body}>
          <p style={clm.note}>
            This removes the ticket from the Pipeline. The customer&apos;s record is kept permanently — this only closes this one ticket.
          </p>
          <label style={clm.label}>Reason (required)</label>
          <textarea
            style={clm.textarea} value={reason} onChange={e => setReason(e.target.value)}
            placeholder="e.g. Customer went with a competitor, budget too low, unresponsive after 3 attempts..."
            autoFocus
          />
        </div>
        <div style={clm.footer}>
          <button style={clm.cancelBtn} onClick={onClose} disabled={saving}>Cancel</button>
          <button style={{ ...clm.confirmBtn, opacity: reason.trim() ? 1 : 0.5 }} onClick={confirm} disabled={saving || !reason.trim()}>
            {saving ? 'Closing...' : 'Close lead'}
          </button>
        </div>
      </div>
    </div>
  );
}

const clm = {
  backdrop: modalBackdrop,
  modal: { background: theme.surface, borderRadius: 16, width: '100%', maxWidth: 440, boxShadow: theme.shadowMd },
  header: { display: 'flex', alignItems: 'flex-start', gap: 12, padding: '16px 20px', borderBottom: `1px solid ${theme.border}` },
  headerIcon: { width: 34, height: 34, borderRadius: 9, background: theme.highBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  title: { fontSize: 14.5, fontWeight: 700, color: theme.ink, margin: 0 },
  sub: { fontSize: 12, color: theme.inkFaint, margin: '2px 0 0' },
  closeBtn: { background: theme.borderSoft, border: 'none', cursor: 'pointer', width: 28, height: 28, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.inkSoft, flexShrink: 0 },
  body: { padding: '16px 20px' },
  note: { fontSize: 12, color: theme.inkSoft, lineHeight: 1.5, margin: '0 0 14px', background: theme.bg, borderRadius: 8, padding: '8px 10px' },
  label: { fontSize: 11, fontWeight: 700, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 },
  textarea: { width: '100%', border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', background: theme.bg, color: theme.ink, minHeight: 80, resize: 'vertical', boxSizing: 'border-box' },
  error: { color: theme.high, fontSize: 12, marginTop: 8 },
  footer: { display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 20px', borderTop: `1px solid ${theme.border}` },
  cancelBtn: { background: theme.bg, border: `1px solid ${theme.border}`, color: theme.inkSoft, fontSize: 13, fontWeight: 600, padding: '8px 18px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
  confirmBtn: { background: theme.high, border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, padding: '8px 22px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
};

function Field({ label, children }) {
  return (
    <div style={dp.field}>
      <label style={dp.fieldLabel}>{label}</label>
      {children}
    </div>
  );
}

const dp = {
  // Each note gets its own full-width row — these are narrative notes, not
  // one-line fields, so they don't belong in the panel's 2/3/4-column grids.
  noteRow: { marginBottom: 12 },
  // Per-call note, sitting under its own date + Done row inside the
  // follow-up schedule grid. Roomier than dp.textarea, which was cramped
  // enough that staff missed these fields entirely.
  callNoteBox: { width: '100%', minHeight: 62, marginTop: 6, background: theme.bg, border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '8px 10px', fontSize: 12.5, lineHeight: 1.5, color: theme.ink, fontFamily: 'inherit', boxSizing: 'border-box', resize: 'vertical' },
  noteLabel: { display: 'block', fontSize: 11, fontWeight: 600, color: theme.inkFaint, marginBottom: 4 },
  noteBox: { width: '100%', minHeight: 68, background: theme.bg, border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '9px 11px', fontSize: 12.5, lineHeight: 1.55, color: theme.ink, fontFamily: 'inherit', boxSizing: 'border-box', resize: 'vertical' },
  productMeta: { margin: '4px 0 0', fontSize: 10.5, color: theme.inkFaint, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
  catPill: { fontSize: 9.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.3, color: theme.inkSoft, background: theme.borderSoft, borderRadius: 5, padding: '2px 6px' },
  priceNote: { margin: '4px 0 0', fontSize: 10.5, fontWeight: 600, color: theme.med },
  priceOk: { margin: '4px 0 0', fontSize: 10.5, fontWeight: 600, color: theme.success },
  priceReset: { background: 'none', border: 'none', padding: 0, font: 'inherit', color: theme.accent, textDecoration: 'underline', cursor: 'pointer' },
  waError: { margin: '4px 0 0', fontSize: 11, fontWeight: 600, color: theme.high },
  waSaved: { margin: '4px 0 0', fontSize: 11, fontWeight: 600, color: theme.success },
  wrap: { padding: '18px 24px 22px 24px', display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 1400, width: '100%', boxSizing: 'border-box' },
  section: { display: 'flex', flexDirection: 'column', gap: 10 },
  sectionTitle: { fontSize: 11, fontWeight: 700, color: theme.accentInk, textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0 },
  sectionHint: { fontSize: 11.5, color: theme.inkFaint, margin: '-4px 0 4px', lineHeight: 1.5 },
  dateRow: { display: 'flex', alignItems: 'center', gap: 10 },
  doneCheck: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: theme.inkSoft, whiteSpace: 'nowrap', cursor: 'pointer' },
  promoSentNote: { fontSize: 12, color: theme.success, fontWeight: 600, margin: 0 },
  sectionSubtitle: { fontSize: 10.5, fontWeight: 700, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 8px' },
  weekSentNote: { fontSize: 10.5, color: theme.success, fontWeight: 600, margin: '3px 0 0' },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  grid4: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 },
  grid3: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 },
  field: { display: 'flex', flexDirection: 'column', gap: 5 },
  fieldLabel: { fontSize: 10.5, fontWeight: 600, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.04em' },
  input: { background: theme.surface, border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '7px 10px', fontSize: 13, color: theme.ink, fontFamily: 'inherit', boxSizing: 'border-box' },
  select: { background: theme.surface, border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '7px 10px', fontSize: 13, color: theme.ink, fontFamily: 'inherit', cursor: 'pointer' },
  textarea: { background: theme.surface, border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '7px 10px', fontSize: 13, color: theme.ink, fontFamily: 'inherit', minHeight: 60, resize: 'vertical', lineHeight: 1.5, boxSizing: 'border-box' },
};

// Repainted to the reference design: a denser grid (smaller type, tighter
// padding, hairline row rules), uppercase micro-headers, squared status/priority
// pills instead of rounded-20 lozenges, and outlined action buttons that only
// pick up colour on hover. `phoneCell` is new, for the phone column the
// reference adds. Column widths live on the <th>s, as before.
const lt = {
  // minHeight: 0 is load-bearing, not tidying. A flex item defaults to
  // min-height: auto, i.e. "never shrink below my content" — so with a full
  // page of rows this container grew past the viewport instead of scrolling
  // inside it, pushing the pager docked beneath it off the bottom of the
  // screen. The pager only became visible once you scrolled the whole page.
  // Overriding it to 0 lets the container shrink and scroll internally, which
  // is what overflowY: auto was always meant to do.
  wrap:  { flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'auto', background: theme.surface },
  // No horizontal scrollbar under the rows.
  //
  // The 11 columns declare 1304px of width, so on anything narrower than
  // roughly a 1368px window the table overflowed and drew a scrollbar across
  // the bottom of the page. Hiding that bar alone would have been wrong — it
  // was doing a real job, and the Actions column would simply have become
  // unreachable.
  //
  // Instead the table is allowed to FIT. With tableLayout: 'fixed' the <th>
  // widths behave as proportions once the table is constrained to 100%, so the
  // columns scale down together rather than one being cut off, and every cell
  // already truncates with an ellipsis (see td/th below) so narrowing degrades
  // into shorter text rather than lost content. minWidth stops that collapsing
  // past the point of legibility on a genuinely small window, where the strip
  // does then scroll — deliberately, because at that width there is no honest
  // alternative.
  tableFit: { minWidth: 980, width: '100%' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12, background: theme.surface, tableLayout: 'fixed' },
  th:    { padding: '7px 9px', color: theme.inkFaint, fontWeight: 500, fontSize: 9.5, textAlign: 'left', whiteSpace: 'nowrap', background: theme.surface, position: 'sticky', top: 0, zIndex: 1, textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: `1px solid ${theme.border}` },
  row:   { borderBottom: `1px solid ${theme.borderSoft}` },
  td:    { padding: '10px 9px', color: theme.inkSoft, verticalAlign: 'middle', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis' },
  dash:  { color: theme.inkFaint, fontSize: 12 },

  expandBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', color: theme.inkFaint, cursor: 'pointer', width: 20, height: 20, borderRadius: 5 },
  // Styled to read as the reference's bordered pill rather than a native form
  // control: appearance:none drops the OS dropdown arrow and grey chrome, so a
  // still-fully-functional <select> looks like the static chip in the design.
  statusSelect: {
    appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
    border: '1px solid transparent', borderRadius: 4, padding: '2px 7px',
    fontSize: 9.5, fontWeight: 500, letterSpacing: '0.04em', textTransform: 'uppercase',
    cursor: 'pointer', outline: 'none', fontFamily: 'inherit', maxWidth: '100%', textAlign: 'left',
  },
  phoneCell: { color: theme.ink, fontVariantNumeric: 'tabular-nums', letterSpacing: '0.01em', whiteSpace: 'nowrap' },
  custName: { fontWeight: 500, color: theme.ink, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  custPhone: { fontSize: 10.5, color: theme.inkFaint, fontFamily: theme.mono, marginTop: 1 },
  nameInput: { border: `1px solid ${theme.accent}`, borderRadius: 5, padding: '3px 6px', fontSize: 12, fontFamily: 'inherit', width: '100%', boxSizing: 'border-box', outline: 'none' },
  // Plain text, not a chip: no border, no fill, no emoji. The source is
  // reference information rather than a status, so it does not need the
  // visual weight a bordered pill gives it.
  sourceBadge: { fontSize: 12, color: theme.inkSoft, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' },
  productText: { fontSize: 12, color: theme.inkSoft },
  dateInput: { border: `1px solid ${theme.border}`, borderRadius: 5, padding: '3px 6px', fontSize: 12, fontFamily: 'inherit', color: theme.ink, background: theme.surface },
  followUpStage: { fontSize: 10, fontWeight: 600, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.04em' },
  assignee: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: theme.inkSoft, marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden' },
  assigneeAvatar: { width: 15, height: 15, borderRadius: '50%', background: theme.accentSoft, color: theme.accentInk, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9.5, fontWeight: 600, flexShrink: 0 },
  slaBadge: { display: 'inline-flex', fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4 },
  chatBtn:  { display: 'flex', alignItems: 'center', justifyContent: 'center', background: theme.surface, border: `1px solid ${theme.border}`, color: theme.inkSoft, width: 19, height: 19, borderRadius: 5, cursor: 'pointer' },
  pdfBtn:   { display: 'flex', alignItems: 'center', justifyContent: 'center', background: theme.surface, border: `1px solid ${theme.border}`, color: theme.inkSoft, width: 19, height: 19, borderRadius: 5, cursor: 'pointer' },
  orderBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', background: theme.surface, border: `1px solid ${theme.border}`, color: theme.inkSoft, width: 19, height: 19, borderRadius: 5, cursor: 'pointer' },
  closeBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', background: theme.surface, border: `1px solid ${theme.border}`, color: theme.high, width: 19, height: 19, borderRadius: 5, cursor: 'pointer' },
};

// ─── Confirm Order Modal ──────────────────────────────────────────────────────

// Delivery/payment vocabulary is shared with every other order screen via
// lib/deliveryMethod.js. This modal keeps its own payment list (it offers
// 'cheque', which the other flows don't) but takes the delivery methods —
// including 'cash_on_delivery' — from the shared module.





// ─── Chat View Modal ──────────────────────────────────────────────────────────

export function ChatViewModal({ lead, onClose }) {
  const [messages, setMessages] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [reply,    setReply]    = useState('');
  const [sending,  setSending]  = useState(false);
  const bottomRef  = useRef(null);
  const customerId = lead.customers?.id;
  const n          = custName(lead);

  async function fetchMsgs() {
    if (!customerId) return;
    const res  = await apiFetch(`/api/messages?customer_id=${customerId}`);
    const data = await res.json();
    setMessages(data.messages || []);
    setLoading(false);
  }

  useEffect(() => {
    fetchMsgs();
    const unsub = onEvent('message_insert', fetchMsgs);
    return unsub;
  }, [customerId]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  async function sendReply() {
    if (!reply.trim() || sending || !customerId) return;
    setSending(true);
    await apiFetch('/api/send-message', {
      method: 'POST',
      body: JSON.stringify({ customerId, message: reply.trim() }),
    });
    setReply('');
    await fetchMsgs();
    setSending(false);
  }

  const st = STATUS[lead.status];

  return (
    <div style={cv.backdrop} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={cv.modal} className="summary-card">
        <div style={cv.header}>
          <div style={cv.avatar}>{n.charAt(0).toUpperCase()}</div>
          <div style={{ flex: 1 }}>
            <p style={cv.name}>{n}</p>
            <p style={cv.phone}>{lead.customers?.whatsapp_number}</p>
          </div>
          {st && (
            <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 20, background: st.bg, color: st.color }}>
              {st.label}
            </span>
          )}
          <button style={cv.closeBtn} onClick={onClose}><X size={16} /></button>
        </div>

        <div style={cv.body}>
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><div className="summary-spinner" /></div>
          ) : messages.length === 0 ? (
            <p style={{ textAlign: 'center', color: theme.inkFaint, fontSize: 13, padding: 40 }}>No messages yet</p>
          ) : (
            messages.map(m => (
              <div key={m.id} style={{ display: 'flex', justifyContent: m.direction === 'outbound' ? 'flex-end' : 'flex-start', marginBottom: 8 }}>
                <div style={{
                  maxWidth: '70%', padding: '8px 12px', borderRadius: 12,
                  background: m.direction === 'outbound' ? theme.accent : theme.bg,
                  color: m.direction === 'outbound' ? '#fff' : theme.ink,
                  fontSize: 13, lineHeight: 1.5,
                }}>
                  {m.content}
                </div>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>

        <div style={cv.footer}>
          <input
            style={cv.replyInput} placeholder="Type a reply…" value={reply}
            onChange={e => setReply(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && sendReply()}
          />
          <button style={cv.sendBtn} onClick={sendReply} disabled={sending || !reply.trim()}>
            {sending ? '…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}

const cv = {
  backdrop: modalBackdrop,
  modal: { background: theme.surface, borderRadius: 16, width: '100%', maxWidth: 520, maxHeight: vh(85), display: 'flex', flexDirection: 'column', boxShadow: theme.shadowMd, overflow: 'hidden' },
  header: { display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', borderBottom: `1px solid ${theme.border}` },
  avatar: { width: 36, height: 36, borderRadius: '50%', background: theme.accent, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 15, flexShrink: 0 },
  name: { fontSize: 13.5, fontWeight: 700, color: theme.ink, margin: 0 },
  phone: { fontSize: 11.5, color: theme.inkFaint, margin: 0 },
  closeBtn: { background: theme.borderSoft, border: 'none', cursor: 'pointer', width: 28, height: 28, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.inkSoft, flexShrink: 0 },
  body: { flex: 1, overflowY: 'auto', padding: 16, background: theme.bg },
  footer: { display: 'flex', gap: 8, padding: 12, borderTop: `1px solid ${theme.border}`, background: theme.surface },
  replyInput: { flex: 1, background: theme.bg, border: `1.5px solid ${theme.border}`, borderRadius: 20, padding: '9px 16px', fontSize: 13, outline: 'none', fontFamily: 'inherit', color: theme.ink },
  sendBtn: { background: theme.accent, border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, padding: '9px 18px', borderRadius: 20, cursor: 'pointer', fontFamily: 'inherit' },
};

const p = {
  page: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: theme.bg },
  topbar: {
    height: 44, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px',
    background: theme.surface, borderBottom: `1px solid ${theme.border}`,
  },
  title: { fontSize: 14.5, fontWeight: 600, letterSpacing: '-0.01em', color: theme.ink },
  titleCount: { fontSize: 11, color: theme.inkFaint, fontWeight: 500, marginLeft: 5 },
  topRight: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 7 },
  // .btn / .share from the reference: 26px tall, hairline border, and the
  // primary carries the accent's own soft shadow.
  btn:        { height: 26, display: 'flex', alignItems: 'center', gap: 5, background: theme.surface, border: `1px solid ${theme.border}`, color: theme.inkSoft, fontSize: 10.5, fontWeight: 500, padding: '0 10px', borderRadius: 7, cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit' },
  btnActive:  { background: theme.accent, borderColor: theme.accent, color: '#fff' },
  btnBadge:   { background: theme.accentSoft, color: theme.accentInk, fontSize: 9.5, fontWeight: 700, borderRadius: 10, padding: '1px 5px', lineHeight: 1.4 },
  btnPrimary: { height: 26, display: 'flex', alignItems: 'center', gap: 5, background: theme.accent, border: 'none', color: '#fff', fontSize: 10.5, fontWeight: 500, padding: '0 10px', borderRadius: 7, cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit', boxShadow: '0 1px 2px rgba(13,148,136,0.35)' },
  center: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' },
  emptyIcon: { width: 64, height: 64, borderRadius: 18, background: theme.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  emptyTitle: { fontSize: 15, fontWeight: 600, color: theme.ink, margin: 0 },
  emptySub: { fontSize: 13, color: theme.inkFaint, marginTop: 4 },
};
