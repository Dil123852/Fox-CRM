import { useEffect, useState } from 'react';
import { X, Plus, Minus, Trash2, ShoppingBag, Banknote } from 'lucide-react';
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
  DELIVERY_METHODS, PAYMENT_METHODS, isCOD, labelFor,
  needsDeliveryAddress, paymentMethodFor, codSummary,
} from '../lib/deliveryMethod';
import { vh } from '../lib/viewport';

// Order modal for the Messages/Chat page — same catalog-cart UI as
// ShowroomOrderModal, but for a customer we already know (no phone/name
// lookup needed) and pre-seeded from whatever the AI has already extracted
// onto this customer's open lead (product_type/bed_size/qty/unit_price/
// delivery_address, via analyzeConversation) so staff aren't re-typing what
// the chat already captured. Everything stays editable — the AI-filled cart
// item is just a starting point, matched against the real catalog by name
// where possible so pricing/stock reflect a real product, not a guess.
export default function ChatOrderModal({ conv, onClose, onSaved }) {
  const customer = conv?.customer;

  const [customerName, setCustomerName] = useState(customer?.name || '');
  const [products, setProducts] = useState([]);
  const [productsLoading, setProductsLoading] = useState(true);
  const [lead, setLead] = useState(null);
  const [leadLoading, setLeadLoading] = useState(true);
  const [items, setItems] = useState([]);
  const [seeded, setSeeded] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customItem, setCustomItem] = useState({ name: '', bed_size: '', qty: 1, unit_price: '' });

  const [deliveryMethod, setDeliveryMethod] = useState('delivery');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [deliveryDate, setDeliveryDate] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  // Required on every order (migration 040). Prefilled from the customer's
  // recorded contact number when there is one, since that is a real second
  // number rather than a guess.
  const [secondaryPhone, setSecondaryPhone] = useState(customer?.contact_whatsapp_number || '');
  const [notes, setNotes] = useState('');
  // Automated WhatsApp order confirmation, sent server-side by
  // POST /api/orders. On by default, skippable per order.
  const [sendConfirmation, setSendConfirmation] = useState(true);
  const [promo, setPromo] = useState(null);
  // The "Apply volume discount" tick (migration 057), on by default.
  const [volumeApplied, setVolumeApplied] = useState(true);
  // Custom discount (migration 053), as typed: { amount, reason }.
  const [customInput, setCustomInput] = useState({ amount: '', reason: '' });
  const { staff } = useAuth();

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  useErrorPopup(error, 'Could not place the order');

  useEffect(() => {
    apiFetch('/api/products').then(r => r.json()).then(d => {
      setProducts((d.products || []).filter(p => p.active));
    }).catch(() => {}).finally(() => setProductsLoading(false));
  }, []);

  useEffect(() => {
    if (!customer?.id) { setLeadLoading(false); return; }
    apiFetch(`/api/leads?customerId=${customer.id}`).then(r => r.json()).then(d => {
      setLead((d.leads || [])[0] || null);
    }).catch(() => {}).finally(() => setLeadLoading(false));
  }, [customer?.id]);

  // Seed the cart from the lead once both the lead and the catalog have
  // loaded — matched by name against products so a real catalog row (with
  // its own stock/variant pricing) is used when it exists, otherwise the
  // lead's own free-text values become a one-off custom item.
  useEffect(() => {
    if (seeded || leadLoading || productsLoading) return;
    setSeeded(true);
    if (lead?.delivery_address) setDeliveryAddress(lead.delivery_address);
    if (!lead?.product_type) return;

    const match = products.find(p => p.name.toLowerCase() === lead.product_type.toLowerCase());
    const qty = parseInt(lead.qty) || 1;
    if (match) {
      const variant = (match.variants || []).find(v => v.dimension === lead.bed_size || v.size === lead.bed_size);
      const unitPrice = lead.unit_price != null ? Number(lead.unit_price) : (variant?.price || match.variants?.[0]?.price || 0);
      setItems([{
        name: match.name,
        bed_size: variant?.dimension || lead.bed_size || null,
        category: match.category,
        qty, unit_price: unitPrice,
      }]);
    } else {
      setItems([{
        name: lead.product_type,
        bed_size: lead.bed_size || null,
        category: null,
        qty, unit_price: lead.unit_price != null ? Number(lead.unit_price) : 0,
      }]);
    }
  }, [seeded, leadLoading, productsLoading, lead, products]);

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
      // Free text: an off-catalog item has no variant to pick a dimension from.
      // Empty stays null so nothing prints where a size would go.
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
  // Only PAID mattresses earn the volume discount — a giveaway must not also
  // discount the rest of the order.
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
  // The name is required like the numbers: the order is invoiced and delivered
  // against it, and a chat customer frequently has none recorded yet (the
  // WhatsApp profile gives a number, not a name).
  const canSubmit =
    !!customer?.id &&
    customerName.trim().length > 0 &&
    secondaryPhone.trim().length > 0 &&
    items.length > 0 &&
    !custom.error &&
    !saving;

  async function submit() {
    if (!canSubmit) return;
    setSaving(true); setError(null);
    try {
      // Write the name back onto the CUSTOMER, not just this order. The chat
      // flow used to send it only in the order payload, so a customer who
      // ordered by chat stayed nameless everywhere else in the CRM.
      // POST /api/customers find-or-creates by phone and backfills a missing
      // name, so this is safe to call whether or not they already have one.
      if (customerName.trim()) {
        await apiFetch('/api/customers', {
          method: 'POST',
          body: JSON.stringify({ phone: customer.whatsapp_number, name: customerName.trim() }),
        }).catch(() => { /* never block a real order on a name backfill */ });
      }

      const orderRes = await apiFetch('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          customerId: customer.id,
          customerName: customerName.trim(),
          customerPhone: customer.whatsapp_number,
          secondaryPhone: secondaryPhone.trim(),
          items: items.map(({ name, bed_size, pillow_top, qty, unit_price, free }) => ({
            name, bed_size, qty, unit_price,
            ...(pillow_top ? { pillow_top: true } : {}),
            // Explicit: this mapping picks keys, so without it a giveaway
            // would be saved as a normal charged line.
            ...(free ? { free: true } : {}),
          })),
          totalAmount: total,
          // The discounts that made `total` lower than the line items
          // (migration 046). Sent as real fields, not just prose in `notes`:
          // the invoice needs to print the saving the customer was given and
          // still land on this same total.
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

      if (promo) {
        try {
          const redeemRes = await apiFetch('/api/promo-codes/redeem', {
            method: 'POST',
            body: JSON.stringify({ code: promo.code, phone: customer.whatsapp_number, orderTotal: promo.eligibleSubtotal ?? afterVolumeDiscount, items }),
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
            <div style={s.headerIcon}><ShoppingBag size={17} color={theme.accentInk} /></div>
            <div>
              <p style={s.headerTitle}>New Order</p>
              <p style={s.headerSub}>{customer?.name || customer?.whatsapp_number}{leadLoading ? '' : lead ? ' · pre-filled from chat' : ''}</p>
            </div>
          </div>
          <button style={s.closeBtn} onClick={onClose}><X size={16} /></button>
        </div>

        <div style={s.body}>
          <Section title="Customer">
            <div className="responsive-row2" style={s.row2}>
              <Field label="Name">
                <input
                  style={{ ...s.input, ...(customerName.trim() ? {} : { borderColor: theme.high }) }}
                  value={customerName}
                  onChange={e => setCustomerName(e.target.value)}
                  placeholder="Customer name *"
                />
              </Field>
              <Field label="Phone number">
                <input style={{ ...s.input, background: theme.borderSoft, color: theme.inkFaint }} value={customer?.whatsapp_number || ''} readOnly />
              </Field>
            </div>
          </Section>

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

          <Section title={`Order Items (${items.length})`}>
            {leadLoading ? (
              <p style={{ fontSize: 12.5, color: theme.inkFaint }}>Loading chat details...</p>
            ) : items.length === 0 ? (
              <p style={{ fontSize: 12.5, color: theme.inkFaint }}>Tap a product above to add it here.</p>
            ) : (
              <>
                {items.map((it, i) => (
                  <div key={i} style={s.cartRow}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={s.cartName}>
                        {isFreeItem(it) && <span style={s.freeTag}>FREE</span>}
                        {it.name}
                      </p>
                      <p style={s.cartMeta}>{[it.bed_size, it.pillow_top && 'Pillow-top'].filter(Boolean).join(' · ') || '—'}</p>
                    </div>
                    <div style={s.qtyStepper}>
                      <button style={s.qtyBtn} onClick={() => updateQty(i, -1)}><Minus size={12} /></button>
                      <span style={s.qtyVal}>{it.qty}</span>
                      <button style={s.qtyBtn} onClick={() => updateQty(i, 1)}><Plus size={12} /></button>
                    </div>
                    <input
                      style={s.priceInput} type="number" min="0" step="0.01"
                      value={it.unit_price}
                      onChange={e => setItems(prev => prev.map((row, idx) => idx === i ? { ...row, unit_price: parseFloat(e.target.value) || 0 } : row))}
                    />
                    <button style={s.removeBtn} onClick={() => removeItem(i)}><Trash2 size={13} /></button>
                  </div>
                ))}
                <div style={{ marginTop: 10 }}>
                  <FreeProductSection products={products} items={items} onChange={setItems} />
                </div>
                {freeTotal > 0 && (
                  <>
                    <div style={s.totalRow}>
                      <span style={s.totalLabel}>Subtotal</span>
                      <span style={{ ...s.totalValue, fontSize: 13 }}>LKR {grossTotal.toLocaleString('en', { minimumFractionDigits: 2 })}</span>
                    </div>
                    <div style={s.totalRow}>
                      <span style={{ ...s.totalLabel, color: theme.success }}>Free pillows</span>
                      <span style={{ ...s.totalValue, fontSize: 13, color: theme.success }}>-LKR {freeTotal.toLocaleString()}</span>
                    </div>
                  </>
                )}
                {volume.eligible > 0 && (
                  <div style={s.totalRow}>
                    <VolumeDiscountToggle
                      eligible={volume.eligible}
                      mattressCount={mattressCount}
                      applied={volumeApplied}
                      onChange={setVolumeApplied}
                      labelStyle={s.totalLabel}
                      valueStyle={{ ...s.totalValue, fontSize: 13 }}
                      prefix="LKR "
                    />
                  </div>
                )}

                <div style={{ marginTop: 10 }}>
                  <PromoCodeField phone={customer?.whatsapp_number} orderTotal={afterVolumeDiscount} items={items} onValidated={setPromo} />
                </div>

                {promoDiscount > 0 && (
                  <div style={s.totalRow}>
                    <span style={{ ...s.totalLabel, color: theme.success }}>Promo code ({promo.code})</span>
                    <span style={{ ...s.totalValue, fontSize: 13, color: theme.success }}>-LKR {promoDiscount.toLocaleString()}</span>
                  </div>
                )}

                <div style={{ marginTop: 10 }}>
                  <CustomDiscountField value={customInput} onChange={setCustomInput} error={custom.error} role={staff?.role} />
                </div>
                {custom.amount > 0 && !custom.error && (
                  <div style={s.totalRow}>
                    <span style={{ ...s.totalLabel, color: theme.success }}>Custom discount</span>
                    <span style={{ ...s.totalValue, fontSize: 13, color: theme.success }}>-LKR {custom.amount.toLocaleString()}</span>
                  </div>
                )}
                <div style={s.totalRow}>
                  <span style={s.totalLabel}>Total</span>
                  <span style={s.totalValue}>LKR {total.toLocaleString('en', { minimumFractionDigits: 2 })}</span>
                </div>
              </>
            )}
          </Section>

          {/* Required on every order, so it is marked and blocks submit. */}
          <Section title="Contact">
            <Field label="Additional contact number *">
              <input
                style={{
                  ...s.input,
                  ...(secondaryPhone.trim() ? {} : { borderColor: theme.high }),
                }}
                value={secondaryPhone}
                onChange={e => setSecondaryPhone(e.target.value)}
                placeholder="e.g. 0771234567"
              />
              <p style={s.fieldHint}>
                Someone to call about this delivery if the main number does not answer.
              </p>
            </Field>
          </Section>

          {/* Cash on Delivery spans delivery and payment, so the two sections
              collapse into one when it's picked — see lib/deliveryMethod.js */}
          <Section title={cod ? 'Delivery & Payment' : 'Delivery'}>
            <div style={s.fieldBlock}>
            <Field label="Method">
              <div className="method-pills" style={s.pills}>
                {DELIVERY_METHODS.map(m => (
                  <button key={m} style={{ ...s.pill, ...(deliveryMethod === m ? s.pillActive : {}) }} onClick={() => setDeliveryMethod(m)}>{labelFor(m)}</button>
                ))}
              </div>
            </Field>
            </div>
            {needsDeliveryAddress(deliveryMethod) && (
              <div style={s.fieldBlock}>
                <Field label="Expected date">
                  <input style={s.input} type="date" value={deliveryDate} onChange={e => setDeliveryDate(e.target.value)} />
                </Field>
              </div>
            )}
            {needsDeliveryAddress(deliveryMethod) && (
              <Field label="Delivery address">
                <textarea style={{ ...s.input, ...s.textarea }} value={deliveryAddress} onChange={e => setDeliveryAddress(e.target.value)} placeholder="Full delivery address..." />
              </Field>
            )}
            {cod && (
              <div style={s.codBox}>
                <div style={s.codHead}>
                  <Banknote size={14} color={theme.success} />
                  <span>Cash on Delivery</span>
                </div>
                <p style={s.codAmount}>LKR {total.toLocaleString('en', { minimumFractionDigits: 2 })}</p>
                <p style={s.codNote}>{codSummary(total)} Payment method is set to cash and payment status stays Pending until the delivery is confirmed.</p>
              </div>
            )}
          </Section>

          {!cod && (
            <Section title="Payment">
              <div style={s.pills}>
                {PAYMENT_METHODS.map(m => (
                  <button key={m} style={{ ...s.pill, ...(paymentMethod === m ? s.pillActive : {}) }} onClick={() => setPaymentMethod(m)}>{m.replace('_', ' ')}</button>
                ))}
              </div>
            </Section>
          )}

          <Section title="Notes">
            <textarea style={{ ...s.input, ...s.textarea }} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Internal notes (optional)" />
          </Section>

          <Section title="Customer Confirmation">
            <label style={s.confirmRow}>
              <input type="checkbox" checked={sendConfirmation}
                onChange={e => setSendConfirmation(e.target.checked)} />
              <span>
                <span style={s.confirmLabel}>Send order confirmation on WhatsApp</span>
                <span style={s.confirmHint}>Asks the customer to verify the name, items, total, payment method and delivery address.</span>
              </span>
            </label>
          </Section>
        </div>


        <div style={s.footer}>
          <button style={s.cancelBtn} onClick={onClose}>Cancel</button>
          <button style={{ ...s.saveBtn, opacity: canSubmit ? 1 : 0.5 }} onClick={submit} disabled={!canSubmit}>
            {saving ? 'Placing order...' : `Place Order — LKR ${total.toLocaleString('en', { minimumFractionDigits: 0 })}`}
          </button>
        </div>
      </div>
    </div>
  );
}

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
  modal: { background: theme.surface, borderRadius: 16, width: '100%', maxWidth: 720, maxHeight: vh(90), display: 'flex', flexDirection: 'column', boxShadow: theme.shadowMd, overflow: 'hidden' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: `1px solid ${theme.border}`, flexShrink: 0 },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 12 },
  headerIcon: { width: 38, height: 38, borderRadius: 10, background: theme.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  headerTitle: { fontSize: 15, fontWeight: 700, color: theme.ink, margin: 0 },
  headerSub: { fontSize: 12, color: theme.inkFaint, margin: 0 },
  closeBtn: { background: theme.borderSoft, border: 'none', cursor: 'pointer', width: 30, height: 30, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.inkSoft, flexShrink: 0 },
  body: { flex: 1, overflowY: 'auto', padding: '18px 20px 8px' },
  sectionTitle: { fontSize: 11, fontWeight: 700, color: theme.accentInk, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 },
  fieldLabel: { fontSize: 11, color: theme.inkFaint, fontWeight: 600 },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 },
  // Spacing for a Field that stands on its own row rather than inside a
  // row2 grid (which carried the bottom margin) — Field itself has none.
  fieldHint: { margin: '4px 0 0', fontSize: 10.5, color: theme.inkFaint, lineHeight: 1.4 },
  fieldBlock: { marginBottom: 12 },
  input: { background: theme.bg, border: `1.5px solid ${theme.border}`, borderRadius: 8, padding: '9px 12px', color: theme.ink, fontSize: 13, width: '100%', fontFamily: 'inherit', boxSizing: 'border-box' },
  textarea: { resize: 'vertical', minHeight: 60, lineHeight: 1.5 },

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

  freeTag: { fontSize: 9, fontWeight: 800, color: theme.success, background: theme.successBg, padding: '1px 5px', borderRadius: 4, marginRight: 6, letterSpacing: '0.06em' },
  cartRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: `1px solid ${theme.borderSoft}` },
  cartName: { fontSize: 13, fontWeight: 600, color: theme.ink, margin: 0 },
  cartMeta: { fontSize: 11, color: theme.inkFaint, margin: 0 },
  qtyStepper: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 },
  qtyBtn: { width: 22, height: 22, borderRadius: 6, border: `1px solid ${theme.border}`, background: theme.bg, color: theme.inkSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' },
  qtyVal: { fontSize: 12.5, fontWeight: 700, color: theme.ink, minWidth: 16, textAlign: 'center' },
  priceInput: { fontSize: 13, fontWeight: 700, color: theme.success, minWidth: 90, textAlign: 'right', flexShrink: 0, background: theme.bg, border: `1px solid ${theme.border}`, borderRadius: 6, padding: '4px 8px', fontFamily: 'inherit' },
  removeBtn: { background: 'none', border: 'none', color: theme.inkFaint, cursor: 'pointer', padding: 4, display: 'flex', flexShrink: 0 },

  totalRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 10, marginTop: 4 },
  totalLabel: { fontSize: 13, color: theme.inkSoft, fontWeight: 600 },
  totalValue: { fontSize: 17, fontWeight: 800, color: theme.accentInk },

  // One row, no wrapping: the delivery-method pills are a 4-item set and
  // 'Cash on Delivery' is far wider than the rest, so the default wrap
  // dropped it onto a second line. Pills shrink to fit instead, and each
  // label stays on a single line (see pill's whiteSpace).
  pills: { display: 'flex', gap: 6, flexWrap: 'nowrap' },
  pill: { background: theme.bg, border: `1.5px solid ${theme.border}`, color: theme.inkSoft, fontSize: 12, fontWeight: 600, padding: '6px 13px', borderRadius: 7, cursor: 'pointer', textTransform: 'capitalize', fontFamily: 'inherit', whiteSpace: 'nowrap', minWidth: 0, flexShrink: 1 },
  confirmRow: { display: 'flex', alignItems: 'flex-start', gap: 9, cursor: 'pointer' },
  confirmLabel: { display: 'block', fontSize: 12.5, fontWeight: 600, color: theme.ink },
  confirmHint: { display: 'block', fontSize: 11.5, color: theme.inkFaint, marginTop: 2, lineHeight: 1.45 },
  pillActive: { background: theme.accentSoft, border: `1.5px solid ${theme.accent}`, color: theme.accentInk },
  codBox: { marginTop: 12, padding: '12px 14px', borderRadius: 10, background: theme.successBg, border: `1.5px solid ${theme.success}` },
  codHead: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 800, letterSpacing: 0.4, textTransform: 'uppercase', color: theme.success },
  codAmount: { margin: '6px 0 0', fontSize: 20, fontWeight: 800, color: theme.ink },
  codNote: { margin: '4px 0 0', fontSize: 11.5, lineHeight: 1.5, color: theme.inkSoft },

  error: { background: theme.highBg, color: theme.high, fontSize: 12, padding: '8px 20px', borderTop: `1px solid ${theme.high}` },
  footer: { display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 20px', borderTop: `1px solid ${theme.border}`, flexShrink: 0 },
  cancelBtn: { background: theme.bg, border: `1px solid ${theme.border}`, color: theme.inkSoft, fontSize: 13, fontWeight: 600, padding: '9px 18px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
  saveBtn: { background: theme.accent, border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, padding: '9px 20px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit' },
};
