import { useEffect, useRef, useState } from 'react';
import { X, Plus, Minus, Trash2, ShoppingBag, Check, Banknote, Store, Truck, Package, Hammer, CreditCard, Landmark, Globe, FileText } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { isFreeItem, paidSubtotal, grossSubtotal, freeValue, volumeDiscountChoice } from '../lib/orderItems';
import VolumeDiscountToggle from './VolumeDiscountToggle';
import FreeProductSection from './FreeProductSection';
import { theme, modalBackdrop } from '../lib/theme';
import PromoCodeField from './PromoCodeField';
import CustomDiscountField from './CustomDiscountField';
import { customDiscountState } from '../lib/customDiscount';
import { useAuth } from '../lib/AuthContext';
import { useErrorPopup } from './DialogProvider';
import {
  DELIVERY_METHODS, PAYMENT_METHODS, isCOD, labelFor, paymentLabelFor,
  needsDeliveryAddress, paymentMethodFor, codSummary,
} from '../lib/deliveryMethod';
import { vh } from '../lib/viewport';

// What each arrangement actually means for the agent at the counter. Kept next
// to the component rather than in lib/deliveryMethod.js because this wording is
// UI guidance for this screen, not part of the shared delivery vocabulary.
const DELIVERY_ICON = {
  pickup: Store,
  delivery: Truck,
  courier: Package,
  cash_on_delivery: Banknote,
};
const DELIVERY_HINT = {
  pickup: 'Collected in store — no address needed',
  delivery: 'We deliver — needs an address and date',
  courier: 'Sent by courier — needs an address',
  cash_on_delivery: 'We deliver and collect the cash on handover',
};
const PAYMENT_ICON = {
  cash: Banknote,
  bank_transfer: Landmark,
  card: CreditCard,
  online: Globe,
};

// A walk-in order placed by staff at the showroom — no prior WhatsApp
// conversation or lead required. Resolves (or creates) the customer by
// phone via POST /api/customers, then places the order the same way any
// other order-creation path does via POST /api/orders.
// Builds the opening cart when converting an enquiry.
//
// lead.items is the real multi-product list GET /api/leads already returns
// (lead_items, migration 031) and is what the Pipeline itself shows. Older
// leads predate that table and carry a single product in the legacy columns
// instead, so those are the fallback — otherwise converting one of them would
// open an empty cart and the agent would retype what the lead already knows.
function cartFromLead(lead) {
  if (!lead) return [];
  const rows = Array.isArray(lead.items) ? lead.items : [];
  const fromItems = rows
    .filter(r => r.product_type)
    .map(r => ({
      name: r.product_type,
      bed_size: r.bed_size || null,
      qty: Number(r.qty) || 1,
      // A lead records what the customer asked about, so the price may be
      // missing or unset; 0 lets the agent price it on the order screen
      // rather than blocking the conversion.
      unit_price: Number(r.unit_price) || 0,
      ...(r.pillow_top ? { pillow_top: true } : {}),
    }));
  if (fromItems.length > 0) return fromItems;

  if (!lead.product_type) return [];
  const price = Number(lead.unit_price);
  return [{
    name: lead.product_type,
    bed_size: lead.bed_size || null,
    qty: Number(lead.qty) || 1,
    // leads.unit_price is numeric and one live row holds PostgreSQL NaN, which
    // would otherwise reach the order as a real price.
    unit_price: Number.isFinite(price) && price > 0 ? price : 0,
  }];
}

// A saved quotation's lines as a cart (migration 054). Same shape as order
// items; `category` is filled in once the catalog loads (see the products
// effect), since stored lines do not carry it.
function cartFromQuotation(q) {
  return (Array.isArray(q?.items) ? q.items : []).map(it => ({
    name: it.name,
    bed_size: it.bed_size || null,
    qty: Number(it.qty) || 1,
    unit_price: Number(it.unit_price) || 0,
    ...(it.pillow_top ? { pillow_top: true } : {}),
    ...(it.free ? { free: true } : {}),
  }));
}

// `mode="quotation"` (migration 054) turns this same screen into the
// quotation builder — same customer lookup, catalog cart, free items, volume
// and custom discount — minus everything that only means something once goods
// are sold: delivery method, payment, advance, promo code and the WhatsApp
// confirmation. `quotation` edits a saved one in place (its customer is then
// fixed); `recreateFrom` starts a NEW quotation prefilled from an old one.
//
// `lead` is optional: given one, this same screen becomes the convert-to-order
// flow with everything the enquiry already knows filled in. Deliberately the
// SAME component rather than a copy, so the walk-in and convert paths cannot
// drift apart — a change to the cart, the free-pillow section or the delivery
// options lands on both at once.
export default function ShowroomOrderModal({ onClose, onSaved, lead = null, mode = 'order', quotation = null, recreateFrom = null }) {
  const isQuote = mode === 'quotation';
  const quoteSrc = isQuote ? quotation || recreateFrom : null;
  const quoteCustomer = quoteSrc
    ? { id: quoteSrc.customer_id, whatsapp_number: quoteSrc.customer_phone, name: quoteSrc.customer_name }
    : null;
  const [phone, setPhone] = useState(quoteSrc?.customer_phone || lead?.customers?.whatsapp_number || '');
  const [name, setName] = useState(quoteSrc?.customer_name || lead?.customers?.name || '');
  // A converted enquiry already belongs to a customer, so the lookup is
  // pre-resolved and the customer fields are locked below. So does a
  // quotation being edited or recreated (a recreate may still change it).
  const [matchedCustomer, setMatchedCustomer] = useState(quoteCustomer || lead?.customers || null);
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [activeSearchField, setActiveSearchField] = useState(null); // 'phone' | 'name'
  const searchTimer = useRef(null);

  const [products, setProducts] = useState([]);
  const [productsLoading, setProductsLoading] = useState(true);
  const [items, setItems] = useState(() => (quoteSrc ? cartFromQuotation(quoteSrc) : cartFromLead(lead)));
  const [customOpen, setCustomOpen] = useState(false);
  const [customItem, setCustomItem] = useState({ name: '', bed_size: '', qty: 1, unit_price: '' });

  const [deliveryMethod, setDeliveryMethod] = useState('pickup');
  const [deliveryAddress, setDeliveryAddress] = useState(quoteSrc?.delivery_address || lead?.delivery_address || '');
  const [deliveryDate, setDeliveryDate] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [isCustomOrder, setIsCustomOrder] = useState(false);
  const [advanceRequired, setAdvanceRequired] = useState('');
  // Additional contact number, required on every order (migration 040). When
  // converting, the enquiry's customer may already have a separate contact
  // number recorded — offer it rather than making the agent retype it.
  const [secondaryPhone, setSecondaryPhone] = useState(
    quoteSrc?.secondary_phone || lead?.customers?.contact_whatsapp_number || ''
  );
  // Editing keeps the quotation's notes (including its custom-discount trail);
  // a recreate starts clean — its own trail is written when it is saved.
  const [notes, setNotes] = useState(isQuote && quotation ? quotation.notes || '' : '');
  // Automated WhatsApp order confirmation (POST /api/orders sends it
  // server-side). On by default; staff can skip it when the customer is at
  // the counter with a printed receipt or gave an unreachable number.
  const [sendConfirmation, setSendConfirmation] = useState(true);
  const [promo, setPromo] = useState(null);
  // The "Apply volume discount" tick (migration 057). A saved or recreated
  // quotation keeps the choice it was made with.
  const [volumeApplied, setVolumeApplied] = useState(!quoteSrc?.volume_discount_waived);
  // What is typed in the promo field, valid or not (quotation mode only
  // uses it: a typed-but-invalid code blocks saving rather than vanishing).
  const [promoTyped, setPromoTyped] = useState(quoteSrc?.promo_code || '');
  // Custom discount (migration 053), as typed: { amount, reason }.
  const [customInput, setCustomInput] = useState(() =>
    Number(quoteSrc?.custom_discount) > 0
      ? { amount: String(Number(quoteSrc.custom_discount)), reason: quoteSrc.custom_discount_reason || '' }
      : { amount: '', reason: '' }
  );
  const { staff } = useAuth();

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  useErrorPopup(error, isQuote ? 'Could not save the quotation' : 'Could not place the order');

  useEffect(() => {
    apiFetch('/api/products').then(r => r.json()).then(d => {
      setProducts((d.products || []).filter(p => p.active));
      // Lines opened from a lead or a saved quotation carry no category, and
      // the volume discount counts mattresses BY category — so without this a
      // two-mattress cart opened that way silently lost its discount. Looked
      // up by name (like every other order-item-to-product link), across
      // inactive products too so a retired mattress still counts.
      const byName = new Map((d.products || []).map(p => [String(p.name).toLowerCase(), p.category]));
      setItems(prev => prev.map(it => (
        it.category !== undefined ? it : { ...it, category: byName.get(String(it.name || '').toLowerCase()) ?? null }
      )));
    }).catch(() => {}).finally(() => setProductsLoading(false));
  }, []);

  // Live customer lookup — fires from whichever of Phone/Name the user is
  // actively typing in (activeSearchField), matching the same GET
  // /api/customers?search= used for both name and phone (ILIKE on either
  // column server-side).
  useEffect(() => {
    clearTimeout(searchTimer.current);
    const term = activeSearchField === 'name' ? name : activeSearchField === 'phone' ? phone : '';
    if (term.trim().length < 2) { setSearchResults([]); return; }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await apiFetch(`/api/customers?search=${encodeURIComponent(term.trim())}`);
        const data = await res.json();
        setSearchResults(data.customers || []);
      } catch { /* ignore */ }
      setSearching(false);
    }, 350);
    return () => clearTimeout(searchTimer.current);
  }, [phone, name, activeSearchField]);

  function pickMatch(customer) {
    setMatchedCustomer(customer);
    setPhone(customer.whatsapp_number);
    setName(customer.name || '');
    setSearchResults([]);
    setActiveSearchField(null);
  }

  function onPhoneChange(v) {
    setPhone(v);
    if (matchedCustomer && v !== matchedCustomer.whatsapp_number) setMatchedCustomer(null);
  }

  function onNameChange(v) {
    setName(v);
    if (matchedCustomer && v !== (matchedCustomer.name || '')) setMatchedCustomer(null);
  }

  function addItem(item) {
    setItems(prev => {
      const idx = prev.findIndex(it => it.name === item.name && it.bed_size === item.bed_size && it.pillow_top === item.pillow_top);
      if (idx >= 0) return prev.map((it, i) => i === idx ? { ...it, qty: it.qty + 1 } : it);
      return [...prev, { ...item, qty: 1 }];
    });
  }
  function updateQty(idx, delta) {
    setItems(prev => prev.map((it, i) => i === idx ? { ...it, qty: Math.max(1, it.qty + delta) } : it));
  }
  function removeItem(idx) { setItems(prev => prev.filter((_, i) => i !== idx)); }

  function addCustomItem() {
    if (!customItem.name.trim()) return;
    setItems(prev => [...prev, {
      name: customItem.name.trim(),
      // Free text, unlike a catalog pick: an off-catalog item has no variant to
      // choose a dimension from, and the size may be a bespoke measurement the
      // catalog does not carry. Empty stays null so the cart and the invoice
      // print nothing rather than an empty separator.
      bed_size: customItem.bed_size.trim() || null,
      category: null,
      qty: parseInt(customItem.qty) || 1, unit_price: parseFloat(customItem.unit_price) || 0,
    }]);
    setCustomItem({ name: '', bed_size: '', qty: 1, unit_price: '' });
    setCustomOpen(false);
  }

  // Free pillows are worth their price but cost nothing: they are shown in the
  // Subtotal at full worth, then deducted again (lib/orderItems.js). The
  // discounts below apply to what is actually charged — the paid lines.
  const grossTotal = grossSubtotal(items);
  const freeTotal = freeValue(items);
  const subtotal = paidSubtotal(items);
  // Volume discount (real, confirmed price list): flat LKR off the whole
  // order once 2 or more mattresses are in the cart. No published rate past
  // 3, so 3+ uses the 3-mattress rate rather than guessing a higher one.
  // Only PAID mattresses earn the volume discount. The Free Pillows section
  // cannot add a mattress, so this is defensive rather than reachable from this
  // screen — it protects the total against a free mattress arriving on an order
  // some other way (the API directly, or an imported row).
  const mattressCount = items.reduce(
    (sum, it) => sum + (it.category === 'mattress' && !isFreeItem(it) ? it.qty : 0), 0
  );
  const volume = volumeDiscountChoice(mattressCount, volumeApplied);
  const volumeDiscount = volume.amount;
  const afterVolumeDiscount = Math.max(0, subtotal - volumeDiscount);
  const promoDiscount = promo ? Number(promo.previewDiscount) || 0 : 0;
  const afterPromo = Math.max(0, afterVolumeDiscount - promoDiscount);
  // Applied last, so the promo code still validates against the after-volume
  // figure exactly as before.
  const custom = customDiscountState(customInput.amount, customInput.reason, afterPromo);
  const total = Math.max(0, afterPromo - custom.amount);
  const cod = isCOD(deliveryMethod);
  const advance = Math.max(0, parseFloat(advanceRequired) || 0);
  // What the driver collects is the total LESS the advance, not the total.
  const codCollect = Math.max(0, total - advance);
  // A second contact number is required for every order, so the button stays
  // disabled without one. The server enforces the same rule, so this is a
  // courtesy that explains the requirement rather than the only guard.
  // Customer identity is required to place an order: the name and phone are
  // what the order is delivered and invoiced against, and both are written back
  // to the customers row (POST /api/customers find-or-creates by phone and
  // backfills a missing name). Converting an enquiry the customer is already
  // known, but an enquiry often has no NAME yet — the counter is where it is
  // learned — so the same rule applies either way.
  const canSubmit =
    phone.trim().length > 0 &&
    name.trim().length > 0 &&
    // Optional on a quotation: nothing is being delivered yet.
    (isQuote || secondaryPhone.trim().length > 0) &&
    items.length > 0 &&
    !custom.error &&
    // A quotation prints the code, so it must be the checked one — never
    // save while a typed code is still being checked or was refused.
    (!isQuote || !promoTyped.trim() || !!promo) &&
    !saving;

  // Quotation mode (migration 054). The customer is resolved exactly as for an
  // order — POST /api/customers find-or-creates by phone — so a number that
  // matches an existing customer files the quotation under them. Editing
  // keeps the customer the quotation was made for.
  async function submitQuotation() {
    setSaving(true); setError(null);
    try {
      let customerId = quotation?.customer_id;
      if (!quotation) {
        const custRes = await apiFetch('/api/customers', {
          method: 'POST',
          body: JSON.stringify({ phone: phone.trim(), name: name.trim() }),
        });
        const custData = await custRes.json();
        if (!custData.success) { setError(custData.error || 'Could not resolve customer'); setSaving(false); return; }
        customerId = custData.customer.id;
      }
      const res = await apiFetch(quotation ? `/api/quotations/${quotation.id}` : '/api/quotations', {
        method: quotation ? 'PATCH' : 'POST',
        body: JSON.stringify({
          customerId,
          customerName: name.trim(),
          secondaryPhone: secondaryPhone.trim() || null,
          deliveryAddress: deliveryAddress.trim() || null,
          items: items.map(({ name, bed_size, pillow_top, qty, unit_price, free }) => ({
            name, bed_size, qty, unit_price,
            ...(pillow_top ? { pillow_top: true } : {}),
            ...(free ? { free: true } : {}),
          })),
          volumeDiscount: volumeDiscount || null,
          volumeDiscountWaived: volume.waived,
          // Shown on the quotation, never redeemed (migration 055): the server
          // re-checks the code and recomputes its discount itself.
          promoCode: promo ? promo.code : null,
          customDiscount: custom.amount || null,
          customDiscountReason: custom.amount ? custom.reason : null,
          notes: notes.trim() || null,
          ...(recreateFrom && !quotation ? { recreatedFromId: recreateFrom.id } : {}),
        }),
      });
      const data = await res.json();
      if (!data.success) { setError(data.error || 'Failed to save the quotation'); setSaving(false); return; }
      onSaved?.(data.quotation);
      onClose();
    } catch (err) {
      setError('Network error: ' + err.message);
      setSaving(false);
    }
  }

  async function submit() {
    if (!canSubmit) return;
    if (isQuote) return submitQuotation();
    setSaving(true); setError(null);
    try {
      const custRes = await apiFetch('/api/customers', {
        method: 'POST',
        body: JSON.stringify({ phone: phone.trim(), name: name.trim() }),
      });
      const custData = await custRes.json();
      if (!custData.success) { setError(custData.error || 'Could not resolve customer'); setSaving(false); return; }

      const orderRes = await apiFetch('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          customerId: custData.customer.id,
          // Converting: links the order to the enquiry AND closes that
          // enquiry server-side, which is what takes it off the Pipeline.
          ...(lead ? { leadId: lead.id } : {}),
          customerName: name.trim() || null,
          customerPhone: phone.trim(),
          secondaryPhone: secondaryPhone.trim(),
          items: items.map(({ name, bed_size, pillow_top, qty, unit_price, free }) => ({
            name, bed_size, qty, unit_price,
            ...(pillow_top ? { pillow_top: true } : {}),
            // Carried through explicitly: this mapping picks keys rather than
            // spreading, so a giveaway would silently become a charged line.
            ...(free ? { free: true } : {}),
          })),
          totalAmount: total,
          // The discounts that made `total` lower than the line items
          // (migration 046). Sent as real fields, not just prose in `notes`:
          // the invoice needs to print the saving the customer was given and
          // still land on this same total. Before these were stored, the PDF
          // could only sum the gross items and so overstated the bill.
          promoCode: promo ? promo.code : null,
          promoDiscount: promoDiscount || null,
          volumeDiscount: volumeDiscount || null,
          volumeDiscountWaived: volume.waived,
          // The server stamps who gave it, writes it into the internal notes
          // and notifies the admins — so it is not added to `notes` here.
          customDiscount: custom.amount || null,
          customDiscountReason: custom.amount ? custom.reason : null,
          currency: 'LKR',
          deliveryAddress: needsDeliveryAddress(deliveryMethod) ? (deliveryAddress || null) : null,
          deliveryDate: deliveryDate || null,
          deliveryMethod,
          // COD pins payment to cash — the DB enforces the same pairing
          paymentMethod: paymentMethodFor(deliveryMethod, paymentMethod),
          isCustomOrder,
          // An advance is allowed on any order (migration 034) — a customer
          // may pay part now and the balance cash on delivery. A blank field
          // means no advance, not zero.
          advanceRequired: advance > 0 ? advance : null,
          sendConfirmation,
          notes: [
            notes,
            volumeDiscount > 0 ? `Volume discount applied: -LKR ${volumeDiscount.toLocaleString()} (${mattressCount} mattresses)` : null,
            volume.waived ? `Volume discount not given (${mattressCount} mattresses, would have been -LKR ${volume.eligible.toLocaleString()})` : null,
            promo ? `Promo code ${promo.code} applied: -LKR ${promoDiscount.toLocaleString()}` : null,
          ].filter(Boolean).join(' | ') || null,
        }),
      });
      const orderData = await orderRes.json();
      if (!orderData.success) { setError(orderData.error || 'Failed to place order'); setSaving(false); return; }

      // Redeem for real only now that the order exists and the total is
      // final — validate above was read-only. Best-effort: an order that's
      // already been created should not be undone by a redemption race lost
      // to someone else redeeming the same code in the seconds in between.
      if (promo) {
        try {
          const redeemRes = await apiFetch('/api/promo-codes/redeem', {
            method: 'POST',
            body: JSON.stringify({ code: promo.code, phone: phone.trim(), orderTotal: promo.eligibleSubtotal ?? afterVolumeDiscount, items }),
          });
          const redeemData = await redeemRes.json();
          if (redeemData.success) {
            await apiFetch(`/api/promo-codes/redemptions/${redeemData.redemptionId}`, {
              method: 'PATCH',
              body: JSON.stringify({ orderId: orderData.order.id }),
            });
          }
        } catch (promoErr) {
          console.warn('Promo redemption failed (order still placed):', promoErr.message);
        }
      }

      onSaved?.(orderData.order, orderData.confirmation);
      onClose();
    } catch (err) {
      setError('Network error: ' + err.message);
      setSaving(false);
    }
  }

  return (
    <div className="responsive-modal-backdrop" style={s.backdrop} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="responsive-modal" style={s.modal}>
        <div style={s.header}>
          <div style={s.headerLeft}>
            <div style={s.headerIcon}>
              {isQuote ? <FileText size={17} color={theme.accentInk} /> : <ShoppingBag size={17} color={theme.accentInk} />}
            </div>
            <div>
              <p style={s.headerTitle}>
                {isQuote
                  ? quotation ? `Edit Quotation ${quotation.quotation_no}`
                    : recreateFrom ? `Recreate ${recreateFrom.quotation_no}` : 'New Quotation'
                  : lead ? 'Convert Enquiry to Order' : 'New Showroom Order'}
              </p>
              <p style={s.headerSub}>
                {isQuote
                  ? quotation ? 'Saved under the same quotation number'
                    : recreateFrom ? 'A new quotation number, prefilled from the original'
                    : 'Filed under the customer this phone number belongs to'
                  : lead
                    ? 'Prefilled from the enquiry — the enquiry closes when this order is placed'
                    : 'For a walk-in customer — no WhatsApp chat needed'}
              </p>
            </div>
          </div>
          <button style={s.closeBtn} onClick={onClose}><X size={16} /></button>
        </div>

        {/* Two columns: the form scrolls on the left, the cart stays put on
            the right so the running order and total never scroll away. */}
        <div style={s.split} className="confirm-order-split">
        <div style={s.body}>
          {/* Converting: the customer is already known from the enquiry, so the
              lookup is replaced by a read-only summary. Letting it be edited
              here would let the agent point the order at a different customer
              than the enquiry it is closing. Name stays editable, since an
              enquiry often has no name yet and the counter is where it is
              learned. No "from enquiry" badge here: the modal title already
              says this is a conversion, so it only repeated the heading. */}
          {lead || (isQuote && quotation) ? (
            <Section title="Customer">
              <div style={s.lockedCust} className="locked-cust">
                <div style={s.lockedAvatar}>{(name || phone || '?').charAt(0).toUpperCase()}</div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  {/* The enquiry usually has the number but not the name, and
                      an order needs one — so this stays editable and required,
                      and the placeholder says so rather than looking optional. */}
                  <input
                    style={{
                      ...s.lockedNameInput,
                      ...(name.trim() ? {} : { color: theme.high }),
                    }}
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="Customer name *"
                  />
                  <p style={s.lockedPhone}>{phone || 'No phone on the enquiry'}</p>
                  {isQuote && quotation && (
                    <p style={s.lockedHint}>To quote a different customer, use Recreate instead</p>
                  )}
                </div>
                {/* Inside the same card rather than a separate field below it:
                    it is one more contact detail for this customer, and a
                    stacked Field with its own label and hint cost three extra
                    rows for a single short input. */}
                <div style={s.lockedExtra}>
                  <label style={s.lockedExtraLabel}>{isQuote ? 'Additional number' : 'Additional number *'}</label>
                  <input
                    style={{
                      ...s.lockedExtraInput,
                      ...(secondaryPhone.trim() || isQuote ? {} : s.inputRequired),
                    }}
                    value={secondaryPhone}
                    onChange={e => setSecondaryPhone(e.target.value)}
                    placeholder="Backup contact"
                    title="Someone to call about this delivery if the main number does not answer"
                  />
                </div>
              </div>
            </Section>
          ) : (
          <Section title="Customer">
            {/* One row of three: phone, name, additional number. The third
                field used to sit full-width underneath with its own two-line
                hint, which cost three extra rows of height and broke the grid.
                Its guidance now lives in the placeholder and a title tooltip. */}
            <div className="responsive-row2" style={s.row3}>
              <Field label="Phone number *">
                <div style={{ position: 'relative' }}>
                  <input
                    style={{ ...s.input, ...(phone.trim() ? {} : s.inputRequired) }} value={phone}
                    onChange={e => onPhoneChange(e.target.value)}
                    onFocus={() => setActiveSearchField('phone')}
                    // Our own customer-match dropdown is the lookup here; the
                    // browser's saved-values list would cover it, and saving
                    // the number is what later filled it into search boxes.
                    autoComplete="off"
                    name="customer-phone-lookup"
                    data-1p-ignore="true"
                    data-lpignore="true"
                    data-bwignore="true"
                    placeholder="Phone Number" autoFocus
                  />
                  {matchedCustomer && <span style={s.matchTag}><Check size={11} /> Existing</span>}
                  {activeSearchField === 'phone' && searchResults.length > 0 && (
                    <div style={s.dropdown}>
                      {searching && <div style={s.dropdownHint}>Searching...</div>}
                      {searchResults.map(c => (
                        <button key={c.id} style={s.dropdownItem} onClick={() => pickMatch(c)}>
                          <span style={{ fontWeight: 600 }}>{c.name || c.whatsapp_number}</span>
                          <span style={{ color: theme.inkFaint, fontSize: 11.5 }}>{c.whatsapp_number}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </Field>
              <Field label="Name *">
                <div style={{ position: 'relative' }}>
                  <input
                    style={{ ...s.input, ...(name.trim() ? {} : s.inputRequired) }} value={name}
                    onChange={e => onNameChange(e.target.value)}
                    onFocus={() => setActiveSearchField('name')}
                    autoComplete="off"
                    name="customer-name-lookup"
                    data-1p-ignore="true"
                    data-lpignore="true"
                    data-bwignore="true"
                    placeholder="Customer name"
                  />
                  {activeSearchField === 'name' && searchResults.length > 0 && (
                    <div style={s.dropdown}>
                      {searching && <div style={s.dropdownHint}>Searching...</div>}
                      {searchResults.map(c => (
                        <button key={c.id} style={s.dropdownItem} onClick={() => pickMatch(c)}>
                          <span style={{ fontWeight: 600 }}>{c.name || c.whatsapp_number}</span>
                          <span style={{ color: theme.inkFaint, fontSize: 11.5 }}>{c.whatsapp_number}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </Field>
              {/* Required, so the label is marked and an unfilled box keeps a
                  red edge — the Place Order button also stays disabled. */}
              <Field label={isQuote ? 'Additional number' : 'Additional number *'}>
                <input
                  style={{
                    ...s.input,
                    ...(secondaryPhone.trim() || isQuote ? {} : s.inputRequired),
                  }}
                  value={secondaryPhone}
                  onChange={e => setSecondaryPhone(e.target.value)}
                  placeholder="Backup contact"
                  title="Someone to call about this delivery if the main number does not answer"
                />
              </Field>
            </div>
          </Section>
          )}

          <Section title="Products">
            {productsLoading ? (
              <p style={{ fontSize: 12.5, color: theme.inkFaint }}>Loading catalog...</p>
            ) : (
              <div className="responsive-product-grid" style={s.productGrid}>
                {products.map(p => (
                  <ProductCard key={p.id} product={p} onAdd={addItem} />
                ))}
              </div>
            )}

            {customOpen ? (
              <div style={s.customRow}>
                <input style={{ ...s.input, flex: 2.4 }} placeholder="Custom item name" value={customItem.name} onChange={e => setCustomItem(c => ({ ...c, name: e.target.value }))} autoFocus />
                <input style={{ ...s.input, flex: 1.2 }} placeholder="Size" title="Size or dimension, e.g. 72x36 — leave empty if it has none" value={customItem.bed_size} onChange={e => setCustomItem(c => ({ ...c, bed_size: e.target.value }))} />
                <input style={{ ...s.input, flex: 0.8, textAlign: 'center' }} type="number" min="1" title="Quantity" value={customItem.qty} onChange={e => setCustomItem(c => ({ ...c, qty: e.target.value }))} />
                <input style={{ ...s.input, flex: 1.5, textAlign: 'right' }} type="number" min="0" placeholder="Price" value={customItem.unit_price} onChange={e => setCustomItem(c => ({ ...c, unit_price: e.target.value }))} />
                <button style={s.addItemBtn} onClick={addCustomItem}>Add</button>
                <button style={s.removeBtn} onClick={() => setCustomOpen(false)}><X size={13} /></button>
              </div>
            ) : (
              <button style={s.addCustomBtn} onClick={() => setCustomOpen(true)}><Plus size={13} /> Add custom item (not in catalog)</button>
            )}
          </Section>

          {/* Free products sit in the left column directly under Products: a
              giveaway is picked from the same catalog, so the two choices
              belong together. The cart on the right stays a summary of what
              the order contains rather than a second place to edit it. */}
          {/* No <Section> wrapper: FreeProductSection draws its own header
              (gift icon, and the running total given away), so wrapping it
              would print the title twice. */}
          <div style={{ marginBottom: 20 }}>
            <FreeProductSection products={products} items={items} onChange={setItems} />
          </div>

          {/* Cash on Delivery is one arrangement spanning both delivery and
              payment, so when it's picked these two sections read as one:
              the Payment method selector is replaced by a fixed COD summary
              stating the exact amount the driver collects. */}
          {isQuote ? (
            <Section title="Delivery">
              <Field label="Delivery address (printed on the quotation)">
                <input
                  style={s.input}
                  value={deliveryAddress}
                  onChange={e => setDeliveryAddress(e.target.value)}
                  placeholder="Street, city — optional"
                />
              </Field>
            </Section>
          ) : (
          <Section title={cod ? 'Delivery & Payment' : 'Delivery'}>
            {/* Option CARDS rather than bare pills. Four one-word pills made
                the agent recall what each arrangement implies — in particular
                that Cash on Delivery decides the payment method and that
                Pickup means no address. Each card now states its own
                consequence, so the choice is read rather than remembered, and
                the selected one is unmistakable at a glance across a counter. */}
            <div style={s.fieldBlock}>
              <Field label="How is the customer getting it?">
                <div style={s.methodGrid}>
                  {DELIVERY_METHODS.map(m => {
                    const on = deliveryMethod === m;
                    const Icon = DELIVERY_ICON[m] || Package;
                    return (
                      <button
                        key={m}
                        type="button"
                        style={{ ...s.methodCard, ...(on ? s.methodCardOn : {}) }}
                        onClick={() => setDeliveryMethod(m)}
                        aria-pressed={on}
                      >
                        <Icon size={15} color={on ? theme.accentInk : theme.inkFaint} />
                        <span style={{ ...s.methodName, ...(on ? { color: theme.accentInk } : {}) }}>
                          {labelFor(m)}
                        </span>
                        <span style={s.methodHint}>{DELIVERY_HINT[m]}</span>
                      </button>
                    );
                  })}
                </div>
              </Field>
            </div>
            {/* Date and address share a row instead of stacking: the date is a
                narrow control and left a half-empty line of its own. Both are
                hidden for pickup, where neither applies. */}
            {needsDeliveryAddress(deliveryMethod) && (
              <div style={s.dateAddrRow} className="responsive-row2">
                <Field label="Expected date">
                  <input style={s.input} type="date" value={deliveryDate} onChange={e => setDeliveryDate(e.target.value)} />
                </Field>
                <Field label="Delivery address">
                  <input
                    style={s.input}
                    value={deliveryAddress}
                    onChange={e => setDeliveryAddress(e.target.value)}
                    placeholder="Street, city"
                  />
                </Field>
              </div>
            )}
            {/* Advance and made-to-order on ONE row. Both previously carried a
                permanent hint line explaining themselves, which cost four rows
                for two controls — the explanations are now tooltips, and the
                space is used for the thing that actually changes as you type:
                the balance left after the advance. */}
            <div style={s.advRow} className="responsive-row2">
              <Field label="Advance received now">
                <div style={s.moneyWrap}>
                  <span style={s.moneyPrefix}>LKR</span>
                  <input
                    style={s.moneyInput}
                    type="number"
                    min="0"
                    step="0.01"
                    value={advanceRequired}
                    onChange={e => setAdvanceRequired(e.target.value)}
                    placeholder="0.00"
                    title="Leave empty if nothing is paid today"
                  />
                </div>
              </Field>
              <label
                style={{ ...s.customChip, ...(isCustomOrder ? s.customChipOn : {}) }}
                title="Built for this customer — normally needs an advance"
              >
                <input
                  type="checkbox"
                  checked={isCustomOrder}
                  onChange={e => setIsCustomOrder(e.target.checked)}
                />
                <Hammer size={13} color={isCustomOrder ? theme.accentInk : theme.inkFaint} />
                <span style={{ ...s.customChipText, ...(isCustomOrder ? { color: theme.accentInk } : {}) }}>
                  Made-to-order
                </span>
              </label>
            </div>
            {/* Only once there is a figure to react to — an empty row of
                placeholder text would just be noise. */}
            {advance > 0 && (
              <p style={s.advBalance}>
                Balance after advance:{' '}
                <strong>LKR {Math.max(0, total - advance).toLocaleString('en', { minimumFractionDigits: 2 })}</strong>
              </p>
            )}
            {cod && (
              <div style={s.codBox}>
                <div style={s.codHead}>
                  <Banknote size={14} color={theme.success} />
                  <span>Cash on Delivery</span>
                </div>
                <p style={s.codAmount}>LKR {codCollect.toLocaleString('en', { minimumFractionDigits: 2 })}</p>
                <p style={s.codNote}>
                  {advance > 0
                    ? `Advance of LKR ${advance.toLocaleString('en', { minimumFractionDigits: 2 })} is taken now — the driver collects the balance shown above, not the full order total.`
                    : codSummary(total)}
                  {' '}Payment method is set to cash and payment status stays Pending until the delivery is confirmed.
                </p>
              </div>
            )}
          </Section>
          )}

          {/* Hidden under COD, where the method is necessarily cash and the
              panel above already says so — offering a choice that cannot be
              changed would be a lie. */}
          {!cod && !isQuote && (
            <Section title="Payment">
              <div style={s.methodGrid}>
                {PAYMENT_METHODS.map(m => {
                  const on = paymentMethod === m;
                  const Icon = PAYMENT_ICON[m] || Banknote;
                  return (
                    <button
                      key={m}
                      type="button"
                      style={{ ...s.methodCard, ...(on ? s.methodCardOn : {}) }}
                      onClick={() => setPaymentMethod(m)}
                      aria-pressed={on}
                    >
                      <Icon size={15} color={on ? theme.accentInk : theme.inkFaint} />
                      <span style={{ ...s.methodName, ...(on ? { color: theme.accentInk } : {}) }}>
                        {paymentLabelFor(m)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </Section>
          )}

          <Section title="Notes">
            <textarea style={{ ...s.input, ...s.textarea }} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Internal notes (optional)" />
          </Section>

          {!isQuote && (
          <Section title="Customer Confirmation">
            <label style={s.confirmRow}>
              <input type="checkbox" checked={sendConfirmation}
                onChange={e => setSendConfirmation(e.target.checked)} />
              <span>
                <span style={s.confirmLabel}>Send order confirmation on WhatsApp</span>
                <span style={s.confirmHint}>
                  {phone.trim()
                    ? `Asks ${phone.trim()} to verify the name, items, total, payment method and delivery address.`
                    : 'Asks the customer to verify the name, items, total, payment method and delivery address.'}
                </span>
              </span>
            </label>
          </Section>
          )}
        </div>

        {/* Quotation mode: the promo code AND custom discount are both open
            below the list, and together they left the item list — the only
            part allowed to shrink — at zero height. So here the list keeps its
            natural height and the whole panel scrolls instead. */}
        <aside style={isQuote ? { ...s.cart, ...s.cartScroll } : s.cart}>
          <p style={s.cartHead}>{isQuote ? 'Quotation Items' : 'Order Items'} ({items.length})</p>

          {/* Only the item LIST scrolls — a walk-in order can hold many
              products — while the promo field and totals below stay put. */}
          <div style={isQuote ? { ...s.cartList, ...s.cartListNatural } : s.cartList} className="cart-list">
            {items.length === 0 ? (
              <div style={s.cartEmpty}>
                <ShoppingBag size={22} color={theme.inkFaint} />
                <p style={s.cartEmptyText}>Tap a product to add it here</p>
              </div>
            ) : items.map((it, i) => (
              <div key={i} style={s.cartItem}>
                <div style={s.cartItemTop}>
                  <span style={s.cartItemName}>
                    {isFreeItem(it) && <span style={s.freeTag}>FREE</span>}
                    {it.name}
                  </span>
                  <button style={s.removeBtn} onClick={() => removeItem(i)} title="Remove"><Trash2 size={13} /></button>
                </div>
                <p style={s.cartItemMeta}>{[it.bed_size, it.pillow_top && 'Pillow-top'].filter(Boolean).join(' · ') || '—'}</p>
                <div style={s.cartItemBottom}>
                  <div style={s.qtyStepper}>
                    <button style={s.qtyBtn} onClick={() => updateQty(i, -1)}><Minus size={12} /></button>
                    <span style={s.qtyVal}>{it.qty}</span>
                    <button style={s.qtyBtn} onClick={() => updateQty(i, 1)}><Plus size={12} /></button>
                  </div>
                  <span style={s.cartItemLine}>{(Math.abs(it.unit_price) * it.qty).toLocaleString('en', { minimumFractionDigits: 2 })}</span>
                </div>
              </div>
            ))}
          </div>

          {/* On a quotation the code is SHOWN, not redeemed (migration 055):
              redeeming uses up the customer's one go at it, which belongs to
              placing the order. Its end date and any limit on uses are
              printed on the quotation. */}
          <div style={s.cartPromo}>
            <label style={s.cartPromoLabel}>Promo Code</label>
            <PromoCodeField
              phone={phone}
              orderTotal={afterVolumeDiscount}
              items={items}
              onValidated={setPromo}
              initialCode={quoteSrc?.promo_code || ''}
              onCodeChange={setPromoTyped}
            />
            {isQuote && (
              <span style={s.cartPromoHint}>Shown on the quotation — used only when the order is placed</span>
            )}
          </div>

          <CustomDiscountField value={customInput} onChange={setCustomInput} error={custom.error} role={staff?.role} compact />

          <div style={s.cartTotals}>
            <div style={s.cartTotalLine}>
              <span style={s.cartRowLabel}>Subtotal</span>
              <span style={s.cartRowVal}>{grossTotal > 0 ? grossTotal.toLocaleString('en', { minimumFractionDigits: 2 }) : '—'}</span>
            </div>
            {freeTotal > 0 && (
              <div style={s.cartTotalLine}>
                <span style={{ ...s.cartRowLabel, color: theme.success }}>Free pillows</span>
                <span style={{ ...s.cartRowVal, color: theme.success }}>-{freeTotal.toLocaleString()}</span>
              </div>
            )}
            {volume.eligible > 0 && (
              <div style={s.cartTotalLine}>
                <VolumeDiscountToggle
                  eligible={volume.eligible}
                  mattressCount={mattressCount}
                  applied={volumeApplied}
                  onChange={setVolumeApplied}
                  labelStyle={s.cartRowLabel}
                  valueStyle={s.cartRowVal}
                />
              </div>
            )}
            {promoDiscount > 0 && (
              <div style={s.cartTotalLine}>
                <span style={{ ...s.cartRowLabel, color: theme.success }}>Promo ({promo.code})</span>
                <span style={{ ...s.cartRowVal, color: theme.success }}>-{promoDiscount.toLocaleString()}</span>
              </div>
            )}
            {custom.amount > 0 && !custom.error && (
              <div style={s.cartTotalLine}>
                <span style={{ ...s.cartRowLabel, color: theme.success }}>Custom discount</span>
                <span style={{ ...s.cartRowVal, color: theme.success }}>-{custom.amount.toLocaleString()}</span>
              </div>
            )}
            <div style={s.cartGrandRow}>
              <span style={s.cartGrandLabel}>Total</span>
              <span style={s.cartGrandVal}>
                <span style={s.cartCurrency}>LKR</span> {items.length > 0 ? total.toLocaleString('en', { minimumFractionDigits: 2 }) : '—'}
              </span>
            </div>
            {cod && <p style={s.cartCod}>Collected in cash on delivery</p>}
          </div>
        </aside>
        </div>


        <div style={s.footer}>
          {/* A disabled button with no reason is the most common way staff get
              stuck, so name what is actually missing. */}
          {!canSubmit && !saving && (
            <span style={s.missingHint}>
              {items.length === 0
                ? 'Add at least one product'
                : `Required: ${[
                    !phone.trim() && 'phone number',
                    !name.trim() && 'customer name',
                    !isQuote && !secondaryPhone.trim() && 'additional number',
                    custom.error && `custom discount — ${custom.error.toLowerCase()}`,
                    isQuote && promoTyped.trim() && !promo && 'a valid promo code (or remove it)',
                  ].filter(Boolean).join(', ')}`}
            </span>
          )}
          <button style={s.cancelBtn} onClick={onClose}>Cancel</button>
          <button style={{ ...s.saveBtn, opacity: canSubmit ? 1 : 0.5 }} onClick={submit} disabled={!canSubmit}>
            {isQuote
              ? saving ? 'Saving...' : `${quotation ? 'Save changes' : 'Save quotation'} — LKR ${total.toLocaleString('en', { minimumFractionDigits: 0 })}`
              : saving ? 'Placing order...' : `Place Order — LKR ${total.toLocaleString('en', { minimumFractionDigits: 0 })}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// variants shape (migration 015): {size, dimension, price} — dimension is
// the exact WxL in inches (e.g. "72x36"), the real per-unit pick now that
// each product has one fixed thickness. Pillow-top is a flat per-product
// addon (product.pillow_top_addon_price) applied on top of whichever
// dimension is picked, not a separate priced variant.
function ProductCard({ product, onAdd }) {
  const available = Math.max(0, (product.stock_quantity || 0) - (product.reserved_quantity || 0));
  const sizes = [...new Set((product.variants || []).map(v => v.size))];
  const [selectedSize, setSelectedSize] = useState(sizes[0]);
  const [pillowTop, setPillowTop] = useState(false);

  // Branch on the product's real SHAPE, not its category: pillows now carry
  // proper sizes with per-dimension prices just like a mattress, so a sized
  // pillow must flow through the normal size -> dimension picker below. Only a
  // product still holding one unsized {price} variant (the two seeded pillows,
  // until staff give them sizes) gets the flat one-tap card.
  const unsized = !(product.variants || []).some(v => v.size || v.dimension || v.height);
  if (unsized) {
    const price = product.variants?.[0]?.price || 0;
    return (
      <button style={s.pillowCard} onClick={() => onAdd({ name: product.name, bed_size: null, category: product.category, unit_price: price })}>
        <span style={s.pillowName}>{product.name}</span>
        <span style={s.pillowPrice}>LKR {price.toLocaleString()}</span>
      </button>
    );
  }

  const dimensionOpts = (product.variants || []).filter(v => v.size === selectedSize);
  const addonPrice = Number(product.pillow_top_addon_price) || 0;

  return (
    <div style={s.productCard}>
      <p style={s.productName}>{product.name}</p>
      {available > 0 && <p style={s.stockNote}>{available} in stock</p>}
      <div style={s.sizeRow}>
        {sizes.map(sz => (
          <button key={sz} style={{ ...s.sizeChip, ...(selectedSize === sz ? s.sizeChipActive : {}) }} onClick={() => setSelectedSize(sz)}>{sz}</button>
        ))}
      </div>
      <div style={s.heightRow}>
        {dimensionOpts.map(v => {
          // A size may legitimately have no dimension (a pillow sized only
          // "Standard", say), so fall back to the size name — an unlabelled
          // chip would be unpickable. bed_size follows the same fallback so
          // the order line still records what was chosen.
          const dim = v.dimension ?? v.height;
          const label = dim || v.size;
          return (
            <button key={label} style={s.heightChip} onClick={() => onAdd({
              name: product.name, bed_size: label, category: product.category, pillow_top: pillowTop,
              unit_price: v.price + (pillowTop ? addonPrice : 0),
            })}>
              {label} · LKR {(v.price + (pillowTop ? addonPrice : 0)).toLocaleString()}
            </button>
          );
        })}
      </div>
      {product.has_pillow_top_option && addonPrice > 0 && (
        <label style={s.pillowTopToggle}>
          <input type="checkbox" checked={pillowTop} onChange={e => setPillowTop(e.target.checked)} />
          Pillow-top upgrade (+LKR {addonPrice.toLocaleString()})
        </label>
      )}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <p style={s.sectionTitle}>{title}</p>
      {children}
    </div>
  );
}
function Field({ label, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <label style={s.fieldLabel}>{label}</label>
      {children}
    </div>
  );
}

const s = {
  backdrop: modalBackdrop,
  // Wider (was 720) to fit the product picker and the cart side by side.
  modal: { background: theme.surface, borderRadius: 16, width: '100%', maxWidth: 1120, maxHeight: vh(92), display: 'flex', flexDirection: 'column', boxShadow: theme.shadowMd, overflow: 'hidden' },
  // Each column scrolls (or doesn't) on its own, so the cart can stay fixed.
  split: { display: 'flex', flex: 1, minHeight: 0, alignItems: 'stretch' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: `1px solid ${theme.border}`, flexShrink: 0 },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 12 },
  headerIcon: { width: 38, height: 38, borderRadius: 10, background: theme.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  headerTitle: { fontSize: 15, fontWeight: 700, color: theme.ink, margin: 0 },
  headerSub: { fontSize: 12, color: theme.inkFaint, margin: 0 },
  closeBtn: { background: theme.borderSoft, border: 'none', cursor: 'pointer', width: 30, height: 30, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.inkSoft, flexShrink: 0 },
  body: { flex: 1, minWidth: 0, overflowY: 'auto', padding: '18px 20px 8px' },
  sectionTitle: { fontSize: 11, fontWeight: 700, color: theme.accentInk, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 },
  fieldLabel: { fontSize: 11, color: theme.inkFaint, fontWeight: 600 },
  row3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 12 },
  // A required field that is still empty keeps a red edge rather than shouting
  // an error message the agent has not earned yet.
  inputRequired: { borderColor: theme.high },
  // Spacing for a Field that stands on its own row rather than inside a
  // row2 grid (which carried the bottom margin) — Field itself has none.
  fieldBlock: { marginBottom: 12 },
  input: { background: theme.bg, border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '9px 12px', color: theme.ink, fontSize: 13, width: '100%', fontFamily: 'inherit', boxSizing: 'border-box' },
  textarea: { resize: 'vertical', minHeight: 60, lineHeight: 1.5 },

  matchTag: { position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', display: 'flex', alignItems: 'center', gap: 3, fontSize: 10.5, fontWeight: 700, color: theme.success, background: theme.successBg, padding: '2px 7px', borderRadius: 10 },
  dropdown: { position: 'absolute', top: '110%', left: 0, right: 0, background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 10, boxShadow: theme.shadowMd, zIndex: 10, overflow: 'hidden', maxHeight: 160, overflowY: 'auto' },
  dropdownHint: { padding: '8px 12px', fontSize: 11.5, color: theme.inkFaint },
  dropdownItem: { display: 'flex', flexDirection: 'column', gap: 1, width: '100%', textAlign: 'left', padding: '8px 12px', background: 'none', border: 'none', borderBottom: `1px solid ${theme.borderSoft}`, cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' },

  productGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 },
  productCard: { border: `1px solid ${theme.border}`, borderRadius: 10, padding: 12, background: theme.bg },
  productName: { fontSize: 13, fontWeight: 700, color: theme.ink, margin: '0 0 2px' },
  stockNote: { fontSize: 10.5, color: theme.inkFaint, margin: '0 0 8px' },
  sizeRow: { display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 },
  sizeChip: { fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 6, border: `1px solid ${theme.border}`, background: theme.surface, color: theme.inkSoft, cursor: 'pointer', fontFamily: 'inherit' },
  sizeChipActive: { background: theme.accentSoft, border: `1px solid ${theme.accent}`, color: theme.accentInk },
  heightRow: { display: 'flex', gap: 4, flexWrap: 'wrap' },
  heightChip: { fontSize: 11, fontWeight: 600, padding: '5px 9px', borderRadius: 6, border: `1px solid ${theme.border}`, background: theme.surface, color: theme.ink, cursor: 'pointer', fontFamily: 'inherit' },
  pillowTopToggle: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: theme.inkSoft, marginTop: 8, cursor: 'pointer' },
  pillowCard: { display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start', border: `1px solid ${theme.border}`, borderRadius: 10, padding: 12, background: theme.bg, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' },
  pillowName: { fontSize: 13, fontWeight: 700, color: theme.ink },
  pillowPrice: { fontSize: 12, color: theme.accentInk, fontWeight: 600 },

  customRow: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 },
  addCustomBtn: { display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: `1.5px dashed ${theme.border}`, color: theme.inkFaint, fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', marginTop: 4 },
  addItemBtn: { background: theme.accent, border: 'none', color: '#fff', fontSize: 12, fontWeight: 700, padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },

  qtyStepper: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 },

  // ── Cart (right column) ───────────────────────────────────────────────────
  // The panel itself doesn't scroll; only the item list inside it does, since
  // a walk-in order can hold many products while the promo field and totals
  // must stay visible.
  cart: { width: 330, flexShrink: 0, borderLeft: `1px solid ${theme.border}`, background: theme.bg, padding: '18px 18px 20px', display: 'flex', flexDirection: 'column', gap: 12, overflow: 'hidden' },
  cartScroll: { overflowY: 'auto' },
  cartListNatural: { flex: 'none', overflowY: 'visible' },
  cartHead: { fontSize: 11, fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase', color: theme.inkFaint, margin: 0, flexShrink: 0 },
  cartList: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 },
  freeTag: { fontSize: 9, fontWeight: 800, color: theme.success, background: theme.successBg, padding: '1px 5px', borderRadius: 4, marginRight: 6, letterSpacing: '0.06em' },
  cartItem: { background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 10, padding: '10px 11px' },
  cartItemTop: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6 },
  cartItemName: { fontSize: 12.5, fontWeight: 700, color: theme.ink, lineHeight: 1.35 },
  cartItemMeta: { margin: '2px 0 0', fontSize: 11, color: theme.inkFaint },
  cartItemBottom: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 8, paddingTop: 8, borderTop: `1px dashed ${theme.border}` },
  cartItemLine: { fontSize: 13, fontWeight: 700, color: theme.ink, fontVariantNumeric: 'tabular-nums' },
  cartEmpty: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '26px 12px', background: theme.surface, border: `1px dashed ${theme.border}`, borderRadius: 10 },
  cartEmptyText: { margin: 0, fontSize: 12, color: theme.inkFaint, textAlign: 'center' },
  cartPromo: { display: 'flex', flexDirection: 'column', gap: 5, flexShrink: 0 },
  cartPromoHint: { fontSize: 10.5, color: theme.inkFaint, lineHeight: 1.35 },
  cartPromoLabel: { fontSize: 11, fontWeight: 600, color: theme.inkFaint },
  cartTotals: { flexShrink: 0, borderTop: `1px solid ${theme.border}`, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 6 },
  cartTotalLine: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  cartRowLabel: { fontSize: 12, color: theme.inkSoft },
  cartRowVal: { fontSize: 12.5, fontWeight: 600, color: theme.ink, fontVariantNumeric: 'tabular-nums' },
  cartGrandRow: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginTop: 4, paddingTop: 10, borderTop: `1px solid ${theme.border}` },
  cartGrandLabel: { fontSize: 12.5, fontWeight: 700, color: theme.ink },
  cartGrandVal: { fontSize: 19, fontWeight: 800, color: theme.ink, fontVariantNumeric: 'tabular-nums' },
  cartCurrency: { fontSize: 11.5, fontWeight: 700, color: theme.inkFaint },
  confirmRow: { display: 'flex', alignItems: 'flex-start', gap: 9, cursor: 'pointer' },
  confirmLabel: { display: 'block', fontSize: 12.5, fontWeight: 600, color: theme.ink },
  confirmHint: { display: 'block', fontSize: 11.5, color: theme.inkFaint, marginTop: 2, lineHeight: 1.45 },
  cartCod: { margin: '2px 0 0', fontSize: 11, fontWeight: 600, color: theme.success },
  qtyBtn: { width: 22, height: 22, borderRadius: 6, border: `1px solid ${theme.border}`, background: theme.bg, color: theme.inkSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' },
  qtyVal: { fontSize: 12.5, fontWeight: 700, color: theme.ink, minWidth: 16, textAlign: 'center' },
  removeBtn: { background: 'none', border: 'none', color: theme.inkFaint, cursor: 'pointer', padding: 4, display: 'flex', flexShrink: 0 },


  // One row, no wrapping: the delivery-method pills are a 4-item set and
  // 'Cash on Delivery' is far wider than the rest, so the default wrap
  // dropped it onto a second line. Pills shrink to fit instead, and each
  // label stays on a single line (see pill's whiteSpace).
  // Option cards: a 2-up grid so four choices fit the left column without
  // shrinking to unreadable pills, and each keeps room for its own hint line.
  lockedExtra: { display: 'flex', flexDirection: 'column', gap: 3, flexShrink: 0, width: 150 },
  lockedExtraLabel: { fontSize: 10, fontWeight: 700, color: theme.inkFaint, textTransform: 'uppercase', letterSpacing: '0.04em' },
  lockedExtraInput: { width: '100%', background: theme.surface, border: `1.5px solid ${theme.border}`, borderRadius: 7, padding: '6px 9px', fontSize: 12.5, color: theme.ink, fontFamily: 'inherit', boxSizing: 'border-box' },
  lockedCust: { display: 'flex', alignItems: 'center', gap: 10, border: `1px solid ${theme.border}`, borderRadius: 9, padding: '9px 11px', background: theme.bg },
  lockedAvatar: { width: 32, height: 32, borderRadius: '50%', background: theme.accent, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13, flexShrink: 0 },
  lockedNameInput: { width: '100%', border: 'none', background: 'transparent', padding: 0, fontSize: 13.5, fontWeight: 700, color: theme.ink, fontFamily: 'inherit', outline: 'none' },
  lockedHint: { fontSize: 11, color: theme.inkFaint, margin: '2px 0 0' },
  lockedPhone: { margin: '2px 0 0', fontSize: 11.5, color: theme.inkSoft },

  methodGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(168px, 1fr))', gap: 8 },
  methodCard: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 3, textAlign: 'left', background: theme.surface, border: `1.5px solid ${theme.border}`, borderRadius: 9, padding: '9px 11px', cursor: 'pointer', fontFamily: 'inherit', width: '100%' },
  methodCardOn: { borderColor: theme.accent, background: theme.accentSoft },
  methodName: { fontSize: 12.5, fontWeight: 700, color: theme.ink, textTransform: 'capitalize' },
  methodHint: { fontSize: 10.5, color: theme.inkFaint, lineHeight: 1.35 },

  // The advance block reads as one decision, not two stray controls.
  // A currency prefix inside the field, so the number is unambiguous without a
  // separate label repeating "LKR".
  dateAddrRow: { display: 'grid', gridTemplateColumns: '150px 1fr', gap: 10, marginBottom: 12 },
  advRow: { display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'end', marginBottom: 6 },
  // A chip rather than a bare checkbox with a sentence beside it: it reads as
  // one toggleable thing and sits on the same line as the amount.
  customChip: { display: 'flex', alignItems: 'center', gap: 6, border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '8px 11px', background: theme.surface, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  customChipOn: { borderColor: theme.accent, background: theme.accentSoft },
  customChipText: { fontSize: 12.5, fontWeight: 700, color: theme.ink },
  advBalance: { margin: '0 0 12px', fontSize: 11.5, color: theme.inkSoft },
  moneyWrap: { display: 'flex', alignItems: 'center', background: theme.surface, border: `1.5px solid ${theme.border}`, borderRadius: 8, overflow: 'hidden' },
  moneyPrefix: { fontSize: 11, fontWeight: 700, color: theme.inkFaint, padding: '0 8px', flexShrink: 0 },
  moneyInput: { flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', padding: '8px 10px 8px 0', fontSize: 13, color: theme.ink, fontFamily: 'inherit' },

  // Cash on Delivery combined panel — deliberately green/success-toned so the
  // amount the driver has to collect is the most scannable thing in the form.
  codBox: { marginTop: 12, padding: '12px 14px', borderRadius: 10, background: theme.successBg, border: `1.5px solid ${theme.success}` },
  codHead: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 800, letterSpacing: 0.4, textTransform: 'uppercase', color: theme.success },
  codAmount: { margin: '6px 0 0', fontSize: 20, fontWeight: 800, color: theme.ink },
  codNote: { margin: '4px 0 0', fontSize: 11.5, lineHeight: 1.5, color: theme.inkSoft },

  error: { background: theme.highBg, color: theme.high, fontSize: 12, padding: '8px 20px', borderTop: `1px solid ${theme.high}` },
  footer: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, padding: '14px 20px', borderTop: `1px solid ${theme.border}`, flexShrink: 0 },
  missingHint: { flex: 1, fontSize: 11.5, color: theme.high, fontWeight: 600 },
  cancelBtn: { background: theme.bg, border: `1px solid ${theme.border}`, color: theme.inkSoft, fontSize: 13, fontWeight: 600, padding: '9px 18px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
  saveBtn: { background: theme.accent, border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, padding: '9px 20px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
};
