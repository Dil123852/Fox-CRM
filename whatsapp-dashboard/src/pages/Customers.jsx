import { useEffect, useMemo, useRef, useState } from 'react';
import { businessDay } from '../lib/businessTime';
import { Link } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { Users, Download, Columns3, ChevronDown } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { theme, CHANNEL_BADGE } from '../lib/theme';
import PageHeader from '../components/PageHeader';
import CallButton from '../components/CallButton';

const CHANNEL_OPTS = [
  { value: '', label: 'All channels' },
  { value: 'whatsapp', label: 'WhatsApp' }, // covers both meta and twilio — see backend filtering below
  { value: 'call', label: 'Call' },
  { value: 'showroom', label: 'Showroom' },
];

// 'Customer' (name) is the anchor column and always shown — everything else
// can be hidden. Order here is the table's column order.
const TOGGLEABLE_COLUMNS = [
  { key: 'phone',     label: 'Phone' },
  { key: 'address',   label: 'Address' },
  { key: 'channel',   label: 'Channel' },
  { key: 'interest',  label: 'Interested In' },
  { key: 'priority',  label: 'Priority' },
  { key: 'joined',    label: 'Joined' },
];

const PRIORITY = {
  high:   { color: theme.high, bg: theme.highBg },
  medium: { color: theme.med,  bg: theme.medBg },
  low:    { color: theme.low,  bg: theme.lowBg },
};

export default function Customers() {
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [channel, setChannel] = useState('');
  const [interest, setInterest] = useState('');
  const [loyaltyOnly, setLoyaltyOnly] = useState(false);
  const [visibleCols, setVisibleCols] = useState(() => Object.fromEntries(TOGGLEABLE_COLUMNS.map(c => [c.key, true])));
  const [colMenuOpen, setColMenuOpen] = useState(false);
  const colMenuRef = useRef(null);

  useEffect(() => {
    if (!colMenuOpen) return;
    function onClickOutside(e) {
      if (colMenuRef.current && !colMenuRef.current.contains(e.target)) setColMenuOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [colMenuOpen]);

  function toggleCol(key) {
    setVisibleCols(prev => ({ ...prev, [key]: !prev[key] }));
  }

  useEffect(() => {
    apiFetch('/api/customers-directory')
      .then(r => r.json())
      .then(({ customers: data }) => setCustomers(data || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const interestOptions = useMemo(() => {
    const set = new Set(customers.map(c => c.interested_in).filter(Boolean));
    return [...set].sort();
  }, [customers]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return customers.filter(c => {
      if (q) {
        const hay = `${c.name || ''} ${c.whatsapp_number} ${c.address || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (channel) {
        const matchesWhatsapp = channel === 'whatsapp' && (c.channel === 'meta' || c.channel === 'twilio');
        if (!matchesWhatsapp && c.channel !== channel) return false;
      }
      if (interest && c.interested_in !== interest) return false;
      if (loyaltyOnly && !c.is_loyalty_customer) return false;
      return true;
    });
  }, [customers, search, channel, interest, loyaltyOnly]);

  function exportXLSX() {
    const allCols = [
      { key: null,        label: 'Name', get: c => c.name || '' }, // the anchor column, always exported
      { key: 'phone',     label: 'Phone', get: c => c.whatsapp_number },
      { key: 'address',   label: 'Address', get: c => c.address || '' },
      { key: 'channel',   label: 'Channel', get: c => CHANNEL_BADGE[c.channel]?.label || c.channel },
      { key: 'interest',  label: 'Interested In', get: c => c.interested_in || '' },
      { key: null,        label: 'Loyalty Customer', get: c => c.is_loyalty_customer ? 'Yes' : 'No' },
      { key: null,        label: 'Total Orders', get: c => c.total_orders_count ?? 0 },
      { key: null,        label: 'Lifetime Value (LKR)', get: c => Number(c.lifetime_value) || 0 },
      { key: 'priority',  label: 'Priority', get: c => c.priority_label || '' },
      { key: 'joined',    label: 'Joined', get: c => new Date(c.created_at).toLocaleDateString('en-CA') },
    ];
    // Export matches what's visible on screen — a hidden column is left out here too.
    const cols = allCols.filter(c => c.key === null || visibleCols[c.key]);
    const headers = cols.map(c => c.label);
    const rows = filtered.map(c => cols.map(col => col.get(c)));
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    ws['!cols'] = cols.map(c => ({ wch: Math.max(c.label.length + 4, 14) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Customers');
    XLSX.writeFile(wb, `Nidikumba_Customers_${businessDay()}.xlsx`);
  }

  return (
    <div style={s.page}>
      <PageHeader title="Customers" search={search} onSearch={setSearch} searchPlaceholder="Search name, phone, address..." />

      <div style={s.filterBar}>
        <select style={s.select} value={channel} onChange={e => setChannel(e.target.value)}>
          {CHANNEL_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select style={s.select} value={interest} onChange={e => setInterest(e.target.value)}>
          <option value="">All interests</option>
          {interestOptions.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <label style={s.checkboxLabel}>
          <input type="checkbox" checked={loyaltyOnly} onChange={e => setLoyaltyOnly(e.target.checked)} />
          Loyalty customers only
        </label>
        <span style={s.count}>{filtered.length} of {customers.length}</span>

        <div style={{ position: 'relative' }} ref={colMenuRef}>
          <button style={s.colsBtn} onClick={() => setColMenuOpen(o => !o)}>
            <Columns3 size={13} /> Columns <ChevronDown size={12} />
          </button>
          {colMenuOpen && (
            <div style={s.colsMenu}>
              {TOGGLEABLE_COLUMNS.map(c => (
                <label key={c.key} style={s.colsMenuItem}>
                  <input type="checkbox" checked={visibleCols[c.key]} onChange={() => toggleCol(c.key)} />
                  {c.label}
                </label>
              ))}
            </div>
          )}
        </div>

        <button style={s.exportBtn} onClick={exportXLSX} disabled={filtered.length === 0}>
          <Download size={13} /> Export .xlsx
        </button>
      </div>

      {loading ? (
        <div style={s.center}><p style={{ color: theme.inkFaint, fontSize: 13 }}>Loading...</p></div>
      ) : filtered.length === 0 ? (
        <div style={s.center}>
          <Users size={36} color={theme.inkFaint} strokeWidth={1.2} />
          <p style={{ color: theme.inkFaint, marginTop: 10, fontSize: 13 }}>No customers match these filters</p>
        </div>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Customer</th>
                {visibleCols.phone && <th style={s.th}>Phone</th>}
                {visibleCols.address && <th style={s.th}>Address</th>}
                {visibleCols.channel && <th style={s.th}>Channel</th>}
                {visibleCols.interest && <th style={s.th}>Interested In</th>}
                {visibleCols.priority && <th style={s.th}>Priority</th>}
                {visibleCols.joined && <th style={s.th}>Joined</th>}
                <th style={s.th} />
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => {
                const pri = PRIORITY[c.priority_label] || PRIORITY.low;
                const displayName = c.name || c.whatsapp_number;
                const badge = CHANNEL_BADGE[c.channel];
                return (
                  <tr key={c.id}>
                    <td style={s.td}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={s.avatar}>{displayName.charAt(0).toUpperCase()}</div>
                        <div>
                          <span style={{ fontWeight: 600, color: theme.ink, display: 'block' }}>
                            {c.name || <span style={{ color: theme.inkFaint, fontWeight: 400 }}>No name</span>}
                          </span>
                          {c.is_loyalty_customer && <span style={s.loyaltyTag}>Loyalty</span>}
                        </div>
                      </div>
                    </td>
                    {visibleCols.phone && <td style={{ ...s.td, fontFamily: theme.mono }}>{c.whatsapp_number}</td>}
                    {visibleCols.address && (
                      <td style={{ ...s.td, maxWidth: 220 }}>
                        {c.address ? <span title={c.address}>{c.address}</span> : <span style={{ color: theme.inkFaint }}>—</span>}
                      </td>
                    )}
                    {visibleCols.channel && (
                      <td style={s.td}>
                        {badge ? <span style={s.channelPill}>{badge.icon} {badge.label}</span> : c.channel}
                      </td>
                    )}
                    {visibleCols.interest && <td style={s.td}>{c.interested_in || <span style={{ color: theme.inkFaint }}>—</span>}</td>}
                    {visibleCols.priority && (
                      <td style={s.td}>
                        <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: pri.bg, color: pri.color }}>
                          {c.priority_label || 'low'}
                        </span>
                      </td>
                    )}
                    {visibleCols.joined && (
                      <td style={{ ...s.td, color: theme.inkFaint, fontSize: 12 }}>
                        {new Date(c.created_at).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' })}
                      </td>
                    )}
                    <td style={s.td}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end' }}>
                        <CallButton customerId={c.id} customerName={c.name || c.whatsapp_number} />
                        <Link to={`/customers/${c.id}`} style={s.viewBtn}>View →</Link>
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
  );
}

const s = {
  page: { display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', background: theme.bg },
  filterBar: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 28px', background: theme.surface, borderBottom: `1px solid ${theme.border}`, flexShrink: 0, flexWrap: 'wrap' },
  select: { border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '6px 10px', fontSize: 12.5, fontFamily: 'inherit', background: theme.bg, color: theme.ink, cursor: 'pointer' },
  checkboxLabel: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: theme.inkSoft, cursor: 'pointer' },
  count: { fontSize: 12, color: theme.inkFaint, marginLeft: 'auto' },
  exportBtn: { display: 'flex', alignItems: 'center', gap: 6, background: theme.success, border: 'none', color: '#fff', fontSize: 12.5, fontWeight: 700, padding: '7px 14px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
  colsBtn: { display: 'flex', alignItems: 'center', gap: 6, background: theme.bg, border: `1.5px solid ${theme.border}`, color: theme.inkSoft, fontSize: 12.5, fontWeight: 600, padding: '6px 12px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
  colsMenu: { position: 'absolute', top: '110%', right: 0, background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 10, boxShadow: theme.shadowMd, zIndex: 20, padding: 8, minWidth: 170 },
  colsMenuItem: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: theme.ink, padding: '6px 8px', borderRadius: 7, cursor: 'pointer' },

  center: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 },
  tableWrap: { flex: 1, overflow: 'auto', background: theme.surface },
  table: { width: '100%', borderCollapse: 'collapse', background: theme.surface },
  th: { textAlign: 'left', fontSize: 8.5, fontWeight: 500, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.06em', padding: '6px 8px', borderBottom: `1px solid ${theme.border}`, background: theme.surface, position: 'sticky', top: 0, zIndex: 1, whiteSpace: 'nowrap' },
  td: { padding: '8px 8px', borderBottom: `1px solid ${theme.borderSoft}`, fontSize: 10.5, color: theme.inkSoft, verticalAlign: 'middle' },
  avatar: { width: 30, height: 30, borderRadius: '50%', background: theme.accentSoft, color: theme.accentInk, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13, flexShrink: 0 },
  loyaltyTag: { fontSize: 10, fontWeight: 700, color: theme.success, background: theme.successBg, borderRadius: 20, padding: '1px 7px', display: 'inline-block', marginTop: 2 },
  channelPill: { fontSize: 12, fontWeight: 600, color: theme.inkSoft, background: theme.bg, border: `1px solid ${theme.border}`, borderRadius: 20, padding: '3px 9px' },
  viewBtn: { color: theme.accentInk, fontWeight: 600, fontSize: 12, textDecoration: 'none', padding: '4px 10px', borderRadius: 7, background: theme.accentSoft },
};
