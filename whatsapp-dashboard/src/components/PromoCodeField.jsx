import { useEffect, useRef, useState } from 'react';
import { Tag, Check, X } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { theme } from '../lib/theme';
import { promoDiscountLabel, perUnitBreakdown } from '../lib/promoFormat';

// Validates a promo code live against the customer's phone + current order
// total, using the same public POST /api/promo-codes/validate the website
// calls (Phase 9) — so a staff-placed order is checked with the exact same
// rules (expiry, redemption cap, already-used-by-this-phone) a web
// redemption would be. Reports the validated result up via onValidated so
// the parent can redeem it for real (POST /api/promo-codes/redeem) only at
// order-submit time, once the total is final.
// `initialCode` starts the field with a code already applied (a quotation
// being edited or recreated, migration 055) — it is re-validated on mount like
// any typed code. `onCodeChange` reports what is typed, so a caller can refuse
// to save while a typed code is not (yet) valid instead of silently dropping it.
export default function PromoCodeField({ phone, orderTotal, items, onValidated, initialCode = '', onCodeChange }) {
  const [code, setCode] = useState(initialCode || '');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState(null); // { valid, message, previewDiscount, discountType, discountPercent, discountAmount }
  const [allCodes, setAllCodes] = useState(null);
  const [focused, setFocused] = useState(false);
  const debounceRef = useRef(null);

  // Loaded once per mount — the codes list is small, so filtering by prefix
  // client-side avoids a request per keystroke. requireRole admin/viewer on
  // this route, same as PromoCodes.jsx's own management page.
  useEffect(() => {
    apiFetch('/api/promo-codes').then(r => r.json()).then(d => setAllCodes(d.promoCodes || [])).catch(() => setAllCodes([]));
  }, []);

  const matches = focused && code.trim() && allCodes
    ? allCodes.filter(c => c.active && c.code.toUpperCase().startsWith(code.trim().toUpperCase()) && c.code.toUpperCase() !== code.trim().toUpperCase()).slice(0, 6)
    : [];

  function pickCode(c) {
    setCode(c.code);
    setFocused(false);
  }

  useEffect(() => { onCodeChange?.(code); }, [code]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (!code.trim() || !phone?.trim()) {
      setResult(null);
      onValidated?.(null);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setChecking(true);
      try {
        const res = await apiFetch('/api/promo-codes/validate', {
          method: 'POST',
          body: JSON.stringify({ code: code.trim().toUpperCase(), phone: phone.trim(), orderTotal: orderTotal || 0, items: items || [] }),
        });
        const data = await res.json();
        setResult(data);
        onValidated?.(data.valid ? { code: code.trim().toUpperCase(), ...data } : null);
      } catch {
        setResult({ valid: false, message: 'Network error checking code' });
        onValidated?.(null);
      }
      setChecking(false);
    }, 450);
    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, phone, orderTotal, JSON.stringify(items)]);

  function clear() {
    setCode('');
    setResult(null);
    onValidated?.(null);
  }

  return (
    <div>
      <div style={{ position: 'relative' }}>
        <Tag size={13} style={s.icon} />
        <input
          style={{ ...s.input, ...(result?.valid ? s.inputValid : result && !result.valid ? s.inputInvalid : {}) }}
          value={code}
          onChange={e => setCode(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 120)}
          placeholder="Promo code (optional)"
          disabled={!phone?.trim()}
        />
        {code && (
          <button style={s.clearBtn} onClick={clear} title="Remove code"><X size={13} /></button>
        )}
        {matches.length > 0 && (
          <div style={s.dropdown}>
            {matches.map(c => (
              <button key={c.id} style={s.dropdownItem} onClick={() => pickCode(c)}>
                <span style={{ fontWeight: 700, fontFamily: theme.mono }}>{c.code}</span>
                <span style={{ color: theme.inkFaint, fontSize: 11.5 }}>
                  {promoDiscountLabel(c)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {!phone?.trim() && <p style={s.hint}>Enter the customer&apos;s phone number first</p>}
      {checking && <p style={s.hint}>Checking...</p>}
      {!checking && result?.valid && (
        <>
          <p style={s.validMsg}>
            <Check size={12} /> Valid — LKR {Number(result.previewDiscount).toLocaleString()} off
            {perUnitBreakdown(result) && <span style={{ fontWeight: 500 }}> ({perUnitBreakdown(result)})</span>}
          </p>
          {result.discountScope === 'per_unit' && result.maxUnitsPerOrder != null && result.eligibleUnits > result.maxUnitsPerOrder && (
            <p style={s.hint}>This code counts at most {result.maxUnitsPerOrder} mattress{result.maxUnitsPerOrder > 1 ? 'es' : ''} per order</p>
          )}
          {result.eligibleProductNames?.length > 0 && (
            <p style={s.hint}>Only applies to: {result.eligibleProductNames.join(', ')}</p>
          )}
        </>
      )}
      {!checking && result && !result.valid && (
        <p style={s.invalidMsg}>{result.message}</p>
      )}
    </div>
  );
}

const s = {
  icon: { position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: theme.inkFaint },
  input: { background: theme.bg, border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '9px 32px', color: theme.ink, fontSize: 13, width: '100%', fontFamily: 'inherit', boxSizing: 'border-box', textTransform: 'uppercase' },
  inputValid: { border: `1.5px solid ${theme.success}` },
  inputInvalid: { border: `1.5px solid ${theme.high}` },
  clearBtn: { position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: theme.inkFaint, display: 'flex', padding: 2 },
  dropdown: { position: 'absolute', top: '110%', left: 0, right: 0, background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 10, boxShadow: theme.shadowMd, zIndex: 10, overflow: 'hidden', maxHeight: 180, overflowY: 'auto' },
  dropdownItem: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '8px 12px', background: 'none', border: 'none', borderBottom: `1px solid ${theme.borderSoft}`, cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' },
  hint: { fontSize: 11, color: theme.inkFaint, margin: '4px 0 0' },
  validMsg: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 600, color: theme.success, margin: '4px 0 0' },
  invalidMsg: { fontSize: 11.5, fontWeight: 600, color: theme.high, margin: '4px 0 0' },
};
