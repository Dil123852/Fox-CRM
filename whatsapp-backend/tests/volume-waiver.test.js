// "Apply volume discount" tick (migration 057).
//
// Staff may choose not to give the volume discount. The choice is stored as
// volume_discount_waived so the edit screen — which recomputes the discount
// from the cart — keeps it off, and a waived order/quotation never carries a
// volume discount at the same time (the DB refuses both).

jest.mock('pg');
jest.mock('@anthropic-ai/sdk', () => require('./__mocks__/anthropic'));

const request = require('supertest');
const { mockPool } = require('pg');
const { authHeader } = require('./helpers');

const { app, schemaFlags, parseQuotationBody } = require('../index');

const ORDER_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_ID = '00000000-0000-0000-0000-0000000000a1';

function installDb() {
  mockPool.query.mockImplementation((sql, params = []) => {
    if (/FROM staff_users WHERE id=\$1/.test(sql)) {
      return Promise.resolve({ rows: [{ id: params[0], name: 'Kasun', role: 'admin', active: true }] });
    }
    if (/INSERT INTO orders/.test(sql)) {
      return Promise.resolve({ rows: [{ id: ORDER_ID, order_number: 'ORD-01060', customer_name: 'Namal' }] });
    }
    if (/^UPDATE orders SET /.test(sql.trim()) || /UPDATE orders\s+SET discount_total/.test(sql)) {
      return Promise.resolve({ rows: [{ id: ORDER_ID, order_number: 'ORD-01060' }] });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}
const calls = (re) => mockPool.query.mock.calls.filter(([sql]) => re.test(sql));

const TWO_MATTRESSES = {
  customerId: 'c1',
  customerName: 'Namal',
  customerPhone: '94771234567',
  secondaryPhone: '0771234568',
  items: [{ name: 'Nidikumba Ayu Spring', qty: 2, unit_price: 97000 }],
  totalAmount: 194000,
  sendConfirmation: false,
};
const place = (body) => request(app).post('/api/orders').set(authHeader('admin', { id: AGENT_ID })).send(body);
const edit = (body) => request(app).patch(`/api/orders/${ORDER_ID}`).set(authHeader('admin', { id: AGENT_ID })).send(body);

beforeEach(() => {
  jest.clearAllMocks();
  schemaFlags.volumeWaiver = true;
  schemaFlags.customDiscount = true; // discount_total is recomputed only on a 053+ database
  installDb();
});
afterAll(() => { schemaFlags.volumeWaiver = false; schemaFlags.customDiscount = false; });

describe('placing an order', () => {
  test('waived: stored as waived, and no volume discount even if the screen sent one', async () => {
    const res = await place({ ...TWO_MATTRESSES, volumeDiscount: 1500, volumeDiscountWaived: true });
    expect(res.status).toBe(200);
    const [sql, params] = calls(/INSERT INTO orders/)[0];
    expect(sql).toMatch(/volume_discount_waived/);
    expect(params[params.length - 1]).toBe(true);
    expect(params[18]).toBeNull(); // volume_discount
    expect(params[19]).toBeNull(); // discount_total
  });

  test('not waived: exactly as before — the column is not even named', async () => {
    const res = await place({ ...TWO_MATTRESSES, volumeDiscount: 1500, totalAmount: 192500, volumeDiscountWaived: false });
    expect(res.status).toBe(200);
    const [sql, params] = calls(/INSERT INTO orders/)[0];
    expect(sql).not.toMatch(/volume_discount_waived/);
    expect(params[18]).toBe(1500);
  });

  test('a non-boolean is refused rather than guessed', async () => {
    expect((await place({ ...TWO_MATTRESSES, volumeDiscountWaived: 'yes' })).status).toBe(400);
    expect(calls(/INSERT INTO orders/)).toHaveLength(0);
  });

  test('on a database without 057 only a waived order is refused; others still go through', async () => {
    schemaFlags.volumeWaiver = false;
    const waived = await place({ ...TWO_MATTRESSES, volumeDiscountWaived: true });
    expect(waived.status).toBe(503);
    expect(waived.body.error).toMatch(/057/);
    expect((await place({ ...TWO_MATTRESSES, volumeDiscount: 1500, totalAmount: 192500 })).status).toBe(200);
  });
});

describe('editing an order', () => {
  test('waiving clears the volume discount in the same write and recomputes discount_total', async () => {
    const res = await edit({ volume_discount_waived: true, volume_discount: 1500, total_amount: 194000 });
    expect(res.status).toBe(200);
    const [sql, params] = calls(/^\s*UPDATE orders SET /)[0];
    expect(sql).toMatch(/volume_discount_waived=/);
    expect(sql).toMatch(/volume_discount=/);
    const cols = sql.match(/SET (.*) WHERE/s)[1].split(',').map((c) => c.trim().split('=')[0]);
    expect(params[cols.indexOf('volume_discount')]).toBeNull();
    expect(params[cols.indexOf('volume_discount_waived')]).toBe(true);
    expect(calls(/SET discount_total = NULLIF/)).toHaveLength(1);
  });

  test('re-ticking stores false', async () => {
    const res = await edit({ volume_discount_waived: false, volume_discount: 1500 });
    expect(res.status).toBe(200);
    const [sql, params] = calls(/^\s*UPDATE orders SET /)[0];
    const cols = sql.match(/SET (.*) WHERE/s)[1].split(',').map((c) => c.trim().split('=')[0]);
    expect(params[cols.indexOf('volume_discount_waived')]).toBe(false);
    expect(params[cols.indexOf('volume_discount')]).toBe(1500);
  });

  test('non-boolean refused; waiving on a pre-057 database is a 503', async () => {
    expect((await edit({ volume_discount_waived: 'true' })).status).toBe(400);
    schemaFlags.volumeWaiver = false;
    expect((await edit({ volume_discount_waived: true })).status).toBe(503);
  });
});

describe('quotations', () => {
  const base = { customerName: 'Namal', items: [{ name: 'Nidikumba Ayu Spring', qty: 2, unit_price: 97000 }] };

  test('waived: no volume discount on the quotation and the full price as total', () => {
    const q = parseQuotationBody({ ...base, volumeDiscount: 1500, volumeDiscountWaived: true });
    expect(q.volumeWaived).toBe(true);
    expect(q.volume).toBeNull();
    expect(q.total).toBe(194000);
  });

  test('not waived: unchanged', () => {
    const q = parseQuotationBody({ ...base, volumeDiscount: 1500 });
    expect(q.volumeWaived).toBe(false);
    expect(q.volume).toBe(1500);
    expect(q.total).toBe(192500);
  });

  test('a non-boolean is refused', () => {
    expect(parseQuotationBody({ ...base, volumeDiscountWaived: 1 }).error).toMatch(/true or false/);
  });
});
