import { theme } from '../lib/theme';

// The "Apply volume discount" tick in an order's or quotation's totals
// (migration 057). Shown only when the cart qualifies (2+ paid mattresses) —
// with nothing to give there is nothing to switch off. On by default; unticked,
// the amount is shown struck through so staff can see what the customer is
// NOT getting before they save.
//
// `labelStyle`/`valueStyle` come from the screen it sits in, so it reads like
// the totals rows around it.
export default function VolumeDiscountToggle({ eligible, mattressCount, applied, onChange, labelStyle, valueStyle, prefix = '' }) {
  if (!(eligible > 0)) return null;
  const amount = eligible.toLocaleString();
  return (
    <label
      style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, cursor: 'pointer' }}
      title={applied ? 'Untick to not give the volume discount on this order' : 'Tick to give the volume discount'}
    >
      <span style={{ ...labelStyle, display: 'inline-flex', alignItems: 'center', gap: 6, color: applied ? theme.success : theme.inkFaint }}>
        <input
          type="checkbox"
          checked={applied}
          onChange={(e) => onChange(e.target.checked)}
          aria-label="Apply volume discount"
          style={{ margin: 0, accentColor: theme.success, cursor: 'pointer' }}
        />
        {applied ? `Volume (${mattressCount} mattresses)` : 'Volume discount not given'}
      </span>
      <span style={{ ...valueStyle, color: applied ? theme.success : theme.inkFaint, textDecoration: applied ? 'none' : 'line-through' }}>
        -{prefix}{amount}
      </span>
    </label>
  );
}
