// Per-agent visibility (migration 058).
//
// A sales agent sees only their own calls, callbacks and orders; admins and
// viewers see everyone's and may pick one agent. These tests pin the SQL the
// routes send, because the scope must come from the login and never from
// anything the browser sends. Row-level behaviour (which rows actually match)
// is verified against a real database clone, not here.

jest.mock('pg');
jest.mock('@anthropic-ai/sdk', () => require('./__mocks__/anthropic'));

const request = require('supertest');
const { mockPool } = require('pg');
const { authHeader } = require('./helpers');

const { app, schemaFlags } = require('../index');

const AGENT = '00000000-0000-0000-0000-0000000000a1';
const OTHER = '00000000-0000-0000-0000-0000000000a2';
const ADMIN = '00000000-0000-0000-0000-0000000000b1';
const ORDER_ID = '11111111-1111-1111-1111-111111111111';

const STAFF = {
  [AGENT]: { id: AGENT, name: 'Agent A', role: 'sales_agent', active: true },
  [OTHER]: { id: OTHER, name: 'Agent B', role: 'sales_agent', active: true },
  [ADMIN]: { id: ADMIN, name: 'Boss', role: 'admin', active: true },
};

// visibleOrders: order ids the visibility check (SELECT 1 FROM orders ...)
// should find. Everything else answers an empty result.
let visibleOrders;
function installDb() {
  mockPool.query.mockImplementation((sql, params = []) => {
    const q = typeof sql === 'string' ? sql : sql.text;
    const ok = (rows) => Promise.resolve({ rows, rowCount: rows.length });
    if (/FROM staff_users WHERE id=\$1/.test(q)) return ok(STAFF[params[0]] ? [STAFF[params[0]]] : []);
    if (/SELECT 1 FROM orders o WHERE o\.id = \$1/.test(q)) return ok(visibleOrders.includes(params[0]) ? [{ '?column?': 1 }] : []);
    if (/INSERT INTO orders/.test(q)) return ok([{ id: ORDER_ID, order_number: 'ORD-01070', placed_by: AGENT }]);
    if (/SELECT count\(\*\)::int AS total FROM call_events/.test(q)) return ok([{ total: 0 }]);
    return ok([]);
  });
}
const calls = (re) =>
  mockPool.query.mock.calls
    .map(([sql, params]) => [typeof sql === 'string' ? sql : sql.text, params || []])
    .filter(([sql]) => re.test(sql));
const as = (id) => authHeader(STAFF[id].role, { id });

beforeEach(() => {
  jest.clearAllMocks();
  schemaFlags.callEventStaff = true;
  schemaFlags.orderPlacedBy = true;
  visibleOrders = [];
  installDb();
});
afterAll(() => {
  schemaFlags.callEventStaff = false;
  schemaFlags.orderPlacedBy = false;
});

describe('GET /api/calls', () => {
  test('a sales agent always gets their own calls, whatever staffId they send', async () => {
    const res = await request(app).get(`/api/calls?staffId=${OTHER}`).set(as(AGENT));
    expect(res.status).toBe(200);
    const [sql, params] = calls(/FROM call_events ce/).at(-1);
    expect(sql).toMatch(/ce\.staff_id = \$\d+/);
    expect(params).toContain(AGENT);
    expect(params).not.toContain(OTHER);
  });

  test("a sales agent cannot ask for 'none' (unattributed calls) either", async () => {
    await request(app).get('/api/calls?staffId=none').set(as(AGENT));
    const [sql, params] = calls(/FROM call_events ce/).at(-1);
    expect(sql).not.toMatch(/staff_id IS NULL/);
    expect(params).toContain(AGENT);
  });

  test('an admin sees everyone by default, and can pick one agent', async () => {
    await request(app).get('/api/calls').set(as(ADMIN));
    const [sql] = calls(/FROM call_events ce/).at(-1);
    expect(sql).not.toMatch(/ce\.staff_id =/);

    await request(app).get(`/api/calls?staffId=${OTHER}`).set(as(ADMIN));
    const [picked, params] = calls(/FROM call_events ce/).at(-1);
    expect(picked).toMatch(/ce\.staff_id = \$\d+/);
    expect(params).toContain(OTHER);
  });

  test('without migration 051 a sales agent gets nothing rather than everything', async () => {
    schemaFlags.callEventStaff = false;
    await request(app).get('/api/calls').set(as(AGENT));
    const [sql] = calls(/FROM call_events ce/).at(-1);
    expect(sql).toMatch(/WHERE false/);
  });
});

describe('GET /api/calls/callbacks', () => {
  test("a sales agent gets only misses on their own phone", async () => {
    const res = await request(app).get(`/api/calls/callbacks?staffId=${OTHER}`).set(as(AGENT));
    expect(res.status).toBe(200);
    const [sql, params] = calls(/FROM v_missed_call_callbacks v/)[0];
    expect(sql).toMatch(/WHERE v\.missed_on_staff_id = \$1/);
    expect(params).toEqual([AGENT]);
  });

  test('an admin can filter by agent or see all', async () => {
    await request(app).get('/api/calls/callbacks').set(as(ADMIN));
    expect(calls(/FROM v_missed_call_callbacks v/)[0][0]).not.toMatch(/WHERE v\.missed_on_staff_id/);
    await request(app).get(`/api/calls/callbacks?staffId=${OTHER}`).set(as(ADMIN));
    const [sql, params] = calls(/FROM v_missed_call_callbacks v/)[1];
    expect(sql).toMatch(/WHERE v\.missed_on_staff_id = \$1/);
    expect(params).toEqual([OTHER]);
  });

  test("an admin's 'none' finds misses from before 051", async () => {
    await request(app).get('/api/calls/callbacks?staffId=none').set(as(ADMIN));
    expect(calls(/FROM v_missed_call_callbacks v/)[0][0]).toMatch(/WHERE v\.missed_on_staff_id IS NULL/);
  });
});

describe('orders', () => {
  test('POST records the logged-in staff member as placer, ignoring the body', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set(as(AGENT))
      .send({
        customerId: 'c1', customerName: 'Namal', customerPhone: '94771234567', secondaryPhone: '0771234568',
        items: [{ name: 'Ayu Sleep 6', qty: 1, unit_price: 28500 }], totalAmount: 28500,
        sendConfirmation: false, placedBy: OTHER, placed_by: OTHER,
      });
    expect(res.status).toBe(200);
    const [sql, params] = calls(/INSERT INTO orders/)[0];
    expect(sql).toMatch(/placed_by/);
    expect(params).toContain(AGENT);
    expect(params).not.toContain(OTHER);
  });

  test('GET /api/orders: a sales agent gets placed-by-me OR my-lead orders only', async () => {
    const res = await request(app).get(`/api/orders?placedBy=${OTHER}`).set(as(AGENT));
    expect(res.status).toBe(200);
    const [sql, params] = calls(/FROM orders o/).at(-1);
    expect(sql).toMatch(/o\.placed_by = \$1 OR o\.lead_id IN \(SELECT id FROM leads_all WHERE assigned_staff_id = \$1\)/);
    expect(params).toEqual([AGENT]);
  });

  test('GET /api/orders: an admin sees all, can filter by placer, and gets names', async () => {
    await request(app).get('/api/orders').set(as(ADMIN));
    let [sql, params] = calls(/FROM orders o/).at(-1);
    expect(sql).not.toMatch(/o\.placed_by =/);
    expect(sql).toMatch(/placed_by_name/);
    expect(params).toEqual([]);

    await request(app).get(`/api/orders?placedBy=${OTHER}`).set(as(ADMIN));
    [sql, params] = calls(/FROM orders o/).at(-1);
    expect(sql).toMatch(/o\.placed_by = \$1/);
    expect(params).toEqual([OTHER]);
  });

  test('finance and delivery still see every order', async () => {
    for (const role of ['finance', 'delivery_coordinator']) {
      const id = role === 'finance' ? '00000000-0000-0000-0000-0000000000c1' : '00000000-0000-0000-0000-0000000000c2';
      STAFF[id] = { id, name: role, role, active: true };
      await request(app).get('/api/orders').set(as(id));
      const [sql] = calls(/FROM orders o/).at(-1);
      expect(sql).not.toMatch(/WHERE assigned_staff_id =/);
    }
  });

  test("without 058 a sales agent still sees their leads' orders", async () => {
    schemaFlags.orderPlacedBy = false;
    await request(app).get('/api/orders').set(as(AGENT));
    const [sql] = calls(/FROM orders o/).at(-1);
    expect(sql).not.toMatch(/placed_by =/);
    expect(sql).toMatch(/o\.lead_id IN \(SELECT id FROM leads_all WHERE assigned_staff_id = \$1\)/);
  });

  test.each([
    ['get', `/api/orders/${ORDER_ID}`],
    ['get', `/api/orders/${ORDER_ID}/detail`],
    ['get', `/api/orders/${ORDER_ID}/invoice`],
    ['get', `/api/orders/${ORDER_ID}/payments`],
    ['get', `/api/orders/${ORDER_ID}/attachments`],
    ['patch', `/api/orders/${ORDER_ID}`],
    ['post', `/api/orders/${ORDER_ID}/payments`],
  ])("%s %s: someone else's order answers 404 for a sales agent", async (method, url) => {
    const res = await request(app)[method](url).set(as(AGENT)).send(method === 'get' ? undefined : { amount: 100, status: 'confirmed' });
    expect(res.status).toBe(404);
    // Nothing past the check touched the order.
    expect(calls(/UPDATE orders|INSERT INTO order_payments|FROM order_payments|v_order_payment_summary/)).toHaveLength(0);
  });

  test('a visible order gets past the check', async () => {
    visibleOrders = [ORDER_ID];
    await request(app).get(`/api/orders/${ORDER_ID}/payments`).set(as(AGENT));
    expect(calls(/v_order_payment_summary/)).toHaveLength(1);
  });

  test('an admin skips the ownership check entirely', async () => {
    await request(app).get(`/api/orders/${ORDER_ID}/payments`).set(as(ADMIN));
    expect(calls(/SELECT 1 FROM orders o WHERE o\.id/)).toHaveLength(0);
    expect(calls(/v_order_payment_summary/)).toHaveLength(1);
  });

  test("a sales agent cannot download proof attached to someone else's order", async () => {
    await request(app).get('/api/attachments/22222222-2222-2222-2222-222222222222').set(as(AGENT));
    const [sql, params] = calls(/FROM payment_attachments a/)[0];
    expect(sql).toMatch(/o\.placed_by = \$2 OR o\.lead_id IN/);
    expect(params).toEqual(['22222222-2222-2222-2222-222222222222', AGENT]);
  });
});

describe('POST /api/orders with a leadId', () => {
  const LEAD = '44444444-4444-4444-4444-444444444444';
  const CUSTOMER = '33333333-3333-3333-3333-333333333333';
  const body = (extra) => ({
    customerId: CUSTOMER, customerName: 'Namal', customerPhone: '94771234567', secondaryPhone: '0771234568',
    items: [{ name: 'Ayu Sleep 6', qty: 1, unit_price: 28500 }], totalAmount: 28500, sendConfirmation: false, ...extra,
  });

  test("someone else's / another customer's lead is refused before anything is written", async () => {
    // installDb answers the lead check with no rows.
    const res = await request(app).post('/api/orders').set(as(AGENT)).send(body({ leadId: LEAD }));
    expect(res.status).toBe(400);
    const [sql, params] = calls(/SELECT l\.id FROM leads l WHERE l\.id = \$1 AND l\.customer_id = \$2/)[0];
    // Also hides other agents' call leads, like the Pipeline does.
    expect(sql).toMatch(/l\.assigned_staff_id = \$4/);
    expect(params).toEqual([LEAD, CUSTOMER, expect.any(Array), AGENT]);
    expect(calls(/INSERT INTO orders/)).toHaveLength(0);
    expect(calls(/UPDATE leads/)).toHaveLength(0);
  });

  test('a malformed leadId is refused', async () => {
    const res = await request(app).post('/api/orders').set(as(AGENT)).send(body({ leadId: "x' OR 1=1" }));
    expect(res.status).toBe(400);
    expect(calls(/INSERT INTO orders/)).toHaveLength(0);
  });

  test("the customer's own visible lead is accepted and closed", async () => {
    mockPool.query.mockImplementation((sql, params = []) => {
      const ok = (rows) => Promise.resolve({ rows, rowCount: rows.length });
      if (/FROM staff_users WHERE id=\$1/.test(sql)) return ok([STAFF[params[0]]]);
      if (/SELECT l\.id FROM leads l WHERE l\.id = \$1/.test(sql)) return ok([{ id: LEAD }]);
      if (/INSERT INTO orders/.test(sql)) return ok([{ id: ORDER_ID, order_number: 'ORD-01071', placed_by: AGENT }]);
      return ok([]);
    });
    const res = await request(app).post('/api/orders').set(as(AGENT)).send(body({ leadId: LEAD }));
    expect(res.status).toBe(200);
    expect(calls(/UPDATE leads\s+SET status = 'won'/)).toHaveLength(1);
  });
});

describe('GET /api/customers/:id', () => {
  test("the enquiry list's converted-order link is scoped too", async () => {
    await request(app).get('/api/customers/33333333-3333-3333-3333-333333333333').set(as(AGENT));
    const [sql, params] = calls(/LEFT JOIN orders o ON o\.lead_id = l\.id/)[0];
    expect(sql).toMatch(/o\.lead_id = l\.id AND \(o\.placed_by = \$2 OR/);
    // Other agents' call leads are hidden here too, like on the Pipeline.
    expect(sql).toMatch(/WHERE l\.customer_id = \$1 AND \(NOT \(l\.source = ANY\(\$3\)\) OR l\.assigned_staff_id = \$4\)/);
    expect(params).toEqual(['33333333-3333-3333-3333-333333333333', AGENT, expect.any(Array), AGENT]);
  });

  test("a sales agent's view of a customer lists only their own orders and calls", async () => {
    await request(app).get('/api/customers/33333333-3333-3333-3333-333333333333').set(as(AGENT));
    const [orderSql, orderParams] = calls(/FROM orders o\s+LEFT JOIN \(/)[0];
    expect(orderSql).toMatch(/o\.placed_by = \$2 OR o\.lead_id IN/);
    expect(orderParams[1]).toBe(AGENT);
    const [callSql, callParams] = calls(/FROM call_events WHERE customer_id=\$1/)[0];
    expect(callSql).toMatch(/AND staff_id = \$2/);
    expect(callParams).toEqual(['33333333-3333-3333-3333-333333333333', AGENT]);
  });

  test('an admin sees all of them', async () => {
    await request(app).get('/api/customers/33333333-3333-3333-3333-333333333333').set(as(ADMIN));
    expect(calls(/FROM orders o\s+LEFT JOIN \(/)[0][0]).not.toMatch(/placed_by =/);
    expect(calls(/FROM call_events WHERE customer_id=\$1/)[0][1]).toEqual(['33333333-3333-3333-3333-333333333333']);
  });
});

describe('GET /api/staff/roster', () => {
  test('admins and viewers get it; sales agents do not', async () => {
    expect((await request(app).get('/api/staff/roster').set(as(ADMIN))).status).toBe(200);
    expect((await request(app).get('/api/staff/roster').set(as(AGENT))).status).toBe(403);
  });
});

describe('GET /api/leads — the Pipeline "Last calls" dots', () => {
  const pageQuery = () => calls(/AS recent_calls/)[0];

  test("a sales agent's dots are only calls on their own phone", async () => {
    const res = await request(app).get('/api/leads').set(as(AGENT));
    expect(res.status).toBe(200);
    const [sql, params] = pageQuery();
    expect(sql).toMatch(/ce\.customer_id = l\.customer_id/);
    expect(sql).toMatch(/LIMIT 3/);
    const m = sql.match(/ce\.staff_id = \$(\d+)/);
    expect(m).not.toBeNull();
    expect(params[Number(m[1]) - 1]).toBe(AGENT);
    // The count query must not carry the extra parameter (Postgres could not type it).
    const [countSql, countParams] = calls(/SELECT count\(\*\)::int AS total\s+FROM leads l/)[0];
    expect(countSql).not.toMatch(/ce\.staff_id/);
    const highest = Math.max(...[...countSql.matchAll(/\$(\d+)/g)].map(x => Number(x[1])));
    expect(countParams).toHaveLength(highest);
  });

  test("an admin's dots include every agent's calls", async () => {
    await request(app).get('/api/leads').set(as(ADMIN));
    const [sql] = pageQuery();
    expect(sql).toMatch(/AS recent_calls/);
    expect(sql).not.toMatch(/ce\.staff_id = \$/);
  });

  test('without migration 051 a sales agent gets no dots rather than everyone’s', async () => {
    schemaFlags.callEventStaff = false;
    await request(app).get('/api/leads').set(as(AGENT));
    expect(pageQuery()[0]).toMatch(/AND false/);
  });
});

describe('call history card (GET /api/calls?customerId=) and the lead page dots', () => {
  const CUST = '33333333-3333-3333-3333-333333333333';

  test("a sales agent's customer history is still only their own calls", async () => {
    const res = await request(app).get(`/api/calls?customerId=${CUST}&limit=10&staffId=${OTHER}`).set(as(AGENT));
    expect(res.status).toBe(200);
    const [sql, params] = calls(/FROM call_events ce/).at(-1);
    expect(sql).toMatch(/ce\.customer_id = \$\d+/);
    expect(sql).toMatch(/ce\.staff_id = \$\d+/);
    expect(params).toEqual(expect.arrayContaining([CUST, AGENT]));
    expect(params).not.toContain(OTHER);
  });

  test('an admin gets every agent’s calls with that customer', async () => {
    await request(app).get(`/api/calls?customerId=${CUST}`).set(as(ADMIN));
    const [sql, params] = calls(/FROM call_events ce/).at(-1);
    expect(sql).toMatch(/ce\.customer_id = \$1/);
    expect(sql).not.toMatch(/ce\.staff_id = \$/);
    expect(params[0]).toBe(CUST);
  });

  test('a malformed customerId is refused before any query', async () => {
    const res = await request(app).get("/api/calls?customerId=1' OR '1'='1").set(as(ADMIN));
    expect(res.status).toBe(400);
    expect(calls(/FROM call_events ce/)).toHaveLength(0);
  });

  test('GET /api/leads/:id carries the same scoped dots', async () => {
    await request(app).get('/api/leads/44444444-4444-4444-4444-444444444444').set(as(AGENT));
    const [sql, params] = calls(/AS recent_calls/)[0];
    const m = sql.match(/ce\.staff_id = \$(\d+)/);
    expect(params[Number(m[1]) - 1]).toBe(AGENT);
  });
});

describe('single-lead routes check the lead is visible (call-lead rule)', () => {
  const LEAD = '55555555-5555-5555-5555-555555555555';
  test.each([
    ['patch', `/api/leads/${LEAD}`, { status: 'won' }],
    ['post', `/api/leads/${LEAD}/quotation`, {}],
    ['get', `/api/leads/${LEAD}/items`, undefined],
    ['post', `/api/leads/${LEAD}/items`, { product_type: 'Ayu Sleep 6' }],
    ['patch', `/api/leads/${LEAD}/items/66666666-6666-6666-6666-666666666666`, { qty: 2 }],
    ['delete', `/api/leads/${LEAD}/items/66666666-6666-6666-6666-666666666666`, undefined],
  ])("%s %s: another agent's hidden call lead answers 404 and is not touched", async (method, url, body) => {
    const res = await request(app)[method](url).set(as(AGENT)).send(body);
    expect(res.status).toBe(404);
    const [sql, params] = calls(/SELECT 1 FROM leads l WHERE l\.id = \$1/)[0];
    expect(sql).toMatch(/l\.assigned_staff_id = \$3/);
    expect(params).toEqual([LEAD, expect.any(Array), AGENT]);
    expect(calls(/UPDATE leads|lead_items|quotation_number_seq/)).toHaveLength(0);
  });

  test('an admin is not held up by the check', async () => {
    await request(app).get(`/api/leads/${LEAD}/items`).set(as(ADMIN));
    expect(calls(/SELECT 1 FROM leads l WHERE l\.id = \$1/)).toHaveLength(0);
  });

  test('a malformed lead id is a 404 without a query', async () => {
    const res = await request(app).patch("/api/leads/x'--").set(as(AGENT)).send({ status: 'won' });
    expect(res.status).toBe(404);
    expect(calls(/FROM leads l/)).toHaveLength(0);
  });
});
