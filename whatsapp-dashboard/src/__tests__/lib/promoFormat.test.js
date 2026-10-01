import { describe, it, expect } from 'vitest';
import { promoDiscountLabel, perUnitBreakdown, unscopedAppliesLabel } from '../../lib/promoFormat';

describe('promoFormat', () => {
  it('labels per-bill, per-mattress and capped codes', () => {
    expect(promoDiscountLabel({ discount_type: 'percent', discount_percent: 10 })).toBe('10% off');
    expect(promoDiscountLabel({ discount_type: 'amount', discount_amount: '2500.00', discount_scope: 'order' })).toBe('LKR 2,500 off');
    expect(promoDiscountLabel({ discount_type: 'amount', discount_amount: '2500.00', discount_scope: 'per_unit' })).toBe('LKR 2,500 off per mattress');
    expect(promoDiscountLabel({ discount_type: 'amount', discount_amount: 2500, discount_scope: 'per_unit', max_units_per_order: 3 }))
      .toBe('LKR 2,500 off per mattress (up to 3)');
  });
  it('breaks a validated per-mattress result into units × amount', () => {
    expect(perUnitBreakdown({ discountScope: 'per_unit', countedUnits: 2, discountAmount: '2500.00' })).toBe('2 × LKR 2,500');
    expect(perUnitBreakdown({ discountScope: 'order', countedUnits: null, discountAmount: '2500.00' })).toBeNull();
  });
  it('an unscoped per-mattress code covers mattresses, not every product', () => {
    expect(unscopedAppliesLabel({ discount_scope: 'per_unit' })).toBe('All mattresses');
    expect(unscopedAppliesLabel({ discount_scope: 'order' })).toBe('All products');
  });
});
