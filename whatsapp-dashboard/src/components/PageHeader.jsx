import { Search, Plus } from 'lucide-react';
import { theme } from '../lib/theme';

// Shared page topbar, matched to the Pipeline page's own header so every screen
// opens with the same 44px band: title (+ optional count) on the left, controls
// on the right. Eight pages render this, so the sizing below is the single
// place that keeps their headers in step with LeadsPage's `p.topbar`.
//
// HEADER_H must equal LeadsPage's topbar height and the Sidebar's brand block:
// all three meet along the top of the screen, and a mismatch shows up as
// horizontal rules that do not line up across the sidebar seam.
export const HEADER_H = 44;

export default function PageHeader({ title, count, search, onSearch, searchPlaceholder, action, onAction, children }) {
  return (
    <div style={s.topbar}>
      <div style={s.title}>
        {title}
        {count !== undefined && count !== null && <span style={s.count}>{count}</span>}
      </div>

      <div style={s.right}>
        {onSearch && (
          <div style={s.search}>
            <Search size={12} color={theme.inkFaint} />
            {/* autoComplete off: otherwise the browser fills a phone number
                just typed into an order/quotation form into this box. */}
            <input
              style={s.searchInput}
              name="page-filter"
              type="search"
              data-1p-ignore="true"
              data-lpignore="true"
              data-bwignore="true"
              autoComplete="off"
              spellCheck={false}
              placeholder={searchPlaceholder || 'Search'}
              value={search}
              onChange={e => onSearch(e.target.value)}
            />
          </div>
        )}
        {/* Extra page-specific controls sit between search and the primary
            action, matching where Pipeline puts Auto-assign / Today Call. */}
        {children}
        {action && (
          <button style={s.btn} className="pipeline-btn-primary" onClick={onAction}>
            <Plus size={12} strokeWidth={2.4} />
            {action}
          </button>
        )}
      </div>
    </div>
  );
}

const s = {
  topbar: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px',
    height: HEADER_H, boxSizing: 'border-box',
    borderBottom: `1px solid ${theme.border}`, background: theme.surface, flexShrink: 0,
  },
  title: { fontSize: 14.5, fontWeight: 600, letterSpacing: '-0.01em', color: theme.ink, whiteSpace: 'nowrap' },
  count: { fontSize: 11, color: theme.inkFaint, fontWeight: 500, marginLeft: 5 },
  right: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 7 },
  search: {
    display: 'flex', alignItems: 'center', gap: 6, background: theme.surface,
    border: `1px solid ${theme.border}`, borderRadius: 7, padding: '0 9px', height: 26, width: 178,
  },
  searchInput: {
    border: 'none', background: 'none', outline: 'none', fontSize: 11, width: '100%',
    color: theme.ink, fontFamily: 'inherit',
  },
  btn: {
    display: 'flex', alignItems: 'center', gap: 5, padding: '0 10px', height: 26, borderRadius: 7,
    border: `1px solid ${theme.accent}`, fontSize: 10.5, fontWeight: 500, cursor: 'pointer',
    fontFamily: 'inherit', whiteSpace: 'nowrap', background: theme.accent, color: '#fff',
    boxShadow: '0 1px 2px rgba(13,148,136,0.35)',
  },
};
