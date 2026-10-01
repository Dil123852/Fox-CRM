// Delivery & payment method vocabulary — one source of truth for every order
// screen (ShowroomOrderModal, ChatOrderModal, LeadsPage's
// ConfirmOrderModal, OrderDetailModal, OrderDeliveryPage).
//
// 'cash_on_delivery' (migration 026) is the one method that spans both the
// delivery and the payment side of an order: the goods travel by delivery AND
// the cash is collected at handover. It lives in delivery_method rather than
// payment_method because it is the delivery that carries the payment — a
// pickup can never be COD, whereas a COD order is always a delivery. Picking
// it therefore forces payment_method='cash' (the DB enforces the same pairing
// via orders_cod_requires_cash_payment) and the two separate "Delivery" and
// "Payment" sections collapse into a single combined block, so staff set and
// read one real-world arrangement instead of two fields they have to keep
// consistent by hand.

export const COD = 'cash_on_delivery';

export const DELIVERY_METHODS = ['pickup', 'delivery', 'courier', COD];
export const PAYMENT_METHODS  = ['cash', 'bank_transfer', 'card', 'online'];

export const DELIVERY_METHOD_LABEL = {
  pickup:   'Pickup',
  delivery: 'Delivery',
  courier:  'Courier',
  [COD]:    'Cash on Delivery',
};

export const isCOD = method => method === COD;

// A COD order still needs an address and a date — it is a delivery. Only a
// showroom pickup has neither.
export const needsDeliveryAddress = method => method !== 'pickup';

// COD pins payment_method to cash; every other method leaves the staff's own
// choice alone. Used at submit time in the creation modals and when saving an
// edit, so the value sent to the API can never violate the DB constraint.
export const paymentMethodFor = (deliveryMethod, chosenPaymentMethod) =>
  isCOD(deliveryMethod) ? 'cash' : chosenPaymentMethod;

export const labelFor = method =>
  DELIVERY_METHOD_LABEL[method] || (method || '').replace(/_/g, ' ') || '—';

export const paymentLabelFor = method =>
  (method || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || '—';

// The one-line human summary of a COD order, shown wherever payment and
// delivery are presented together. `total` may be null when the amount isn't
// known yet (an in-progress form with an empty cart).
export function codSummary(total, currency = 'LKR') {
  const amount = Number(total);
  return amount > 0
    ? `${currency} ${amount.toLocaleString()} collected in cash by the driver on handover.`
    : 'Collected in cash by the driver on handover.';
}
