import { describe, it, expect } from 'vitest';
import { customDiscountState } from '../../lib/customDiscount';

describe('customDiscountState', () => {
  it('an empty or zero amount is no discount and never an error', () => {
    expect(customDiscountState('', '', 1000)).toEqual({ amount: 0, reason: '', error: null });
    expect(customDiscountState('0', 'x', 1000)).toEqual({ amount: 0, reason: '', error: null });
  });
  it('an amount needs a reason', () => {
    expect(customDiscountState('2500', '  ', 10000).error).toBe('A reason is required');
  });
  it('cannot exceed what is left to pay', () => {
    expect(customDiscountState('10001', 'x', 10000).error).toMatch(/left to pay/);
    expect(customDiscountState('10000', 'x', 10000).error).toBeNull();
  });
  it('rejects a negative or garbled amount', () => {
    expect(customDiscountState('-5', 'x', 10000).error).toBe('Enter a valid amount');
    expect(customDiscountState('abc', 'x', 10000).error).toBe('Enter a valid amount');
  });
  it('a valid discount is trimmed and rounded to cents', () => {
    expect(customDiscountState('2500.456', ' loyal ', 10000)).toEqual({ amount: 2500.46, reason: 'loyal', error: null });
  });
});
