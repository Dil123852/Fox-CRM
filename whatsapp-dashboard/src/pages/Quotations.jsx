import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Download, Pencil, Copy, FileText } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { theme } from '../lib/theme';
import { roleAllowed } from '../lib/roles';
import { useAuth } from '../lib/AuthContext';
import { previewQuotationPDF, quotationPayload } from '../lib/quotationPdf';
import PageHeader from '../components/PageHeader';
import ShowroomOrderModal from '../components/ShowroomOrderModal';
import DocumentPreviewModal from '../components/DocumentPreviewModal';
import { useDialog } from '../components/DialogProvider';

// Quotations (migration 054). Built on the same screen as a New Showroom
// Order (ShowroomOrderModal, mode="quotation"), filed under the customer the
// phone number belongs to, and editable, recreatable and downloadable from
// here. Mirrors the routes' own role split: admin/sales_agent write, viewer
// reads.
const WRITE_ROLES = ['admin', 'sales_agent'];

const money = n => (Number(n) || 0).toLocaleString('en', { minimumFractionDigits: 2 });
function formatWhen(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' });
}
// "Nidikumba Rise ×2, Gel Pillow (free)" — enough to tell quotations apart in
// the list without opening them.
function itemsSummary(items) {
  return (items || [])
    .map(it => `${it.name}${Number(it.qty) > 1 ? ` ×${it.qty}` : ''}${it.free ? ' (free)' : ''}`)
    .join(', ');
}

export default function Quotations() {
  const { staff } = useAuth();
  const canWrite = roleAllowed(staff?.role, WRITE_ROLES);
  const dialog = useDialog();
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [search, setSearch] = useState('');
  // { mode: 'new' | 'edit' | 'recreate', quotation? }
  const [editor, setEditor] = useState(null);
  const [preview, setPreview] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();

  const load = useCallback(() => {
    apiFetch('/api/quotations')
      .then(async r => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Could not load quotations');
        setRows(d.quotations || []);
        setLoadError(null);
      })
      .catch(err => setLoadError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // /quotations?open=<id> — how a notification or the customer page links
  // straight to one quotation. Opens the editor for staff who can edit, and
  // the PDF preview for everyone else.
  useEffect(() => {
    const open = searchParams.get('open');
    if (!open || loading) return;
    const q = rows.find(r => r.id === open);
    searchParams.delete('open');
    setSearchParams(searchParams, { replace: true });
    if (!q) {
      dialog.alert({ title: 'Quotation not found', message: 'It may have been opened from an old link.', tone: 'warning' });
      return;
    }
    if (canWrite) setEditor({ mode: 'edit', quotation: q });
    else setPreview(q);
  }, [searchParams, setSearchParams, rows, loading, canWrite, dialog]);

  const shown = useMemo(() => {
    const t = search.trim().toLowerCase();
    if (!t) return rows;
    const digits = t.replace(/[^0-9]/g, '');
    // 0771234567 must find the stored 94771234567.
    const local = digits.startsWith('0') ? digits.slice(1) : digits;
    return rows.filter(r =>
      r.quotation_no.toLowerCase().includes(t) ||
      (r.customer_name || '').toLowerCase().includes(t) ||
      (local.length >= 3 && (r.customer_phone || '').includes(local))
    );
  }, [rows, search]);

  function saved(q) {
    load();
    // Straight to the document, since producing it is usually why staff are here.
    setPreview(q);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <PageHeader
        title="Quotations"
        count={rows.length || undefined}
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search number, name or phone..."
        action={canWrite ? 'New Quotation' : undefined}
        onAction={() => setEditor({ mode: 'new' })}
      />

      <div style={s.body}>
        {loading ? (
          <p style={s.empty}>Loading…</p>
        ) : loadError ? (
          <p style={{ ...s.empty, color: theme.high }}>{loadError}</p>
        ) : shown.length === 0 ? (
          <div style={s.emptyBox}>
            <FileText size={22} color={theme.inkFaint} />
            <p style={s.empty}>
              {rows.length === 0
                ? 'No quotations yet. Use New Quotation to build one the same way as a showroom order.'
                : 'No quotation matches that search.'}
            </p>
          </div>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                {['Quotation', 'Customer', 'Items', 'Total', 'Prepared by', 'Date', ''].map((h, i) => (
                  <th key={i} style={{ ...s.th, ...(h === 'Total' ? { textAlign: 'right' } : {}) }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map(q => (
                <tr key={q.id} className="orders-row">
                  <td style={s.td}>
                    <span style={s.no}>{q.quotation_no}</span>
                    {q.recreated_from_no && <span style={s.sub}>from {q.recreated_from_no}</span>}
                  </td>
                  <td style={s.td}>
                    <button type="button" style={s.custLink} onClick={() => navigate(`/customers/${q.customer_id}`)} title="Open customer">
                      {q.customer_name}
                    </button>
                    <span style={s.sub}>{q.customer_phone}</span>
                  </td>
                  <td style={{ ...s.td, maxWidth: 280 }}>
                    <span style={s.items} title={itemsSummary(q.items)}>{itemsSummary(q.items)}</span>
                    {q.promo_code && Number(q.promo_discount) > 0 && (
                      <span
                        style={{ ...s.discountTag, color: theme.accentInk, background: theme.accentSoft, marginRight: 4 }}
                        title={q.promo_expires_at ? `Promo valid until ${formatWhen(q.promo_expires_at)}` : 'Promo code'}
                      >
                        {q.promo_code} −LKR {money(q.promo_discount)}
                      </span>
                    )}
                    {Number(q.custom_discount) > 0 && (
                      <span style={s.discountTag} title={q.custom_discount_reason || ''}>
                        Custom discount LKR {money(q.custom_discount)}
                      </span>
                    )}
                  </td>
                  <td style={{ ...s.td, textAlign: 'right', color: theme.ink, fontWeight: 600, whiteSpace: 'nowrap' }}>
                    LKR {money(q.total_amount)}
                  </td>
                  <td style={s.td}>{q.created_by_name || '—'}</td>
                  <td style={{ ...s.td, whiteSpace: 'nowrap' }}>
                    {formatWhen(q.created_at)}
                    {q.updated_by && q.updated_at !== q.created_at && (
                      <span style={s.sub}>edited {formatWhen(q.updated_at)}</span>
                    )}
                  </td>
                  <td style={{ ...s.td, whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <button type="button" style={s.iconBtn} title="Download / preview PDF" onClick={() => setPreview(q)}>
                      <Download size={13} />
                    </button>
                    {canWrite && (
                      <>
                        <button type="button" style={s.iconBtn} title="Edit this quotation" onClick={() => setEditor({ mode: 'edit', quotation: q })}>
                          <Pencil size={13} />
                        </button>
                        <button type="button" style={s.iconBtn} title="Recreate — a new quotation prefilled from this one" onClick={() => setEditor({ mode: 'recreate', quotation: q })}>
                          <Copy size={13} />
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editor && (
        <ShowroomOrderModal
          mode="quotation"
          quotation={editor.mode === 'edit' ? editor.quotation : null}
          recreateFrom={editor.mode === 'recreate' ? editor.quotation : null}
          onClose={() => setEditor(null)}
          onSaved={saved}
        />
      )}

      {preview && (
        <DocumentPreviewModal
          payload={quotationPayload(preview)}
          render={previewQuotationPDF}
          title={preview.quotation_no}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

const s = {
  body: { flex: 1, overflow: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 10.5, background: theme.surface },
  th: {
    textAlign: 'left', fontSize: 8.5, fontWeight: 500, color: theme.inkFaint, textTransform: 'uppercase',
    letterSpacing: '0.06em', padding: '6px 8px', borderBottom: `1px solid ${theme.border}`,
    background: theme.surface, position: 'sticky', top: 0, zIndex: 1, whiteSpace: 'nowrap',
  },
  td: { padding: '8px 8px', borderBottom: `1px solid ${theme.borderSoft}`, fontSize: 10.5, color: theme.inkSoft, verticalAlign: 'middle' },
  no: { display: 'block', fontFamily: theme.mono, fontWeight: 600, color: theme.ink, fontSize: 11 },
  sub: { display: 'block', fontSize: 9.5, color: theme.inkFaint, marginTop: 2 },
  custLink: {
    display: 'block', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit',
    fontSize: 11, fontWeight: 600, color: theme.ink, textAlign: 'left',
  },
  items: { display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  discountTag: {
    display: 'inline-block', marginTop: 3, fontSize: 9.5, fontWeight: 600, color: theme.med,
    background: theme.medBg, padding: '1px 6px', borderRadius: 8,
  },
  iconBtn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, marginLeft: 4,
    borderRadius: 6, border: `1px solid ${theme.border}`, background: theme.surface, color: theme.inkSoft, cursor: 'pointer',
  },
  emptyBox: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '48px 16px' },
  empty: { fontSize: 13, color: theme.inkSoft, textAlign: 'center', maxWidth: 380, margin: '0 auto', padding: 16 },
};
