import { describe, it, expect, vi } from 'vitest';
import { quotationTerms } from '../../lib/quotationPdf';

// Records every string the REAL quotation renderer draws (same approach as
// invoiceRender.test.js — jsPDF puts `text` on each instance, so the
// constructor is wrapped rather than the prototype patched).
vi.mock('../../lib/pdfFonts', () => ({ registerPdfFonts: async () => false }));
if (typeof URL.createObjectURL !== 'function') URL.createObjectURL = () => 'blob:test';

async function drawnText(build) {
  const drawn = [];
  vi.resetModules();
  vi.doMock('jspdf', async () => {
    const actual = await vi.importActual('jspdf');
    const Real = actual.default;
    const Wrapped = function (...args) {
      const doc = new Real(...args);
      const realText = doc.text.bind(doc);
      doc.text = (txt, ...rest) => {
        if (typeof txt === 'string') drawn.push(txt);
        else if (Array.isArray(txt)) drawn.push(...txt.filter(t => typeof t === 'string'));
        return realText(txt, ...rest);
      };
      doc.save = () => doc;
      return doc;
    };
    return { ...actual, default: Wrapped, jsPDF: Wrapped };
  });
  const mod = await import('../../lib/quotationPdf');
  await mod.downloadQuotationPDF(build(mod));
  vi.doUnmock('jspdf');
  return drawn;
}
// A label and its figure are separate text() calls.
const after = (drawn, label) => {
  const i = drawn.lastIndexOf(label);
  return i === -1 ? null : drawn[i + 1];
};

const SAVED = {
  id: 'q1',
  quotation_no: 'QUO-01003',
  customer_name: 'Namal Perera',
  customer_phone: '94771234567',
  delivery_address: 'No 5, Kandy Road',
  items: [
    { name: 'Nidikumba Ayu Spring', bed_size: '72x60', qty: 2, unit_price: 97000 },
    { name: 'Gel Pillow', qty: 2, unit_price: -6500, free: true },
  ],
  volume_discount: '1500.00',
  promo_code: 'BMICH2500',
  promo_discount: '5000.00',
  promo_discount_scope: 'per_unit',
  promo_unit_amount: '2500.00',
  promo_expires_at: '2026-09-20T18:29:59Z',
  promo_max_redemptions: 50,
  promo_redemption_count: 47,
  custom_discount: '3000.00',
  custom_discount_reason: 'price match — internal',
  total_amount: '184500.00',
  created_at: '2026-09-01T08:00:00Z',
};

describe('quotation PDF — the same totals as the order invoice', () => {
  it('prints free items at worth, then every deduction, landing on the stored total', async () => {
    const drawn = await drawnText(mod => mod.quotationPayload(SAVED));
    // 2 x 97,000 + the free pillows at their worth (2 x 6,500), as the invoice does.
    expect(after(drawn, 'Subtotal')).toBe('207,000.00');
    expect(after(drawn, 'Free items')).toBe('- 13,000.00');
    expect(after(drawn, 'Volume discount')).toBe('- 1,500.00');
    // Named with the code, and per-mattress arithmetic shown like the invoice.
    expect(after(drawn, 'Promo code BMICH2500 (2 × LKR 2,500)')).toBe('- 5,000.00');
    expect(after(drawn, 'Special discount')).toBe('- 3,000.00');
    // 207,000 - 13,000 - 1,500 - 5,000 - 3,000 = 184,500
    expect(after(drawn, 'Total')).toBe('184,500.00');
    expect(drawn.some(t => t.startsWith('Gel Pillow') && t.includes('(FREE)'))).toBe(true);
    // No catch-all line: the deductions fully explain the gap.
    expect(drawn).not.toContain('Discount');
    // The custom discount's reason is internal.
    expect(drawn.some(t => t.includes('price match'))).toBe(false);
    // Nothing has been paid on a quotation.
    expect(drawn.some(t => /BALANCE|ADVANCE/.test(t))).toBe(false);
  });

  it('dates it when issued, with its validity and the promo end date beneath', async () => {
    const drawn = await drawnText(mod => mod.quotationPayload(SAVED));
    expect(after(drawn, 'DATE :')).toBe('01.09.2026');
    expect(after(drawn, 'VALID UNTIL :')).toBe('01.10.2026');
    expect(drawn).toContain('PROMO VALID TO :');
    expect(drawn.some(t => t.includes('Promo code BMICH2500 is valid until'))).toBe(true);
    expect(drawn.some(t => t.includes('limited to 50 customers'))).toBe(true);
  });

  it('a lead quotation uses the same layout, with unpriced lines on request', async () => {
    const drawn = await drawnText(() => ({
      quotationNo: 'QUO-01001',
      lead: { customer_name: 'Lead Customer', whatsapp_number: '94770000000' },
      items: [
        { product_type: 'Nidikumba Rise', bed_size: '72x60', qty: 1, unit_price: 45100 },
        { product_type: 'Gel Pillow', qty: 1, unit_price: 0 },
      ],
      total: 45100,
    }));
    expect(after(drawn, 'Subtotal')).toBe('45,100.00');
    expect(after(drawn, 'Total')).toBe('45,100.00');
    expect(drawn).toContain('On request');
    expect(drawn.some(t => t.startsWith('Nidikumba Rise'))).toBe(true);
    expect(drawn).not.toContain('PROMO VALID TO :');
  });
});

describe('quotationTerms — the promo conditions printed for the customer', () => {
  const validUntil = new Date('2026-10-01T00:00:00');
  const promo = { code: 'BMICH2500', amount: 5000, expiresAt: '2026-09-20T12:00:00', maxRedemptions: 50, redemptionCount: 47 };

  it('says when the code ends, that it ends before the quotation, and the price without it', () => {
    const { extraTerms } = quotationTerms({ validUntil, promo, total: 184500 });
    expect(extraTerms[0]).toBe(
      'Promo code BMICH2500 is valid until 20.09.2026, before this quotation expires; ' +
      'an order placed after that date is priced without it, at LKR 189,500.00.'
    );
  });

  it('states a limited number of uses and how many are left', () => {
    const { extraTerms } = quotationTerms({ validUntil, promo, total: 184500, today: new Date('2026-09-05T10:00:00') });
    expect(extraTerms[1]).toBe(
      'The code is limited to 50 customers (3 places left on 05.09.2026) and is given only if a place ' +
      'is still free when the order is placed, once per customer.'
    );
  });

  it('names the products a scoped code covers', () => {
    const { extraTerms } = quotationTerms({ validUntil, promo: { ...promo, eligibleProducts: ['Nidikumba Rise'] }, total: 1 });
    expect(extraTerms[0]).toMatch(/^Promo code BMICH2500 \(Nidikumba Rise only\) is valid until/);
  });

  it('an unlimited code with no end date still says it is once per customer', () => {
    const { extraTerms } = quotationTerms({ validUntil, promo: { code: 'OPEN', amount: 100 }, total: 900 });
    expect(extraTerms).toEqual([
      'Promo code OPEN is applied when the order is placed; without it the price is LKR 1,000.00.',
      'The code can be used once per customer.',
    ]);
  });

  it('never more than two promo sentences, so the page keeps its layout', () => {
    expect(quotationTerms({ validUntil, promo: { ...promo, eligibleProducts: ['A', 'B'] }, total: 1 }).extraTerms).toHaveLength(2);
  });

  it('no promo code, no promo terms — just the validity line', () => {
    const t = quotationTerms({ validUntil, promo: null, total: 900 });
    expect(t.extraTerms).toEqual([]);
    expect(t.validityLine).toBe('Prices on this quotation are valid until 01.10.2026.');
  });
});
