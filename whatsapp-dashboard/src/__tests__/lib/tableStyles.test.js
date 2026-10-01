import { describe, it, expect } from 'vitest';
import { tableStyles } from '../../lib/tableStyles';
import { theme } from '../../lib/theme';

// The shared table styles must stay byte-identical to the Pipeline table
// (`lt` in LeadsPage.jsx), which is the reference design every other page is
// being aligned to. This asserts the VALUES rather than diffing source text,
// so a drift in either direction fails here instead of shipping.
const REFERENCE = {
  wrap:  { flex: 1, overflowY: 'auto', overflowX: 'auto', background: theme.surface },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 10.5, background: theme.surface, tableLayout: 'fixed' },
  th:    { padding: '6px 8px', color: theme.inkFaint, fontWeight: 500, fontSize: 8.5, textAlign: 'left', whiteSpace: 'nowrap', background: theme.surface, position: 'sticky', top: 0, zIndex: 1, textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: `1px solid ${theme.border}` },
  row:   { borderBottom: `1px solid ${theme.borderSoft}` },
  td:    { padding: '8px 8px', color: theme.inkSoft, verticalAlign: 'middle', fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis' },
  dash:  { color: theme.inkFaint, fontSize: 10.5 },
};

describe('shared table styles match the Pipeline reference', () => {
  for (const key of Object.keys(REFERENCE)) {
    it(`${key} is identical to the reference`, () => {
      expect(tableStyles[key]).toEqual(REFERENCE[key]);
    });
  }

  it('the sticky header can actually stick: wrap scrolls and is not overflow:hidden', () => {
    // A sticky th inside an overflow:hidden ancestor silently does not stick —
    // the bug this consistency pass fixes on the card-wrapped pages.
    expect(tableStyles.th.position).toBe('sticky');
    expect(tableStyles.wrap.overflowY).toBe('auto');
    expect(tableStyles.wrap.overflowY).not.toBe('hidden');
  });

  it('ellipsis on td is backed by a fixed table layout', () => {
    // textOverflow does nothing without tableLayout:'fixed'.
    expect(tableStyles.td.textOverflow).toBe('ellipsis');
    expect(tableStyles.table.tableLayout).toBe('fixed');
  });
});
