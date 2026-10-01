// Shared design tokens for the redesigned dashboard (matches
// nidikumba-dashboard-redesign.html). Import `theme` rather than
// hardcoding hex values so every page stays in sync with one source.
export const theme = {
  bg: '#FAFAF8',
  surface: '#FFFFFF',
  border: '#E8E6E1',
  borderSoft: '#F0EEE9',
  ink: '#1A1918',
  inkSoft: '#716C63',
  inkFaint: '#A8A399',
  // Teal, matching the login screen's own #0d9488 button/checkbox — the app
  // accent was an unrelated indigo, so signing in changed colour scheme
  // mid-flow. Nothing outside this file hardcodes these three, so changing
  // them here recolours every page at once.
  accent: '#0D9488',
  accentSoft: '#E6F5F2',
  accentInk: '#0F766E',
  low: '#8B8578',
  lowBg: '#F1EFEA',
  med: '#C87D1B',
  medBg: '#FBF0DF',
  high: '#B0432E',
  highBg: '#FAECE8',
  success: '#3D7A4F',
  successBg: '#E9F3EA',
  info: '#3763A8',
  infoBg: '#EAF0F9',
  cancel: '#948E80',
  cancelBg: '#F1EFEA',
  radius: 10,
  radiusLg: 14,
  shadowSm: '0 1px 2px rgba(26,25,24,0.04)',
  shadowMd: '0 4px 16px rgba(26,25,24,0.08)',
  font: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  mono: "'JetBrains Mono', monospace",
};

// Status → { label, color, bg } for the 6 real lead statuses (leads.status).
// 'not_answered' is a call outcome staff set by hand (the customer didn't pick
// up) — it sits between Follow up and the terminal Won/Lost, and the AI never
// sets it; analyzeConversation only ever extracts 'won'/'lost'.
// Labels match what LeadsPage.jsx/LeadDetail.jsx already use elsewhere in
// the app — same statuses, just restyled to this palette, not renamed.
// 'showroom' retired as a pipeline status (Phase 15) — see SOURCE_BADGE below,
// it's a source/origin concept now, not a stage a lead passes through.
export const LEAD_STATUS = {
  new:            { label: 'New',       color: theme.low,     bg: theme.lowBg },
  quotation_sent: { label: 'Quotation', color: theme.info,    bg: theme.infoBg },
  follow_up:      { label: 'Follow up', color: theme.med,     bg: theme.medBg },
  not_answered:   { label: 'Not Answered', color: theme.high, bg: theme.highBg },
  won:            { label: 'Won',       color: theme.success, bg: theme.successBg },
  lost:           { label: 'Lost',      color: theme.cancel,  bg: theme.cancelBg },
};

// Source badge (Phase 15.2) — leads.source real values: 'Facebook' (misnamed
// historically; analyzeConversation hardcodes this for every WhatsApp-
// originated lead — it is NOT actually Facebook, there is no Facebook
// integration anywhere in this codebase), 'Dialog call', 'showroom'. Keyed
// on the raw source string since that's what the API returns; label is the
// honest channel name regardless of the stored string.
export const SOURCE_BADGE = {
  'Facebook':         { label: 'WhatsApp',     icon: '💬' },
  // Two source strings mean "call": 'Call tracker app' is what POST /api/calls
  // writes today (the Android call-log sync), 'Dialog call' is the retired
  // webhook integration still present on historical rows. 'Call tracker app'
  // was MISSING here, so every call-originated lead rendered a blank source.
  'Call tracker app': { label: 'Call',         icon: '📞' },
  'Dialog call':      { label: 'Call',         icon: '📞' },
  'showroom':         { label: 'Showroom',     icon: '🏪' },
  'website chat':     { label: 'Website Chat', icon: '🌐' },
};

// Never returns undefined: an unrecognised source still renders, using the
// raw string, rather than silently disappearing from the table. Every new
// source value the backend introduces should be added above, but a missing
// entry must not look like missing data.
export const sourceBadge = src => SOURCE_BADGE[src] || (
  src ? { label: String(src), icon: '•' } : null
);

// customers.channel — a customer's own first-contact channel (4 real
// values, CHECK-constrained). Distinct from SOURCE_BADGE above, which keys
// on leads.source (a per-ticket origin string, not the customer record).
export const CHANNEL_BADGE = {
  meta:     { label: 'WhatsApp',     icon: '💬' },
  twilio:   { label: 'WhatsApp',     icon: '💬' },
  call:     { label: 'Call',         icon: '📞' },
  showroom: { label: 'Showroom',     icon: '🏪' },
  webchat:  { label: 'Website Chat', icon: '🌐' },
};

// All 7 real order statuses (orders.status), including 'pending' — the
// column's own default before staff touch anything (see CLAUDE.md).
export const ORDER_STATUS = {
  pending:    { label: 'Pending',    color: theme.low,       bg: theme.lowBg },
  new:        { label: 'New',        color: theme.low,       bg: theme.lowBg },
  confirmed:  { label: 'Confirmed',  color: theme.info,      bg: theme.infoBg },
  processing: { label: 'Processing', color: theme.med,       bg: theme.medBg },
  shipped:    { label: 'Shipped',    color: theme.accentInk, bg: theme.accentSoft },
  delivered:  { label: 'Delivered',  color: theme.success,   bg: theme.successBg },
  cancelled:  { label: 'Cancelled',  color: theme.cancel,    bg: theme.cancelBg },
};

// The dim, blurred sheet behind a modal. Identical in 15 separate style
// objects before this was shared; spread it instead of retyping it, and
// override only the property that genuinely differs:
//   modalBackdrop                     — the default
//   { ...modalBackdrop, zIndex: 320 } — VariantEditorModal, which opens on
//                                       top of Inventory's own modal
//   { ...modalBackdrop, background: 'rgba(26,25,24,0.45)' }
//                                     — DocumentPreviewModal's darker sheet
export const modalBackdrop = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(26,25,24,0.4)',
  backdropFilter: 'blur(4px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 300,
  padding: 20,
};

export const PAYMENT_STATUS = {
  pending:  { label: 'Pending',  color: theme.low },
  partial:  { label: 'Partial',  color: theme.med },
  paid:     { label: 'Paid',     color: theme.success },
  refunded: { label: 'Refunded', color: theme.cancel },
  failed:   { label: 'Failed',   color: theme.high },
};
