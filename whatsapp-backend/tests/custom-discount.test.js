// Custom discount + admin notifications (migration 053).
//
// A discount staff give at their own discretion, on top of the automatic
// volume discount. It needs a reason, is written into the order's internal
// notes server-side, and when a non-admin gives it every admin is notified.

jest.mock('pg');
jest.mock('@anthropic-ai/sdk', () => require('./__mocks__/anthropic'));

const request = require('supertest');
const { mockPool } = require('pg');
const { authHeader } = require('./helpers');

const { app, schemaFlags, parseCustomDiscount, customDiscountNote } = require('../index');

const ORDER_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_ID = '00000000-0000-0000-0000-0000000000a1';
const ADMIN_ID = '00000000-0000-0000-0000-0000000000b1';

let current; // the stored order the mocked DB holds
let role;

function installDb() {
  mockPool.query.mockImplementation((sql, params = []) => {
    if (/FROM staff_users WHERE id=\$1/.test(sql)) {
      return Promise.resolve({ rows: [{ id: params[0], name: role === 'admin' ? 'Admin A' : 'Kasun', role, active: true }] });
    }
    // The sales agent's own order (058 ownership check).
    if (/SELECT 1 FROM orders o WHERE o\.id = \$1/.test(sql)) return Promise.resolve({ rows: [{}], rowCount: 1 });
    if (/INSERT INTO orders/.test(sql)) {
      return Promise.resolve({ rows: [{ id: ORDER_ID, order_number: 'ORD-01050', customer_name: 'Namal', notes: params[11] }] });
    }
    if (/INSERT INTO staff_notifications/.test(sql)) {
      return Promise.resolve({ rows: [{ id: 'n1', recipient_id: ADMIN_ID, created_at: '2026-09-24T00:00:00Z' }] });
    }
    if (/SELECT order_number, customer_name, items, volume_discount, promo_discount/.test(sql)) {
      return Promise.resolve({ rows: [current] });
    }
    if (/^UPDATE orders SET /.test(sql.trim()) || /UPDATE orders\s+SET discount_total/.test(sql) || /UPDATE orders SET notes/.test(sql)) {
      return Promise.resolve({ rows: [{ ...current, id: ORDER_ID }] });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

const calls = re => mockPool.query.mock.calls.filter(([sql]) => re.test(sql));

const ORDER_BODY = {
  customerId: 'c1',
  customerName: 'Namal',
  customerPhone: '94771234567',
  secondaryPhone: '0771234568',
  items: [{ name: 'Nidikumba Ayu Spring', qty: 2, unit_price: 97000 }],
  volumeDiscount: 1500,
  totalAmount: 187500,
  notes: 'Deliver after 5pm',
  sendConfirmation: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  schemaFlags.customDiscount = true;
  role = 'sales_agent';
  current = {
    order_number: 'ORD-01050', customer_name: 'Namal',
    items: [{ name: 'Nidikumba Ayu Spring', qty: 2, unit_price: 97000 }],
    volume_discount: '1500.00', promo_discount: null, custom_discount: null, custom_discount_reason: null,
  };
  installDb();
});
afterAll(() => { schemaFlags.customDiscount = false; });

describe('parseCustomDiscount', () => {
  test('no amount, blank or zero means no discount', () => {
    for (const v of [undefined, null, '', 0, '0']) expect(parseCustomDiscount(v, '')).toEqual({ amount: null, reason: null });
  });
  test('an amount needs a reason', () => {
    expect(parseCustomDiscount(5000, '  ').error).toMatch(/reason is required/);
  });
  test('negative and non-numeric are refused', () => {
    expect(parseCustomDiscount(-1, 'x').error).toBeTruthy();
    expect(parseCustomDiscount('abc', 'x').error).toBeTruthy();
  });
  test('valid input is trimmed and rounded to cents', () => {
    expect(parseCustomDiscount('2500.556', ' loyal customer ')).toEqual({ amount: 2500.56, reason: 'loyal customer' });
  });
});

describe('customDiscountNote', () => {
  const staff = { name: 'Kasun', role: 'sales_agent' };
  test('given', () => {
    expect(customDiscountNote(staff, { amount: 5000, reason: 'matched price' }))
      .toMatch(/^\[Custom discount\] LKR 5,000 by Kasun \(sales agent\), .+ — Reason: matched price$/);
  });
  test('changed, reason-only update, removed', () => {
    expect(customDiscountNote(staff, { amount: 3000, reason: 'r', previous: 5000 })).toMatch(/^\[Custom discount changed\] LKR 5,000 → LKR 3,000/);
    expect(customDiscountNote(staff, { amount: 3000, reason: 'r2', previous: 3000 })).toMatch(/^\[Custom discount reason updated\] LKR 3,000/);
    expect(customDiscountNote(staff, { amount: null, previous: 3000 })).toMatch(/^\[Custom discount removed\] was LKR 3,000/);
  });
});

describe('POST /api/orders with a custom discount', () => {
  const post = (body, as = 'sales_agent', id = AGENT_ID) => {
    role = as;
    return request(app).post('/api/orders').set(authHeader(as, { id })).send({ ...ORDER_BODY, ...body });
  };

  test('refuses a discount with no reason', async () => {
    const res = await post({ customDiscount: 5000 });
    expect(res.status).toBe(400);
    expect(calls(/INSERT INTO orders/)).toHaveLength(0);
  });

  test('refuses a discount larger than what is left to pay', async () => {
    const res = await post({ customDiscount: 192501, customDiscountReason: 'x' });
    expect(res.status).toBe(400);
  });

  test('refuses (503) on a database without migration 053', async () => {
    schemaFlags.customDiscount = false;
    const res = await post({ customDiscount: 5000, customDiscountReason: 'x' });
    expect(res.status).toBe(503);
  });

  test('an order without a custom discount inserts exactly the pre-053 columns', async () => {
    schemaFlags.customDiscount = false;
    const res = await post({});
    expect(res.status).toBe(200);
    const [sql, params] = calls(/INSERT INTO orders/)[0];
    expect(sql).not.toMatch(/custom_discount/);
    expect(params).toHaveLength(20);
    expect(params[11]).toBe('Deliver after 5pm');
  });

  test('stores it, stamps who gave it, writes the note, and notifies admins', async () => {
    const res = await post({ customDiscount: 5000, customDiscountReason: 'long-time customer', totalAmount: 182500 });
    expect(res.status).toBe(200);

    const [sql, params] = calls(/INSERT INTO orders/)[0];
    expect(sql).toMatch(/custom_discount, custom_discount_reason, custom_discount_by, custom_discount_at/);
    expect(params[19]).toBe(6500); // discount_total = volume 1,500 + custom 5,000
    expect(params.slice(20, 23)).toEqual([5000, 'long-time customer', AGENT_ID]); // by = the caller, not the body
    expect(params[11]).toMatch(/^Deliver after 5pm\n\[Custom discount\] LKR 5,000 by Kasun \(sales agent\).+Reason: long-time customer$/);

    const notify = calls(/INSERT INTO staff_notifications/);
    expect(notify).toHaveLength(1);
    expect(notify[0][0]).toMatch(/s\.role IN \('admin', 'super_admin'\)/);
    expect(notify[0][1][0]).toBe(AGENT_ID);
    expect(notify[0][1][1]).toBe('Kasun gave a custom discount on ORD-01050');
  });

  test('an admin giving one gets the note but no notification', async () => {
    const res = await post({ customDiscount: 5000, customDiscountReason: 'owner approved' }, 'admin', ADMIN_ID);
    expect(res.status).toBe(200);
    expect(calls(/INSERT INTO orders/)[0][1][11]).toMatch(/\[Custom discount\] LKR 5,000 by Admin A \(admin\)/);
    expect(calls(/INSERT INTO staff_notifications/)).toHaveLength(0);
  });
});

describe('PATCH /api/orders/:id custom discount', () => {
  const patch = (body, as = 'sales_agent') => {
    role = as;
    return request(app).patch(`/api/orders/${ORDER_ID}`).set(authHeader(as, { id: AGENT_ID })).send(body);
  };

  test('adding one appends the note, recomputes discount_total and notifies', async () => {
    const res = await patch({ custom_discount: 4000, custom_discount_reason: 'scratched display unit', total_amount: 188500 });
    expect(res.status).toBe(200);
    const [mainSql, mainParams] = calls(/^UPDATE orders SET updated_at/)[0];
    expect(mainSql).toMatch(/custom_discount_by=/);
    expect(mainParams).toContain(AGENT_ID);
    expect(calls(/SET discount_total = NULLIF/)).toHaveLength(1);
    const note = calls(/UPDATE orders SET notes = concat_ws/)[0];
    expect(note[1][1]).toMatch(/^\[Custom discount\] LKR 4,000 by Kasun .+Reason: scratched display unit$/);
    expect(calls(/INSERT INTO staff_notifications/)).toHaveLength(1);
  });

  test('re-saving the same discount adds no note and no notification', async () => {
    current = { ...current, custom_discount: '4000.00', custom_discount_reason: 'scratched display unit' };
    const res = await patch({ custom_discount: 4000, custom_discount_reason: 'scratched display unit' });
    expect(res.status).toBe(200);
    expect(calls(/UPDATE orders SET notes = concat_ws/)).toHaveLength(0);
    expect(calls(/INSERT INTO staff_notifications/)).toHaveLength(0);
  });

  test('removing one is noted but not notified', async () => {
    current = { ...current, custom_discount: '4000.00', custom_discount_reason: 'r' };
    const res = await patch({ custom_discount: null });
    expect(res.status).toBe(200);
    expect(calls(/UPDATE orders SET notes = concat_ws/)[0][1][1]).toMatch(/^\[Custom discount removed\] was LKR 4,000/);
    expect(calls(/INSERT INTO staff_notifications/)).toHaveLength(0);
  });

  test('finance cannot set it (pricing field)', async () => {
    const res = await patch({ custom_discount: 1000, custom_discount_reason: 'x' }, 'finance');
    expect(res.status).toBe(403);
  });

  test('a change without a reason is refused', async () => {
    const res = await patch({ custom_discount: 1000 });
    expect(res.status).toBe(400);
  });
});

describe('notification routes are scoped to the caller', () => {
  test('marking one read filters by the caller as recipient', async () => {
    role = 'admin';
    const res = await request(app)
      .post('/api/notifications/22222222-2222-2222-2222-222222222222/read')
      .set(authHeader('admin', { id: ADMIN_ID }));
    expect(res.status).toBe(404); // the mocked UPDATE matched nothing
    const [sql, params] = calls(/UPDATE staff_notifications/)[0];
    expect(sql).toMatch(/recipient_id=\$2/);
    expect(params[1]).toBe(ADMIN_ID);
  });

  test('the list is empty, not an error, before migration 053', async () => {
    schemaFlags.customDiscount = false;
    role = 'viewer';
    const res = await request(app).get('/api/notifications').set(authHeader('viewer'));
    expect(res.body).toEqual({ notifications: [], unread: 0 });
  });
});
