import { useEffect, useMemo, useState } from 'react';
import { X, Trash2, Pencil, Plus, Banknote, Receipt } from 'lucide-react';
import { theme, ORDER_STATUS, PAYMENT_STATUS, modalBackdrop } from '../lib/theme';
import { roleAllowed, seesAllAgents } from '../lib/roles';
import { apiFetch } from '../lib/api';
import { isFreeItem, paidSubtotal, grossSubtotal, freeValue, volumeDiscountChoice, paidMattressCount } from '../lib/orderItems';
import VolumeDiscountToggle from './VolumeDiscountToggle';
import FreeProductSection from './FreeProductSection';
import PromoCodeField from './PromoCodeField';
import CustomDiscountField from './CustomDiscountField';
import { customDiscountState } from '../lib/customDiscount';
import { formatDimension, variantValue } from '../lib/format';
import { useErrorPopup } from './DialogProvider';
import {
  DELIVERY_METHODS, PAYMENT_METHODS, isCOD, labelFor,
  paymentMethodFor, paymentLabelFor, codSummary,
} from '../lib/deliveryMethod';
import { vh } from '../lib/viewport';

// The value identifying one variant in the size dropdown, and what is stored
// in the order line's bed_size. Normally the exact dimension ("84x36");
// falls back to the legacy thickness key, then to the size name for a
// variant carrying no dimension at all (a pillow sized only "Standard"),
// so an option is never valueless.
// products.variants stores dimensions as WxL in inches. Shown with a real
// multiplication sign so it reads as a measurement; anything not in that
// form (a nominal size, legacy data) is shown unchanged.
const STATUS_OPTIONS = Object.keys(ORDER_STATUS);
const PAYMENT_STATUS_OPTIONS = ['pending', 'partial', 'paid', 'failed', 'refunded'];

// Mirrors PATCH /api/orders/:id's own role split (whatsapp-backend/index.js)
// exactly, so the UI never offers an edit the backend would 403 on:
// payment fields need admin/finance (a sales_agent may also change the
// payment METHOD while the order is unpaid — see `can` below), pricing/items
// need admin/sales_agent,
// delivery_coordinator is further restricted to delivery+status+notes only
// (no customer_name, no special_requirements).
const ROLE_EDIT = {
  customer:            ['admin', 'sales_agent', 'finance'],
  items:               ['admin', 'sales_agent'],
  delivery:            ['admin', 'sales_agent', 'finance', 'delivery_coordinator'],
  paymentMethod:       ['admin', 'finance'],
  // The advance is an agreed amount, not a received payment (that lives in
  // order_payments), so sales agents can set it as well as finance.
  advance:             ['admin', 'sales_agent', 'finance'],
  specialRequirements: ['admin', 'sales_agent', 'finance'],
  notes:               ['admin', 'sales_agent', 'finance', 'delivery_coordinator'],
};

function toForm(o) {
  return {
    customerName: o.customer_name || o.customers?.name || '',
    customerPhone: o.customer_phone || o.customers?.whatsapp_number || '',
    secondaryPhone: o.secondary_phone || '',
    items: (o.items || []).map(it => ({ ...it })),
    deliveryMethod: o.delivery_method || 'delivery',
    deliveryDate: o.delivery_date ? o.delivery_date.slice(0, 10) : '',
    deliveryAddress: o.delivery_address || '',
    paymentMethod: o.payment_method || 'cash',
    specialRequirements: o.special_requirements || '',
    notes: o.notes || '',
    isCustomOrder: !!o.is_custom_order,
    advanceRequired: o.advance_required != null ? String(o.advance_required) : '',
    // migration 053
    customDiscount: Number(o.custom_discount) > 0 ? String(Number(o.custom_discount)) : '',
    customDiscountReason: o.custom_discount_reason || '',
    // migration 057 — the "Apply volume discount" tick
    volumeApplied: !o.volume_discount_waived,
  };
}

export default function OrderDetailModal({ order, role, saving, onClose, onSave, onDelete, onInvoice }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => toForm(order));
  const [deliverConfirm, setDeliverConfirm] = useState(false);
  // Evidence prompt for marking an order paid (migration 041).
  const [paidPrompt, setPaidPrompt] = useState(false);
  const [taxInvoiceNo, setTaxInvoiceNo] = useState(order.tax_invoice_no || '');
  const [deliverNote, setDeliverNote] = useState('');

  // Real catalog, so an edited line picks its product and size from the
  // price list in the database instead of being retyped from memory — the
  // same pattern LeadsPage's Convert-to-Order modal and ShowroomOrderModal
  // already use. Prices live in products.variants as {size, dimension,
  // price} and depend on BOTH product and exact dimension (every dimension
  // is a different price in each product), so a lookup needs both fields.
  // Only fetched once the user actually starts editing — a read-only view
  // of an order has no use for it.
  const [products, setProducts] = useState([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [productsFailed, setProductsFailed] = useState(false);

  useEffect(() => {
    if (!editing || products.length > 0 || productsLoading) return;
    let alive = true;
    setProductsLoading(true);
    apiFetch('/api/products')
      .then(r => r.json())
      .then(d => { if (alive) setProducts((d.products || []).filter(p => p.active)); })
      // Leave every field manually typeable rather than blocking the edit:
      // an unreachable catalog must not make an order uneditable.
      .catch(() => { if (alive) setProductsFailed(true); })
      .finally(() => { if (alive) setProductsLoading(false); });
    return () => { alive = false; };
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  // The payment method is also open to a sales_agent while the order is
  // unpaid (confirmed with the user) — they choose it when placing the order.
  // Once paid it is a settled record, so it stays admin/finance. Mirrors the
  // same rule in PATCH /api/orders/:id.
  const can = key => roleAllowed(role, ROLE_EDIT[key])
    || (key === 'paymentMethod' && roleAllowed(role, ['sales_agent']) && order.payment_status !== 'paid');
  const canEditAnything = Object.keys(ROLE_EDIT).some(can);

  // Promo code while editing. `promoCleared` removes the code the order was
  // placed with; `newPromo` is a code validated by PromoCodeField. The server
  // re-validates, redeems and links a new code on save (PATCH /api/orders/:id).
  const [promoCleared, setPromoCleared] = useState(false);
  const [newPromo, setNewPromo] = useState(null);

  // Numeric copies of the edited lines, so the helpers below can sum them.
  const numericItems = items => items.map(it => ({
    ...it, unit_price: parseFloat(it.unit_price) || 0, qty: parseInt(it.qty) || 0,
  }));

  // The money on the order, for the saved view or the edit in progress.
  //
  // The volume discount follows the EDITED cart: going from one mattress to two
  // must add the discount, and back to one must remove it. It is recomputed
  // from the catalog (order items carry no category), so while the catalog has
  // not loaded — or failed to — the discount the order already had is kept
  // rather than silently dropped.
  function pricing(items, isEditing) {
    const lines = numericItems(items);
    const paid = paidSubtotal(lines);
    // Staff may have chosen not to give it (migration 057): the tick is kept
    // with the order, so an edit never silently hands the discount back.
    const count = products.length > 0 ? paidMattressCount(lines, products) : 0;
    const choice = isEditing && products.length > 0
      ? volumeDiscountChoice(count, form.volumeApplied)
      : { eligible: 0, amount: Number(order.volume_discount) || 0, waived: !!order.volume_discount_waived };
    const volume = choice.amount;
    const keptCode = !promoCleared && order.promo_code ? order.promo_code : null;
    const promo = !isEditing
      ? (order.promo_code ? { code: order.promo_code, amount: Number(order.promo_discount) || 0 } : null)
      : newPromo
        ? { code: newPromo.code, amount: Number(newPromo.previewDiscount) || 0 }
        : keptCode ? { code: keptCode, amount: Number(order.promo_discount) || 0 } : null;
    // Custom discount (migration 053) is applied last, after the promo code.
    const afterPromo = Math.max(0, paid - volume - (promo?.amount || 0));
    const custom = isEditing
      ? customDiscountState(form.customDiscount, form.customDiscountReason, afterPromo)
      : { amount: Number(order.custom_discount) || 0, reason: order.custom_discount_reason || '', error: null };
    return {
      gross: grossSubtotal(lines),
      free: freeValue(lines),
      paid,
      volume,
      volumeChoice: { ...choice, mattressCount: count },
      promo,
      custom,
      total: Math.max(0, afterPromo - custom.amount),
    };
  }

  function startEdit() {
    setForm(toForm(order));
    setPromoCleared(false);
    setNewPromo(null);
    setEditing(true);
  }

  // PATCH /api/orders/:id reads snake_case keys directly off req.body (unlike
  // POST /api/orders, which destructures camelCase) — must match its `allowed`
  // list exactly or the field silently fails to persist.
  function saveEdit() {
    const patch = {};
    if (can('customer')) {
      patch.customer_name = form.customerName.trim() || null;
      patch.customer_phone = form.customerPhone.trim() || null;
    }
    if (can('delivery')) {
      // Grouped with delivery rather than customer: it is the delivery contact,
      // and unlike customer_phone nothing is ever SENT to it, so the roles that
      // run deliveries are the ones who need to fix it.
      patch.secondary_phone = form.secondaryPhone.trim() || null;
    }
    if (can('items')) {
      const items = form.items.filter(it => (it.name || '').trim());
      const p = pricing(items, true);
      patch.items = items;
      patch.total_amount = p.total;
      // Stored as NULL rather than 0 when absent, matching how POST
      // /api/orders records an order with no discount (migration 046).
      patch.volume_discount = p.volume > 0 ? p.volume : null;
      // Only sent when it is (or was) switched off, so an ordinary edit still
      // works on a server whose database does not have migration 057 yet.
      if (p.volumeChoice.waived || order.volume_discount_waived) {
        patch.volume_discount_waived = p.volumeChoice.waived;
      }
      patch.promo_code = p.promo?.code || null;
      patch.promo_discount = p.promo && p.promo.amount > 0 ? p.promo.amount : null;
      // The server stamps who changed it, appends the internal note and
      // notifies admins; it also recomputes discount_total itself.
      // Only sent when there is (or was) one, so an ordinary edit still works
      // on a server whose database does not have migration 053 yet.
      if (p.custom.amount > 0 || Number(order.custom_discount) > 0) {
        patch.custom_discount = p.custom.amount > 0 ? p.custom.amount : null;
        patch.custom_discount_reason = p.custom.amount > 0 ? p.custom.reason : null;
      }
      const discounts = p.volume + (p.promo?.amount || 0) + p.custom.amount;
      patch.discount_total = discounts > 0 ? discounts : null;
    }
    if (can('delivery')) {
      patch.delivery_method = form.deliveryMethod;
      patch.delivery_date = form.deliveryDate || null;
      patch.delivery_address = form.deliveryAddress.trim() || null;
    }
    if (can('paymentMethod')) patch.payment_method = paymentMethodFor(form.deliveryMethod, form.paymentMethod);
    else if (can('delivery') && isCOD(form.deliveryMethod) && order.payment_method !== 'cash') {
      // Switching an order to COD requires payment_method='cash' (DB
      // constraint orders_cod_requires_cash_payment). A delivery-only editor
      // can't send payment fields — PATCH /api/orders/:id 403s them — so the
      // COD option is hidden from them entirely rather than offered and
      // failed. This branch is the belt-and-braces case: it can only be
      // reached if the form somehow holds COD without payment edit rights.
      patch.delivery_method = order.delivery_method;
    }
    if (can('advance')) {
      patch.is_custom_order = !!form.isCustomOrder;
      const adv = parseFloat(form.advanceRequired);
      // An empty field clears the advance; the DB requires a positive amount
      // within the total (orders_advance_within_total), so a 0 or a blank
      // must become NULL rather than being sent as 0.
      patch.advance_required = Number.isFinite(adv) && adv > 0 ? adv : null;
    }
    if (can('specialRequirements')) patch.special_requirements = form.specialRequirements.trim() || null;
    if (can('notes')) patch.notes = form.notes.trim() || null;
    onSave(order.id, patch);
    setEditing(false);
  }

  function set(k, v) { setForm(f => ({ ...f, [k]: v })); }
  function updateItem(i, k, v) { setForm(f => ({ ...f, items: f.items.map((it, idx) => idx === i ? { ...it, [k]: v } : it) })); }
  // Several keys at once — changing the product has to reset the size and
  // re-price in the SAME update, or a stale size from the previous product
  // survives for a render and prices the line at nothing.
  function patchItem(i, patch) { setForm(f => ({ ...f, items: f.items.map((it, idx) => idx === i ? { ...it, ...patch } : it) })); }
  function addItem() { setForm(f => ({ ...f, items: [...f.items, { name: '', bed_size: '', qty: 1, unit_price: '' }] })); }
  function removeItem(i) { setForm(f => ({ ...f, items: f.items.filter((_, idx) => idx !== i) })); }

  function handleStatusSelect(newStatus) {
    if (newStatus === 'delivered') { setDeliverNote(''); setDeliverConfirm(true); }
    else onSave(order.id, { status: newStatus });
  }

  function confirmDelivery() {
    if (!deliverNote.trim()) return;
    const patch = { status: 'delivered', delivery_confirmation_note: deliverNote.trim() };
    if (order.payment_status !== 'paid') patch.payment_status = 'paid';
    onSave(order.id, patch);
    setDeliverConfirm(false);
  }

  const editPricing = editing ? pricing(form.items, true) : null;
  const itemsTotal = editing ? editPricing.total : order.total_amount || 0;

  const savedCOD   = isCOD(order.delivery_method);
  const editingCOD = isCOD(form.deliveryMethod);

  // What the driver actually collects on a COD order is the total LESS money
  // already received — otherwise the COD box tells the driver to collect the
  // full amount on an order the customer has part-paid, which is a real cash
  // handling error, not just a display nit. amount_paid is derived from the
  // order_payments ledger by trg_order_payment_change (migration 028).
  const savedAdvance   = Number(order.advance_required) || 0;
  const advancePaid    = Number(order.amount_paid) || 0;
  const orderTotal     = Number(order.total_amount) || 0;
  const savedCollect   = Math.max(0, orderTotal - advancePaid);
  // How much of the AGREED advance is still missing. Distinct from the
  // balance: this is what blocks confirmation (PATCH /api/orders/:id checks
  // v_order_payment_summary.advance_satisfied), whereas the balance is simply
  // what remains payable.
  const advanceOutstanding = Math.max(0, savedAdvance - advancePaid);
  const editingAdvance = Math.max(0, parseFloat(form.advanceRequired) || 0);
  // While EDITING, preview the arrangement being set up: subtract whichever is
  // larger of what has been received and the advance being agreed. The saved
  // view below deliberately does the opposite and only ever subtracts money
  // actually received, since that is what the driver can rely on.
  const editingCollect = Math.max(0, itemsTotal - Math.max(advancePaid, editingAdvance));
  // Setting COD writes payment_method='cash' (DB constraint), and PATCH
  // /api/orders/:id lets only admin/finance touch payment fields — so a
  // delivery-only editor never gets COD as an option. They can still see and
  // keep an order that's already COD; they just can't switch one into it.
  const deliveryOptions = can('paymentMethod') || savedCOD
    ? DELIVERY_METHODS
    : DELIVERY_METHODS.filter(m => !isCOD(m));

  return (
    <div style={s.backdrop} onClick={e => e.target === e.currentTarget && !deliverConfirm && onClose()}>
      <div style={s.modal} className="summary-card">
        <div style={s.header}>
          <div>
            <p style={s.headerOrderNum}>Order #{order.order_number}</p>
            <p style={s.headerDate}>{new Date(order.created_at).toLocaleString('en', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
          </div>
          <div style={s.headerActions}>
            {editing ? (
              <>
                <button style={s.cancelBtn} onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
                <button
                  style={{ ...s.saveBtn, opacity: editPricing?.custom.error ? 0.5 : 1 }}
                  onClick={saveEdit}
                  disabled={saving || !!editPricing?.custom.error}
                  title={editPricing?.custom.error ? `Custom discount: ${editPricing.custom.error}` : undefined}
                >{saving ? 'Saving...' : 'Save'}</button>
              </>
            ) : (
              <>
                {onInvoice && (
                  <button style={s.invoiceBtn} onClick={() => onInvoice(order)} title="Preview the invoice">
                    <Receipt size={12} /> Invoice
                  </button>
                )}
                {canEditAnything && (
                  <button style={s.editBtn} onClick={startEdit}><Pencil size={12} /> Edit</button>
                )}
                <button style={s.deleteBtn} onClick={() => onDelete(order.id)} disabled={saving}><Trash2 size={13} /> Delete</button>
              </>
            )}
            <button style={s.closeBtn} onClick={onClose} title="Close" aria-label="Close"><X size={16} /></button>
          </div>
        </div>

        <div style={s.body}>
          <div style={s.controlRow}>
            <ControlBlock label="Order Status">
              <select style={{ ...s.select, color: ORDER_STATUS[order.status]?.color || theme.inkSoft, background: ORDER_STATUS[order.status]?.bg || theme.bg }}
                value={order.status} onChange={e => handleStatusSelect(e.target.value)} disabled={saving}>
                {STATUS_OPTIONS.map(o => <option key={o} value={o}>{ORDER_STATUS[o].label}</option>)}
              </select>
            </ControlBlock>
            <ControlBlock label="Payment">
              <select style={{ ...s.select, color: PAYMENT_STATUS[order.payment_status]?.color || theme.inkSoft }}
                value={order.payment_status || 'pending'}
                onChange={e => {
                  // Marking paid needs a Tax Invoice number, so it opens the
                  // evidence prompt rather than saving immediately. Every other
                  // value saves as before.
                  if (e.target.value === 'paid' && order.payment_status !== 'paid') setPaidPrompt(true);
                  else onSave(order.id, { payment_status: e.target.value });
                }}
                disabled={saving}>
                {PAYMENT_STATUS_OPTIONS.map(o => <option key={o} value={o}>{PAYMENT_STATUS[o].label}</option>)}
              </select>
            </ControlBlock>
            <ControlBlock label="Total">
              {/* Number(): total_amount arrives as a string (pg numeric), and a
                  string's toLocaleString ignores the options — it printed
                  "29400.00" with no thousands separator. */}
              <p style={s.totalAmt}>{order.currency} {Number(itemsTotal).toLocaleString('en', { minimumFractionDigits: 2 })}</p>
            </ControlBlock>
          </div>

          <DetailCard title="Customer">
            {editing && can('customer') ? (
              <div style={s.row2}>
                <input style={s.input} value={form.customerName} onChange={e => set('customerName', e.target.value)} placeholder="Customer name" />
                <input style={s.input} name="order-customer-phone" autoComplete="off" data-1p-ignore="true" data-lpignore="true" data-bwignore="true" value={form.customerPhone} onChange={e => set('customerPhone', e.target.value)} placeholder="Phone" />
              </div>
            ) : (
              <>
                <InfoRow label="Name" value={order.customer_name || order.customers?.name || '—'} />
                <InfoRow label="Phone" value={order.customer_phone || order.customers?.whatsapp_number || '—'} />
                <InfoRow label="Additional number" value={order.secondary_phone || '—'} />
                {/* Who placed it (058) — for admins/viewers, who see every
                    agent's orders. Orders placed before 058 fall back to the
                    agent of the lead they came from. */}
                {seesAllAgents(role) && (
                  <InfoRow
                    label="Placed by"
                    value={order.placed_by_name
                      || (order.lead_staff_name ? `Unknown · lead: ${order.lead_staff_name}` : 'Unknown')}
                  />
                )}
              </>
            )}
            {/* Editable by whoever can edit delivery. Orders placed before
                migration 040 have none, so this is not marked required here —
                blocking an edit to an old order over a field that did not
                exist when it was placed would be wrong. */}
            {editing && can('delivery') && (
              <div style={{ marginTop: 8 }}>
                <input
                  style={s.input}
                  value={form.secondaryPhone}
                  onChange={e => set('secondaryPhone', e.target.value)}
                  placeholder="Additional contact number"
                />
              </div>
            )}
          </DetailCard>

          <DetailCard title="Order Items">
            {editing && can('items') ? (
              <>
                <div style={s.itemHead}>
                  <span style={{ flex: 3 }}>Product</span>
                  <span style={{ flex: 2 }}>Size</span>
                  <span style={{ flex: 1, textAlign: 'center' }}>Qty</span>
                  <span style={{ flex: 1.6, textAlign: 'right' }}>Unit price</span>
                  <span style={{ width: 26 }} />
                </div>
                {/* Paid rows only — giveaways are managed in the Free Products
                    section below, where their negative price is labelled rather
                    than shown in a plain number input that would read as a
                    mistake. The original index is kept so patchItem/removeItem
                    still address the right entry in form.items. */}
                {form.items.map((it, i) => [it, i]).filter(([it]) => !isFreeItem(it)).map(([it, i]) => (
                  <ItemRow
                    key={i}
                    item={it}
                    products={products}
                    loading={productsLoading}
                    failed={productsFailed}
                    onPatch={patch => patchItem(i, patch)}
                    onField={(k, v) => updateItem(i, k, v)}
                    onRemove={() => removeItem(i)}
                  />
                ))}
                <button style={s.addItemBtn} onClick={addItem}><Plus size={13} /> Add item</button>

                <div style={{ marginTop: 12 }}>
                  <FreeProductSection
                    products={products}
                    items={form.items}
                    onChange={next => setForm(f => ({ ...f, items: next }))}
                  />
                </div>

                <div style={{ marginTop: 12 }}>
                  <p style={s.subLabel}>Promo code</p>
                  {!promoCleared && order.promo_code && !newPromo ? (
                    <div style={s.promoChip}>
                      <span style={{ fontWeight: 700, fontFamily: theme.mono }}>{order.promo_code}</span>
                      <span style={{ color: theme.success }}>- {fmt(order.promo_discount, order.currency)}</span>
                      <div style={{ flex: 1 }} />
                      <button type="button" style={s.resetLink} onClick={() => setPromoCleared(true)}>Remove / change</button>
                    </div>
                  ) : (
                    <PromoCodeField
                      phone={form.customerPhone}
                      orderTotal={Math.max(0, editPricing.paid - editPricing.volume)}
                      items={numericItems(form.items).filter(it => !isFreeItem(it))}
                      onValidated={setNewPromo}
                    />
                  )}
                </div>

                <div style={{ marginTop: 12 }}>
                  <CustomDiscountField
                    value={{ amount: form.customDiscount, reason: form.customDiscountReason }}
                    onChange={v => setForm(f => ({ ...f, customDiscount: v.amount, customDiscountReason: v.reason }))}
                    error={editPricing.custom.error}
                    role={role}
                  />
                </div>

                <PriceBreakdown
                  p={editPricing}
                  currency={order.currency}
                  onVolumeApplied={v => set('volumeApplied', v)}
                  volumeApplied={form.volumeApplied}
                />
              </>
            ) : (order.items || []).length === 0 ? (
              <p style={{ color: theme.inkFaint, fontSize: 13 }}>No items recorded</p>
            ) : (
              <table style={s.itemsTable}>
                <thead>
                  {/* 'Scale' dropped: it is empty on every real order (the
                      column belonged to the retired thickness-based catalog),
                      and pillow-top is the flag that actually varies a line's
                      price, so it is shown against the size instead. */}
                  <tr>{['Product', 'Size', 'Qty', 'Unit Price', 'Subtotal'].map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {order.items.map((it, i) => {
                    const label = (it.product ? it.product.replace(' Mattress', '') : (it.name || '—'))
                      + (isFreeItem(it) ? '  (FREE)' : '');
                    // A free line is stored negative; shown at its full worth
                    // (as on the invoice) and greyed, since it is not charged.
                    const free = isFreeItem(it);
                    const unit = Math.abs(parseFloat(it.unit_price) || 0);
                    const sub = unit * (parseInt(it.qty) || 1);
                    return (
                      <tr key={i}>
                        <td style={s.td}>{label}</td>
                        <td style={{ ...s.td, textAlign: 'center' }}>
                          {it.bed_size ? formatDimension(it.bed_size) : '—'}
                          {it.pillow_top && <span style={s.pillowTopTag}>+ pillow-top</span>}
                        </td>
                        <td style={{ ...s.td, textAlign: 'center' }}>{it.qty || 1}</td>
                        <td style={{ ...s.td, textAlign: 'right' }}>{unit.toLocaleString('en', { minimumFractionDigits: 2 })}</td>
                        <td style={{ ...s.td, textAlign: 'right', color: free ? theme.inkFaint : theme.success, fontWeight: 700 }}>{sub.toLocaleString('en', { minimumFractionDigits: 2 })}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {!editing && (order.items || []).length > 0 && (() => {
              const p = pricing(order.items || [], false);
              return p.free > 0 || p.volume > 0 || p.volumeChoice.waived || p.promo || p.custom.amount > 0
                ? <PriceBreakdown p={{ ...p, total: Number(order.total_amount) || 0 }} currency={order.currency} />
                : null;
            })()}
          </DetailCard>

          {/* Cash on Delivery is one arrangement spanning delivery and
              payment, so these two cards read as one when it applies — see
              lib/deliveryMethod.js. `editingCOD` tracks the in-progress form
              while `savedCOD` reflects what's actually stored. */}
          <DetailCard title={(editing ? editingCOD : savedCOD) ? 'Delivery & Payment' : 'Delivery'}>
            {editing && can('delivery') ? (
              <>
                <div className="method-pills" style={s.pills}>
                  {deliveryOptions.map(m => (
                    <button key={m} style={{ ...s.pill, ...(form.deliveryMethod === m ? s.pillActive : {}) }} onClick={() => set('deliveryMethod', m)}>{labelFor(m)}</button>
                  ))}
                </div>
                <div style={{ ...s.row2, marginTop: 10 }}>
                  <input style={s.input} type="date" value={form.deliveryDate} onChange={e => set('deliveryDate', e.target.value)} />
                  <input style={s.input} value={form.deliveryAddress} onChange={e => set('deliveryAddress', e.target.value)} placeholder="Delivery address" />
                </div>
                {can('advance') && (
                  <div style={{ ...s.row2, marginTop: 10 }}>
                    <label style={s.advLabel}>
                      <input
                        type="checkbox"
                        checked={form.isCustomOrder}
                        onChange={e => set('isCustomOrder', e.target.checked)}
                      />
                      Custom / made-to-order
                    </label>
                    <input
                      style={s.input}
                      type="number"
                      min="0"
                      step="0.01"
                      value={form.advanceRequired}
                      onChange={e => set('advanceRequired', e.target.value)}
                      placeholder="Advance received (optional)"
                    />
                  </div>
                )}
                {editingCOD && (
                  <div style={s.codBox}>
                    <div style={s.codHead}><Banknote size={14} color={theme.success} /><span>Cash on Delivery</span></div>
                    <p style={s.codAmount}>{order.currency} {editingCollect.toLocaleString('en', { minimumFractionDigits: 2 })}</p>
                    <p style={s.codNote}>
                      {editingAdvance > 0
                        // Says "to be paid" rather than "is paid": while
                        // editing this is the intended arrangement, and the
                        // money may not have been received yet.
                        ? `Advance of ${fmt(editingAdvance, order.currency)} to be paid separately — the driver then collects the balance shown above. Payment method will be saved as cash.`
                        : `${codSummary(itemsTotal, order.currency)} Payment method will be saved as cash.`}
                    </p>
                  </div>
                )}
              </>
            ) : (
              <>
                <InfoRow label="Method" value={labelFor(order.delivery_method)} />
                <InfoRow label="Date" value={order.delivery_date ? new Date(order.delivery_date).toLocaleDateString('en', { day: 'numeric', month: 'long', year: 'numeric' }) : '—'} />
                <InfoRow label="Address" value={order.delivery_address || '—'} />
                {order.is_custom_order && <InfoRow label="Custom order" value="Made to order" />}

                {/* The payment position, spelled out. A single "Advance:
                    20,000 · 0.00 received" row was too easy to misread — the
                    agreed amount and the amount actually received are
                    different numbers and staff act on both. */}
                {(savedAdvance > 0 || advancePaid > 0) && (
                  <div style={s.payBox}>
                    <p style={s.payHead}>Payment breakdown</p>
                    <MoneyRow label="Order total" value={fmt(orderTotal, order.currency)} />
                    {savedAdvance > 0 && (
                      <MoneyRow
                        label="Advance"
                        value={fmt(savedAdvance, order.currency)}
                      />
                    )}
                    <MoneyRow
                      label="Received so far"
                      value={fmt(advancePaid, order.currency)}
                      tone={advanceOutstanding > 0 ? 'warn' : 'ok'}
                    />
                    {advanceOutstanding > 0 && (
                      <MoneyRow
                        label="Not backed by a payment"
                        value={fmt(advanceOutstanding, order.currency)}
                        tone="warn"
                      />
                    )}
                    <MoneyRow
                      label={savedCOD ? 'Driver collects' : 'Balance due'}
                      value={fmt(savedCollect, order.currency)}
                      strong
                    />
                    {/* Entering an advance now records it as received, so
                        "agreed but unpaid" is no longer a state the order can
                        be in. This only fires on legacy rows saved before
                        that change, where the figure was stored without a
                        ledger row behind it. */}
                    {advanceOutstanding > 0 && (
                      <p style={s.payWarn}>
                        This advance was recorded before advances were logged as payments,
                        so no payment sits behind it — the driver would still collect the
                        full {fmt(orderTotal, order.currency)}.
                      </p>
                    )}
                  </div>
                )}

                {savedCOD && (
                  <div style={s.codBox}>
                    <div style={s.codHead}><Banknote size={14} color={theme.success} /><span>Cash on Delivery</span></div>
                    <p style={s.codAmount}>{order.currency} {savedCollect.toLocaleString('en', { minimumFractionDigits: 2 })}</p>
                    <p style={s.codNote}>
                      {order.payment_status === 'paid'
                        ? 'Collected in cash by the driver on handover — payment received.'
                        : advancePaid > 0
                          // Only claim a deduction once money is actually IN.
                          // Keying this off the AGREED advance printed
                          // "balance after the advance" beside the full total
                          // on an order where nothing had been received.
                          ? `Balance after ${fmt(advancePaid, order.currency)} already received — the driver collects this amount, not the full order total.`
                          : codSummary(order.total_amount, order.currency)}
                    </p>
                  </div>
                )}
              </>
            )}
          </DetailCard>

          {/* Payment method gets its own card only when it isn't already
              stated by the COD block above. */}
          {!(editing ? editingCOD : savedCOD) && (
            <DetailCard title="Payment">
              {editing && can('paymentMethod') ? (
                <div style={s.pills}>
                  {PAYMENT_METHODS.map(m => (
                    <button key={m} style={{ ...s.pill, ...(form.paymentMethod === m ? s.pillActive : {}) }} onClick={() => set('paymentMethod', m)}>{m.replace('_', ' ')}</button>
                  ))}
                </div>
              ) : (
                <InfoRow label="Method" value={paymentLabelFor(order.payment_method)} />
              )}
              {/* The evidence behind a paid order, shown with who recorded it —
                  the point of collecting it is that it can be checked later. */}
              {order.tax_invoice_no && (
                <InfoRow
                  label="Tax Invoice"
                  value={
                    order.tax_invoice_no +
                    (order.paid_marked_at ? ` · ${new Date(order.paid_marked_at).toLocaleDateString()}` : '')
                  }
                />
              )}
            </DetailCard>
          )}

          <PaymentProofCard orderId={order.id} role={role} />

          {(editing && can('specialRequirements')) || order.special_requirements ? (
            <DetailCard title="Special Requirements">
              {editing && can('specialRequirements') ? (
                <textarea style={{ ...s.input, ...s.textarea }} value={form.specialRequirements} onChange={e => set('specialRequirements', e.target.value)} placeholder="Customizations, packaging..." />
              ) : (
                <p style={{ fontSize: 13, color: theme.inkSoft, lineHeight: 1.6 }}>{order.special_requirements}</p>
              )}
            </DetailCard>
          ) : null}

          {(editing && can('notes')) || order.notes ? (
            <DetailCard title="Internal Notes">
              {editing && can('notes') ? (
                <textarea style={{ ...s.input, ...s.textarea }} value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="Team notes only..." />
              ) : (
                <p style={{ fontSize: 13, color: theme.inkSoft, lineHeight: 1.6 }}>{order.notes}</p>
              )}
            </DetailCard>
          ) : null}
        </div>
      </div>

      {/* Evidence prompt. The Tax Invoice number is the proof that the money was
          taken, so the order cannot be marked paid without it — the same rule
          the server enforces, surfaced here so the agent is asked rather than
          rejected. */}
      {paidPrompt && (
        <div style={s.backdrop} onClick={e => e.target === e.currentTarget && setPaidPrompt(false)}>
          <div style={s.confirmModal}>
            <p style={s.modalTitle}>Mark paid — #{order.order_number}</p>
            <p style={s.modalSub}>
              Enter the Tax Invoice number raised for this payment. It is recorded
              against the order with your name, so the entry can be traced later.
            </p>
            <input
              style={s.input}
              value={taxInvoiceNo}
              onChange={e => setTaxInvoiceNo(e.target.value)}
              placeholder="e.g. INV-2026-0442"
              autoFocus
            />
            <div style={s.modalActions}>
              <button style={s.cancelBtn} onClick={() => setPaidPrompt(false)}>Cancel</button>
              <button
                style={{ ...s.saveBtn, opacity: taxInvoiceNo.trim() ? 1 : 0.5 }}
                disabled={!taxInvoiceNo.trim() || saving}
                onClick={() => {
                  onSave(order.id, { payment_status: 'paid', tax_invoice_no: taxInvoiceNo.trim() });
                  setPaidPrompt(false);
                }}
              >
                Mark paid
              </button>
            </div>
          </div>
        </div>
      )}

      {deliverConfirm && (
        <div style={s.backdrop} onClick={e => e.target === e.currentTarget && setDeliverConfirm(false)}>
          <div style={s.confirmModal}>
            <p style={s.modalTitle}>Confirm delivery — #{order.order_number}</p>
            <p style={s.modalSub}>
              Marking an order delivered requires a confirmation note{order.payment_status !== 'paid' ? ', and will also mark payment as Paid' : ''} (enforced by the database).
            </p>
            {order.payment_status !== 'paid' && (
              <div style={s.modalNotice}>Payment status is currently <strong>{PAYMENT_STATUS[order.payment_status]?.label || order.payment_status}</strong> — it will be set to <strong>Paid</strong> when you confirm.</div>
            )}
            <label style={s.modalLabel}>Delivery confirmation note</label>
            <textarea
              style={s.modalTextarea}
              value={deliverNote}
              onChange={e => setDeliverNote(e.target.value)}
              placeholder="e.g. Delivered to customer at the address, signed for by receptionist"
              autoFocus
            />
            <div style={s.modalActions}>
              <button style={s.cancelBtn} onClick={() => setDeliverConfirm(false)} disabled={saving}>Cancel</button>
              <button style={{ ...s.saveBtn, opacity: deliverNote.trim() ? 1 : 0.5 }} onClick={confirmDelivery} disabled={saving || !deliverNote.trim()}>
                {saving ? 'Saving...' : 'Confirm delivery'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// One editable order line. Product and size are picked from the real catalog
// and the unit price fills itself in from products.variants, rather than all
// three being typed from memory — the same rule the showroom and
// lead-conversion order flows already follow.
//
// Two real cases this must not break, both present in live order data:
//   * an off-catalog line ("Test Custom Item", or a product since retired)
//     stays selectable and keeps its typed name and price — the dropdown
//     offers it as its own option instead of silently clearing it;
//   * pillow_top: true is a real key on existing items, and the flat addon
//     it implies is already baked into that line's unit_price. It is shown
//     and editable here; previously it was invisible in this form and
//     survived only because the row was never touched.
function ItemRow({ item, products, loading, failed, onPatch, onField, onRemove }) {
  const name = item.name || '';
  const product = products.find(p => p.name === name) || null;
  // A name that is set but matches no active product: keep it usable rather
  // than erasing what the order actually recorded.
  const offCatalog = !!name && !product && !loading;

  // Memoized on the product itself: `product?.variants || []` would hand back
  // a fresh [] every render for a product with none, so the grouping below
  // would recompute forever.
  const variants = useMemo(() => product?.variants || [], [product]);
  // Grouped by nominal size so the list reads Single / Double / Queen / ...
  // with the exact dimensions under each, matching the lead-conversion modal.
  const groups = useMemo(() => {
    const m = new Map();
    for (const v of variants) {
      const k = v.size ?? '';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(v);
    }
    return [...m.entries()];
  }, [variants]);

  // A product whose single variant carries no size at all (the seeded
  // pillows) has nothing to choose — its price comes from the product alone.
  const unsized = variants.length === 1 && !variantValue(variants[0]);
  const selected = unsized
    ? variants[0]
    : variants.find(v => variantValue(v) === item.bed_size) || null;

  const addon = product?.has_pillow_top_option ? Number(product.pillow_top_addon_price) || 0 : 0;
  const catalogPrice = selected
    ? Number(selected.price) + (item.pillow_top ? addon : 0)
    : null;
  const priceNum = Number(item.unit_price);
  const offCatalogPrice = catalogPrice != null && Number.isFinite(priceNum)
    && Math.round(priceNum) !== Math.round(catalogPrice);

  function pickProduct(nextName) {
    const next = products.find(p => p.name === nextName) || null;
    const nextVariants = next?.variants || [];
    const nextUnsized = nextVariants.length === 1 && !variantValue(nextVariants[0]);
    // Changing the product invalidates the old size and price together.
    onPatch({
      name: nextName,
      bed_size: nextUnsized ? null : '',
      pillow_top: false,
      unit_price: nextUnsized ? Number(nextVariants[0].price) : '',
    });
  }

  function pickSize(value) {
    const v = variants.find(x => variantValue(x) === value) || null;
    onPatch({
      bed_size: value,
      unit_price: v ? Number(v.price) + (item.pillow_top ? addon : 0) : '',
    });
  }

  function togglePillowTop(on) {
    onPatch({
      pillow_top: on,
      // Re-price off the catalog so the addon is applied exactly once,
      // rather than added to whatever is currently in the field.
      unit_price: selected ? Number(selected.price) + (on ? addon : 0) : item.unit_price,
    });
  }

  return (
    <div style={s.itemRowWrap}>
      <div style={s.itemRow}>
        <select
          style={{ ...s.input, flex: 3 }}
          value={offCatalog ? '__off__' : name}
          onChange={e => pickProduct(e.target.value)}
          disabled={loading || failed}
        >
          <option value="">{loading ? 'Loading…' : failed ? 'Catalog unavailable' : 'Select product'}</option>
          {products.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
          {offCatalog && <option value="__off__">{name} (not in catalog)</option>}
        </select>

        {unsized ? (
          <span style={{ ...s.input, flex: 2, ...s.inputStatic }}>—</span>
        ) : (
          <select
            style={{ ...s.input, flex: 2 }}
            value={item.bed_size || ''}
            onChange={e => pickSize(e.target.value)}
            disabled={!product}
          >
            <option value="">{!product ? '—' : 'Select size'}</option>
            {groups.map(([size, vars]) => (
              <optgroup key={size} label={size}>
                {vars.map(v => (
                  <option key={variantValue(v)} value={variantValue(v)}>
                    {formatDimension(variantValue(v))}
                  </option>
                ))}
              </optgroup>
            ))}
            {/* A size the current product no longer offers (legacy or
                discontinued data) stays selectable so editing another field
                never silently drops what the order actually recorded. */}
            {item.bed_size && !selected && (
              <option value={item.bed_size}>{formatDimension(item.bed_size)}</option>
            )}
          </select>
        )}

        <input
          style={{ ...s.input, flex: 1, textAlign: 'center' }}
          type="number" min="1" value={item.qty ?? 1}
          onChange={e => onField('qty', e.target.value)}
        />
        <input
          style={{ ...s.input, flex: 1.6, textAlign: 'right' }}
          type="number" min="0" value={item.unit_price ?? ''}
          onChange={e => onField('unit_price', e.target.value)}
        />
        <button style={s.removeBtn} onClick={onRemove}><Trash2 size={13} /></button>
      </div>

      {(product?.has_pillow_top_option && addon > 0) || offCatalogPrice ? (
        <div style={s.itemNoteRow}>
          {product?.has_pillow_top_option && addon > 0 && (
            <label style={s.pillowTopLabel}>
              <input
                type="checkbox"
                checked={!!item.pillow_top}
                onChange={e => togglePillowTop(e.target.checked)}
              />
              Pillow-top (+LKR {addon.toLocaleString()})
            </label>
          )}
          {offCatalogPrice && (
            <span style={s.priceNote}>
              Catalog: LKR {catalogPrice.toLocaleString()}{' '}
              <button style={s.resetLink} onClick={() => onField('unit_price', catalogPrice)}>reset</button>
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}

// Payment proof for an order's advances (migration 041).
//
// Shown only when the order actually has a ledger entry: attaching a slip to an
// order nobody has paid anything against would be meaningless, and an empty
// card on every order is noise.
function PaymentProofCard({ orderId, role }) {
  const [payments, setPayments] = useState([]);
  const [attachments, setAttachments] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useErrorPopup(error, 'Could not upload the payment proof');

  const canAttach = roleAllowed(role, ['admin', 'finance', 'sales_agent']);

  async function load() {
    try {
      const [p, a] = await Promise.all([
        apiFetch(`/api/orders/${orderId}/payments`).then(r => r.json()),
        apiFetch(`/api/orders/${orderId}/attachments`).then(r => r.json()),
      ]);
      setPayments(p.payments || []);
      setAttachments(a.attachments || []);
    } catch {
      /* leave the card empty rather than breaking the order screen */
    }
  }
  useEffect(() => { load(); }, [orderId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Downloads through apiFetch and opens the result as a blob URL. A plain
  // <a href> to /api/attachments/:id sent no Authorization header, so the
  // route answered 401 and the link was broken for every legitimate user —
  // the proof could be uploaded but never read back. Leaving the route open
  // to make the link work would have been the wrong fix: the file is payment
  // evidence.
  async function openProof(a) {
    setError('');
    try {
      const res = await apiFetch(`/api/attachments/${a.id}`);
      if (!res.ok) throw new Error('Could not open that file');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      // Revoked on a delay rather than immediately: the new tab needs the URL
      // to still resolve when it loads.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      setError(err.message);
    }
  }

  async function upload(paymentId, file) {
    if (!file) return;
    // Checked here as well as server-side so the staff member is told before a
    // 4MB upload travels and is rejected.
    if (file.size > 4 * 1024 * 1024) { setError('That file is larger than 4MB'); return; }
    setBusy(true); setError('');
    try {
      const data = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(new Error('Could not read the file'));
        fr.readAsDataURL(file);
      });
      const res = await apiFetch(`/api/orders/${orderId}/payments/${paymentId}/attachments`, {
        method: 'POST',
        body: JSON.stringify({ filename: file.name, mimeType: file.type, data }),
      });
      const json = await res.json();
      if (!json.success) setError(json.error || 'Upload failed');
      else await load();
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  }

  if (payments.length === 0) return null;

  return (
    <DetailCard title="Payments & proof">
      {payments.map(p => {
        const proofs = attachments.filter(a => a.payment_id === p.id);
        return (
          <div key={p.id} style={s.proofRow}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={s.proofAmount}>
                {Number(p.amount).toLocaleString('en', { minimumFractionDigits: 2 })}
                <span style={s.proofKind}>{p.kind}</span>
              </p>
              <p style={s.proofMeta}>
                {p.method}
                {p.paid_at && ` · ${new Date(p.paid_at).toLocaleDateString()}`}
                {p.recorded_by_name && ` · ${p.recorded_by_name}`}
              </p>
              {proofs.map(a => (
                <button key={a.id} type="button" style={s.proofLink} onClick={() => openProof(a)}>
                  <Receipt size={11} /> {a.filename}
                </button>
              ))}
            </div>
            {canAttach && (
              <label style={s.attachBtn}>
                {busy ? 'Uploading…' : proofs.length ? '+ Another' : '+ Attach proof'}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  style={{ display: 'none' }}
                  onChange={e => { upload(p.id, e.target.files?.[0]); e.target.value = ''; }}
                />
              </label>
            )}
          </div>
        );
      })}
    </DetailCard>
  );
}

function ControlBlock({ label, children }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
    <span style={{ fontSize: 10, fontWeight: 700, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
    {children}
  </div>;
}
function DetailCard({ title, children }) {
  return <div style={{ background: theme.bg, borderRadius: theme.radius, padding: '14px 16px', marginBottom: 10, border: `1px solid ${theme.border}` }}>
    <p style={{ fontSize: 11, fontWeight: 700, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>{title}</p>
    {children}
  </div>;
}
// Money formatter used by the payment breakdown, so every figure in that
// block reads the same way.
function fmt(n, currency) {
  return `${currency || 'LKR'} ${(Number(n) || 0).toLocaleString('en', { minimumFractionDigits: 2 })}`;
}

// A labelled money line. `tone` marks an amount that needs attention (an
// outstanding advance) or reassures (fully received); `strong` is the figure
// staff act on.
function MoneyRow({ label, value, tone, strong }) {
  const color = tone === 'warn' ? theme.high : tone === 'ok' ? theme.success : theme.ink;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0' }}>
      <span style={{ fontSize: 12.5, color: theme.inkFaint }}>{label}</span>
      <span style={{
        fontSize: strong ? 14 : 12.5,
        fontWeight: strong ? 800 : 600,
        color,
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      }}>{value}</span>
    </div>
  );
}

// Subtotal (free pillows at full worth) -> free pillows -> volume -> promo ->
// custom discount -> total, in the order they are applied — the same lines the invoice prints.
// While editing, `onVolumeApplied` turns the volume line into the "Apply
// volume discount" tick (migration 057).
function PriceBreakdown({ p, currency, onVolumeApplied, volumeApplied }) {
  const choice = p.volumeChoice || {};
  const tick = onVolumeApplied && choice.eligible > 0;
  return (
    <div style={s.payBox}>
      <MoneyRow label="Subtotal" value={fmt(p.gross, currency)} />
      {p.free > 0 && <MoneyRow label="Free pillows" value={`- ${fmt(p.free, currency)}`} tone="ok" />}
      {tick ? (
        <div style={{ display: 'flex', padding: '4px 0' }}>
          <VolumeDiscountToggle
            eligible={choice.eligible}
            mattressCount={choice.mattressCount}
            applied={volumeApplied}
            onChange={onVolumeApplied}
            labelStyle={{ fontSize: 12.5 }}
            valueStyle={{ fontSize: 12.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}
            prefix={`${currency || 'LKR'} `}
          />
        </div>
      ) : p.volume > 0 ? (
        <MoneyRow label="Volume discount" value={`- ${fmt(p.volume, currency)}`} tone="ok" />
      ) : choice.waived ? (
        <MoneyRow label="Volume discount" value="Not given" />
      ) : null}
      {p.promo && p.promo.amount > 0 && (
        <MoneyRow label={`Promo ${p.promo.code}`} value={`- ${fmt(p.promo.amount, currency)}`} tone="ok" />
      )}
      {p.custom && p.custom.amount > 0 && !p.custom.error && (
        <>
          <MoneyRow label="Custom discount" value={`- ${fmt(p.custom.amount, currency)}`} tone="ok" />
          {p.custom.reason && <p style={s.customReason}>{p.custom.reason}</p>}
        </>
      )}
      <MoneyRow label="Total" value={fmt(p.total, currency)} strong />
    </div>
  );
}

function InfoRow({ label, value }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: `1px solid ${theme.border}` }}>
    <span style={{ fontSize: 13, color: theme.inkFaint }}>{label}</span>
    <span style={{ fontSize: 13, color: theme.ink, fontWeight: 500, textAlign: 'right', maxWidth: '60%' }}>{value}</span>
  </div>;
}

const s = {
  backdrop: modalBackdrop,
  customReason: { margin: '-2px 0 6px', fontSize: 11.5, color: theme.inkSoft, fontStyle: 'italic', lineHeight: 1.4 },
  modal: { background: theme.surface, borderRadius: 16, width: '100%', maxWidth: 680, maxHeight: vh(90), display: 'flex', flexDirection: 'column', boxShadow: theme.shadowMd, overflow: 'hidden' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '16px 20px', borderBottom: `1px solid ${theme.border}`, flexShrink: 0 },
  headerOrderNum: { fontSize: 17, fontWeight: 700, color: theme.ink, margin: 0 },
  headerDate: { fontSize: 12, color: theme.inkFaint, margin: '2px 0 0' },
  headerActions: { display: 'flex', alignItems: 'center', gap: 8 },
  advLabel: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: theme.inkSoft, cursor: 'pointer', fontFamily: 'inherit' },
  payBox: { marginTop: 10, background: theme.bg, border: `1px solid ${theme.border}`, borderRadius: 10, padding: '10px 12px' },
  payHead: { margin: '0 0 6px', fontSize: 10.5, fontWeight: 800, letterSpacing: 0.4, textTransform: 'uppercase', color: theme.inkFaint },
  payWarn: { margin: '8px 0 0', paddingTop: 8, borderTop: `1px dashed ${theme.border}`, fontSize: 11.5, color: theme.high, lineHeight: 1.5 },
  editBtn: { display: 'flex', alignItems: 'center', gap: 5, background: theme.accentSoft, border: 'none', color: theme.accentInk, fontSize: 12, fontWeight: 700, padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
  invoiceBtn: { display: 'flex', alignItems: 'center', gap: 5, background: theme.successBg, border: 'none', color: theme.success, fontSize: 12, fontWeight: 700, padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
  deleteBtn: { display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: `1.5px solid ${theme.highBg}`, color: theme.high, fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
  closeBtn: { background: theme.borderSoft, border: 'none', cursor: 'pointer', width: 30, height: 30, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.inkSoft, flexShrink: 0 },
  proofRow: { display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0', borderBottom: `1px solid ${theme.borderSoft}` },
  proofAmount: { margin: 0, fontSize: 13, fontWeight: 700, color: theme.ink, display: 'flex', alignItems: 'center', gap: 7 },
  proofKind: { fontSize: 9.5, fontWeight: 800, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.05em' },
  proofMeta: { margin: '2px 0 0', fontSize: 11, color: theme.inkSoft, textTransform: 'capitalize' },
  proofLink: { display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 4, fontSize: 11, color: theme.accentInk, fontWeight: 600, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textDecoration: 'underline', fontFamily: 'inherit' },
  attachBtn: { flexShrink: 0, fontSize: 11, fontWeight: 700, color: theme.accentInk, background: theme.bg, border: `1.5px dashed ${theme.border}`, borderRadius: 7, padding: '5px 10px', cursor: 'pointer' },
  proofError: { margin: '8px 0 0', fontSize: 11.5, color: theme.high },
  cancelBtn: { background: theme.bg, border: `1px solid ${theme.border}`, color: theme.inkSoft, fontSize: 12.5, fontWeight: 600, padding: '7px 14px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
  saveBtn: { background: theme.accent, border: 'none', color: '#fff', fontSize: 12.5, fontWeight: 700, padding: '7px 16px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },

  body: { flex: 1, overflowY: 'auto', padding: 24 },
  controlRow: { display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' },
  select: { border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', outline: 'none', fontFamily: 'inherit' },
  totalAmt: { fontSize: 18, fontWeight: 800, color: theme.success, margin: 0 },

  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
  input: { background: theme.surface, border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '8px 10px', color: theme.ink, fontSize: 13, width: '100%', fontFamily: 'inherit', boxSizing: 'border-box' },
  textarea: { resize: 'vertical', minHeight: 60, lineHeight: 1.5 },

  itemHead: { display: 'flex', gap: 6, fontSize: 10, fontWeight: 700, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.04em', paddingBottom: 6, marginBottom: 6 },
  itemRow: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 },
  itemRowWrap: { marginBottom: 4 },
  // A product with no size to pick still needs to hold the column's width,
  // so the row's fields stay aligned with the header above them.
  inputStatic: { display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.inkFaint, background: theme.bg },
  itemNoteRow: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', margin: '0 0 8px 2px' },
  pillowTopLabel: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: theme.inkSoft, cursor: 'pointer' },
  priceNote: { fontSize: 11, color: theme.med },
  subLabel: { fontSize: 10, fontWeight: 700, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 6px' },
  promoChip: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, background: theme.surface, border: `1.5px solid ${theme.success}`, borderRadius: 8, padding: '8px 10px' },
  pillowTopTag: { display: 'block', fontSize: 10, color: theme.inkFaint, marginTop: 2 },
  resetLink: { background: 'none', border: 'none', padding: 0, color: theme.accentInk, fontSize: 11, fontWeight: 700, cursor: 'pointer', textDecoration: 'underline', fontFamily: 'inherit' },
  removeBtn: { background: 'none', border: 'none', color: theme.inkFaint, cursor: 'pointer', padding: 4, display: 'flex', flexShrink: 0 },
  addItemBtn: { display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: `1.5px dashed ${theme.border}`, color: theme.inkFaint, fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', marginTop: 4 },

  // One row, no wrapping: the delivery-method pills are a 4-item set and
  // 'Cash on Delivery' is far wider than the rest, so the default wrap
  // dropped it onto a second line. Pills shrink to fit instead, and each
  // label stays on a single line (see pill's whiteSpace).
  pills: { display: 'flex', gap: 6, flexWrap: 'nowrap' },
  pill: { background: theme.surface, border: `1.5px solid ${theme.border}`, color: theme.inkSoft, fontSize: 12, fontWeight: 600, padding: '6px 13px', borderRadius: 7, cursor: 'pointer', textTransform: 'capitalize', fontFamily: 'inherit', whiteSpace: 'nowrap', minWidth: 0, flexShrink: 1 },
  codBox: { marginTop: 10, padding: '10px 12px', borderRadius: 10, background: theme.successBg, border: `1.5px solid ${theme.success}` },
  codHead: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 800, letterSpacing: 0.4, textTransform: 'uppercase', color: theme.success },
  codAmount: { margin: '5px 0 0', fontSize: 18, fontWeight: 800, color: theme.ink },
  codNote: { margin: '3px 0 0', fontSize: 11.5, lineHeight: 1.5, color: theme.inkSoft },
  pillActive: { background: theme.accentSoft, border: `1.5px solid ${theme.accent}`, color: theme.accentInk },

  itemsTable: { width: '100%', borderCollapse: 'collapse' },
  th: { fontSize: 10, fontWeight: 700, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.04em', textAlign: 'left', padding: '6px 8px', borderBottom: `1px solid ${theme.border}` },
  td: { fontSize: 13, color: theme.ink, padding: '8px 8px', borderBottom: `1px solid ${theme.borderSoft}` },

  confirmModal: { background: theme.surface, borderRadius: 16, width: '100%', maxWidth: 440, boxShadow: theme.shadowMd, padding: 20 },
  modalTitle: { fontSize: 14.5, fontWeight: 700, color: theme.ink, margin: 0 },
  modalSub: { fontSize: 12.5, color: theme.inkSoft, margin: '4px 0 12px', lineHeight: 1.5 },
  modalNotice: { fontSize: 12, color: theme.med, background: theme.medBg, borderRadius: 8, padding: '8px 10px', marginBottom: 12, lineHeight: 1.5 },
  modalLabel: { fontSize: 11, fontWeight: 700, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 },
  modalTextarea: { width: '100%', border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', minHeight: 70, resize: 'vertical', background: theme.bg, color: theme.ink, boxSizing: 'border-box' },
  modalActions: { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 },
};
