// Quotations (migration 054): built like a showroom order, stored under the
// customer, editable in place, recreated as a new number.

jest.mock('pg');
jest.mock('@anthropic-ai/sdk', () => require('./__mocks__/anthropic'));

const request = require('supertest');
const { mockPool } = require('pg');
const { authHeader } = require('./helpers');

const { app, schemaFlags, parseQuotationBody } = require('../index');

const CUST = '22222222-2222-2222-2222-222222222222';
const QID = '33333333-3333-3333-3333-333333333333';
const AGENT_ID = '00000000-0000-0000-0000-0000000000a1';

let role;
let current; // the stored quotation, for PATCH

function installDb() {
  mockPool.query.mockImplementation((sql, params = []) => {
    if (/FROM staff_users WHERE id=\$1/.test(sql)) {
      return Promise.resolve({ rows: [{ id: params[0], name: 'Kasun', role, active: true }] });
    }
    if (/SELECT id, whatsapp_number FROM customers WHERE id=\$1/.test(sql)) {
      return Promise.resolve({ rows: params[0] === CUST ? [{ id: CUST, whatsapp_number: '94771234567' }] : [] });
    }
    if (/INSERT INTO quotations/.test(sql)) return Promise.resolve({ rows: [{ id: QID }] });
    if (/SELECT customer_phone, custom_discount, custom_discount_reason, custom_discount_by, custom_discount_at FROM quotations/.test(sql)) {
      return Promise.resolve({ rows: current ? [current] : [] });
    }
    if (/FROM quotations q/.test(sql)) {
      return Promise.resolve({ rows: [{ id: QID, quotation_no: 'QUO-01003', customer_name: 'Namal' }] });
    }
    if (/INSERT INTO staff_notifications/.test(sql)) {
      return Promise.resolve({ rows: [{ id: 'n1', recipient_id: 'admin1', created_at: '2026-09-28T00:00:00Z' }] });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}
const calls = re => mockPool.query.mock.calls.filter(([sql]) => re.test(sql));

const BODY = {
  customerId: CUST,
  customerName: 'Namal',
  items: [
    { name: 'Nidikumba Ayu Spring', bed_size: '72x60', qty: 2, unit_price: 97000 },
    { name: 'Gel Pillow', qty: 2, unit_price: -6500, free: true },
  ],
  volumeDiscount: 1500,
};

beforeEach(() => {
  jest.clearAllMocks();
  schemaFlags.customDiscount = true;
  schemaFlags.quotations = true;
  role = 'sales_agent';
  current = { custom_discount: null, custom_discount_reason: null, custom_discount_by: null, custom_discount_at: null };
  installDb();
});
afterAll(() => { schemaFlags.customDiscount = false; schemaFlags.quotations = false; });

describe('parseQuotationBody', () => {
  test('computes the total itself: paid lines less the discounts', () => {
    const q = parseQuotationBody({ ...BODY, customDiscount: 2500, customDiscountReason: 'loyal', totalAmount: 1 });
    expect(q.total).toBe(194000 - 1500 - 2500); // the client's totalAmount is ignored
    expect(q.discountTotal).toBe(4000);
  });
  test('a free line stays negative and flagged; a negative non-free price is refused', () => {
    expect(parseQuotationBody(BODY).items[1]).toMatchObject({ unit_price: -6500, free: true });
    expect(parseQuotationBody({ ...BODY, items: [{ name: 'X', qty: 1, unit_price: -5 }] }).error).toMatch(/Invalid price/);
  });
  test('only known item keys survive', () => {
    const q = parseQuotationBody({ ...BODY, volumeDiscount: 0, items: [{ name: 'X', qty: 1, unit_price: 10, category: 'mattress', evil: '<script>' }] });
    expect(Object.keys(q.items[0]).sort()).toEqual(['bed_size', 'name', 'qty', 'unit_price']);
  });
  test('refuses no items, a missing name, and discounts larger than the quotation', () => {
    expect(parseQuotationBody({ ...BODY, items: [] }).error).toBeTruthy();
    expect(parseQuotationBody({ ...BODY, customerName: ' ' }).error).toMatch(/name/);
    expect(parseQuotationBody({ ...BODY, volumeDiscount: 999999 }).error).toMatch(/volume/);
    expect(parseQuotationBody({ ...BODY, customDiscount: 192501, customDiscountReason: 'x' }).error).toMatch(/custom/);
  });
  test('an additional number is optional but must be a real mobile when given', () => {
    expect(parseQuotationBody({ ...BODY, secondaryPhone: '0771234568' }).secondaryPhone).toBe('94771234568');
    expect(parseQuotationBody({ ...BODY, secondaryPhone: '123' }).error).toMatch(/additional/);
    expect(parseQuotationBody(BODY).secondaryPhone).toBeNull();
  });
});

describe('POST /api/quotations', () => {
  const post = (body, as = 'sales_agent') => {
    role = as;
    return request(app).post('/api/quotations').set(authHeader(as, { id: AGENT_ID })).send({ ...BODY, ...body });
  };

  test('files it under the customer, printing the customer record\'s own number', async () => {
    const res = await post({ customerPhone: '94700000000' });
    expect(res.status).toBe(200);
    const [, params] = calls(/INSERT INTO quotations/)[0];
    expect(params[0]).toBe(CUST);
    expect(params[2]).toBe('94771234567'); // from the customer row, not the body
    expect(params[12]).toBe(192500); // total_amount
    expect(params[15]).toBe(AGENT_ID); // created_by
  });

  test('an unknown customer is 404', async () => {
    const res = await post({ customerId: '99999999-9999-9999-9999-999999999999' });
    expect(res.status).toBe(404);
  });

  test('a custom discount by an agent is noted and notified; the notification points at the quotation', async () => {
    const res = await post({ notes: 'Needs delivery to Kandy', customDiscount: 3000, customDiscountReason: 'bulk buyer' });
    expect(res.status).toBe(200);
    const [, params] = calls(/INSERT INTO quotations/)[0];
    expect(params[13]).toMatch(/^Needs delivery to Kandy\n\[Custom discount\] LKR 3,000 by Kasun \(sales agent\).+Reason: bulk buyer$/);
    const [sql, np] = calls(/INSERT INTO staff_notifications/)[0];
    expect(sql).toMatch(/quotation_id\)/);
    expect(np[1]).toBe('Kasun gave a custom discount on quotation QUO-01003');
  });

  test('viewer and finance cannot create', async () => {
    expect((await post({}, 'viewer')).status).toBe(403);
    expect((await post({}, 'finance')).status).toBe(403);
  });

  test('503 before migration 054', async () => {
    schemaFlags.quotations = false;
    expect((await post({})).status).toBe(503);
  });
});

describe('PATCH /api/quotations/:id', () => {
  const patch = body => {
    role = 'sales_agent';
    return request(app).patch(`/api/quotations/${QID}`).set(authHeader('sales_agent', { id: AGENT_ID })).send({ ...BODY, ...body });
  };

  test('re-saving the same discount keeps who gave it and adds no note', async () => {
    current = { custom_discount: '3000.00', custom_discount_reason: 'bulk buyer', custom_discount_by: 'someone-else', custom_discount_at: '2026-09-01' };
    const res = await patch({ customDiscount: 3000, customDiscountReason: 'bulk buyer', notes: 'kept' });
    expect(res.status).toBe(200);
    const [, params] = calls(/UPDATE quotations SET/)[0];
    expect(params[8]).toBe('someone-else');
    expect(params[12]).toBe('kept');
    expect(calls(/INSERT INTO staff_notifications/)).toHaveLength(0);
  });

  test('changing it is noted and notified', async () => {
    current = { custom_discount: '3000.00', custom_discount_reason: 'bulk buyer', custom_discount_by: 'x', custom_discount_at: 'y' };
    await patch({ customDiscount: 5000, customDiscountReason: 'bulk buyer' });
    const [, params] = calls(/UPDATE quotations SET/)[0];
    expect(params[8]).toBe(AGENT_ID);
    expect(params[12]).toMatch(/\[Custom discount changed\] LKR 3,000 → LKR 5,000/);
    expect(calls(/INSERT INTO staff_notifications/)).toHaveLength(1);
  });

  test('never moves the quotation to another customer', async () => {
    await patch({ customerId: '99999999-9999-9999-9999-999999999999' });
    const [sql] = calls(/UPDATE quotations SET/)[0];
    expect(sql).not.toMatch(/customer_id/);
  });

  test('404 for an unknown quotation', async () => {
    current = null;
    expect((await patch({})).status).toBe(404);
  });
});

describe('GET /api/quotations', () => {
  test('search normalises a local phone number', async () => {
    role = 'viewer';
    const res = await request(app).get('/api/quotations?search=0771234567').set(authHeader('viewer'));
    expect(res.status).toBe(200);
    const [, params] = calls(/FROM quotations q/)[0];
    expect(params).toEqual(['%0771234567%', '%94771234567%']);
  });
  test('delivery_coordinator cannot read quotations', async () => {
    role = 'delivery_coordinator';
    const res = await request(app).get('/api/quotations').set(authHeader('delivery_coordinator'));
    expect(res.status).toBe(403);
  });
});

describe('promo code on a quotation (migration 055) — shown, never redeemed', () => {
  let promoRow;
  let validity;
  function installPromoDb() {
    const base = mockPool.query.getMockImplementation();
    mockPool.query.mockImplementation((sql, params = []) => {
      if (/FROM validate_promo_code/.test(sql)) return Promise.resolve({ rows: [validity] });
      if (/FROM promo_codes WHERE id=\$1/.test(sql)) return Promise.resolve({ rows: [promoRow] });
      if (/FROM products WHERE category = 'mattress'/.test(sql)) {
        return Promise.resolve({ rows: [{ name: 'Nidikumba Ayu Spring' }] });
      }
      return base(sql, params);
    });
  }
  beforeEach(() => {
    schemaFlags.quotationPromo = true;
    validity = { valid: true, message: 'Valid', discount_type: 'amount', discount_percent: null, discount_amount: '2500.00', promo_code_id: 'p1' };
    promoRow = { eligible_product_names: null, discount_scope: 'per_unit', max_units_per_order: null };
    installPromoDb();
  });
  afterAll(() => { schemaFlags.quotationPromo = false; });
  const post = body => {
    role = 'sales_agent';
    return request(app).post('/api/quotations').set(authHeader('sales_agent', { id: AGENT_ID })).send({ ...BODY, ...body });
  };

  test('computes the promo server-side (2 mattresses x 2,500) and takes it off the total', async () => {
    const res = await post({ promoCode: 'BMICH2500' });
    expect(res.status).toBe(200);
    const [sql, params] = calls(/INSERT INTO quotations/)[0];
    expect(sql).toMatch(/promo_code, promo_discount/);
    expect(params.slice(16)).toEqual(['BMICH2500', 5000]);
    expect(params[12]).toBe(194000 - 1500 - 5000); // total_amount
    expect(params[11]).toBe(1500 + 5000); // discount_total
  });

  test('is checked against the customer record\'s own number, never redeemed', async () => {
    await post({ promoCode: 'BMICH2500' });
    const [, vp] = calls(/FROM validate_promo_code/)[0];
    expect(vp).toEqual(['BMICH2500', '94771234567']);
    expect(calls(/redeem_promo_code/)).toHaveLength(0);
    expect(calls(/promo_code_redemptions/)).toHaveLength(0);
  });

  test('an invalid or used-up code is refused with its reason', async () => {
    validity = { valid: false, message: 'This code has reached its redemption limit' };
    const res = await post({ promoCode: 'FULL' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Promo code FULL: This code has reached its redemption limit');
    expect(calls(/INSERT INTO quotations/)).toHaveLength(0);
  });

  test('the custom discount must fit in what is left after the promo', async () => {
    const res = await post({ promoCode: 'BMICH2500', customDiscount: 190000, customDiscountReason: 'x' });
    expect(res.status).toBe(400);
  });

  test('503 for a promo code before migration 055; a quotation without one still saves', async () => {
    schemaFlags.quotationPromo = false;
    expect((await post({ promoCode: 'BMICH2500' })).status).toBe(503);
    expect((await post({})).status).toBe(200);
  });

  test('editing re-checks the code, and clearing it stores NULL', async () => {
    role = 'sales_agent';
    current = { customer_phone: '94771234567', custom_discount: null, custom_discount_reason: null, custom_discount_by: null, custom_discount_at: null };
    await request(app).patch(`/api/quotations/${QID}`).set(authHeader('sales_agent', { id: AGENT_ID })).send({ ...BODY, promoCode: 'BMICH2500' });
    let [, params] = calls(/UPDATE quotations SET/)[0];
    expect(params.slice(14)).toEqual(['BMICH2500', 5000]);
    mockPool.query.mockClear();
    await request(app).patch(`/api/quotations/${QID}`).set(authHeader('sales_agent', { id: AGENT_ID })).send({ ...BODY });
    [, params] = calls(/UPDATE quotations SET/)[0];
    expect(params.slice(14)).toEqual([null, null]);
    expect(calls(/FROM validate_promo_code/)).toHaveLength(0);
  });
});
