import { describe, it, expect, vi } from 'vitest';

// Verify the REAL invoice renderer by recording every string it draws, rather
// than re-implementing its arithmetic in the test. Fonts are stubbed because
// jsdom cannot decode the embedded TTFs, and the letterhead images are not
// what is under test.
vi.mock('../../lib/pdfFonts', () => ({ registerPdfFonts: async () => false }));

if (typeof URL.createObjectURL !== 'function') URL.createObjectURL = () => 'blob:test';

const BASE = {
  order_number: 'ORD-TEST',
  customer_full_name: 'Test Customer',
  delivery_method: 'pickup',
  items: [{ name: 'Nidikumba Rise', bed_size: '72x60', qty: 2, unit_price: 45100 }],
};

// Every string passed to doc.text(), in draw order.
//
// jsPDF assigns `text` and `save` as OWN properties on each instance rather
// than on the prototype, so they are wrapped on the constructed document via a
// Proxy on the constructor — patching jsPDF.prototype silently does nothing.
async function drawnText(order, advances = []) {
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
  const { downloadInvoicePDF } = await import('../../lib/invoicePdf');
  await downloadInvoicePDF({ order, advances, invoiceNo: 'INV-TEST' });
  vi.doUnmock('jspdf');
  return drawn;
}

// The label column and the figure column are drawn as separate text() calls,
// so pair a label with the figure drawn immediately after it.
function amountAfter(drawn, label) {
  const i = drawn.findIndex(t => t === label);
  return i === -1 ? null : drawn[i + 1];
}

describe('invoice PDF — discounts (migration 046)', () => {
  it('names the promo code and prints both discounts, landing on total_amount', async () => {
    const drawn = await drawnText({
      ...BASE,
      total_amount: '85700.00',
      promo_code: 'ZZTEST3000',
      promo_discount: '3000.00',
      volume_discount: '1500.00',
      discount_total: '4500.00',
    });

    // Items are 2 x 45,100 = 90,200 gross.
    expect(amountAfter(drawn, 'Subtotal')).toBe('90,200.00');
    expect(amountAfter(drawn, 'Volume discount')).toBe('- 1,500.00');
    // The code the customer used is named on the document.
    expect(amountAfter(drawn, 'Promo code ZZTEST3000')).toBe('- 3,000.00');
    // 90,200 - 1,500 - 3,000 = 85,700, which is orders.total_amount.
    expect(amountAfter(drawn, 'Total')).toBe('85,700.00');
    // No catch-all line is needed when the discounts fully explain the gap.
    expect(drawn).not.toContain('Discount');
  });

  it('prints no discount lines when the order had none', async () => {
    const drawn = await drawnText({ ...BASE, total_amount: '90200.00' });
    expect(amountAfter(drawn, 'Subtotal')).toBe('90,200.00');
    expect(amountAfter(drawn, 'Total')).toBe('90,200.00');
    expect(drawn.some(t => t.startsWith('Promo code'))).toBe(false);
    expect(drawn).not.toContain('Volume discount');
    expect(drawn).not.toContain('Discount');
  });

  it('bridges the gap on a pre-046 order whose discount was never recorded', async () => {
    // total_amount is lower than the line items, but no discount column is set
    // — every order placed before migration 046. The page must still add up.
    const drawn = await drawnText({ ...BASE, total_amount: '85700.00' });
    expect(amountAfter(drawn, 'Subtotal')).toBe('90,200.00');
    expect(amountAfter(drawn, 'Discount')).toBe('- 4,500.00');
    expect(amountAfter(drawn, 'Total')).toBe('85,700.00');
  });

  it('deducts a recorded advance from the balance, not from the total', async () => {
    const drawn = await drawnText(
      { ...BASE, total_amount: '85700.00', promo_code: 'ZZTEST3000', promo_discount: '3000.00', volume_discount: '1500.00' },
      [{ amount: '20000.00', paid_at: '2026-09-01T00:00:00Z' }]
    );
    expect(amountAfter(drawn, 'Total')).toBe('85,700.00');
    // 85,700 - 20,000 = 65,700 still owed, carried by the balance band.
    expect(drawn).toContain('65,700.00');
  });
});

describe('invoice PDF — free pillows cost nothing', () => {
  // The exact order from the reported invoice: the Subtotal must include the
  // free pillows at full worth so the Amount column adds up, then deduct them.
  const ORDER = {
    ...BASE,
    items: [
      { name: 'Ayu Sleep 6', bed_size: '75x36', qty: 1, unit_price: 29400 },
      { name: 'Nidikumba Ayu Spring', bed_size: '72x36', qty: 1, unit_price: 53000 },
      { name: 'Nidikumba Pillows', bed_size: '16x27', qty: 4, unit_price: -1700, free: true },
    ],
  };

  it('includes free items in the Subtotal, then deducts them', async () => {
    const drawn = await drawnText({ ...ORDER, total_amount: '82400.00' });
    // 29,400 + 53,000 + 4 x 1,700 = 89,200.
    expect(amountAfter(drawn, 'Subtotal')).toBe('89,200.00');
    expect(amountAfter(drawn, 'Free items')).toBe('- 6,800.00');
    // The customer pays for the mattresses only.
    expect(amountAfter(drawn, 'Total')).toBe('82,400.00');
    expect(drawn).not.toContain('Discount');
  });

  it('applies the volume discount after the free items', async () => {
    const drawn = await drawnText({ ...ORDER, total_amount: '80900.00', volume_discount: '1500.00' });
    expect(amountAfter(drawn, 'Subtotal')).toBe('89,200.00');
    expect(amountAfter(drawn, 'Free items')).toBe('- 6,800.00');
    expect(amountAfter(drawn, 'Volume discount')).toBe('- 1,500.00');
    expect(amountAfter(drawn, 'Total')).toBe('80,900.00');
    expect(drawn).not.toContain('Discount');
  });
});

describe('invoice PDF — per-mattress promo (migration 052)', () => {
  it('shows the unit breakdown for a per-mattress code, and the total still lands on total_amount', async () => {
    const drawn = await drawnText({
      ...BASE,
      total_amount: '85200.00',
      promo_code: 'BMICH2500',
      promo_discount: '5000.00',
      promo_discount_scope: 'per_unit',
      promo_unit_amount: '2500.00',
    });
    expect(amountAfter(drawn, 'Promo code BMICH2500 (2 × LKR 2,500)')).toBe('- 5,000.00');
    expect(drawn).toContain('85,200.00');
  });

  it('falls back to the plain label when the discount is not a whole multiple (capped by the order value)', async () => {
    const drawn = await drawnText({
      ...BASE,
      total_amount: '86200.00',
      promo_code: 'BMICH2500',
      promo_discount: '4000.00',
      promo_discount_scope: 'per_unit',
      promo_unit_amount: '2500.00',
    });
    expect(amountAfter(drawn, 'Promo code BMICH2500')).toBe('- 4,000.00');
  });

  it('a per-bill code keeps the plain label', async () => {
    const drawn = await drawnText({
      ...BASE, total_amount: '87700.00', promo_code: 'FLAT2500', promo_discount: '2500.00',
      promo_discount_scope: 'order', promo_unit_amount: '2500.00',
    });
    expect(amountAfter(drawn, 'Promo code FLAT2500')).toBe('- 2,500.00');
  });
});

describe('invoice PDF — custom discount (migration 053)', () => {
  it('prints a Special discount line after the promo, without the internal reason', async () => {
    const drawn = await drawnText({
      ...BASE,
      total_amount: '80700.00',
      promo_code: 'ZZTEST3000',
      promo_discount: '3000.00',
      volume_discount: '1500.00',
      custom_discount: '5000.00',
      custom_discount_reason: 'price match with competitor',
      discount_total: '9500.00',
    });
    // 90,200 - 1,500 - 3,000 - 5,000 = 80,700
    expect(amountAfter(drawn, 'Special discount')).toBe('- 5,000.00');
    expect(amountAfter(drawn, 'Total')).toBe('80,700.00');
    expect(drawn.indexOf('Special discount')).toBeGreaterThan(drawn.indexOf('Promo code ZZTEST3000'));
    expect(drawn).not.toContain('Discount');
    expect(drawn.some(t => t.includes('price match'))).toBe(false);
  });
});
