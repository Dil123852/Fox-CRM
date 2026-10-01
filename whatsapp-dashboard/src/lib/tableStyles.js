import { theme } from './theme';

// The one definition of what a data table looks like in this dashboard.
//
// Taken verbatim from the Pipeline table (`lt` in components/LeadsPage.jsx),
// which is the reference design. Every list page had been carrying its own
// copy of these values in a local `const s = {...}` — the `th` line was
// duplicated across eleven files and `td` across twelve. They happened to
// agree, but nothing kept them agreeing: a change to the reference reached
// only the file it was made in.
//
// Precedent for this module is lib/toolbarStyles.js, which did the same for
// filter/toolbar chrome.
//
// Usage — spread into the local style object so a page can still override a
// single key where it genuinely differs:
//
//   import { tableStyles as ts } from '../lib/tableStyles';
//   const s = { ...ts, someLocalThing: {...} };
//
// or reference directly: <th style={ts.th}>.

export const tableStyles = {
  // The scroll container. `flex: 1` + its own overflow is what makes the
  // sticky header work: `position: sticky` needs a scrolling ancestor, and it
  // must NOT be `overflow: hidden` — several pages wrapped their table in a
  // card with `overflow: hidden` for its rounded corners, which silently
  // disabled the sticky header they had already written.
  wrap: {
    flex: 1,
    overflowY: 'auto',
    overflowX: 'auto',
    background: theme.surface,
  },

  // `tableLayout: 'fixed'` is load-bearing, not cosmetic: it is what makes the
  // per-column widths authoritative and what allows `td`'s ellipsis below to
  // work at all. Without it, `overflow: hidden` / `textOverflow` on a cell do
  // nothing, and a long address silently widens its column instead of
  // truncating.
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 10.5,
    background: theme.surface,
    tableLayout: 'fixed',
  },

  th: {
    padding: '6px 8px',
    color: theme.inkFaint,
    fontWeight: 500,
    fontSize: 8.5,
    textAlign: 'left',
    whiteSpace: 'nowrap',
    background: theme.surface,
    position: 'sticky',
    top: 0,
    zIndex: 1,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    borderBottom: `1px solid ${theme.border}`,
  },

  // The row rule lives on the ROW, not on every cell. Some pages put
  // `borderBottom` on `td` instead; with `borderCollapse: 'collapse'` that
  // looks the same, but it means a page cannot style a row (hover, selected,
  // inactive) without fighting twelve cell borders.
  row: {
    borderBottom: `1px solid ${theme.borderSoft}`,
  },

  td: {
    padding: '8px 8px',
    color: theme.inkSoft,
    verticalAlign: 'middle',
    fontSize: 10.5,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },

  // An empty cell, so a missing value reads as deliberately blank rather than
  // as data that failed to load.
  dash: {
    color: theme.inkFaint,
    fontSize: 10.5,
  },
};

export default tableStyles;
