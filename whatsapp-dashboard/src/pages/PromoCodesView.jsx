import { useEffect, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { theme } from '../lib/theme';
import { promoDiscountLabel, unscopedAppliesLabel } from '../lib/promoFormat';
import PageHeader from '../components/PageHeader';
import PromoCodeDetailModal from '../components/PromoCodeDetailModal';
import { useErrorPopup } from '../components/DialogProvider';

// Read-only promo code list for sales agents (confirmed with the user): they
// quote and apply codes at the counter, so they need to see what exists, what
// it gives, what it applies to and whether it can still be used — but not
// create, edit, deactivate or delete codes, and not see influencer
// commissions. The admin page (PromoCodes.jsx) is a separate route for that
// reason rather than this page with its buttons hidden: nothing here can
// write, so nothing needs hiding.

// Why a code cannot be used right now, or null if it can. Mirrors the checks
// validate_promo_code makes (active, expiry, redemption cap), so the page
// agrees with what happens when the code is typed into an order. The
// once-per-customer rule depends on the phone, so it is not shown here.
function blockedReason(c) {
  if (!c.active) return 'Inactive';
  if (c.expires_at && new Date(c.expires_at) < new Date()) return 'Expired';
  if (c.max_redemptions != null && (c.redemption_count ?? 0) >= c.max_redemptions) return 'Used up';
  return null;
}


export default function PromoCodesView() {
  const [codes, setCodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useErrorPopup(error, 'Could not load promo codes');
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('usable');
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    apiFetch('/api/promo-codes')
      .then(r => r.json())
      .then(d => {
        if (d.promoCodes) setCodes(d.promoCodes);
        else setError(d.error || 'Could not load promo codes');
      })
      .catch(e => setError('Network error: ' + e.message))
      .finally(() => setLoading(false));
  }, []);

  const usable = codes.filter(c => !blockedReason(c));
  const shown = (tab === 'usable' ? usable : codes)
    .filter(c => !search.trim() || c.code.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <PageHeader title="Promo Codes" search={search} onSearch={setSearch} searchPlaceholder="Search codes..." />

      <div style={s.tabs}>
        <button style={{ ...s.tab, ...(tab === 'usable' ? s.tabActive : {}) }} onClick={() => setTab('usable')}>
          Can be used now <span style={s.tabCount}>{usable.length}</span>
        </button>
        <button style={{ ...s.tab, ...(tab === 'all' ? s.tabActive : {}) }} onClick={() => setTab('all')}>
          All codes <span style={s.tabCount}>{codes.length}</span>
        </button>
        <span style={s.readOnly}>View only</span>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '18px 28px', background: theme.bg }}>
        {loading ? (
          <p style={s.muted}>Loading...</p>
        ) : error ? (
          <p style={s.muted}>{"Couldn't load promo codes."}</p>
        ) : (
          <div style={s.tableWrap}>
            <table style={s.table}>
              <thead>
                <tr>{['Code', 'Discount', 'Applies to', 'Used', 'Expires', 'Status'].map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr><td style={s.td} colSpan={6}>{tab === 'usable' ? 'No codes can be used right now.' : 'No promo codes yet.'}</td></tr>
                ) : shown.map(c => {
                  const blocked = blockedReason(c);
                  const scoped = c.eligible_product_names?.length > 0;
                  return (
                    <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => setSelected(c)}>
                      <td style={{ ...s.td, fontFamily: theme.mono, fontWeight: 700 }}><CopyableCode code={c.code} /></td>
                      <td style={s.td}>{promoDiscountLabel(c)}</td>
                      <td style={s.td}>
                        {scoped ? c.eligible_product_names.join(', ') : <span style={{ color: theme.inkFaint }}>{unscopedAppliesLabel(c)}</span>}
                      </td>
                      <td style={s.td}>{c.redemption_count ?? 0}{c.max_redemptions != null ? ` / ${c.max_redemptions}` : ''}</td>
                      <td style={s.td}>{c.expires_at ? new Date(c.expires_at).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Never'}</td>
                      <td style={s.td}>
                        <span style={{ ...s.pill, ...(blocked ? s.pillOff : s.pillOn) }}>{blocked || 'Can be used'}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selected && <PromoCodeDetailModal code={selected} readOnly onClose={() => setSelected(null)} />}
    </div>
  );
}

function CopyableCode({ code }) {
  const [copied, setCopied] = useState(false);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {code}
      <button
        style={s.copyBtn}
        onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
        title="Copy code"
      >
        {copied ? <Check size={12} color={theme.success} /> : <Copy size={12} />}
      </button>
    </span>
  );
}

// Same chrome as PromoCodes.jsx, so the two pages read as one product.
const s = {
  tabs: { display: 'flex', alignItems: 'center', gap: 18, padding: '0 16px', background: theme.surface, borderBottom: `1px solid ${theme.border}`, flexShrink: 0, overflowX: 'auto' },
  tab: {
    display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, padding: '9px 0 8px', cursor: 'pointer', fontFamily: 'inherit',
    whiteSpace: 'nowrap', border: 'none', background: 'none', marginBottom: -1,
    // Longhands, not the `borderBottom` shorthand: tabActive overrides only the
    // colour, and mixing the two makes React warn on every tab switch.
    borderBottomWidth: 1.5, borderBottomStyle: 'solid', borderBottomColor: 'transparent',
    color: theme.inkSoft, fontWeight: 400,
  },
  tabActive: { color: theme.accentInk, fontWeight: 600, borderBottomColor: theme.accent },
  tabCount: { fontSize: 11, color: theme.inkFaint },
  readOnly: { marginLeft: 'auto', fontSize: 10.5, fontWeight: 600, color: theme.inkFaint, background: theme.borderSoft, borderRadius: 20, padding: '2px 9px', whiteSpace: 'nowrap' },
  muted: { color: theme.inkFaint, fontSize: 13 },
  tableWrap: { background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: theme.radiusLg, overflow: 'auto', maxHeight: '100%' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 10.5, background: theme.surface },
  th: { textAlign: 'left', fontSize: 8.5, fontWeight: 500, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.06em', padding: '6px 8px', borderBottom: `1px solid ${theme.border}`, background: theme.surface, position: 'sticky', top: 0, zIndex: 1, whiteSpace: 'nowrap' },
  td: { padding: '8px 8px', borderBottom: `1px solid ${theme.borderSoft}`, fontSize: 10.5, color: theme.inkSoft, verticalAlign: 'middle' },
  copyBtn: { background: 'none', border: 'none', cursor: 'pointer', color: theme.inkFaint, display: 'flex', padding: 2 },
  pill: { borderRadius: 20, padding: '3px 10px', fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap' },
  pillOn: { color: theme.success, background: theme.successBg },
  pillOff: { color: theme.inkFaint, background: theme.borderSoft },
};
