import { useEffect, useState } from 'react';
import { TrendingUp, Users, Wallet, Inbox } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { theme } from '../lib/theme';
import PageHeader from '../components/PageHeader';
import { useErrorPopup } from '../components/DialogProvider';

const REPORTS = ['sales-funnel', 'channel-attribution', 'revenue-daily', 'product-performance', 'loyalty-summary'];

const lkr = n => `LKR ${Number(n || 0).toLocaleString('en', { minimumFractionDigits: 0 })}`;
const monthLabel = iso => new Date(iso).toLocaleDateString('en', { month: 'short', year: 'numeric' });
const dayLabel = iso => new Date(iso).toLocaleDateString('en', { day: 'numeric', month: 'short' });

export default function Reports() {
  const [data, setData]       = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  useErrorPopup(error, 'Could not load reports');

  useEffect(() => {
    async function load() {
      try {
        const results = await Promise.all(
          REPORTS.map(r => apiFetch(`/api/reports/${r}`).then(res => res.json()))
        );
        const byName = {};
        results.forEach((r, i) => { byName[REPORTS[i]] = r.data; });
        setData(byName);
      } catch (e) {
        setError(e.message);
      }
      setLoading(false);
    }
    load();
  }, []);

  if (loading) return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="summary-spinner" />
    </div>
  );
  if (error) return <div style={{ padding: 24, color: theme.inkFaint }}>{"Couldn't load reports."}</div>;

  const loyalty = data['loyalty-summary']?.[0] || {};
  const revenue = data['revenue-daily'] || [];
  const funnel  = data['sales-funnel'] || [];
  const channels = data['channel-attribution'] || [];
  const products = data['product-performance'] || [];

  const totalRevenue = revenue.reduce((sum, r) => sum + Number(r.revenue || 0), 0);
  const maxDailyRevenue = Math.max(1, ...revenue.map(r => Number(r.revenue)));
  const maxChannelRevenue = Math.max(1, ...channels.map(c => Number(c.revenue)));
  const maxProductRevenue = Math.max(1, ...products.map(p => Number(p.revenue)));

  return (
    <div style={s.page}>
      <PageHeader title="Business Insights" />
      <div style={s.body}>

      <div style={s.statRow}>
        <StatTile icon={Wallet}  label="Total revenue (all completed orders)" value={lkr(totalRevenue)} />
        <StatTile icon={Users}   label="Loyalty customers" value={loyalty.loyalty_customers ?? 0} />
        <StatTile icon={Inbox}   label="Potential customers" value={loyalty.potential_customers ?? 0} />
        <StatTile icon={TrendingUp} label="Avg lifetime value (loyalty)" value={lkr(loyalty.avg_lifetime_value)} />
      </div>

      <Section title="Revenue by day" subtitle="Completed orders (delivered + paid) only">
        {revenue.length === 0 ? <EmptyNote text="No completed orders yet." /> : (
          <div style={s.barChart}>
            {revenue.map(r => (
              <div key={r.day} style={s.barCol} title={`${dayLabel(r.day)}: ${lkr(r.revenue)} · ${r.orders_completed} order(s)`}>
                <div style={{ ...s.bar, height: `${Math.max(4, (Number(r.revenue) / maxDailyRevenue) * 100)}%` }} />
                <span style={s.barLabel}>{dayLabel(r.day)}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <div style={s.twoCol}>
        <Section title="Revenue by channel" subtitle="Lead source, ranked by revenue">
          {channels.length === 0 ? <EmptyNote text="No leads yet." /> : (
            <div style={s.rankedList}>
              {channels.map(c => (
                <RankedBar key={c.source} label={c.source} value={Number(c.revenue)} max={maxChannelRevenue}
                  detail={`${c.tickets} ticket(s) · ${c.conversion_pct}% converted`} />
              ))}
            </div>
          )}
        </Section>

        <Section title="Product performance" subtitle="Ranked by revenue, completed orders only">
          {products.length === 0 ? <EmptyNote text="No completed orders yet." /> : (
            <div style={s.rankedList}>
              {products.map(p => (
                <RankedBar key={p.product_name} label={p.product_name} value={Number(p.revenue)} max={maxProductRevenue}
                  detail={`${p.units_sold} unit(s) · ${p.times_ordered}× ordered`} />
              ))}
            </div>
          )}
        </Section>
      </div>

      <Section title="Sales funnel by month" subtitle="Ticket-to-order conversion">
        {funnel.length === 0 ? <EmptyNote text="No tickets yet." /> : (
          <table style={s.table}>
            <thead>
              <tr>{['Month', 'Tickets opened', 'Converted', 'Conversion %'].map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {funnel.map(f => (
                <tr key={f.month}>
                  <td style={s.td}>{monthLabel(f.month)}</td>
                  <td style={s.td}>{f.tickets_opened}</td>
                  <td style={s.td}>{f.tickets_converted}</td>
                  <td style={s.td}>{f.conversion_pct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      </div>
    </div>
  );
}

function StatTile({ icon: Icon, label, value }) {
  return (
    <div style={s.statTile}>
      <div style={s.statIcon}><Icon size={12} color={theme.accentInk} /></div>
      <div>
        <p style={s.statValue}>{value}</p>
        <p style={s.statLabel}>{label}</p>
      </div>
    </div>
  );
}

function Section({ title, subtitle, children }) {
  return (
    <div style={s.section}>
      <p style={s.sectionTitle}>{title}</p>
      <p style={s.sectionSubtitle}>{subtitle}</p>
      {children}
    </div>
  );
}

function RankedBar({ label, value, max, detail }) {
  return (
    <div style={s.rankedRow}>
      <div style={s.rankedHead}>
        <span style={s.rankedLabel}>{label}</span>
        <span style={s.rankedValue}>{lkr(value)}</span>
      </div>
      <div style={s.rankedTrack}>
        <div style={{ ...s.rankedFill, width: `${Math.max(2, (value / max) * 100)}%` }} />
      </div>
      <span style={s.rankedDetail}>{detail}</span>
    </div>
  );
}

function EmptyNote({ text }) {
  return <p style={{ color: theme.inkFaint, fontSize: 13, padding: '12px 0' }}>{text}</p>;
}

const s = {
  page: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: theme.bg },
  body: { flex: 1, overflowY: 'auto', padding: '18px 16px' },
  header: { marginBottom: 20 },
  title: { fontSize: 20, fontWeight: 700, color: theme.ink, margin: 0 },
  subtitle: { fontSize: 13, color: theme.inkFaint, margin: '4px 0 0' },

  statRow: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 },
  statTile: { display: 'flex', alignItems: 'center', gap: 10, background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: theme.radius, padding: '11px 14px 13px' },
  statIcon: { width: 20, height: 20, borderRadius: 6, background: theme.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  statValue: { fontSize: 19, fontWeight: 600, color: theme.ink, margin: 0, letterSpacing: '-0.02em', lineHeight: 1 },
  statLabel: { fontSize: 10, color: theme.inkSoft, margin: '5px 0 0' },

  section: { background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: theme.radius, padding: 18, marginBottom: 16 },
  sectionTitle: { fontSize: 14, fontWeight: 700, color: theme.ink, margin: 0 },
  sectionSubtitle: { fontSize: 12, color: theme.inkFaint, margin: '2px 0 14px' },

  twoCol: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 },

  barChart: { display: 'flex', alignItems: 'flex-end', gap: 6, height: 140, padding: '0 4px' },
  barCol: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%', cursor: 'default' },
  bar: { width: '100%', maxWidth: 28, background: theme.accent, borderRadius: '4px 4px 0 0', minHeight: 4, transition: 'opacity 0.1s' },
  barLabel: { fontSize: 10, color: theme.inkFaint, marginTop: 6, whiteSpace: 'nowrap' },

  rankedList: { display: 'flex', flexDirection: 'column', gap: 12 },
  rankedRow: { display: 'flex', flexDirection: 'column', gap: 4 },
  rankedHead: { display: 'flex', justifyContent: 'space-between', fontSize: 12 },
  rankedLabel: { color: theme.ink, fontWeight: 600 },
  rankedValue: { color: theme.accentInk, fontWeight: 700 },
  rankedTrack: { height: 6, background: theme.borderSoft, borderRadius: 3, overflow: 'hidden' },
  rankedFill: { height: '100%', background: theme.accent, borderRadius: 3 },
  rankedDetail: { fontSize: 11, color: theme.inkFaint },

  // fontSize/background here rather than relying on inheritance, matching the
  // Pipeline reference (lib/tableStyles.js) so every list reads at the same
  // size. tableLayout is deliberately NOT set: these tables size their columns
  // from content, and forcing 'fixed' would need per-column widths on each.
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 10.5, background: theme.surface },
  th: { textAlign: 'left', fontSize: 8.5, fontWeight: 500, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.06em', padding: '6px 8px', borderBottom: `1px solid ${theme.border}`, background: theme.surface, position: 'sticky', top: 0, zIndex: 1, whiteSpace: 'nowrap' },
  td: { padding: '8px 8px', borderBottom: `1px solid ${theme.borderSoft}`, fontSize: 10.5, color: theme.inkSoft, verticalAlign: 'middle' },
};
