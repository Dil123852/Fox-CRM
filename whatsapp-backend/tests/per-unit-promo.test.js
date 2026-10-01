// Per-mattress promo codes (migration 052).
//
// BMICH2500 applied per mattress to a bill with two mattresses must give
// LKR 5,000. A per-bill code keeps giving its amount once. Pillows do not
// multiply an unscoped per-mattress code, and a cap limits how many units count.

jest.mock('pg');
jest.mock('@anthropic-ai/sdk', () => require('./__mocks__/anthropic'));

const request = require('supertest');
const { mockPool } = require('pg');
const { authHeader } = require('./helpers');

const { app, countEligibleUnits, cappedPromoUnits, previewPromoDiscount } = require('../index');

const MATTRESSES = ['Nidikumba Ayu Spring', 'Nidikumba Rise', 'Ayu Sleep 6'];
const mattress = (qty, name = 'Nidikumba Ayu Spring', unit_price = 97000) => ({ name, qty, unit_price });
const pillow = qty => ({ name: 'Gel Pillow', qty, unit_price: 6500 });

describe('countEligibleUnits', () => {
  test('an unscoped code counts mattresses only, across lines', () => {
    expect(countEligibleUnits([mattress(2), mattress(1, 'Nidikumba Rise'), pillow(2)], null, MATTRESSES)).toBe(3);
  });
  test('a scoped code counts only its products — pillows too, if chosen', () => {
    expect(countEligibleUnits([mattress(2), pillow(2)], ['Gel Pillow'], MATTRESSES)).toBe(2);
    expect(countEligibleUnits([mattress(2), mattress(1, 'Nidikumba Rise')], ['Nidikumba Rise'], MATTRESSES)).toBe(1);
  });
  test('free lines never count, and names match case-insensitively (and the legacy product key)', () => {
    const items = [mattress(1), { name: 'nidikumba ayu spring', qty: 1, unit_price: -97000, free: true }, { product: 'NIDIKUMBA RISE', qty: 1, unit_price: 1 }];
    expect(countEligibleUnits(items, null, MATTRESSES)).toBe(2);
  });
  test('no items at all is "unknown" (null), not zero', () => {
    expect(countEligibleUnits(undefined, null, MATTRESSES)).toBeNull();
  });
});

describe('previewPromoDiscount', () => {
  const perUnit = { discount_type: 'amount', discount_amount: '2500.00', discount_scope: 'per_unit', max_units_per_order: null };
  test('BMICH2500 on two mattresses = 5,000', () => {
    expect(previewPromoDiscount(perUnit, 194000, 2)).toBe(5000);
  });
  test('a per-bill amount code is unchanged by the unit count', () => {
    expect(previewPromoDiscount({ ...perUnit, discount_scope: 'order' }, 194000, 2)).toBe(2500);
  });
  test('the cap limits the units counted', () => {
    expect(cappedPromoUnits(5, 3)).toBe(3);
    expect(previewPromoDiscount({ ...perUnit, max_units_per_order: 3 }, 500000, 5)).toBe(7500);
  });
  test('never more than the eligible subtotal', () => {
    expect(previewPromoDiscount(perUnit, 4000, 2)).toBe(4000);
  });
  test('unknown units (no items sent) counts as one — the pre-052 result', () => {
    expect(previewPromoDiscount(perUnit, 194000, null)).toBe(2500);
  });
});

// ── Routes ───────────────────────────────────────────────────────────────────
let promo; // the promo_codes row the mocked DB holds
let redeemCalls;

function installDb() {
  redeemCalls = [];
  mockPool.query.mockImplementation((sql, params = []) => {
    if (/FROM staff_users WHERE id=\$1/.test(sql)) {
      return Promise.resolve({ rows: [{ id: 'admin', name: 'A', role: 'admin', active: true }] });
    }
    if (/FROM validate_promo_code/.test(sql)) {
      return Promise.resolve({
        rows: [{ valid: true, message: 'Valid', discount_type: promo.discount_type, discount_percent: null, discount_amount: promo.discount_amount, promo_code_id: 'p1' }],
      });
    }
    if (/FROM promo_codes WHERE (id|code)=\$1/.test(sql)) return Promise.resolve({ rows: [promo] });
    if (/FROM products WHERE category = 'mattress'/.test(sql)) {
      return Promise.resolve({ rows: MATTRESSES.map(name => ({ name })) });
    }
    if (/FROM redeem_promo_code/.test(sql)) {
      redeemCalls.push(params);
      const units = params[3];
      return Promise.resolve({ rows: [{ success: true, message: 'Redeemed', discount_amount: String(2500 * units), redemption_id: 'r1' }] });
    }
    if (/INSERT INTO promo_codes/.test(sql)) return Promise.resolve({ rows: [{ id: 'new', code: params[0] }] });
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

let ip = 0;
const fromNewIp = r => r.set('X-Forwarded-For', `10.9.0.${++ip}`);

beforeEach(() => {
  jest.clearAllMocks();
  promo = { discount_type: 'amount', discount_amount: '2500.00', discount_scope: 'per_unit', max_units_per_order: null, eligible_product_names: null };
  installDb();
});

describe('POST /api/promo-codes/validate', () => {
  const validate = body => fromNewIp(request(app).post('/api/promo-codes/validate')).send({ code: 'BMICH2500', phone: '94771234567', ...body });

  test('previews 2 × 2,500 = 5,000 for two mattresses', async () => {
    const res = await validate({ orderTotal: 194000, items: [mattress(2), pillow(1)] });
    expect(res.body).toMatchObject({ valid: true, discountScope: 'per_unit', eligibleUnits: 2, countedUnits: 2, previewDiscount: 5000 });
  });

  test('refuses a per-mattress code on a bill with no mattress', async () => {
    const res = await validate({ orderTotal: 13000, items: [pillow(2)] });
    expect(res.body.valid).toBe(false);
    expect(res.body.message).toMatch(/per mattress/);
  });

  test('a per-bill code still gives its amount once', async () => {
    promo.discount_scope = 'order';
    const res = await validate({ orderTotal: 194000, items: [mattress(2)] });
    expect(res.body).toMatchObject({ valid: true, previewDiscount: 2500, countedUnits: null });
  });
});

describe('POST /api/promo-codes/redeem', () => {
  const redeem = body => fromNewIp(request(app).post('/api/promo-codes/redeem')).send({ code: 'BMICH2500', phone: '94771234567', orderTotal: 194000, ...body });

  test('counts units from the items server-side and passes them to redeem_promo_code', async () => {
    const res = await redeem({ items: [mattress(2), pillow(3)], units: 99 });
    expect(redeemCalls[0][3]).toBe(2); // items win over a caller-supplied count
    expect(res.body).toMatchObject({ success: true, discountAmount: '5000' });
  });

  test('an older caller sending no items gets one unit — unchanged behaviour', async () => {
    await redeem({});
    expect(redeemCalls[0][3]).toBe(1);
  });

  test('a per-bill code always redeems as one unit', async () => {
    promo.discount_scope = 'order';
    await redeem({ items: [mattress(3)] });
    expect(redeemCalls[0][3]).toBe(1);
  });
});

describe('POST /api/promo-codes (create)', () => {
  const create = body =>
    request(app).post('/api/promo-codes').set(authHeader('admin')).send({ code: 'X', discountType: 'amount', discountAmount: 2500, ...body });

  test('rejects a per-mattress percent code', async () => {
    const res = await create({ discountType: 'percent', discountPercent: 10, discountScope: 'per_unit' });
    expect(res.status).toBe(400);
  });
  test('rejects a mattress limit on a per-bill code, and a limit below 1', async () => {
    expect((await create({ discountScope: 'order', maxUnitsPerOrder: 2 })).status).toBe(400);
    expect((await create({ discountScope: 'per_unit', maxUnitsPerOrder: 0 })).status).toBe(400);
  });
  test('stores scope and cap', async () => {
    const res = await create({ discountScope: 'per_unit', maxUnitsPerOrder: 3 });
    expect(res.status).toBe(200);
    const insert = mockPool.query.mock.calls.find(([sql]) => /INSERT INTO promo_codes/.test(sql));
    expect(insert[1].slice(8)).toEqual(['per_unit', 3]);
  });
});
