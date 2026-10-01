import { renderSalesDocument, promoLineLabel } from './invoicePdf';
import { dmy, money } from './pdfShared';

// Customer-facing quotation — the SAME document as the order invoice
// (renderSalesDocument in invoicePdf.js): same letterhead, same item table
// with free items printed at their worth and marked FREE, and the same totals
// — Subtotal, Free items, Volume discount, Promo code, Special discount,
// Total — computed the same way. A quotation used to have its own renderer
// with its own, simpler totals, which is how the two documents drifted apart.
//
// What is quotation-only:
//  - QUOTATION NO / DATE / VALID UNTIL instead of an invoice number
//  - no advances and no balance band: nothing has been paid on a quotation
//  - a promo code is SHOWN, never redeemed (migration 055), and its limits
//    are stated: when it ends (under the validity period, and in the terms)
//    and, for a code with a limited number of uses, that the discount depends
//    on a place still being free when the order is placed
//
// Two callers: a quotation saved on the Quotations page (quotationPayload)
// and a lead's quotation (POST /api/leads/:id/quotation → { quotationNo,
// lead, items, total }), whose lines may not be priced yet.

export const QUOTATION_VALID_DAYS = 30;

const validDate = v => {
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

/**
 * The terms lines a quotation adds, beyond the two every document carries.
 * Exported for tests: this wording is a commitment to the customer, so it is
 * pinned rather than left to drift.
 *
 * Deliberately TWO sentences at most for a promo code. The page is one A4
 * sheet whose signature is pinned to the foot, and four separate promo lines
 * measured 55mm of terms — enough to push the bank-details QR into the
 * signature even with the item table at its smallest.
 */
export function quotationTerms({ validUntil, promo, total, today = new Date() }) {
  const validityLine = `Prices on this quotation are valid until ${dmy(validUntil)}.`;
  const extra = [];
  if (promo?.code && Number(promo.amount) > 0) {
    const code = promo.code;
    const products = Array.isArray(promo.eligibleProducts) && promo.eligibleProducts.length > 0
      ? ` (${promo.eligibleProducts.join(', ')} only)`
      : '';
    const expires = validDate(promo.expiresAt);
    const without = `LKR ${money((Number(total) || 0) + Number(promo.amount))}`;
    extra.push(
      expires
        ? `Promo code ${code}${products} is valid until ${dmy(expires)}` +
          `${expires < validUntil ? ', before this quotation expires' : ''}; ` +
          `an order placed after that date is priced without it, at ${without}.`
        : `Promo code ${code}${products} is applied when the order is placed; without it the price is ${without}.`
    );
    const cap = Number(promo.maxRedemptions);
    if (cap > 0) {
      const left = Math.max(0, cap - (Number(promo.redemptionCount) || 0));
      extra.push(
        `The code is limited to ${cap} customer${cap === 1 ? '' : 's'} (${left} place${left === 1 ? '' : 's'} left on ` +
        `${dmy(today)}) and is given only if a place is still free when the order is placed, once per customer.`
      );
    } else {
      extra.push('The code can be used once per customer.');
    }
  }
  return { validityLine, extraTerms: extra };
}

async function renderQuotation(payload) {
  const {
    quotationNo, lead, customer, items, discounts = {}, total, issuedAt, promo,
  } = payload || {};
  const issued = validDate(issuedAt) || new Date();
  const validUntil = new Date(issued.getTime() + QUOTATION_VALID_DAYS * 86400000);
  const promoAmount = Math.max(0, Number(promo?.amount) || 0);
  const promoEnds = promoAmount > 0 ? validDate(promo?.expiresAt) : null;

  // A lead's quotation names its lines product_type and may hold unpriced
  // ones; renderRows reads either key.
  const who = customer || {
    name: lead?.customer_name || lead?.whatsapp_number || 'Customer',
    address: lead?.delivery_address || lead?.location,
    phone: lead?.contact_whatsapp_number || lead?.whatsapp_number,
  };

  const { validityLine, extraTerms } = quotationTerms({ validUntil, promo, total });

  return renderSalesDocument({
    metaRows: [
      ['QUOTATION NO', String(quotationNo || '-')],
      ['DATE', dmy(issued)],
      ['VALID UNTIL', dmy(validUntil)],
      // The promo's own end date sits directly under the quotation's
      // validity, so a code ending first is visible at a glance.
      ...(promoEnds ? [['PROMO VALID TO', dmy(promoEnds)]] : []),
    ],
    customer: who,
    items,
    discounts: {
      volume: discounts.volume,
      promo: promoAmount > 0
        ? {
            amount: promoAmount,
            label: promoLineLabel(
              { promo_discount_scope: promo.scope, promo_unit_amount: promo.unitAmount },
              promo.code,
              promoAmount
            ),
          }
        : null,
      custom: discounts.custom,
    },
    total: total ?? null,
    validityLine,
    extraTerms,
    unpricedText: 'On request',
    unpricedTotal: 'To be confirmed',
    filenameBase: quotationNo || 'Quotation',
  });
}

// A quotation saved on the Quotations page (migrations 054/055), as the
// payload the renderer takes. One place, so the list, the customer page and
// the editor all print the same document.
export function quotationPayload(q) {
  return {
    quotationNo: q.quotation_no,
    customer: { name: q.customer_name, address: q.delivery_address, phone: q.customer_phone },
    items: q.items || [],
    total: Number(q.total_amount) || 0,
    discounts: { volume: Number(q.volume_discount) || 0, custom: Number(q.custom_discount) || 0 },
    promo: q.promo_code
      ? {
          code: q.promo_code,
          amount: Number(q.promo_discount) || 0,
          expiresAt: q.promo_expires_at,
          maxRedemptions: q.promo_max_redemptions,
          redemptionCount: q.promo_redemption_count,
          eligibleProducts: q.promo_eligible_products,
          scope: q.promo_discount_scope,
          unitAmount: q.promo_unit_amount,
        }
      : null,
    issuedAt: q.created_at,
  };
}

// Download the quotation.
export async function downloadQuotationPDF(payload) {
  const { doc, filename } = await renderQuotation(payload);
  doc.save(filename);
}

// Same document, returned as a blob URL for an in-page preview. The caller
// MUST revoke the URL when the preview closes — an un-revoked blob holds the
// whole PDF in memory for the life of the tab.
export async function previewQuotationPDF(payload) {
  const { doc, filename } = await renderQuotation(payload);
  const blob = doc.output('blob');
  return { url: URL.createObjectURL(blob), filename, blob };
}
