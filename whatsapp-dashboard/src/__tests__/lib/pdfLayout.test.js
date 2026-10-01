import { it, vi, expect } from 'vitest';

// Layout guard for the shared sales document (invoice + quotation). The page
// is one A4 sheet with the signature image pinned to the foot and the
// bank-details QR above it on the right; a longer terms block (a quotation's
// promo conditions) or more money lines (discounts, advances) push the QR
// down. This draws the REAL renderer with the REAL images and asserts, from
// the recorded coordinates, that every worst case stays on one page with the
// QR caption clear of the signature. It caught an actual 4mm overlap.
import fs from 'node:fs';
import path from 'node:path';
vi.mock('../../lib/pdfFonts', () => ({ registerPdfFonts: async () => false }));
const ASSETS = path.resolve(__dirname, '../../assets');
vi.stubGlobal('fetch', async (url) => {
  const buf = fs.readFileSync(path.join(ASSETS, path.basename(String(url).split('?')[0])));
  return { blob: async () => new Blob([buf], { type: 'image/png' }) };
});
const log = [];
vi.mock('jspdf', async () => {
  const actual = await vi.importActual('jspdf');
  const Real = actual.default;
  const Wrapped = function (...a) {
    const doc = new Real(...a);
    const page = { texts: [], images: [], doc };
    log.push(page);
    const t = doc.text.bind(doc);
    doc.text = (txt, x, y, ...r) => { page.texts.push({ txt: String(Array.isArray(txt) ? txt.join('|') : txt), x, y }); return t(txt, x, y, ...r); };
    const im = doc.addImage.bind(doc);
    doc.addImage = (d, f, x, y, w, h, ...r) => { page.images.push({ x, y, w, h }); return im(d, f, x, y, w, h, ...r); };
    return doc;
  };
  return { ...actual, default: Wrapped, jsPDF: Wrapped };
});
import { previewQuotationPDF, quotationPayload } from '../../lib/quotationPdf';
import { previewInvoicePDF } from '../../lib/invoicePdf';
const q = {
  quotation_no: 'QUO-01003', customer_name: 'Namal Perera', customer_phone: '94771234567',
  delivery_address: 'No 5, Kandy Road, Peradeniya', volume_discount: '1500.00',
  promo_code: 'BMICH2500', promo_discount: '5000.00', promo_discount_scope: 'per_unit', promo_unit_amount: '2500.00',
  promo_expires_at: '2026-09-20T18:29:59Z', promo_max_redemptions: 50, promo_redemption_count: 47,
  promo_eligible_products: ['Nidikumba Ayu Spring', 'Nidikumba Rise', 'Nidikumba Signature'],
  custom_discount: '3000.00', total_amount: '184500.00', created_at: '2026-09-01T08:00:00Z',
  items: [{ name: 'Nidikumba Ayu Spring', bed_size: '72x60', qty: 2, unit_price: 97000 }, { name: 'Gel Pillow', qty: 2, unit_price: -6500, free: true }],
};
const nine = [...Array.from({ length: 8 }, (_, i) => ({ name: `Nidikumba Rise ${i + 1}`, bed_size: '72x60', qty: 1, unit_price: 45100 })), { name: 'Gel Pillow', qty: 2, unit_price: -6500, free: true }];
const out = [];
function report(name) {
  const page = log[log.length - 1];
  const bankY = page.texts.filter(t => t.txt === 'B' && t.x < 40).map(t => t.y).pop();
  const termsY = page.texts.filter(t => t.txt === 'T' && t.x < 40).map(t => t.y).pop();
  const qr = page.images.find(i => Math.abs(i.w - 22) < 0.01);
  const sig = page.images.find(i => Math.abs(i.w - 34) < 0.01);
  const rows = page.texts.filter(t => /^Nidikumba|^Gel Pillow|^\+ \d+ more/.test(t.txt)).length;
  out.push({ name, pages: page.doc.getNumberOfPages(), rows, termsY: +termsY?.toFixed(1), bankY: +bankY?.toFixed(1), qrCaptionBottom: qr ? +(qr.y + qr.h + 3.2).toFixed(1) : null, sigTop: sig ? +sig.y.toFixed(1) : null });
}
it('measures', async () => {
  URL.createObjectURL = () => 'blob:x';
  await previewQuotationPDF(quotationPayload(q)); report('quote 2 lines + promo, all limits');
  await previewQuotationPDF(quotationPayload({ ...q, items: nine, total_amount: '351300.00' })); report('quote 9 lines + promo, all limits');
  await previewQuotationPDF(quotationPayload({ ...q, promo_code: null })); report('quote no promo');
  const order = { order_number: 'ORD-1', customer_name: 'Namal', customer_phone: '94771234567', delivery_address: 'Kandy', delivery_method: 'cash_on_delivery', items: nine, volume_discount: '2500.00', promo_code: 'BMICH2500', promo_discount: '5000.00', custom_discount: '3000.00', total_amount: '350300.00' };
  await previewInvoicePDF({ order, advances: [{ amount: 50000, paid_at: '2026-09-02' }, { amount: 20000, paid_at: '2026-09-10' }], invoiceNo: 'INV-1' }); report('invoice 9 lines, 3 discounts, 2 advances');
  await previewInvoicePDF({ order: { ...order, items: q.items, total_amount: '184500.00', promo_code: null, promo_discount: null, custom_discount: null }, advances: [], invoiceNo: 'INV-2' }); report('invoice simple');
  for (const r of out) {
    expect(r.pages, r.name).toBe(1);
    expect(r.qrCaptionBottom, r.name).toBeLessThan(r.sigTop);
  }
}, 60000);
