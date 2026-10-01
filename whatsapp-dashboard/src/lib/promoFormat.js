// One wording for a promo code's value everywhere it is shown. A per-mattress
// code (migration 052, discount_scope='per_unit') gives its amount once for
// each mattress on the bill, so the label has to say so or "LKR 2,500 off"
// reads as a flat discount.
export function promoDiscountLabel(c) {
  if (!c) return '';
  if (c.discount_type === 'percent') return `${c.discount_percent}% off`;
  const amount = `LKR ${Number(c.discount_amount).toLocaleString()} off`;
  if (c.discount_scope !== 'per_unit') return amount;
  return c.max_units_per_order != null
    ? `${amount} per mattress (up to ${c.max_units_per_order})`
    : `${amount} per mattress`;
}

// "2 × LKR 2,500" for a validated per-mattress result (the camelCase shape
// POST /api/promo-codes/validate returns), or null for any other code.
export function perUnitBreakdown(result) {
  if (!result || result.discountScope !== 'per_unit' || result.countedUnits == null) return null;
  return `${result.countedUnits} × LKR ${Number(result.discountAmount).toLocaleString()}`;
}

// What an unscoped code covers: every product for a per-bill code, but only
// mattresses for a per-mattress one (pillows are not counted as units).
export function unscopedAppliesLabel(c) {
  return c?.discount_scope === 'per_unit' ? 'All mattresses' : 'All products';
}
