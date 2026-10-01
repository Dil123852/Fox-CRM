import { useEffect, useState } from 'react';
import { X, Download, FileText, AlertCircle } from 'lucide-react';
import { theme, modalBackdrop } from '../lib/theme';
import { vh } from '../lib/viewport';


// Shows a generated PDF in the browser's own viewer before staff send it, so
// a wrong address or a missing price is caught while it can still be fixed —
// the alternative is downloading, opening, deleting and starting over.
//
// Serves both the quotation and the invoice: the caller passes that document's
// own preview function, which renders through the SAME code path as its
// download, so what is on screen is the file that gets saved.
// `render` is the document's own preview function (previewQuotationPDF or
// previewInvoicePDF), so one modal serves both without knowing which is which.
export default function DocumentPreviewModal({ payload, onClose, render, title }) {
  const [state, setState] = useState({ status: 'rendering' });

  useEffect(() => {
    let alive = true;
    let createdUrl = null;

    render(payload)
      .then(({ url, filename }) => {
        createdUrl = url;
        // If the modal closed while rendering, revoke immediately rather than
        // setting state on an unmounted component and leaking the blob.
        if (!alive) { URL.revokeObjectURL(url); return; }
        setState({ status: 'ready', url, filename });
      })
      .catch(err => {
        if (alive) setState({ status: 'error', error: err.message });
      });

    return () => {
      alive = false;
      // A blob URL holds the whole PDF in memory until revoked.
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [payload, render]);

  // Escape closes, matching the rest of the app's modals.
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function download() {
    if (state.status !== 'ready') return;
    // Re-use the blob already rendered rather than generating a second copy.
    const a = document.createElement('a');
    a.href = state.url;
    a.download = state.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  const itemCount = (payload?.items || payload?.order?.items || []).length;

  return (
    <div
      style={s.backdrop}
      onClick={e => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label={`${title || "Document"} preview`}
    >
      <div style={s.modal}>
        <div style={s.header}>
          <div style={s.headerLeft}>
            <div style={s.headerIcon}><FileText size={18} color={theme.accentInk} /></div>
            <div>
              <p style={s.headerTitle}>{title || 'Document'}</p>
              <p style={s.headerSub}>
                {payload?.lead?.customer_name
                  || payload?.order?.customer_full_name
                  || payload?.order?.customer_name
                  || 'Customer'}
                {itemCount > 0 && ` · ${itemCount} item${itemCount === 1 ? '' : 's'}`}
              </p>
            </div>
          </div>
          <div style={s.headerRight}>
            <button
              style={{ ...s.downloadBtn, opacity: state.status === 'ready' ? 1 : 0.45 }}
              onClick={download}
              disabled={state.status !== 'ready'}
              title="Download this quotation"
            >
              <Download size={14} /> Download
            </button>
            <button style={s.closeBtn} onClick={onClose} title="Close (Esc)">
              <X size={16} />
            </button>
          </div>
        </div>

        <div style={s.body}>
          {state.status === 'rendering' && (
            <p style={s.note}>Preparing the preview…</p>
          )}

          {state.status === 'error' && (
            <div style={s.errorBox}>
              <AlertCircle size={18} color={theme.high} />
              <div>
                <p style={s.errorTitle}>Could not render the document</p>
                <p style={s.errorText}>{state.error}</p>
              </div>
            </div>
          )}

          {state.status === 'ready' && (
            // An <iframe> uses the browser's built-in PDF viewer, so the
            // preview is the real document — page size, fonts and the embedded
            // signature included — rather than an HTML approximation of it.
            <iframe src={state.url} style={s.frame} title={`${title || "Document"} preview`} />
          )}
        </div>
      </div>
    </div>
  );
}

const s = {
  // Slightly darker sheet, so the previewed document reads as the focus.
  backdrop: { ...modalBackdrop, background: 'rgba(26,25,24,0.45)' },
  // Tall and A4-proportioned: a quotation preview is useless if the page is
  // scaled down to a thumbnail.
  modal: { background: theme.surface, borderRadius: 16, width: '100%', maxWidth: 860, height: vh(94), display: 'flex', flexDirection: 'column', boxShadow: theme.shadowMd, overflow: 'hidden' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: `1px solid ${theme.border}`, flexShrink: 0, gap: 12 },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 },
  headerRight: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  headerIcon: { width: 36, height: 36, borderRadius: 10, background: theme.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  headerTitle: { fontSize: 14.5, fontWeight: 700, color: theme.ink, margin: 0, fontVariantNumeric: 'tabular-nums' },
  headerSub: { fontSize: 12, color: theme.inkFaint, margin: '1px 0 0' },
  downloadBtn: { display: 'flex', alignItems: 'center', gap: 6, background: theme.accentSoft, border: 'none', color: theme.accentInk, fontSize: 12.5, fontWeight: 700, padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
  closeBtn: { background: theme.borderSoft, border: 'none', cursor: 'pointer', width: 32, height: 32, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.inkSoft, flexShrink: 0 },

  body: { flex: 1, minHeight: 0, background: theme.bg, display: 'flex', flexDirection: 'column' },
  frame: { flex: 1, width: '100%', border: 'none', background: theme.bg },
  note: { margin: 0, padding: '28px 20px', fontSize: 13, color: theme.inkFaint, textAlign: 'center' },

  errorBox: { display: 'flex', gap: 10, alignItems: 'flex-start', margin: 20, padding: 14, background: theme.highBg, borderRadius: 10 },
  errorTitle: { margin: 0, fontSize: 13, fontWeight: 700, color: theme.high },
  errorText: { margin: '3px 0 0', fontSize: 12, color: theme.inkSoft, lineHeight: 1.45 },
};
