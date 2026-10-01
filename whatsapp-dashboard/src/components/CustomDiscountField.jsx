import { useState } from 'react';
import { BadgePercent, X } from 'lucide-react';
import { theme } from '../lib/theme';
import { roleAllowed } from '../lib/roles';

// The "Custom discount" control in an order's cart (migration 053). Collapsed
// to a link until used, because most orders have none. Controlled: the parent
// owns { amount, reason } as typed and runs customDiscountState() on it, so
// the total and the submit button read the same validation this shows.
//
// Non-admins are told up front that an admin will be notified — the point is
// that it is not a surprise afterwards.
export default function CustomDiscountField({ value, onChange, error, role, compact = false }) {
  const [open, setOpen] = useState(Boolean(value.amount));
  const isAdmin = roleAllowed(role, ['admin']);

  if (!open) {
    return (
      <button type="button" style={s.addBtn} onClick={() => setOpen(true)}>
        <BadgePercent size={13} /> Add custom discount
      </button>
    );
  }

  const set = (k, v) => onChange({ ...value, [k]: v });

  return (
    <div style={s.wrap}>
      <div style={s.head}>
        <label style={s.label}>Custom discount (LKR)</label>
        <button
          type="button"
          style={s.clearBtn}
          title="Remove custom discount"
          onClick={() => { onChange({ amount: '', reason: '' }); setOpen(false); }}
        >
          <X size={12} />
        </button>
      </div>
      <input
        style={s.input}
        type="number"
        min="0"
        step="100"
        inputMode="decimal"
        placeholder="e.g. 2500"
        value={value.amount}
        onChange={e => set('amount', e.target.value)}
      />
      <textarea
        style={{ ...s.input, ...s.reason, minHeight: compact ? 44 : 54 }}
        placeholder="Reason (required) — e.g. long-time customer, price match"
        value={value.reason}
        maxLength={500}
        onChange={e => set('reason', e.target.value)}
      />
      {error ? (
        <span style={s.error}>{error}</span>
      ) : (
        <span style={s.hint}>
          Saved to the order&apos;s internal notes{isAdmin ? '.' : ' and an admin will be notified.'}
        </span>
      )}
    </div>
  );
}

const s = {
  addBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
    background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer',
    color: theme.accentInk, fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
  },
  wrap: { display: 'flex', flexDirection: 'column', gap: 5, flexShrink: 0 },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  label: { fontSize: 11, fontWeight: 600, color: theme.inkFaint },
  clearBtn: {
    background: 'none', border: 'none', cursor: 'pointer', color: theme.inkFaint,
    padding: 2, display: 'inline-flex',
  },
  input: {
    background: theme.bg, border: `1.5px solid ${theme.border}`, borderRadius: 8,
    padding: '8px 10px', color: theme.ink, fontSize: 13, width: '100%',
    fontFamily: 'inherit', boxSizing: 'border-box',
  },
  reason: { resize: 'vertical', lineHeight: 1.45 },
  hint: { fontSize: 11, color: theme.inkSoft, lineHeight: 1.4 },
  error: { fontSize: 11, color: theme.high, fontWeight: 600, lineHeight: 1.4 },
};
