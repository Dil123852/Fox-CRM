// Custom discount (migration 053): a discount staff give at their own
// discretion, ON TOP of the automatic volume discount and any promo code.
// Applied last, so promo validation (which runs against the after-volume
// figure) is unchanged.
//
// The server enforces the same rules (a reason is required; the discount can
// never exceed what is left to pay) and writes the internal-notes line and the
// admin notification itself — these checks only explain the rule up front.

/**
 * @param {string|number} amountInput what is typed in the amount box
 * @param {string} reason
 * @param {number} maxAllowed what is left to pay before this discount
 * @returns {{ amount: number, reason: string, error: string|null }}
 *   amount 0 = none given
 */
export function customDiscountState(amountInput, reason, maxAllowed) {
  const raw = String(amountInput ?? '').trim();
  const trimmedReason = String(reason ?? '').trim();
  if (!raw) return { amount: 0, reason: '', error: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return { amount: 0, reason: trimmedReason, error: 'Enter a valid amount' };
  if (n === 0) return { amount: 0, reason: '', error: null };
  const amount = Math.round(n * 100) / 100;
  if (amount > Math.max(0, maxAllowed)) {
    return { amount, reason: trimmedReason, error: 'More than what is left to pay on the order' };
  }
  if (!trimmedReason) return { amount, reason: '', error: 'A reason is required' };
  return { amount, reason: trimmedReason, error: null };
}
