// Regression tests for the 2026-09-10 security audit findings.
//
// Each test reproduces the exploit scenario from the report and asserts it now
// fails. Written against the REAL app (see api.test.js's header), so they
// cannot pass while the vulnerability exists.

jest.mock('pg');
jest.mock('@anthropic-ai/sdk', () => require('./__mocks__/anthropic'));

const request = require('supertest');
const crypto = require('crypto');
const { mockPool } = require('pg');
const { authHeader, mockAuthenticatedAs, DEFAULT_ID } = require('./helpers');

process.env.TWILIO_VALIDATE_SIGNATURE = 'false';

const { app, schemaFlags } = require('../index');

const ALL_ROLES = ['admin', 'sales_agent', 'inventory_manager', 'delivery_coordinator', 'finance', 'viewer'];

beforeEach(() => {
  jest.clearAllMocks();
  mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ messages: [{ id: 'wamid.test' }] }),
    text: async () => '{}',
  });
});

describe('AUDIT CRITICAL: ungated customer routes', () => {
  // Exploit: a delivery_coordinator authenticates, dumps the whole customer
  // table, then iterates /api/customers/:id to exfiltrate every WhatsApp
  // transcript — bypassing the PIPELINE_READ_ROLES gate on /api/messages.
  test('delivery_coordinator can no longer list all customers', async () => {
    mockAuthenticatedAs(mockPool, 'delivery_coordinator');
    const res = await request(app).get('/api/customers').set(authHeader('delivery_coordinator'));
    expect(res.status).toBe(403);
  });

  test('inventory_manager can no longer list all customers', async () => {
    mockAuthenticatedAs(mockPool, 'inventory_manager');
    const res = await request(app).get('/api/customers').set(authHeader('inventory_manager'));
    expect(res.status).toBe(403);
  });

  test('delivery_coordinator can no longer read a customer chat transcript', async () => {
    mockAuthenticatedAs(mockPool, 'delivery_coordinator');
    const res = await request(app).get('/api/customers/some-id').set(authHeader('delivery_coordinator'));
    expect(res.status).toBe(403);
  });

  test('/api/customers/:id now matches the /api/messages gate exactly', async () => {
    // The bug was that these two routes served the same chat data behind
    // different gates. Assert they agree for every role.
    for (const role of ALL_ROLES) {
      mockAuthenticatedAs(mockPool, role);
      const viaCustomer = await request(app).get('/api/customers/c1').set(authHeader(role));
      const viaMessages = await request(app).get('/api/messages?customer_id=c1').set(authHeader(role));
      expect({ role, denied: viaCustomer.status === 403 }).toEqual({
        role,
        denied: viaMessages.status === 403,
      });
    }
  });

  test('roles that legitimately need customer lookup still work', async () => {
    for (const role of ['admin', 'viewer', 'sales_agent']) {
      mockAuthenticatedAs(mockPool, role);
      const res = await request(app).get('/api/customers').set(authHeader(role));
      expect({ role, status: res.status }).toEqual({ role, status: 200 });
    }
  });
});

describe('AUDIT: unbounded customer query is now paginated', () => {
  test('applies a default LIMIT instead of returning every row', async () => {
    const h = mockAuthenticatedAs(mockPool, 'admin');
    await request(app).get('/api/customers').set(authHeader('admin'));
    const [[sql, values]] = h.calls();
    expect(sql).toMatch(/LIMIT \$1 OFFSET \$2/);
    expect(values).toEqual([100, 0]);
  });

  test('clamps a hostile limit rather than honouring it', async () => {
    const h = mockAuthenticatedAs(mockPool, 'admin');
    await request(app).get('/api/customers?limit=999999&offset=-5').set(authHeader('admin'));
    const [[, values]] = h.calls();
    expect(values[0]).toBeLessThanOrEqual(200);
    expect(values[1]).toBeGreaterThanOrEqual(0);
  });
});

describe('AUDIT: delivery_coordinator retains the access their job needs', () => {
  // The audit recommended gating orders to admin/finance/sales_agent/viewer.
  // That would have broken production: /orders is this role's landing page and
  // the list is how they reach the delivery screen. Assert it still works, so
  // nobody "hardens" it later without noticing.
  test('can still list orders (their landing page)', async () => {
    mockAuthenticatedAs(mockPool, 'delivery_coordinator');
    const res = await request(app).get('/api/orders').set(authHeader('delivery_coordinator'));
    expect(res.status).toBe(200);
  });

  test('can still read a single order (their delivery screen)', async () => {
    mockAuthenticatedAs(mockPool, 'delivery_coordinator').next({ rows: [{ id: 'o1' }], rowCount: 1 });
    const res = await request(app).get('/api/orders/o1').set(authHeader('delivery_coordinator'));
    expect(res.status).toBe(200);
  });

  test('is still refused the invoice and the payment ledger', async () => {
    mockAuthenticatedAs(mockPool, 'delivery_coordinator');
    const inv = await request(app).get('/api/orders/o1/invoice').set(authHeader('delivery_coordinator'));
    mockAuthenticatedAs(mockPool, 'delivery_coordinator');
    const pay = await request(app).get('/api/orders/o1/payments').set(authHeader('delivery_coordinator'));
    expect(inv.status).toBe(403);
    expect(pay.status).toBe(403);
  });
});

describe('AUDIT HIGH: deactivation and demotion take effect immediately', () => {
  // Exploit: a fired staff member's 12h token kept full prior privileges
  // because authenticate() trusted the JWT claim and never re-read the DB.
  test('a deactivated account is refused even with a valid unexpired token', async () => {
    mockAuthenticatedAs(mockPool, 'admin', { active: false });
    const res = await request(app).get('/api/staff').set(authHeader('admin'));
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/inactive|no longer exists/i);
  });

  test('a deleted account is refused', async () => {
    // No staff row at all for that id.
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await request(app).get('/api/staff').set(authHeader('admin'));
    expect(res.status).toBe(401);
  });

  test('a demoted admin loses admin immediately — the DB role wins over the claim', async () => {
    // Token says admin; staff_users now says viewer.
    mockAuthenticatedAs(mockPool, 'viewer');
    const res = await request(app).get('/api/staff').set(authHeader('admin'));
    expect(res.status).toBe(403);
  });

  test('a promoted user gains the new role immediately', async () => {
    // Token says viewer; staff_users now says admin.
    mockAuthenticatedAs(mockPool, 'admin');
    const res = await request(app).get('/api/staff').set(authHeader('viewer'));
    expect(res.status).toBe(200);
  });

  test('req.staff.id still comes through for self-scoped queries', async () => {
    const h = mockAuthenticatedAs(mockPool, 'sales_agent');
    const res = await request(app).get('/api/performance').set(authHeader('sales_agent'));
    expect(res.status).toBe(200);
    const [[sql, values]] = h.calls();
    expect(sql).toMatch(/staff_id=\$1/);
    expect(values).toEqual([DEFAULT_ID]);
  });

  test('a database outage during auth returns 503, not a 200 or a crash', async () => {
    mockPool.query.mockRejectedValue(new Error('connection refused'));
    const res = await request(app).get('/api/staff').set(authHeader('admin'));
    expect(res.status).toBe(503);
  });
});

describe('AUDIT HIGH: Meta webhook signature verification', () => {
  const body = { object: 'whatsapp_business_account', entry: [] };

  test('an unsigned POST is rejected with 403', async () => {
    // The exploit: curl the endpoint in a loop. Each accepted request created
    // customers, inserted messages and spent money on the Claude API.
    const res = await request(app).post('/webhook').send(body);
    expect(res.status).toBe(403);
  });

  test('a wrong signature is rejected', async () => {
    const res = await request(app).post('/webhook').set('X-Hub-Signature-256', 'sha256=deadbeef').send(body);
    expect(res.status).toBe(403);
  });

  test('no customer is created and no AI call is made on a rejected webhook', async () => {
    const { mockMessageCreate } = require('@anthropic-ai/sdk');
    mockPool.query.mockClear();
    await request(app)
      .post('/webhook')
      .send({
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ value: { messages: [{ type: 'text', from: '94700000000', text: { body: 'x' } }] } }] }],
      });
    await new Promise((r) => setImmediate(r));
    expect(mockPool.query).not.toHaveBeenCalled();
    expect(mockMessageCreate).not.toHaveBeenCalled();
  });

  test('a correctly signed request is accepted when META_APP_SECRET is set', async () => {
    const secret = 'test-meta-app-secret';
    const prev = process.env.META_APP_SECRET;
    process.env.META_APP_SECRET = secret;
    try {
      const raw = JSON.stringify(body);
      const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(Buffer.from(raw)).digest('hex');
      const res = await request(app).post('/webhook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sig).send(raw);
      expect(res.status).toBe(200);
    } finally {
      if (prev === undefined) delete process.env.META_APP_SECRET;
      else process.env.META_APP_SECRET = prev;
    }
  });

  test('a signature valid for a DIFFERENT body is rejected (tamper detection)', async () => {
    const secret = 'test-meta-app-secret';
    const prev = process.env.META_APP_SECRET;
    process.env.META_APP_SECRET = secret;
    try {
      const sig =
        'sha256=' +
        crypto
          .createHmac('sha256', secret)
          .update(Buffer.from(JSON.stringify(body)))
          .digest('hex');
      const res = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', sig)
        .send(JSON.stringify({ object: 'tampered' }));
      expect(res.status).toBe(403);
    } finally {
      if (prev === undefined) delete process.env.META_APP_SECRET;
      else process.env.META_APP_SECRET = prev;
    }
  });
});

// The test that lived here checked a hardcoded list of FIVE paths under a name
// that promised it covered every route. There are 87, so a new route was
// invisible to it — which is how four ungated routes shipped, one of them
// serving bcrypt password hashes to any logged-in user.
//
// Replaced by tests/route-inventory.test.js, which ENUMERATES the router
// instead of listing paths, so it cannot go stale as routes are added.

describe('AUDIT HIGH: password policy is enforced on BOTH paths', () => {
  // The create route enforced nothing at all; the reset route required 6
  // characters. Both now share validatePassword().
  const REJECTED = ['a', 'short', 'password', 'PASSWORD', '  password  ', 'aaaaaaaaaaaa', '12345678901'];

  test('staff creation rejects a weak or short password', async () => {
    for (const password of REJECTED) {
      mockAuthenticatedAs(mockPool, 'admin');
      const res = await request(app)
        .post('/api/staff')
        .set(authHeader('admin'))
        .send({ name: 'X', phone: '94770000001', password, role: 'viewer' });
      expect({ password, status: res.status }).toEqual({ password, status: 400 });
    }
  });

  test('password reset rejects the same set', async () => {
    for (const password of REJECTED) {
      mockAuthenticatedAs(mockPool, 'admin');
      const res = await request(app).patch('/api/staff/s1/password').set(authHeader('admin')).send({ password });
      expect({ password, status: res.status }).toEqual({ password, status: 400 });
    }
  });

  test('a 6-character password is no longer accepted on reset (was the old floor)', async () => {
    mockAuthenticatedAs(mockPool, 'admin');
    const res = await request(app).patch('/api/staff/s1/password').set(authHeader('admin')).send({ password: 'abc123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 12/);
  });

  test('a strong password is accepted on both routes', async () => {
    const strong = 'tr0ubador-horse-battery';

    // First query: the duplicate-phone check (no existing account); second:
    // the INSERT.
    mockAuthenticatedAs(mockPool, 'admin')
      .next({ rows: [], rowCount: 0 })
      .next({ rows: [{ id: 'new-1', name: 'X', role: 'viewer' }], rowCount: 1 });
    const create = await request(app)
      .post('/api/staff')
      .set(authHeader('admin'))
      .send({ name: 'X', phone: '94770000001', password: strong, role: 'viewer' });
    expect(create.status).toBe(200);

    mockAuthenticatedAs(mockPool, 'admin')
      .next({ rows: [{ id: '00000000-0000-0000-0000-00000000051a', role: 'viewer' }], rowCount: 1 }) // the target account
      .next({ rows: [{ id: '00000000-0000-0000-0000-00000000051a' }], rowCount: 1 });
    const reset = await request(app).patch('/api/staff/00000000-0000-0000-0000-00000000051a/password').set(authHeader('admin')).send({ password: strong });
    expect(reset.status).toBe(200);
  });
});

describe('AUDIT HIGH: per-account login lockout', () => {
  const bcrypt = require('bcryptjs');
  const SELECT_LOGIN = /SELECT id, name, phone, password_hash/;

  // detectSchema() sets this at startup from information_schema; nothing calls
  // it under test, so the flag defaults to off and the whole lockout branch
  // would be skipped. Setting it here is what makes these tests exercise the
  // migration-035 code path.
  let prevFlag;
  beforeEach(() => {
    prevFlag = schemaFlags.loginLockout;
    schemaFlags.loginLockout = true;
  });
  afterEach(() => {
    schemaFlags.loginLockout = prevFlag;
  });

  function loginRow(extra = {}) {
    return {
      rows: [
        {
          id: 'staff-1',
          name: 'Test Admin',
          phone: '94771234567',
          password_hash: '$2b$10$' + 'x'.repeat(53),
          role: 'admin',
          failed_login_count: 0,
          locked_until: null,
          ...extra,
        },
      ],
      rowCount: 1,
    };
  }

  test('a failed attempt increments the per-account counter', async () => {
    const seen = [];
    mockPool.query.mockImplementation((sql, params) => {
      seen.push([String(sql), params]);
      if (SELECT_LOGIN.test(String(sql))) return Promise.resolve(loginRow({ failed_login_count: 1 }));
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(app).post('/api/auth/login').send({ phone: '94771234567', password: 'wrong-password' });
    expect(res.status).toBe(401);

    const update = seen.find(([sql]) => /UPDATE staff_users[\s\S]*failed_login_count/.test(sql));
    expect(update).toBeDefined();
    // Second consecutive failure -> count 2, not yet locked.
    expect(update[1][0]).toBe(2);
    expect(update[1][1]).toBe(false);
  });

  test('the threshold sets locked_until', async () => {
    const seen = [];
    mockPool.query.mockImplementation((sql) => {
      seen.push(String(sql));
      if (SELECT_LOGIN.test(String(sql))) return Promise.resolve(loginRow({ failed_login_count: 4 }));
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(app).post('/api/auth/login').send({ phone: '94771234567', password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(seen.some((sql) => /locked_until = CASE WHEN/.test(sql))).toBe(true);
  });

  test('a locked account is refused without comparing the password at all', async () => {
    const compare = jest.spyOn(bcrypt, 'compare');
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    mockPool.query.mockImplementation((sql) => {
      if (SELECT_LOGIN.test(String(sql))) return Promise.resolve(loginRow({ locked_until: future }));
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(app).post('/api/auth/login').send({ phone: '94771234567', password: 'anything' });
    expect(res.status).toBe(401);
    // Refused before bcrypt, so a lockout cannot be detected by response timing.
    expect(compare).not.toHaveBeenCalled();
    compare.mockRestore();
  });

  test('an expired lock no longer blocks login', async () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    const hash = await bcrypt.hash('tr0ubador-horse-battery', 10);
    mockPool.query.mockImplementation((sql) => {
      if (SELECT_LOGIN.test(String(sql))) {
        return Promise.resolve(loginRow({ locked_until: past, password_hash: hash }));
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(app).post('/api/auth/login').send({ phone: '94771234567', password: 'tr0ubador-horse-battery' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
  });

  test('a successful login clears the counter', async () => {
    const seen = [];
    const hash = await bcrypt.hash('tr0ubador-horse-battery', 10);
    mockPool.query.mockImplementation((sql) => {
      seen.push(String(sql));
      if (SELECT_LOGIN.test(String(sql))) {
        return Promise.resolve(loginRow({ failed_login_count: 3, password_hash: hash }));
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(app).post('/api/auth/login').send({ phone: '94771234567', password: 'tr0ubador-horse-battery' });
    expect(res.status).toBe(200);
    expect(seen.some((sql) => /failed_login_count = 0/.test(sql))).toBe(true);
  });

  test('every failure mode returns the same message (no account enumeration)', async () => {
    const bodies = [];

    // Unknown phone.
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    bodies.push(
      (
        await request(app)
          .post('/api/auth/login')
          .send({ phone: '94700000000', password: 'x'.repeat(12) })
      ).body
    );

    // Wrong password.
    mockPool.query.mockImplementation((sql) =>
      SELECT_LOGIN.test(String(sql)) ? Promise.resolve(loginRow()) : Promise.resolve({ rows: [], rowCount: 0 })
    );
    bodies.push((await request(app).post('/api/auth/login').send({ phone: '94771234567', password: 'wrong' })).body);

    // Locked.
    const future = new Date(Date.now() + 60000).toISOString();
    mockPool.query.mockImplementation((sql) =>
      SELECT_LOGIN.test(String(sql)) ? Promise.resolve(loginRow({ locked_until: future })) : Promise.resolve({ rows: [], rowCount: 0 })
    );
    bodies.push((await request(app).post('/api/auth/login').send({ phone: '94771234567', password: 'wrong' })).body);

    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]);
    expect(bodies[0]).toEqual({ error: 'Invalid credentials' });
  });

  test('a login failure no longer leaks the raw database error', async () => {
    mockPool.query.mockRejectedValue(new Error('relation "staff_users" does not exist'));
    const res = await request(app)
      .post('/api/auth/login')
      .send({ phone: '94771234567', password: 'x'.repeat(12) });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
    expect(JSON.stringify(res.body)).not.toMatch(/staff_users|relation/);
  });
});

describe('AUDIT HIGH: raw database errors no longer reach the client', () => {
  // Exploit: probe endpoints and read schema details back out of constraint
  // violations (orders_cod_requires_cash_payment, customers_whatsapp_number_canonical)
  // to map the data model.
  const DB_ERROR = new Error('relation "staff_users" does not exist at character 42');

  test.each([
    ['GET', '/api/staff', 'admin'],
    ['GET', '/api/customers', 'admin'],
    ['GET', '/api/orders', 'admin'],
    ['GET', '/api/products', 'admin'],
    ['GET', '/api/leads', 'sales_agent'],
    ['GET', '/api/warranties', 'admin'],
    ['GET', '/api/service-tickets', 'admin'],
  ])('%s %s returns a generic 500 with no schema detail', async (method, path, role) => {
    mockAuthenticatedAs(mockPool, role).nextError(DB_ERROR);
    const res = await request(app)[method.toLowerCase()](path).set(authHeader(role));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    // The decisive assertion: nothing from the DB message survives.
    expect(JSON.stringify(res.body)).not.toMatch(/relation|staff_users|character 42/);
  });

  test('a duplicate-key violation still maps to 409, not a generic 500', async () => {
    // The regression risk of this sweep: six catch blocks pre-check
    // err.code === '23505' and return a 409. A mechanical find-replace would
    // have turned those into 500s.
    const dupe = new Error('duplicate key value violates unique constraint');
    dupe.code = '23505';
    mockAuthenticatedAs(mockPool, 'admin').nextError(dupe);

    const res = await request(app)
      .post('/api/staff')
      .set(authHeader('admin'))
      .send({ name: 'X', phone: '94770000001', password: 'tr0ubador-horse-battery', role: 'viewer' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already registered/i);
  });
});

describe('AUDIT MEDIUM: SSE query token is scoped to /api/events', () => {
  const { tokenFor } = require('./helpers');

  // REGRESSION (production incident): this used to assert only that
  // QUERY_TOKEN_PATHS contained the string '/api/events' — which stayed true
  // the entire time the feature was broken in production, so the test passed
  // while every live EventSource connection was rejected with 401.
  //
  // The bug: authenticate() is mounted with app.use('/api', ...), and Express
  // STRIPS the mount prefix from req.path inside a mounted handler. req.path
  // was therefore '/events', never '/api/events', so the allowlist lookup
  // never matched. Asserting on the data structure could not see that; only a
  // real request through the middleware can.
  //
  // So this now asserts the OBSERVABLE behaviour: a query token must actually
  // authenticate on /api/events.
  test('/api/events actually authenticates a ?token= (not just allowlisted)', async () => {
    mockAuthenticatedAs(mockPool, 'admin');

    // The SSE handler never ends the response, so supertest would hang waiting
    // for a body. A raw http request against a real listening socket lets the
    // connection be destroyed as soon as the status line arrives — which is
    // the only thing under test: reaching the handler at all (not 401) proves
    // the middleware accepted the query token.
    const http = require('http');
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      const status = await new Promise((resolve, reject) => {
        const req = http.get(
          { host: '127.0.0.1', port, path: `/api/events?token=${tokenFor('admin')}` },
          (res) => {
            resolve(res.statusCode);
            res.destroy();
            req.destroy();
          }
        );
        req.on('error', reject);
      });

      expect(status).not.toBe(401);
      expect(status).toBe(200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('the allowlist is keyed on the full path, including the /api mount prefix', () => {
    // Guards the specific mistake above: an entry written without the mount
    // prefix would silently never match once mounted under app.use('/api').
    const { QUERY_TOKEN_PATHS } = require('../index');
    if (QUERY_TOKEN_PATHS) {
      for (const p of QUERY_TOKEN_PATHS) {
        expect(p.startsWith('/api/')).toBe(true);
      }
      expect(QUERY_TOKEN_PATHS.has('/api/events')).toBe(true);
      expect(QUERY_TOKEN_PATHS.has('/api/auth/me')).toBe(false);
    }
  });

  test('a query token is refused on every other route', async () => {
    for (const path of ['/api/auth/me', '/api/customers', '/api/orders', '/api/staff']) {
      mockAuthenticatedAs(mockPool, 'admin');
      const res = await request(app)
        .get(path)
        .query({ token: tokenFor('admin') });
      expect({ path, status: res.status }).toEqual({ path, status: 401 });
    }
  });
});

describe('AUDIT MEDIUM: delivery auto-payment is COD-only', () => {
  function order(extra = {}) {
    return {
      rows: [
        {
          id: 'o1',
          total_amount: '100000',
          amount_paid: '0',
          payment_status: 'pending',
          payment_method: 'cash',
          delivery_method: 'cash_on_delivery',
          ...extra,
        },
      ],
      rowCount: 1,
    };
  }

  test('a COD order records the balance on delivery (the workflow must keep working)', async () => {
    const seen = [];
    mockPool.query.mockImplementation((sql, params) => {
      const text = String(sql);
      seen.push([text, params]);
      if (/FROM staff_users WHERE id=\$1/.test(text)) {
        return Promise.resolve({
          rows: [{ id: 'staff-1', name: 'D', role: 'delivery_coordinator', active: true }],
          rowCount: 1,
        });
      }
      if (/SELECT total_amount, payment_status, amount_paid, payment_method, delivery_method/.test(text)) {
        return Promise.resolve(order());
      }
      return Promise.resolve({ rows: [{ id: 'o1' }], rowCount: 1 });
    });

    const res = await request(app)
      .patch('/api/orders/o1')
      .set(authHeader('delivery_coordinator'))
      .send({ status: 'delivered', delivery_confirmation_note: 'handed over' });

    expect(res.status).toBe(200);
    expect(seen.some(([sql]) => /INSERT INTO order_payments/.test(sql))).toBe(true);
  });

  test('a NON-COD order does not invent a cash payment', async () => {
    // Exploit: a card-prepaid or disputed order marked delivered was silently
    // recorded as fully collected in cash, in the coordinator's name.
    const seen = [];
    mockPool.query.mockImplementation((sql, params) => {
      const text = String(sql);
      seen.push([text, params]);
      if (/FROM staff_users WHERE id=\$1/.test(text)) {
        return Promise.resolve({
          rows: [{ id: 'staff-1', name: 'D', role: 'delivery_coordinator', active: true }],
          rowCount: 1,
        });
      }
      if (/SELECT total_amount, payment_status, amount_paid, payment_method, delivery_method/.test(text)) {
        return Promise.resolve(order({ delivery_method: 'delivery', payment_method: 'card' }));
      }
      return Promise.resolve({ rows: [{ id: 'o1' }], rowCount: 1 });
    });

    await request(app)
      .patch('/api/orders/o1')
      .set(authHeader('delivery_coordinator'))
      .send({ status: 'delivered', delivery_confirmation_note: 'handed over' });

    expect(seen.some(([sql]) => /INSERT INTO order_payments/.test(sql))).toBe(false);
  });
});

describe('AUDIT MEDIUM: customer identity on an order is gated', () => {
  test('finance can no longer rewrite customer_phone', async () => {
    // orders.customer_phone is where the confirmation and payment receipt are
    // SENT, so an edit there redirects a customer's messages.
    mockAuthenticatedAs(mockPool, 'finance');
    const res = await request(app).patch('/api/orders/o1').set(authHeader('finance')).send({ customer_phone: '94770009999' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/items\/pricing|Sales Agent or Admin/i);
  });

  test('sales_agent and admin still can', async () => {
    const id = '11111111-1111-1111-1111-111111111111';
    for (const role of ['admin', 'sales_agent']) {
      const db = mockAuthenticatedAs(mockPool, role);
      // A sales agent first passes the ownership check (058) — their own order.
      if (role === 'sales_agent') db.next({ rows: [{}], rowCount: 1 });
      db.next({ rows: [{ id }], rowCount: 1 });
      const res = await request(app).patch(`/api/orders/${id}`).set(authHeader(role)).send({ customer_phone: '94770009999' });
      expect({ role, ok: res.status < 400 }).toEqual({ role, ok: true });
    }
  });
});

describe('AUDIT Phase 6: unknown request fields are rejected, not dropped', () => {
  // The column allowlists already stopped mass assignment at the DB layer.
  // The gap was that an unknown key was silently DISCARDED, so a client
  // sending {"name":"x","role":"admin"} got a 200 and could reasonably
  // believe the role had been set.
  test.each([
    ['/api/staff/s1', 'admin', { name: 'x', role: 'admin', isAdmin: true }],
    ['/api/customers/c1', 'admin', { name: 'x', priority_score: 3 }],
    ['/api/campaigns/g1', 'admin', { name: 'x', status: 'active', sent_count: 999 }],
    ['/api/influencers/i1', 'admin', { name: 'x', commission_percent: 4, total_paid: 100000 }],
    ['/api/service-tickets/t1', 'admin', { status: 'open', priority_score: 3 }],
  ])('PATCH %s rejects an unexpected field', async (path, role, body) => {
    mockAuthenticatedAs(mockPool, role);
    const res = await request(app).patch(path).set(authHeader(role)).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown field/i);
  });

  test('a body containing only permitted fields still works', async () => {
    mockPool.connect = jest.fn().mockResolvedValue({ query: (...a) => mockPool.query(...a), release: jest.fn() });
    mockAuthenticatedAs(mockPool, 'admin')
      .next({ rows: [], rowCount: 0 }) // BEGIN
      .next({ rows: [{ id: '00000000-0000-0000-0000-00000000051a', name: 'Old', role: 'viewer', active: true }], rowCount: 1 }) // lock
      .next({ rows: [{ id: '00000000-0000-0000-0000-00000000051a', name: 'Renamed', role: 'viewer', active: true }], rowCount: 1 });
    const res = await request(app).patch('/api/staff/00000000-0000-0000-0000-00000000051a').set(authHeader('admin')).send({ name: 'Renamed' });
    expect(res.status).toBe(200);
  });

  test('the error names the offending field AND what is allowed', async () => {
    mockAuthenticatedAs(mockPool, 'admin');
    const res = await request(app).patch('/api/staff/s1').set(authHeader('admin')).send({ role: 'admin', nope: 1 });
    expect(res.body.error).toContain('nope');
    expect(res.body.error).toContain('name');
    // The legitimate field in the same body must NOT be listed as unknown.
    expect(res.body.error.split('Allowed:')[0]).not.toContain('role');
  });
});

describe('AUDIT Phase 6: free-text fields are length-bounded', () => {
  test('an oversized name is rejected (Postgres TEXT has no limit of its own)', async () => {
    mockAuthenticatedAs(mockPool, 'admin');
    const res = await request(app)
      .patch('/api/customers/c1')
      .set(authHeader('admin'))
      .send({ name: 'x'.repeat(5000) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too long/i);
  });

  test('a normal-length name still passes', async () => {
    mockAuthenticatedAs(mockPool, 'admin').next({ rows: [{ id: 'c1', name: 'Somawathi' }], rowCount: 1 });
    const res = await request(app).patch('/api/customers/c1').set(authHeader('admin')).send({ name: 'Somawathi' });
    expect(res.status).toBe(200);
  });
});

describe('AUDIT Phase 7: order responses are minimized per role', () => {
  const FULL_ORDER = {
    id: 'o1',
    order_number: 'ORD-1',
    customer_name: 'Somawathi',
    customer_phone: '94770001111',
    total_amount: '97000',
    payment_status: 'pending',
    status: 'confirmed',
    delivery_address: '12 Lake Rd',
    delivery_method: 'cash_on_delivery',
    items: [],
    // The internal money trail this role has no use for:
    amount_paid: '20000',
    advance_required: '20000',
    is_custom_order: true,
    notes: 'internal: customer haggled',
    lead_id: 'lead-9',
  };
  const HIDDEN = ['amount_paid', 'advance_required', 'is_custom_order', 'notes', 'lead_id'];

  test('delivery_coordinator does not receive the internal money trail', async () => {
    mockAuthenticatedAs(mockPool, 'delivery_coordinator').next({ rows: [FULL_ORDER], rowCount: 1 });
    const res = await request(app).get('/api/orders/o1').set(authHeader('delivery_coordinator'));

    expect(res.status).toBe(200);
    for (const f of HIDDEN) expect(res.body.order).not.toHaveProperty(f);
    // But keeps what the delivery screen actually renders, including the COD
    // amount they must collect.
    expect(res.body.order.total_amount).toBe('97000');
    expect(res.body.order.payment_status).toBe('pending');
    expect(res.body.order.delivery_address).toBe('12 Lake Rd');
  });

  test('the list is minimized too, not just the detail route', async () => {
    mockAuthenticatedAs(mockPool, 'delivery_coordinator').next({ rows: [FULL_ORDER], rowCount: 1 });
    const res = await request(app).get('/api/orders').set(authHeader('delivery_coordinator'));
    expect(res.status).toBe(200);
    for (const f of HIDDEN) expect(res.body.orders[0]).not.toHaveProperty(f);
  });

  test('finance and admin still receive the full record', async () => {
    for (const role of ['admin', 'finance']) {
      mockAuthenticatedAs(mockPool, role).next({ rows: [FULL_ORDER], rowCount: 1 });
      const res = await request(app).get('/api/orders/o1').set(authHeader(role));
      expect({ role, amount_paid: res.body.order.amount_paid }).toEqual({ role, amount_paid: '20000' });
      expect(res.body.order.notes).toBe('internal: customer haggled');
    }
  });
});

// ── missed-call callback tracker (migration 043) ─────────────────────────────
// The tracker reshapes the same call-log data the Calls page serves, but behind
// a narrower gate: it is a sales accountability worklist, so admin/sales_agent
// only. The threshold that decides done-vs-pending is admin-only on top of that.
describe('missed-call callback tracker role gates', () => {
  const ALLOWED = ['admin', 'sales_agent'];

  test('GET /api/calls/callbacks denies every role except admin and sales_agent', async () => {
    for (const role of ALL_ROLES.filter((r) => !ALLOWED.includes(r))) {
      mockAuthenticatedAs(mockPool, role);
      const res = await request(app).get('/api/calls/callbacks').set(authHeader(role));
      expect({ role, status: res.status }).toEqual({ role, status: 403 });
    }
  });

  test('GET /api/calls/callbacks allows admin and sales_agent', async () => {
    for (const role of ALLOWED) {
      mockAuthenticatedAs(mockPool, role);
      const res = await request(app).get('/api/calls/callbacks').set(authHeader(role));
      expect({ role, denied: res.status === 403 }).toEqual({ role, denied: false });
    }
  });

  test('GET /api/settings/callback-threshold denies every non-admin role', async () => {
    for (const role of ALL_ROLES.filter((r) => r !== 'admin')) {
      mockAuthenticatedAs(mockPool, role);
      const res = await request(app).get('/api/settings/callback-threshold').set(authHeader(role));
      expect({ role, status: res.status }).toEqual({ role, status: 403 });
    }
  });

  // Asserts 403, NOT 400, against a body that would fail validation. The role
  // gate is middleware and must fire BEFORE the handler reads the body — if a
  // refactor moved validation into middleware these would turn into 400s, which
  // would mean a non-admin could probe the route's validation behaviour.
  test('PATCH /api/settings/callback-threshold denies every non-admin role before validating the body', async () => {
    for (const role of ALL_ROLES.filter((r) => r !== 'admin')) {
      mockAuthenticatedAs(mockPool, role);
      const res = await request(app)
        .patch('/api/settings/callback-threshold')
        .set(authHeader(role))
        .send({ seconds: 'not-a-number' });
      expect({ role, status: res.status }).toEqual({ role, status: 403 });
    }
  });

  test('PATCH /api/settings/callback-threshold allows admin', async () => {
    mockAuthenticatedAs(mockPool, 'admin');
    const res = await request(app)
      .patch('/api/settings/callback-threshold')
      .set(authHeader('admin'))
      .send({ seconds: 30 });
    expect(res.status).not.toBe(403);
  });

  // Both settings pairs are admin-only switches on app_settings; pinning them
  // to each other means a gate that drifts on one is caught here.
  test('callback-threshold gates match the auto-assign gates exactly', async () => {
    for (const role of ALL_ROLES) {
      mockAuthenticatedAs(mockPool, role);
      const viaCallback = await request(app).get('/api/settings/callback-threshold').set(authHeader(role));
      const viaAutoAssign = await request(app).get('/api/settings/auto-assign').set(authHeader(role));
      expect({ role, denied: viaCallback.status === 403 }).toEqual({
        role,
        denied: viaAutoAssign.status === 403,
      });

      mockAuthenticatedAs(mockPool, role);
      const patchCallback = await request(app)
        .patch('/api/settings/callback-threshold').set(authHeader(role)).send({ seconds: 20 });
      const patchAutoAssign = await request(app)
        .patch('/api/settings/auto-assign').set(authHeader(role)).send({ enabled: true });
      expect({ role, denied: patchCallback.status === 403 }).toEqual({
        role,
        denied: patchAutoAssign.status === 403,
      });
    }
  });
});

describe('super_admin (migration 045): reaches everything, changes nothing else', () => {
  const { tokenFor } = require('./helpers');

  // The role is granted by a SHORT-CIRCUIT inside requireRole() rather than by
  // being listed at each of the 68 call sites that name 'admin'. That is one
  // line covering 83 gates, which is exactly why it needs its own tests: a
  // mistake there is invisible in a diff and would either open everything to
  // the wrong people or silently fail to open anything.
  //
  // Routes below are picked to span the gate shapes: admin-only, a
  // multi-role set, a set that excludes a specific role, and the one route
  // super_admin alone may reach.
  const GATED = [
    ['GET', '/api/staff'], //      requireRole('admin')
    ['GET', '/api/activity'], //   requireRole('admin','viewer')
    ['GET', '/api/inventory'], //  requireRole('admin','inventory_manager','viewer')
    ['GET', '/api/performance'], //requireRole('admin','viewer','sales_agent')
    ['GET', '/api/reports/sales_funnel'],
  ];

  test('passes every kind of role gate', async () => {
    for (const [method, path] of GATED) {
      mockAuthenticatedAs(mockPool, 'super_admin');
      const res = await request(app)[method.toLowerCase()](path).set(authHeader('super_admin'));
      expect({ path, forbidden: res.status === 403 }).toEqual({ path, forbidden: false });
    }
  });

  test('reaches a route no other role can (its own oversight feed)', async () => {
    mockAuthenticatedAs(mockPool, 'super_admin');
    const ok = await request(app).get('/api/staff-activity').set(authHeader('super_admin'));
    expect(ok.status).not.toBe(403);

    for (const role of ALL_ROLES) {
      mockAuthenticatedAs(mockPool, role);
      const res = await request(app).get('/api/staff-activity').set(authHeader(role));
      expect({ role, forbidden: res.status === 403 }).toEqual({ role, forbidden: true });
    }
  });

  // The narrowing that came with this role, asserted explicitly because it is
  // the ONE thing an existing role lost: admin could restore a deleted record
  // before migration 045 and now cannot.
  test('restore is super_admin only — admin is refused', async () => {
    mockAuthenticatedAs(mockPool, 'admin');
    const asAdmin = await request(app).post('/api/deleted/orders/o1/restore').set(authHeader('admin'));
    expect(asAdmin.status).toBe(403);

    mockAuthenticatedAs(mockPool, 'super_admin');
    const asSuper = await request(app).post('/api/deleted/orders/o1/restore').set(authHeader('super_admin'));
    expect(asSuper.status).not.toBe(403);
  });

  // Listing stays open to admin on purpose: they can still SEE what was
  // removed and ask for it back, they just cannot bring it back themselves.
  test('admin can still list the bin', async () => {
    mockAuthenticatedAs(mockPool, 'admin');
    const res = await request(app).get('/api/deleted/orders').set(authHeader('admin'));
    expect(res.status).not.toBe(403);
  });

  // The short-circuit sits AFTER the req.staff check. If the two were ever
  // reordered, a request with no token at all would be evaluated against an
  // undefined role instead of being rejected — this pins that ordering.
  test('an unauthenticated request is still 401, never short-circuited', async () => {
    const res = await request(app).get('/api/staff-activity');
    expect(res.status).toBe(401);
  });

  // The role is re-read from the database on every request, so a token still
  // claiming super_admin after a demotion must not keep the access.
  test('a demoted super_admin loses access immediately, despite the old claim', async () => {
    mockAuthenticatedAs(mockPool, 'viewer'); // DB now says viewer
    const res = await request(app).get('/api/staff-activity').set({
      Authorization: `Bearer ${tokenFor('super_admin')}`,
    });
    expect(res.status).toBe(403);
  });
});

// ── SSE query token (?token=) ────────────────────────────────────────────────
// EventSource cannot send an Authorization header, so /api/events — and ONLY
// /api/events — accepts the token in the query string.
//
// These exist because that scoping was silently broken: it matched against
// req.path, but authenticate() is mounted with app.use('/api', ...), and
// Express strips the mount point inside a mounted middleware. req.path read
// '/events', never '/api/events', so the query token was refused everywhere
// including the one route meant to allow it. The failure was invisible in
// normal use — every other route sends a real header and kept working, while
// live updates just never arrived.
describe('SSE query-parameter token', () => {
  const { tokenFor } = require('./helpers');

  test('/api/events accepts a token in the query string', async () => {
    mockAuthenticatedAs(mockPool, 'sales_agent');
    const res = await request(app)
      .get(`/api/events?token=${tokenFor('sales_agent')}`)
      // Without this the SSE stream never ends and the test hangs.
      .timeout({ deadline: 1500 })
      .catch(err => err.response || { status: 'timeout-while-streaming' });
    // A 200 or an aborted in-flight stream both prove authentication passed;
    // the point is only that it is not 401.
    expect(res.status).not.toBe(401);
  });

  test('/api/events still rejects a request with no token', async () => {
    const res = await request(app).get('/api/events');
    expect(res.status).toBe(401);
  });

  test('/api/events still rejects a malformed token', async () => {
    const res = await request(app).get('/api/events?token=not.a.jwt');
    expect(res.status).toBe(401);
  });

  // The whole reason the allowlist exists: a token in a URL lands in nginx
  // access logs, browser history and Referer headers. It must buy access to
  // the SSE stream and nothing else.
  test.each(['/api/calls', '/api/leads', '/api/orders', '/api/customers'])(
    'a query token does NOT authenticate %s',
    async path => {
      mockAuthenticatedAs(mockPool, 'admin');
      const res = await request(app).get(`${path}?token=${tokenFor('admin')}`);
      expect(res.status).toBe(401);
    }
  );
});

// ── Call-lead ownership visibility (migration 025) ───────────────────────────
// A lead sourced from a phone call is visible only to the agent it is assigned
// to, plus the oversight roles. These assert the SQL the route actually builds,
// because two separate bugs hid in it and neither was caught by anything:
//
//   1. super_admin was missing from the unrestricted list, so the role that is
//      meant to see everything saw only non-call leads (888 hidden in prod).
//   2. the filter named only 'Call tracker app', while 'Dialog call' — the
//      retired integration, still on 86 open production rows — means "call"
//      too, so those leaked to every agent regardless of assignment.
describe('call-lead visibility filter', () => {
  const { tokenFor } = require('./helpers');

  /** The WHERE clause GET /api/leads actually sent. */
  async function whereClauseFor(role) {
    let sql = '';
    mockAuthenticatedAs(mockPool, role, {
      rest: (...args) => {
        const text = typeof args[0] === 'string' ? args[0] : args[0] && args[0].text;
        if (text && /FROM leads l/.test(text)) sql = text;
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    });
    await request(app).get('/api/leads').set({ Authorization: `Bearer ${tokenFor(role)}` });
    return sql;
  }

  test.each(['admin', 'viewer', 'super_admin'])('%s gets no call-source restriction', async role => {
    const sql = await whereClauseFor(role);
    expect(sql).toMatch(/FROM leads l/);
    expect(sql).not.toMatch(/assigned_staff_id = \$/);
  });

  test('a sales_agent IS restricted to their own call leads', async () => {
    const sql = await whereClauseFor('sales_agent');
    expect(sql).toMatch(/assigned_staff_id = \$/);
  });

  // The regression that matters: the clause must cover BOTH call sources, not
  // just the current one. Asserted on the parameter, since the sources are now
  // bound rather than inlined.
  test('the restriction covers both call source strings', async () => {
    let params = null;
    mockAuthenticatedAs(mockPool, 'sales_agent', {
      rest: (...args) => {
        const text = typeof args[0] === 'string' ? args[0] : args[0] && args[0].text;
        if (text && /FROM leads l/.test(text)) params = args[1];
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    });
    await request(app).get('/api/leads').set({ Authorization: `Bearer ${tokenFor('sales_agent')}` });
    const sources = (params || []).find(p => Array.isArray(p));
    expect(sources).toEqual(expect.arrayContaining(['Call tracker app', 'Dialog call']));
  });
});
