import { theme } from './theme';

// The Pipeline page's toolbar dialect, extracted so other list pages can match
// it instead of each re-deriving its own.
//
// WHY THIS FILE EXISTS: the Pipeline restyle established a specific visual
// language — a 9px/16px bar, 1px hairline borders, 10.5–11px controls, and
// date ranges tucked behind an icon rather than sitting permanently in the
// bar. The Calls and Callbacks pages had been written against the OLDER
// dialect (10px/28px padding, 1.5px borders, 12px text, uppercase bold
// labels, always-visible date inputs), so moving between Pipeline and either
// of them changed the visual language mid-flow.
//
// Kept as a shared module rather than copied into each page for the same
// reason lib/callFormat.js is shared: two copies drift, and the next tweak
// would land in only one of them.
//
// These are the toolbar/filter styles ONLY. Tab strips and table cells
// already matched Pipeline exactly (the earlier chrome pass converted them),
// so they are deliberately not duplicated here.
export const tb = {
  // The toolbar row itself. Pipeline uses 9px/16px against the old 10px/28px,
  // which is what makes the bar read as one band with the tab strip above it.
  bar: {
    display: 'flex', alignItems: 'center', padding: '9px 16px',
    background: theme.surface, borderBottom: `1px solid ${theme.border}`,
    flexShrink: 0, gap: 8, flexWrap: 'wrap',
  },

  // A bare icon affordance, not a button — no border, no background. The dot
  // is what keeps an active filter visible once its inputs are hidden inside
  // the popover; without it a set date range would be invisible from the bar.
  tool: {
    color: theme.inkFaint, display: 'flex', cursor: 'pointer', padding: 2,
    background: 'none', border: 'none', position: 'relative',
  },
  toolOn: { color: theme.accentInk },
  toolDot: {
    position: 'absolute', top: 0, right: 0, width: 5, height: 5,
    borderRadius: '50%', background: theme.accent,
  },
  wrap: { position: 'relative', display: 'flex' },

  popover: {
    position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 40,
    background: theme.surface, border: `1px solid ${theme.border}`,
    borderRadius: 9, boxShadow: theme.shadowMd, padding: 10, width: 194,
  },
  popTitle: {
    fontSize: 9, fontWeight: 600, letterSpacing: '0.07em',
    textTransform: 'uppercase', color: theme.inkFaint, marginBottom: 8,
  },
  popRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 },
  popLabel: { fontSize: 10.5, color: theme.inkSoft, width: 30, flexShrink: 0 },
  popFoot: {
    display: 'flex', alignItems: 'center', gap: 6, marginTop: 9,
    paddingTop: 9, borderTop: `1px solid ${theme.borderSoft}`,
  },
  popClear: {
    flex: 1, background: theme.surface, border: `1px solid ${theme.border}`,
    color: theme.inkSoft, fontSize: 10.5, fontWeight: 500, padding: '5px 0',
    borderRadius: 6, fontFamily: 'inherit',
  },
  popDone: {
    flex: 1, background: theme.accent, border: `1px solid ${theme.accent}`,
    color: '#fff', fontSize: 10.5, fontWeight: 500, padding: '5px 0',
    borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
  },

  dateInput: {
    flex: 1, minWidth: 0, background: theme.surface,
    border: `1px solid ${theme.border}`, borderRadius: 6, padding: '4px 7px',
    color: theme.ink, fontSize: 10.5, outline: 'none', fontFamily: 'inherit',
  },
  // A select sitting directly in the bar (Calls' Answered filter). Matched to
  // dateInput's metrics rather than Pipeline's — Pipeline has no inline
  // select — so the two controls line up at the same height.
  select: {
    background: theme.surface, border: `1px solid ${theme.border}`,
    borderRadius: 6, padding: '4px 7px', color: theme.ink, fontSize: 10.5,
    outline: 'none', fontFamily: 'inherit', cursor: 'pointer',
  },
  // Inline label for a control that stays in the bar. Sentence case at 10.5px:
  // the old uppercase 11px/700 label shouted next to Pipeline's quiet chrome.
  label: { fontSize: 10.5, color: theme.inkSoft, whiteSpace: 'nowrap' },
  group: { display: 'flex', alignItems: 'center', gap: 6 },

  resultCount: { marginLeft: 'auto', fontSize: 10.5, color: theme.inkFaint },

  // .btn / .btn.primary from the reference: 25px tall, hairline border.
  plainBtn: {
    height: 25, display: 'flex', alignItems: 'center', gap: 5,
    background: theme.surface, border: `1px solid ${theme.border}`,
    color: theme.inkSoft, fontSize: 10.5, fontWeight: 500, padding: '0 9px',
    borderRadius: 7, cursor: 'pointer', whiteSpace: 'nowrap',
    fontFamily: 'inherit',
  },
  primaryBtn: {
    height: 25, display: 'flex', alignItems: 'center', gap: 5,
    background: theme.accent, border: `1px solid ${theme.accent}`,
    color: '#fff', fontSize: 10.5, fontWeight: 500, padding: '0 9px',
    borderRadius: 7, cursor: 'pointer', whiteSpace: 'nowrap',
    fontFamily: 'inherit', boxShadow: '0 1px 2px rgba(13,148,136,0.35)',
  },
};

export default tb;
