import { useEffect, useState } from 'react';
import { Users, AlertTriangle, Clock, TrendingUp, RotateCcw, Smartphone } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { theme } from '../lib/theme';
import { useAuth } from '../lib/AuthContext';
import { roleAllowed } from '../lib/roles';
import { useTeamPhoneStatus } from '../lib/phonePresence';
import { useDialog, useErrorPopup } from '../components/DialogProvider';
import PageHeader from '../components/PageHeader';

// node-postgres parses an INTERVAL column into {days, hours, minutes,
// seconds, milliseconds} — only the units that are actually nonzero are
// present, so a fast response might be just {seconds: 45}.
function formatInterval(iv) {
  if (!iv || typeof iv !== 'object') return '—';
  const { days = 0, hours = 0, minutes = 0, seconds = 0 } = iv;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.round(seconds)}s`;
}

function avgIntervalMinutes(iv) {
  if (!iv || typeof iv !== 'object') return null;
  const { days = 0, hours = 0, minutes = 0, seconds = 0 } = iv;
  return days * 1440 + hours * 60 + minutes + seconds / 60;
}

export default function Team() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  useErrorPopup(error, 'Could not load team performance');

  useEffect(() => {
    apiFetch('/api/performance').then(r => r.json()).then(d => {
      if (d.error) setError(d.error);
      else setRows(d.performance || []);
    }).catch(e => setError(e.message)).finally(() => setLoading(false));
  }, []);

  if (loading) return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="summary-spinner" />
    </div>
  );
  if (error) return <div style={{ padding: 24, color: theme.inkFaint }}>{"Couldn't load team performance."}</div>;

  const totalOpen = rows.reduce((sum, r) => sum + Number(r.open_assigned || 0), 0);
  const totalOverdue = rows.reduce((sum, r) => sum + Number(r.overdue_count || 0), 0);
  const totalAssigned = rows.reduce((sum, r) => sum + Number(r.total_assigned || 0), 0);
  const totalConverted = rows.reduce((sum, r) => sum + Number(r.converted_count || 0), 0);
  const teamConversionPct = totalAssigned > 0 ? ((totalConverted / totalAssigned) * 100).toFixed(1) : '0.0';

  const contactMinutes = rows.map(r => avgIntervalMinutes(r.avg_time_to_first_contact)).filter(v => v !== null);
  const avgContactMinutes = contactMinutes.length > 0 ? contactMinutes.reduce((a, b) => a + b, 0) / contactMinutes.length : null;
  const avgContactLabel = avgContactMinutes === null ? '—'
    : avgContactMinutes >= 60 ? `${(avgContactMinutes / 60).toFixed(1)}h`
    : `${Math.round(avgContactMinutes)}m`;

  return (
    <div style={s.page}>
      <PageHeader title="Team Performance" />
      <div style={s.body}>

      <div style={s.statRow}>
        <StatTile icon={Users} label="Open tickets (all staff)" value={totalOpen} />
        <StatTile icon={AlertTriangle} label="Overdue tickets" value={totalOverdue} highlight={totalOverdue > 0} />
        <StatTile icon={Clock} label="Avg time to first contact" value={avgContactLabel} />
        <StatTile icon={TrendingUp} label="Team conversion rate" value={`${teamConversionPct}%`} />
      </div>

      <div style={s.tableWrap}>
        {rows.length === 0 ? (
          <p style={{ padding: 20, color: theme.inkFaint, fontSize: 13 }}>No sales agents with assigned tickets yet.</p>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>{['Staff', 'Open', 'Overdue', 'Conversion', 'Revenue', 'Avg. response'].map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.staff_id}>
                  <td style={{ ...s.td, fontWeight: 600 }}>{r.staff_name}</td>
                  <td style={s.td}>{r.open_assigned}</td>
                  <td style={{ ...s.td, color: Number(r.overdue_count) > 0 ? theme.high : theme.ink, fontWeight: Number(r.overdue_count) > 0 ? 700 : 400 }}>
                    {r.overdue_count}
                  </td>
                  <td style={s.td}>{r.conversion_pct}%</td>
                  <td style={{ ...s.td, fontWeight: 700, color: theme.success }}>LKR {Number(r.revenue || 0).toLocaleString()}</td>
                  <td style={s.td}>{formatInterval(r.avg_time_to_first_contact)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <PairedPhonesSection />
      <ClosedLeadsSection />
      </div>
    </div>
  );
}

function timeAgo(iso) {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString('en', { day: 'numeric', month: 'short' });
}

// Status pill per phone state (GET /api/devices/status).
const PHONE_STATUS = {
  online: { label: 'Online', color: theme.success, bg: theme.successBg },
  offline: { label: 'Offline', color: theme.high, bg: theme.highBg },
  not_paired: { label: 'Not signed in', color: theme.med, bg: theme.medBg },
  unknown: { label: 'Reconnecting…', color: theme.inkSoft, bg: theme.borderSoft },
};

// Click-to-call (migration 050): every sales agent's Call Tracker phone —
// including agents who never signed one in — whether the CRM can reach it
// right now (live, via the device_status event), and a way to cut a lost or
// replaced phone off at once. Admin-only, matching GET /api/devices/status —
// the Team page itself is also open to viewers.
function PairedPhonesSection() {
  const { staff } = useAuth();
  const isAdmin = roleAllowed(staff?.role, ['admin']);
  const rows = useTeamPhoneStatus(isAdmin);
  const [revoked, setRevoked] = useState(() => new Set());
  const [revokingId, setRevokingId] = useState(null);
  const dialog = useDialog();

  if (!isAdmin) return null;

  async function revoke(r) {
    const ok = await dialog.confirm({
      title: `Sign out ${r.staff_name}'s phone?`,
      message: "It stops syncing calls to the CRM and can't receive calls from the CRM until they sign in again on the Call Tracker app.",
      confirmLabel: 'Sign out phone',
      tone: 'danger',
    });
    if (!ok) return;
    setRevokingId(r.device_id);
    try {
      const res = await apiFetch(`/api/devices/${r.device_id}`, { method: 'DELETE' });
      // Shown as "Not signed in" straight away; the next refresh confirms it.
      if (res.ok) setRevoked(prev => new Set(prev).add(r.device_id));
      else {
        await dialog.alert({
          title: 'Could not sign the phone out',
          message: (await res.json().catch(() => ({}))).error || 'Please try again.',
        });
      }
    } catch (e) {
      console.error(e);
      await dialog.alert({ title: 'Could not sign the phone out', message: 'Could not reach the server. Please try again.' });
    }
    setRevokingId(null);
  }

  const list = (rows || []).map(r => (revoked.has(r.device_id) ? { ...r, device_id: null, device_name: null, status: 'not_paired' } : r));
  const downCount = list.filter(r => r.status === 'offline' || r.status === 'not_paired').length;

  return (
    <div style={{ marginTop: 24 }}>
      <p style={s.sectionTitle}>
        Call Tracker phones{downCount > 0 && <span style={{ ...s.pill, marginLeft: 8, color: theme.high, background: theme.highBg }}>{downCount} not connected</span>}
      </p>
      <p style={s.sectionSub}>
        {"Every sales agent's phone. While a phone is offline or not signed in, that agent's calls aren't reaching the CRM and the Call button can't reach them. Updates live."}
      </p>
      <div style={s.tableWrap}>
        {!rows ? (
          <p style={{ padding: 20, color: theme.inkFaint, fontSize: 13 }}>Loading...</p>
        ) : list.length === 0 ? (
          <p style={{ padding: 20, color: theme.inkFaint, fontSize: 13 }}>No sales agents yet.</p>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>{['Staff', 'Phone', 'Status', 'Last seen', ''].map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {list.map(r => {
                const st = PHONE_STATUS[r.status] || PHONE_STATUS.unknown;
                return (
                  <tr key={r.staff_id}>
                    <td style={{ ...s.td, fontWeight: 600 }}>{r.staff_name}</td>
                    <td style={s.td}>
                      {r.device_id ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          <Smartphone size={12} /> {r.device_name || 'Unnamed phone'}
                        </span>
                      ) : (
                        <span style={{ color: theme.inkFaint }}>—</span>
                      )}
                    </td>
                    <td style={s.td}>
                      <span style={{ ...s.pill, color: st.color, background: st.bg }}>{st.label}</span>
                    </td>
                    <td style={s.td}>{r.device_id ? timeAgo(r.last_seen_at) : '—'}</td>
                    <td style={s.td}>
                      {r.device_id && (
                        <button style={s.revokeBtn} onClick={() => revoke(r)} disabled={revokingId === r.device_id}>
                          {revokingId === r.device_id ? 'Signing out…' : 'Sign out phone'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// Finally gives Phase 3's ticket_state/closed_reason columns a UI — closing
// a lead (LeadsPage.jsx) removes it from the Pipeline but the row itself,
// and the reason staff gave, stays visible here so admins can monitor why
// tickets are being closed across the team.
function ClosedLeadsSection() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reopeningId, setReopeningId] = useState(null);

  async function load() {
    setLoading(true);
    try {
      const res = await apiFetch('/api/leads?ticketState=closed');
      const data = await res.json();
      setRows(data.leads || []);
    } catch (e) { console.error(e); }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function reopen(leadId) {
    setReopeningId(leadId);
    try {
      const res = await apiFetch(`/api/leads/${leadId}`, { method: 'PATCH', body: JSON.stringify({ ticket_state: 'open' }) });
      const data = await res.json();
      if (data.success) setRows(prev => prev.filter(r => r.id !== leadId));
    } catch (e) { console.error(e); }
    setReopeningId(null);
  }

  return (
    <div style={{ marginTop: 24 }}>
      <p style={s.sectionTitle}>Closed leads</p>
      <p style={s.sectionSub}>Every ticket closed by staff, with their reason — for monitoring why leads are being closed across the team.</p>
      <div style={s.tableWrap}>
        {loading ? (
          <p style={{ padding: 20, color: theme.inkFaint, fontSize: 13 }}>Loading...</p>
        ) : rows.length === 0 ? (
          <p style={{ padding: 20, color: theme.inkFaint, fontSize: 13 }}>No closed leads yet.</p>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>{['Customer', 'Assigned to', 'Closed', 'Reason', ''].map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td style={{ ...s.td, fontWeight: 600 }}>
                    {r.customers?.name || <span style={{ color: theme.inkFaint, fontWeight: 400 }}>No name</span>}
                    <div style={{ fontSize: 11.5, color: theme.inkFaint, fontWeight: 400 }}>{r.customers?.whatsapp_number}</div>
                  </td>
                  <td style={s.td}>{r.assigned_staff_name || <span style={{ color: theme.inkFaint }}>—</span>}</td>
                  <td style={{ ...s.td, color: theme.inkFaint, fontSize: 12.5 }}>
                    {r.closed_at ? new Date(r.closed_at).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
                  </td>
                  <td style={{ ...s.td, maxWidth: 320 }}>{r.closed_reason || <span style={{ color: theme.inkFaint }}>—</span>}</td>
                  <td style={s.td}>
                    <button style={s.reopenBtn} onClick={() => reopen(r.id)} disabled={reopeningId === r.id} title="Reopen this lead">
                      <RotateCcw size={12} /> {reopeningId === r.id ? 'Reopening...' : 'Reopen'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function StatTile({ icon: Icon, label, value, highlight }) {
  return (
    <div style={s.statTile}>
      <div style={{ ...s.statIcon, background: highlight ? theme.highBg : theme.accentSoft }}>
        <Icon size={12} color={highlight ? theme.high : theme.accentInk} />
      </div>
      <div>
        <p style={{ ...s.statValue, color: highlight ? theme.high : theme.ink }}>{value}</p>
        <p style={s.statLabel}>{label}</p>
      </div>
    </div>
  );
}

const s = {
  page: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: theme.bg },
  body: { flex: 1, overflowY: 'auto', padding: '18px 16px' },
  header: { marginBottom: 20 },
  title: { fontSize: 20, fontWeight: 700, color: theme.ink, margin: 0 },
  subtitle: { fontSize: 13, color: theme.inkFaint, margin: '4px 0 0' },

  statRow: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 },
  statTile: { display: 'flex', alignItems: 'center', gap: 10, background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: theme.radius, padding: '11px 14px 13px' },
  statIcon: { width: 20, height: 20, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  statValue: { fontSize: 19, fontWeight: 600, margin: 0, letterSpacing: '-0.02em', lineHeight: 1 },
  statLabel: { fontSize: 10, color: theme.inkSoft, margin: '5px 0 0' },

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

  sectionTitle: { fontSize: 15, fontWeight: 700, color: theme.ink, margin: '0 0 4px' },
  sectionSub: { fontSize: 12.5, color: theme.inkFaint, margin: '0 0 12px' },
  pill: { display: 'inline-block', fontSize: 10.5, fontWeight: 600, padding: '2px 8px', borderRadius: 20 },
  revokeBtn: { background: theme.highBg, border: 'none', color: theme.high, fontSize: 11.5, fontWeight: 600, padding: '5px 10px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  reopenBtn: { display: 'flex', alignItems: 'center', gap: 5, background: theme.accentSoft, border: 'none', color: theme.accentInk, fontSize: 11.5, fontWeight: 600, padding: '5px 10px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
};
