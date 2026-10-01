// Free items on an order — one place for the rules, so the four order screens,
// the invoice and the quotation cannot drift apart.
//
// HOW A FREE LINE IS STORED (confirmed with the user): a normal order item with
// a NEGATIVE unit_price and free: true.
//
//   { name: 'Bolster Pillow', bed_size: '16x24', qty: 4,
//     unit_price: -2500, free: true }
//
// A free line is WORTH its catalog price but COSTS the customer nothing
// (confirmed with the user): the customer pays for the paid lines only. On the
// invoice and in the cart the free line is shown at full value, included in the
// Subtotal, and then deducted again, so it nets to zero:
//
//   Subtotal     = paid lines + free lines at full worth   (grossSubtotal)
//   Free items   = - free worth                           (freeValue)
//   then volume / promo discounts, if any
//   Total        = paid lines - discounts                  (orderTotal)
//
// The negative sign therefore must NOT be summed into a total. An earlier
// version did exactly that (`sum += unit_price * qty` over every line), which
// took the gift's value off the mattress price — a 53,800 mattress with four
// free bolsters was saved as 43,800. Always total with paidSubtotal/orderTotal.
//
// The sign is kept only as a durable marker for rows written before the
// `free: true` flag existed.
//
// What the negative price deliberately does NOT change:
//   * stock — handle_order_stock_reservation reads only name and qty, so a
//     free line reserves and later decrements the units really given away.
//     Verified against the live trigger: a free Bolster x4 reserved 4.
//   * warranty — handle_order_completed_warranty also matches by name, so a
//     free product is still covered, which is what the customer expects.

// Is this line a giveaway? Keyed on the explicit flag, with the negative price
// as a fallback for any row written before the flag existed.
export function isFreeItem(item) {
  return item?.free === true || (Number(item?.unit_price) || 0) < 0;
}

// The signed value of one line (negative for a free line). Not a contribution
// to the order total — free lines contribute nothing; see orderTotal.
export function lineTotal(item) {
  return (Number(item?.unit_price) || 0) * (Number(item?.qty) || 0);
}

// The charged lines only — what the customer is actually paying for.
export function paidSubtotal(items) {
  return (items || []).filter(i => !isFreeItem(i)).reduce((sum, i) => sum + lineTotal(i), 0);
}

// The value being given away, as a POSITIVE number for display ("you saved X").
// The stored lines are negative, so this flips the sign back.
export function freeValue(items) {
  return Math.abs((items || []).filter(isFreeItem).reduce((sum, i) => sum + lineTotal(i), 0));
}

// Paid lines plus free lines at their full worth — the Subtotal the customer
// sees, before the free items are deducted again.
export function grossSubtotal(items) {
  return paidSubtotal(items) + freeValue(items);
}

// What the customer pays for the items: the paid lines only. A free line
// contributes nothing (it is added in grossSubtotal and deducted by
// freeValue). Order-level discounts (volume, promo) come off after this.
export function orderTotal(items) {
  return Math.max(0, paidSubtotal(items));
}

// Build a free line from a catalog pick. The price is stored negative here, in
// ONE place, so no screen has to remember the sign convention.
export function makeFreeItem({ name, bedSize, qty, unitPrice, category }) {
  return {
    name,
    bed_size: bedSize || null,
    qty: Number(qty) || 1,
    // Math.abs first: a caller passing an already-negative price (re-editing an
    // existing free line) must not flip it back to positive.
    unit_price: -Math.abs(Number(unitPrice) || 0),
    free: true,
    ...(category ? { category } : {}),
  };
}

// How many units of one product the customer actually leaves with, split by
// what they are charged for. Staff enter "2 paid + 4 free" as two lines, so
// this is what lets the UI say "6 Bolster Pillow (2 paid + 4 free)" and make a
// mis-typed quantity visible. Advisory only — it never blocks a save, because
// the agent is the one who knows what was agreed.
export function productTally(items, name) {
  const key = String(name || '').toLowerCase();
  const rows = (items || []).filter(i => String(i.name || '').toLowerCase() === key);
  const paid = rows.filter(i => !isFreeItem(i)).reduce((sum, i) => sum + (Number(i.qty) || 0), 0);
  const free = rows.filter(isFreeItem).reduce((sum, i) => sum + (Number(i.qty) || 0), 0);
  return { paid, free, total: paid + free };
}

// Volume discount (real, confirmed price list): a flat LKR amount off the
// order once 2 or more PAID mattresses are on it. No published rate past 3, so
// 3+ uses the 3-mattress rate rather than guessing a higher one. One place for
// the rule, so placing an order and editing it afterwards cannot disagree.
export function volumeDiscountFor(mattressCount) {
  return mattressCount >= 3 ? 2500 : mattressCount === 2 ? 1500 : 0;
}

// The volume discount actually given, once staff may switch it off (the
// "Apply volume discount" tick, migration 057). `eligible` is what the cart
// earns; `waived` is only meaningful — and only stored — when it earns
// something, so a cart that drops to one mattress forgets the choice.
export function volumeDiscountChoice(mattressCount, applied) {
  const eligible = volumeDiscountFor(mattressCount);
  const waived = eligible > 0 && !applied;
  return { eligible, amount: waived ? 0 : eligible, waived };
}

// Paid mattresses on an order. Stored order items carry no category, so it is
// looked up from the catalog by name (the same by-name matching every other
// order-item-to-product link uses); an item that does carry one uses it.
export function paidMattressCount(items, products) {
  const byName = new Map((products || []).map(p => [String(p.name).toLowerCase(), p.category]));
  return (items || []).reduce((sum, it) => {
    if (isFreeItem(it)) return sum;
    const category = it.category || byName.get(String(it.name || it.product || '').toLowerCase());
    return sum + (category === 'mattress' ? Number(it.qty) || 0 : 0);
  }, 0);
}
