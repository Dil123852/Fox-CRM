import { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { theme } from '../lib/theme';

// Pager for a server-paginated table: page numbers, a per-page selector and a
// "Go to" box. Presentational only — it owns no data and no fetching, so the
// page above it stays the single source of truth for what is loaded.
//
// Built for the call log, kept generic because it is the first pager in this
// app and the leads/orders tables have the same unbounded-list problem.

// Which page numbers to draw, given that a lifetime call log can run to
// hundreds of pages and they cannot all be buttons.
//
// Always shows the first and last page (the two people jump to most), the
// current page and one either side, and an ellipsis across each gap. Returns
// the literal string 'gap' for those, never a page number, so the caller
// cannot accidentally render a clickable ellipsis.
export function pageItems(current, totalPages) {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);

  const items = [1];
  const from = Math.max(2, current - 1);
  const to = Math.min(totalPages - 1, current + 1);

  // A gap of exactly one page is rendered as that page, not an ellipsis —
  // "1 … 3 4 5" wastes the same width as "1 2 3 4 5" while hiding a page.
  if (from > 2) items.push(from === 3 ? 2 : 'gap');
  for (let p = from; p <= to; p++) items.push(p);
  if (to < totalPages - 1) items.push(to === totalPages - 2 ? totalPages - 1 : 'gap');

  items.push(totalPages);
  return items;
}

export default function Pagination({
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
  pageSizes = [10, 25, 50, 100],
}) {
  // Local text state: the box has to allow a half-typed number without the
  // table jumping on every keystroke, so it commits on Enter or blur.
  const [goto, setGoto] = useState('');

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // If the row count shrinks (a filter narrows the results) the current page
  // can fall off the end, leaving an empty table with no obvious way back.
  useEffect(() => {
    if (page > totalPages) onPage(totalPages);
  }, [page, totalPages, onPage]);

  function commitGoto() {
    const n = parseInt(goto, 10);
    // Out-of-range input is clamped rather than rejected: typing 999 into a
    // 12-page list plainly means "the end", and an error message here would
    // be pedantry.
    if (Number.isFinite(n)) onPage(Math.min(Math.max(n, 1), totalPages));
    setGoto('');
  }

  if (!total) return null;

  return (
    <nav style={s.wrap} aria-label="Pagination">
      <button
        style={{ ...s.arrow, ...(page <= 1 ? s.disabled : {}) }}
        onClick={() => onPage(page - 1)}
        disabled={page <= 1}
        aria-label="Previous page"
      >
        <ChevronLeft size={16} />
      </button>

      {pageItems(page, totalPages).map((p, i) =>
        p === 'gap' ? (
          <span key={`gap${i}`} style={s.gap} aria-hidden="true">…</span>
        ) : (
          <button
            key={p}
            style={{ ...s.page, ...(p === page ? s.pageActive : {}) }}
            onClick={() => onPage(p)}
            aria-label={`Page ${p}`}
            aria-current={p === page ? 'page' : undefined}
          >
            {p}
          </button>
        )
      )}

      <button
        style={{ ...s.arrow, ...(page >= totalPages ? s.disabled : {}) }}
        onClick={() => onPage(page + 1)}
        disabled={page >= totalPages}
        aria-label="Next page"
      >
        <ChevronRight size={16} />
      </button>

      <select
        style={s.select}
        value={pageSize}
        onChange={e => onPageSize(Number(e.target.value))}
        aria-label="Rows per page"
      >
        {pageSizes.map(n => (
          <option key={n} value={n}>{n} / page</option>
        ))}
      </select>

      <label style={s.gotoWrap}>
        <span style={s.gotoLabel}>Go to</span>
        <input
          style={s.gotoInput}
          value={goto}
          onChange={e => setGoto(e.target.value.replace(/[^0-9]/g, ''))}
          onKeyDown={e => { if (e.key === 'Enter') commitGoto(); }}
          onBlur={commitGoto}
          inputMode="numeric"
          aria-label="Go to page"
        />
        <span style={s.gotoLabel}>Page</span>
      </label>
    </nav>
  );
}

const s = {
  // A DOCKED BAR, not a floating pill in the content flow.
  //
  // It was `width: fit-content` with `margin: 18px auto 0` and no flexShrink,
  // which made it an ordinary flex child: it scrolled away with the table and
  // only came into view once you reached the very bottom of a long page. The
  // control for changing page is useless if you have to scroll to the end of
  // the page to reach it.
  //
  // Now it is a full-width strip that is the last child of the page's flex
  // column, above the scrolling table's own container, so it holds its place
  // at the bottom of the viewport no matter how far the table scrolls.
  // flexShrink: 0 stops the flex layout squeezing it when the table is tall.
  wrap: {
    display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
    justifyContent: 'center', padding: '10px 18px', background: theme.surface,
    borderTop: `1px solid ${theme.border}`,
    boxSizing: 'border-box', flexShrink: 0,
    // `sticky left: 0` with a viewport-relative width, rather than width:100%.
    //
    // The Pipeline renders this INSIDE the table's scroll container so it
    // follows the last row. That container can also scroll horizontally, and a
    // 100%-width child there is 100% of the CONTENT width — so the bar would
    // slide out of view sideways when the table is scrolled right. Sticky
    // pins it to the container's left edge instead, keeping the controls in
    // place however the table is panned.
    //
    // Harmless where the bar is a plain docked footer (the Calls page): with
    // nothing to scroll past, sticky behaves exactly like static.
    position: 'sticky', left: 0, width: '100%',
  },
  arrow: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 30, height: 30, borderRadius: '50%', border: 'none',
    background: 'transparent', color: theme.inkSoft, cursor: 'pointer',
  },
  page: {
    minWidth: 30, height: 30, padding: '0 8px', borderRadius: '50%',
    border: 'none', background: 'transparent', color: theme.ink,
    fontSize: 13, cursor: 'pointer',
  },
  pageActive: { background: theme.accentSoft, color: theme.accentInk, fontWeight: 600 },
  // The arrows stay in place when unusable rather than disappearing, so the
  // bar does not reflow as you reach the first or last page.
  disabled: { opacity: 0.35, cursor: 'default' },
  gap: { minWidth: 20, textAlign: 'center', color: theme.inkFaint, fontSize: 13 },
  select: {
    height: 30, padding: '0 6px', marginLeft: 6, borderRadius: 999,
    border: `1px solid ${theme.border}`, background: theme.surface,
    color: theme.ink, fontSize: 12.5, cursor: 'pointer',
  },
  gotoWrap: { display: 'flex', alignItems: 'center', gap: 6, marginLeft: 6 },
  gotoLabel: { fontSize: 12.5, color: theme.inkSoft, whiteSpace: 'nowrap' },
  gotoInput: {
    width: 52, height: 30, padding: '0 10px', borderRadius: 999,
    border: `1px solid ${theme.border}`, background: theme.surface,
    color: theme.ink, fontSize: 12.5, textAlign: 'center',
  },
};
