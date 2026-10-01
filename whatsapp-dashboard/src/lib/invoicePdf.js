import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { registerPdfFonts } from './pdfFonts';
import {
  INK, SOFT, MINT, HAIR, M, W, RIGHT, TEXT_L, CELL_PAD,
  money, dmy, dmySlash, formatDimension, tracked, trackedWidth,
  loadImage, logoUrl, signatureUrl, qrUrl,
  drawLetterhead, drawSignature, drawTerms, drawBankDetails,
} from './pdfShared';

// Customer-facing invoice — one A4 page, the same design as the quotation
// (shared letterhead, table and signature via pdfShared.js) with the
// differences the business actually needs:
//
//  - INVOICE NO instead of QUOTATION NO, and no due date: an invoice for a
//    delivered or COD order is payable now, not by some later date
//  - free items chosen by staff on the order are printed at their full worth
//    and marked FREE, then deducted in the totals, so the customer sees what
//    they were given and that it cost them nothing. They are ordinary order
//    items carrying a negative unit_price, not a separately-computed figure
//  - the volume discount and any promo code the order was given are shown as
//    their own deduction lines, the promo named by the code the customer used,
//    so the offer is visible on the document instead of vanishing into the
//    total (migration 046 — before it, neither was stored anywhere and this
//    document printed a total HIGHER than the order's own total_amount)
//  - advances actually recorded against the order are deducted, dated
//  - the mint band carries what is still owed, not the order total, because
//    that is the number the customer acts on
//
// The pillow quantity and the unit price come from the API
// (GET /api/orders/:id/invoice), not from this file, so the document and any
// reconciliation against the order agree by construction.

const Y = {
  meta:      66.0,  // INVOICE NO / DATE
  table:     96.0,  // top of the mint header band
  signature: 283.0, // pinned to the trim edge
};

// A per-mattress code (migration 052) reads "Promo code BMICH2500 (2 × LKR
// 2,500)" so the customer can see why the saving is larger than the code's
// face value. The unit count is only printed when the stored discount is an
// exact multiple of the code's amount — a discount capped by the order value,
// or a code whose amount was edited since, falls back to the plain label
// rather than printing arithmetic that doesn't add up.
export function promoLineLabel(order, promoCode, promoDiscount) {
  if (!promoCode) return 'Promo discount';
  const base = `Promo code ${promoCode}`;
  const unit = Number(order?.promo_unit_amount);
  if (order?.promo_discount_scope !== 'per_unit' || !(unit > 0)) return base;
  const units = promoDiscount / unit;
  if (!Number.isInteger(units) || units < 1) return base;
  return `${base} (${units} × LKR ${unit.toLocaleString('en-US')})`;
}

function renderRows(items, { unpricedText = '' } = {}) {
  const rows = [];
  for (const it of items || []) {
    const qty = Number(it.qty) || 1;
    const unit = Number(it.unit_price ?? it.unitPrice) || 0;
    const size = it.bed_size || it.size;
    // A giveaway is stored with a negative unit_price. It is printed at its
    // full worth with a FREE marker, and the matching deduction appears in the
    // totals below — so the customer can see what the gift was worth.
    const free = it.free === true || unit < 0;
    const shown = Math.abs(unit);
    rows.push([
      // Order items carry a free-text name (no product_id in this schema);
      // the older 'product' key appears on some historical rows, and a lead's
      // quotation lines use product_type.
      (it.name || it.product || it.product_type || 'Item')
        + (it.pillow_top ? '  + pillow-top' : '')
        + (free ? '   (FREE)' : ''),
      size ? formatDimension(size) : '',
      String(qty),
      shown > 0 ? money(shown) : unpricedText,
      shown > 0 ? money(shown * qty) : '',
    ]);
  }
  return rows;
}

// ── page budget ─────────────────────────────────────────────────────────────
// Everything below the item table flows, but the signature is pinned to the
// trim edge and its image (top ~255mm) sits on the right, directly under the
// bank-details QR, whose caption ends ~22.8mm below the block's start. So the
// bank block must START no lower than BANK_LIMIT. Rather than estimate every
// height, the page is drawn, the real start measured, and — only if it is too
// low — drawn again with one table row fewer. That is what keeps a quotation
// carrying promo terms, or an invoice with several advances, on one page.
const BANK_LIMIT = 231;
const MAX_ROWS = 8;
const MIN_ROWS = 2; // one line plus "+ N more lines"
const LINE_H = 5.8;   // one money line

/**
 * The one customer-facing sales document — an invoice or a quotation, same
 * letterhead, same item table, same totals. Callers describe what differs:
 *
 *   metaRows   [label, value] pairs on the right (the document number first)
 *   customer   { name, address, phone }
 *   items      order-item shaped lines (free lines negative, migration 049)
 *   discounts  { volume, promo: { amount, label } | null, custom }
 *   total      the document's own stored total, or null to compute it
 *   advances   recorded advances (invoice only)
 *   band       { label } for the mint balance band (invoice only); the amount
 *              is the total less the advances
 *   validityLine / extraTerms   terms lines beyond the two standard ones
 *   unpricedText / unpricedTotal   what to print for a line or total with no
 *              price yet (a lead's quotation); an invoice leaves them blank
 */
export async function renderSalesDocument(spec) {
  const [logo, signature, qr] = await Promise.all([loadImage(logoUrl), loadImage(signatureUrl), loadImage(qrUrl)]);
  for (let fitRows = MAX_ROWS; ; fitRows--) {
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const hasFonts = await registerPdfFonts(doc);
    const { bankY, filename } = drawSalesDocument(doc, spec, { logo, signature, qr, hasFonts, fitRows });
    if (bankY <= BANK_LIMIT || fitRows <= MIN_ROWS) return { doc, filename };
  }
}

function drawSalesDocument(doc, {
  metaRows, customer, items, discounts = {}, total: storedTotalIn = null,
  advances = [], band = null, validityLine = null, extraTerms = [],
  unpricedText = '', unpricedTotal = null, filenameBase,
}, { logo, signature, qr, hasFonts, fitRows }) {
  const BODY = hasFonts ? 'OpenSans' : 'helvetica';
  const TITLE = hasFonts ? 'Montserrat' : 'helvetica';

  drawLetterhead(doc, { logo, titleFont: TITLE, bodyFont: BODY });

  // ── meta ───────────────────────────────────────────────────────────────────
  const my = Y.meta;
  const LABEL_X = RIGHT - 30;

  doc.setFont(BODY, 'normal');
  doc.setFontSize(9);
  const metaLeftEdge = LABEL_X - Math.max(
    ...metaRows.map(([label]) => doc.getTextWidth(`${label} :`))
  );

  let ry = my;
  for (const [label, value] of metaRows) {
    doc.setFont(BODY, 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...SOFT);
    doc.text(`${label} :`, LABEL_X, ry, { align: 'right' });
    doc.setFont(BODY, 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(...INK);
    doc.text(value, RIGHT, ry, { align: 'right' });
    ry += 6.2;
  }

  // ── issued to ──────────────────────────────────────────────────────────────
  const COL_W = metaLeftEdge - TEXT_L - 8;
  const name = customer?.name || 'Customer';

  doc.setFont(BODY, 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...SOFT);
  doc.text('Issued to :', TEXT_L, my);

  let cy = my + 6.4;
  doc.setFont(BODY, 'bold');
  doc.setFontSize(11.5);
  doc.setTextColor(...INK);
  for (const line of doc.splitTextToSize(name, COL_W).slice(0, 2)) {
    doc.text(line, TEXT_L, cy);
    cy += 5.6;
  }

  doc.setFont(BODY, 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(...SOFT);
  if (customer?.address) {
    for (const line of doc.splitTextToSize(String(customer.address), COL_W).slice(0, 2)) {
      doc.text(line, TEXT_L, cy);
      cy += 5;
    }
  }
  if (customer?.phone) doc.text(String(customer.phone), TEXT_L, cy);

  // ── money ────────────────────────────────────────────────────────────────
  // Free items are ordinary lines carrying a NEGATIVE unit_price. They are
  // printed at full worth, so the Subtotal includes them — the Amount column
  // then adds up to the Subtotal on the page — and the same value is deducted
  // on its own "Free items" line. They cost the customer nothing: the total is
  // the paid lines less any volume/promo/custom discount (lib/orderItems.js).
  const lines = items || [];
  const lineOf = it => (Number(it.unit_price ?? it.unitPrice) || 0) * (Number(it.qty) || 1);
  const isFree = it => it?.free === true || (Number(it.unit_price ?? it.unitPrice) || 0) < 0;
  const paidTotal = lines.filter(it => !isFree(it)).reduce((sum, it) => sum + lineOf(it), 0);
  // Positive for display; the stored lines are negative.
  const freeTotal = Math.abs(lines.filter(isFree).reduce((sum, it) => sum + lineOf(it), 0));
  const subtotal = paidTotal + freeTotal;

  const volumeDiscount = Math.max(0, Number(discounts.volume) || 0);
  const promoDiscount = Math.max(0, Number(discounts.promo?.amount) || 0);
  // Staff-given discount (migration 053). Printed as "Special discount" with
  // the amount only — its reason is an internal note, not for the customer.
  const customDiscount = Math.max(0, Number(discounts.custom) || 0);

  // Prefer the document's own stored total: it is the figure staff agreed with
  // the customer, and for an order the one the payment ledger, the balance and
  // the WhatsApp confirmation all use. A stored 0 is a legitimate figure, so
  // the test is for a real number rather than truthiness.
  const storedTotal = storedTotalIn == null ? NaN : Number(storedTotalIn);
  const computedTotal = Math.max(0, subtotal - freeTotal - promoDiscount - volumeDiscount - customDiscount);
  const total = Number.isFinite(storedTotal) ? Math.max(0, storedTotal) : computedTotal;

  const advanceTotal = (advances || []).reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
  const remaining = Math.max(0, total - advanceTotal);

  // If the printed deductions do not bridge the subtotal to the total, the
  // arithmetic on the page would not add up in front of the customer. That
  // happens on a pre-046 order, whose discount was never recorded. Rather than
  // print a sum that visibly does not work, carry the remainder on one honest
  // "Discount" line.
  const shownDeductions = freeTotal + promoDiscount + volumeDiscount + customDiscount;
  const unexplained = Math.max(0, subtotal - shownDeductions - total);

  // ── items ──────────────────────────────────────────────────────────────────
  const allRows = renderRows(lines, { unpricedText });
  const truncating = allRows.length > fitRows;
  const body = truncating ? allRows.slice(0, fitRows - 1) : allRows;
  if (truncating) {
    const hidden = allRows.length - body.length;
    // The hidden lines carry their own amount, at the worth the table prints
    // them at, so the Amount column still adds up to the Subtotal below.
    const hiddenWorth = lines.slice(body.length).reduce((sum, it) => sum + Math.abs(lineOf(it)), 0);
    body.push([
      `+ ${hidden} more line${hidden === 1 ? '' : 's'}`, '', '', '',
      hiddenWorth > 0 ? money(hiddenWorth) : '',
    ]);
  }
  if (body.length === 0) body.push(['No items yet', '', '', '', '']);

  const HEADS = ['DESCRIPTION', 'SIZE', 'QTY', 'UNIT PRICE', 'AMOUNT'];
  const COL_ALIGN = ['left', 'center', 'center', 'right', 'right'];

  autoTable(doc, {
    startY: Y.table,
    head: [HEADS],
    body,
    theme: 'plain',
    styles: {
      font: BODY, fontSize: 10, textColor: INK, lineWidth: 0, valign: 'middle',
      cellPadding: { top: 2.5, bottom: 2.5, left: CELL_PAD, right: CELL_PAD },
    },
    headStyles: {
      fillColor: MINT, textColor: INK, fontStyle: 'bold', fontSize: 8.5,
      cellPadding: { top: 3.3, bottom: 3.3, left: CELL_PAD, right: CELL_PAD },
    },
    columnStyles: {
      0: { cellWidth: 56.4, halign: COL_ALIGN[0] },
      1: { cellWidth: 24.0, halign: COL_ALIGN[1], textColor: SOFT },
      2: { cellWidth: 13.0, halign: COL_ALIGN[2], textColor: SOFT },
      3: { cellWidth: 35.0, halign: COL_ALIGN[3] },
      4: { cellWidth: 40.0, halign: COL_ALIGN[4], fontStyle: 'bold' },
    },
    didParseCell: data => {
      if (data.section === 'head') data.cell.text = [''];
    },
    didDrawCell: data => {
      if (data.section === 'head') {
        const label = HEADS[data.column.index];
        doc.setFont(BODY, 'bold');
        doc.setFontSize(8.5);
        doc.setTextColor(...INK);
        const gap = 0.9;
        const tw = trackedWidth(doc, label, gap);
        const ha = COL_ALIGN[data.column.index];
        const cx = ha === 'right' ? data.cell.x + data.cell.width - CELL_PAD - tw
          : ha === 'center' ? data.cell.x + (data.cell.width - tw) / 2
          : data.cell.x + CELL_PAD;
        tracked(doc, label, cx, data.cell.y + data.cell.height / 2 + 1.2, gap);
        return;
      }
      if (data.column.index === 0 && data.row.index < body.length - 1) {
        doc.setDrawColor(...HAIR);
        doc.setLineWidth(0.2);
        const yy = data.cell.y + data.cell.height;
        doc.line(M, yy, RIGHT, yy);
      }
    },
    margin: { left: M, right: M },
  });

  const VAL_X = RIGHT - CELL_PAD;   // the AMOUNT column's own right edge
  const LBL_X = RIGHT - 46;
  let ty = doc.lastAutoTable.finalY + 10;

  doc.setDrawColor(...HAIR);
  doc.setLineWidth(0.2);
  doc.line(M, ty - 7.5, RIGHT, ty - 7.5);

  const line = (label, value, opts = {}) => {
    // `box` fills a mint panel behind the row before the text is drawn, so
    // the highlight sits under the label and figure rather than over them.
    if (opts.box) {
      // Height measured against the real glyph boxes, not guessed: at 9.5pt
      // the glyphs run baseline-3.6 to baseline+1.0mm and the rows sit 5.8mm
      // apart, so an 8.4mm box reached 0.58mm into the row above. 6.8mm
      // clears both neighbours with ~0.5mm either side.
      doc.setFillColor(...MINT);
      doc.rect(M, ty - 4.6, W, 6.8, 'F');
    }
    doc.setFont(BODY, opts.bold ? 'bold' : 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(...(opts.strong ? INK : SOFT));
    if (opts.box) {
      // A boxed row reads like the balance band below it: label hard left at
      // the same TEXT_L every other block on the page uses, figure right.
      doc.text(label, TEXT_L, ty);
    } else {
      doc.text(label, LBL_X, ty, { align: 'right' });
    }
    doc.setTextColor(...INK);
    doc.text(value, VAL_X, ty, { align: 'right' });
    ty += opts.box ? 7.4 : LINE_H;
  };

  line('Subtotal', money(subtotal), { strong: true });
  if (freeTotal > 0) line('Free items', `- ${money(freeTotal)}`);
  // The volume discount before the promo, matching the order in which they are
  // actually applied when an order is priced.
  if (volumeDiscount > 0) line('Volume discount', `- ${money(volumeDiscount)}`);
  // Named with the code, so the offer is visible on the document rather than
  // folded silently into the total.
  if (promoDiscount > 0) line(discounts.promo?.label || 'Promo discount', `- ${money(promoDiscount)}`);
  // Last, matching the order screens, where it is applied after the promo.
  if (customDiscount > 0) line('Special discount', `- ${money(customDiscount)}`);
  if (unexplained > 0) line('Discount', `- ${money(unexplained)}`);
  line('Total', total > 0 || unpricedTotal == null ? money(total) : unpricedTotal, { bold: true, strong: true, box: true });

  // Each advance on its own dated line, so a customer can match it to the
  // receipt they were given.
  for (const a of advances || []) {
    const paid = a.paid_at ? new Date(a.paid_at) : null;
    line(`Advance (${paid ? dmySlash(paid) : '—'})`, `- ${money(a.amount)}`);
  }

  // ── the balance band (invoice) ─────────────────────────────────────────────
  // The mint band carries what is still OWED, not the total: that is the
  // number the customer has to act on.
  if (band) {
    const bandY = ty + 1.4;
    const BAND_H = 11;
    doc.setFillColor(...MINT);
    doc.rect(M, bandY, W, BAND_H, 'F');

    // Label small and letter-spaced, amount at normal weight and the same size
    // as the money rows above it — the band's fill is what draws the eye.
    doc.setFont(BODY, 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...INK);
    tracked(doc, band.label, TEXT_L, bandY + 7, 1.2);
    doc.setFont(BODY, 'normal');
    doc.setFontSize(9.5);
    doc.text(money(remaining), VAL_X, bandY + 7, { align: 'right' });
    ty = bandY + BAND_H;
  }

  // ── terms + bank details + signature ───────────────────────────────────────
  // Terms first, then the bank details below whatever they occupy — the QR
  // makes that block taller than its three text lines, so drawTerms returns
  // the real bottom rather than the caller assuming a height.
  const termsBottom = drawTerms(doc, { bodyFont: BODY, y: ty + 12, validityLine, extraLines: extraTerms });
  const bankY = termsBottom + 8;
  drawBankDetails(doc, { bodyFont: BODY, y: bankY, qr });
  drawSignature(doc, { signature, bodyFont: BODY, baseY: Y.signature });

  const safeName = String(name).replace(/[^a-zA-Z0-9]/g, '_');
  return { bankY, filename: `${filenameBase}_${safeName}.pdf` };
}

async function renderInvoice({ order, advances, invoiceNo }) {
  const promoCode = order?.promo_code ? String(order.promo_code).trim() : '';
  const promoDiscount = Math.max(0, Number(order?.promo_discount) || 0);
  const docNo = String(invoiceNo || order?.order_number || '-');
  return renderSalesDocument({
    // No due date: an invoice for a delivered or cash-on-delivery order is
    // payable now, so printing one would be misleading.
    metaRows: [
      ['INVOICE NO', docNo],
      ['DATE', dmy(new Date())],
    ],
    customer: {
      name: order?.customer_full_name || order?.customer_name || 'Customer',
      address: order?.delivery_address,
      phone: order?.contact_whatsapp_number || order?.customer_phone,
    },
    items: order?.items,
    // Discounts the order was given (migration 046). These are NOT in the
    // line items — the items are gross — so before they were stored this
    // document printed a total higher than the order's own total_amount.
    discounts: {
      volume: order?.volume_discount,
      promo: promoDiscount > 0 ? { amount: promoDiscount, label: promoLineLabel(order, promoCode, promoDiscount) } : null,
      custom: order?.custom_discount,
    },
    // Fall back to computing the total only when total_amount is absent, which
    // is how this file behaved for every order before 046.
    total: order?.total_amount ?? null,
    advances,
    // Labelled "Cash on delivery" only when the order really is COD
    // (migration 026) — on a pickup or a prepaid order it would be wrong.
    band: { label: order?.delivery_method === 'cash_on_delivery' ? 'CASH ON DELIVERY' : 'BALANCE DUE' },
    // An invoice's prices are already agreed, so the quotation's validity
    // line would be wrong here.
    validityLine: null,
    filenameBase: invoiceNo || order?.order_number || 'Invoice',
  });
}

export async function downloadInvoicePDF(payload) {
  const { doc, filename } = await renderInvoice(payload);
  doc.save(filename);
}

// Same document as a blob URL for an in-page preview. The caller MUST revoke
// the URL when the preview closes.
export async function previewInvoicePDF(payload) {
  const { doc, filename } = await renderInvoice(payload);
  const blob = doc.output('blob');
  return { url: URL.createObjectURL(blob), filename, blob };
}
