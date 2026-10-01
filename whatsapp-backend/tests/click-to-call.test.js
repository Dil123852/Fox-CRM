// Click-to-call (migration 050): pairing a Call Tracker phone, the per-device
// token, POST /api/dial, and — the property the whole feature rests on — that
// a dial command reaches ONLY the clicker's own phone.
//
// pg is mocked by SQL pattern rather than by a result queue: these routes run
// several queries whose order is an implementation detail, and the stream test
// has two requests in flight at once, which a single shared queue cannot model.

jest.mock('pg');
jest.mock('@anthropic-ai/sdk', () => require('./__mocks__/anthropic'));

const http = require('http');
const crypto = require('crypto');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { mockPool } = require('pg');
const { authHeader } = require('./helpers');

const { app } = require('../index');

const AGENT_A = '00000000-0000-0000-0000-00000000000a';
const AGENT_B = '00000000-0000-0000-0000-00000000000b';
const DEVICE_A = '00000000-0000-0000-0000-0000000000da';
const DEVICE_B = '00000000-0000-0000-0000-0000000000db';
const CUSTOMER = '00000000-0000-0000-0000-0000000000c1';
const LEAD = '00000000-0000-0000-0000-0000000000e1';
const REQUEST_ID = '00000000-0000-0000-0000-0000000000f1';

const TOKEN_A = 'a'.repeat(43);
const TOKEN_B = 'b'.repeat(43);
const sha = t => crypto.createHash('sha256').update(t).digest('hex');

const ADMIN_C = '00000000-0000-0000-0000-00000000000c';
const STAFF = {
  [AGENT_A]: { id: AGENT_A, name: 'Agent A', role: 'sales_agent', active: true },
  [AGENT_B]: { id: AGENT_B, name: 'Agent B', role: 'sales_agent', active: true },
  [ADMIN_C]: { id: ADMIN_C, name: 'Admin C', role: 'admin', active: true },
};

let devices; // token hash -> device row (as lookupDevice's JOIN returns it)
let activeDeviceFor; // staff id -> device id
let recentDialFor; // staff ids with a dial in the last 10s
let leadVisible;
let customer;

function row(rows) {
  return { rows, rowCount: rows.length };
}

/** Answer each query by what it is, so order does not matter. */
function installDb(extra = []) {
  mockPool.query.mockImplementation((sqlOrCfg, params = []) => {
    const sql = typeof sqlOrCfg === 'string' ? sqlOrCfg : sqlOrCfg.text;
    for (const [re, fn] of extra) if (re.test(sql)) return Promise.resolve(fn(params, sql));

    if (/FROM staff_users WHERE id=\$1/.test(sql)) return Promise.resolve(row(STAFF[params[0]] ? [STAFF[params[0]]] : []));
    if (/FROM staff_devices d\s+JOIN staff_users s ON s.id = d.staff_id\s+WHERE d.token_hash/.test(sql)) {
      const d = devices[params[0]];
      return Promise.resolve(row(d ? [d] : []));
    }
    if (/SELECT l.id FROM leads l WHERE l.id = \$1/.test(sql)) return Promise.resolve(row(leadVisible ? [{ id: LEAD }] : []));
    if (/SELECT id, name, whatsapp_number FROM customers WHERE id = \$1/.test(sql)) {
      return Promise.resolve(row(customer && params[0] === customer.id ? [customer] : []));
    }
    if (/SELECT id FROM staff_devices WHERE staff_id = \$1 AND revoked_at IS NULL/.test(sql)) {
      const id = activeDeviceFor[params[0]];
      return Promise.resolve(row(id ? [{ id }] : []));
    }
    if (/SELECT 1 FROM dial_requests/.test(sql)) return Promise.resolve(row(recentDialFor.has(params[0]) ? [{ '?column?': 1 }] : []));
    if (/INSERT INTO dial_requests/.test(sql)) {
      return Promise.resolve(
        row([{ id: REQUEST_ID, staff_id: params[0], phone_number: params[4], expires_at: new Date(Date.now() + 60000) }])
      );
    }
    return Promise.resolve(row([]));
  });
}

function sqlCalls(re) {
  return mockPool.query.mock.calls.filter(([s]) => re.test(typeof s === 'string' ? s : s.text));
}

beforeEach(() => {
  jest.clearAllMocks();
  devices = {
    [sha(TOKEN_A)]: { id: DEVICE_A, staff_id: AGENT_A, staff_name: 'Agent A', role: 'sales_agent' },
    [sha(TOKEN_B)]: { id: DEVICE_B, staff_id: AGENT_B, staff_name: 'Agent B', role: 'sales_agent' },
  };
  activeDeviceFor = { [AGENT_A]: DEVICE_A, [AGENT_B]: DEVICE_B };
  recentDialFor = new Set();
  leadVisible = true;
  customer = { id: CUSTOMER, name: 'Chaminda', whatsapp_number: '94771234567' };
  installDb();
  // Pairing runs in a transaction on a checked-out client; route its queries
  // through the same pattern-matching mock so they are answered and recorded.
  mockPool.connect = jest.fn().mockResolvedValue({ query: (...args) => mockPool.query(...args), release: jest.fn() });
});

describe('POST /api/devices/pair', () => {
  const hash = bcrypt.hashSync('right-password', 4);
  const staffByPhone = role => [
    /FROM staff_users\s+WHERE active=true AND phone = ANY/,
    () => row([{ id: AGENT_A, name: 'Agent A', phone: '94770000001', password_hash: hash, role }]),
  ];

  test('requires phone and password', async () => {
    const res = await request(app).post('/api/devices/pair').send({ phone: '94770000001' });
    expect(res.status).toBe(400);
  });

  test('wrong password is refused with the same vague error as login', async () => {
    installDb([staffByPhone('sales_agent')]);
    const res = await request(app).post('/api/devices/pair').send({ phone: '94770000001', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
    expect(sqlCalls(/INSERT INTO staff_devices/)).toHaveLength(0);
  });

  test('a role that does not make calls cannot pair a phone', async () => {
    installDb([staffByPhone('delivery_coordinator')]);
    const res = await request(app).post('/api/devices/pair').send({ phone: '94770000001', password: 'right-password' });
    expect(res.status).toBe(403);
    expect(sqlCalls(/INSERT INTO staff_devices/)).toHaveLength(0);
  });

  test('success returns the token once and stores only its SHA-256', async () => {
    installDb([staffByPhone('sales_agent'), [/INSERT INTO staff_devices/, () => row([{ id: DEVICE_A }])]]);
    const res = await request(app)
      .post('/api/devices/pair')
      .send({ phone: '94770000001', password: 'right-password', deviceName: 'Galaxy A15' });

    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body.staff).toEqual({ id: AGENT_A, name: 'Agent A', role: 'sales_agent' });

    const [[, params]] = sqlCalls(/INSERT INTO staff_devices/);
    expect(params).toEqual([AGENT_A, 'Galaxy A15', sha(res.body.token)]);
    expect(params).not.toContain(res.body.token);

    // The previous phone is revoked BEFORE the insert, inside one
    // transaction (a single-statement CTE fails the unique index in real
    // Postgres — see the route).
    const order = mockPool.query.mock.calls.map(([s]) => String(s).trim().split(/\s+/).slice(0, 2).join(' '));
    const at = s => order.findIndex(o => o.startsWith(s));
    expect(at('BEGIN')).toBeGreaterThan(-1);
    expect(at('UPDATE staff_devices')).toBeGreaterThan(at('BEGIN'));
    expect(at('INSERT INTO')).toBeGreaterThan(at('UPDATE staff_devices'));
    expect(at('COMMIT')).toBeGreaterThan(at('INSERT INTO'));
  });
});

describe('device token', () => {
  test('the legacy shared key cannot open a phone stream', async () => {
    const res = await request(app).get('/api/devices/stream').set('X-API-Key', process.env.CALL_TRACKER_API_KEY);
    expect(res.status).toBe(401);
  });

  test('an unknown or revoked device token is refused, never falling back to the shared key', async () => {
    const res = await request(app)
      .post('/api/calls')
      .set('Authorization', `Device ${'z'.repeat(43)}`)
      .set('X-API-Key', process.env.CALL_TRACKER_API_KEY)
      .send({ calls: [] });
    expect(res.status).toBe(401);
  });

  test('a demoted owner loses their phone immediately', async () => {
    devices[sha(TOKEN_A)].role = 'viewer';
    const res = await request(app).post('/api/calls').set('Authorization', `Device ${TOKEN_A}`).send({ calls: [] });
    expect(res.status).toBe(401);
  });

  test('a paired phone syncs, and its owner comes from the device — not the typed ownerPhone', async () => {
    const res = await request(app)
      .post('/api/calls')
      .set('Authorization', `Device ${TOKEN_A}`)
      .send({ calls: [], ownerPhone: '94779999999' });
    expect(res.status).toBe(200);
    expect(sqlCalls(/FROM staff_users WHERE phone=\$1 AND active=true/)).toHaveLength(0);
  });

  test('the legacy shared key is refused by default, and syncs only while explicitly allowed', async () => {
    const legacy = () => request(app).post('/api/calls').set('X-API-Key', process.env.CALL_TRACKER_API_KEY).send({ calls: [] });
    expect((await legacy()).status).toBe(401);
    process.env.CALL_TRACKER_ALLOW_LEGACY_KEY = 'true';
    try {
      expect((await legacy()).status).toBe(200);
    } finally {
      delete process.env.CALL_TRACKER_ALLOW_LEGACY_KEY;
    }
  });
});

describe('POST /api/dial', () => {
  const dial = (body, staffId = AGENT_A, role = 'sales_agent') =>
    request(app).post('/api/dial').set(authHeader(role, { id: staffId })).send(body);

  test('roles that do not make calls are refused', async () => {
    // authenticate() takes the role from the DB row, not the token, so the
    // gate is exercised by giving the caller's row a non-calling role.
    STAFF[AGENT_A].role = 'viewer';
    try {
      const res = await dial({ customerId: CUSTOMER });
      expect(res.status).toBe(403);
      expect(sqlCalls(/INSERT INTO dial_requests/)).toHaveLength(0);
    } finally {
      STAFF[AGENT_A].role = 'sales_agent';
    }
  });

  test('customerId is required and must be a UUID', async () => {
    expect((await dial({})).status).toBe(400);
    expect((await dial({ customerId: '1; drop table' })).status).toBe(400);
  });

  test('the number dialled comes from the customer record, never the request body', async () => {
    const res = await dial({ customerId: CUSTOMER, number: '+1999000000' });
    expect(res.status).toBe(200);
    const [[, params]] = sqlCalls(/INSERT INTO dial_requests/);
    expect(params[4]).toBe('94771234567');
  });

  test('no paired phone gives an explanatory 409', async () => {
    delete activeDeviceFor[AGENT_A];
    const res = await dial({ customerId: CUSTOMER });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_DEVICE');
  });

  test('a second click within the repeat window is refused', async () => {
    recentDialFor.add(AGENT_A);
    const res = await dial({ customerId: CUSTOMER });
    expect(res.status).toBe(429);
    expect(sqlCalls(/INSERT INTO dial_requests/)).toHaveLength(0);
  });

  test("a sales agent cannot dial through a lead they are not allowed to see", async () => {
    leadVisible = false;
    const res = await dial({ customerId: CUSTOMER, leadId: LEAD });
    expect(res.status).toBe(404);
    // The same call-ownership rule as GET /api/leads is applied.
    const [[sql]] = sqlCalls(/SELECT l.id FROM leads l/);
    expect(sql).toMatch(/l.assigned_staff_id = \$\d/);
  });

  test('an offline phone records the request as pending', async () => {
    const res = await dial({ customerId: CUSTOMER });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requestId: REQUEST_ID, deviceOnline: false, status: 'pending' });
  });

  test('a customer with no usable number is refused', async () => {
    customer.whatsapp_number = '12';
    const res = await dial({ customerId: CUSTOMER });
    expect(res.status).toBe(422);
  });
});

describe('POST /api/devices/dial/:id/status', () => {
  const report = (body, token = TOKEN_A) =>
    request(app).post(`/api/devices/dial/${REQUEST_ID}/status`).set('Authorization', `Device ${token}`).send(body);

  test('rejects a status the phone may not set', async () => {
    expect((await report({ status: 'pending' })).status).toBe(400);
    expect((await report({ status: 'anything' })).status).toBe(400);
  });

  test("is scoped to the phone owner's own requests", async () => {
    // The UPDATE matches no row (it belongs to someone else) -> 404.
    const res = await report({ status: 'dialing' });
    expect(res.status).toBe(404);
    const [[, params]] = sqlCalls(/UPDATE dial_requests\s+SET status = \$1/);
    expect(params).toEqual(['dialing', null, REQUEST_ID, AGENT_A]);
  });

  test('records the status for its own request', async () => {
    installDb([[/UPDATE dial_requests\s+SET status = \$1/, () => row([{ id: REQUEST_ID, staff_id: AGENT_A }])]]);
    const res = await report({ status: 'busy', error: 'already on a call' });
    expect(res.status).toBe(200);
  });
});

// ── The property the feature rests on ────────────────────────────────────────
describe('dial commands reach only the clicker’s phone', () => {
  let server;
  let base;

  beforeAll(done => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });
  afterAll(done => {
    server.close(done);
  });

  /** Opens a phone stream and collects everything written to it. */
  function openStream(token) {
    return new Promise((resolve, reject) => {
      const req = http.get(`${base}/api/devices/stream`, { headers: { Authorization: `Device ${token}` } }, res => {
        const stream = { chunks: '', req, res };
        res.setEncoding('utf8');
        res.on('data', c => {
          stream.chunks += c;
          if (stream.chunks.includes('event: ready')) resolve(stream);
        });
      });
      req.on('error', reject);
    });
  }

  const settle = () => new Promise(r => setTimeout(r, 150));

  test("agent A's click is written to A's stream and never to B's", async () => {
    const a = await openStream(TOKEN_A);
    const b = await openStream(TOKEN_B);
    // finally, not trailing statements: a failed expect() would otherwise
    // leave both streams open and hang the whole Jest run.
    try {
      const res = await request(server)
        .post('/api/dial')
        .set(authHeader('sales_agent', { id: AGENT_A }))
        .send({ customerId: CUSTOMER });
      await settle();

      expect(res.body.deviceOnline).toBe(true);
      expect(a.chunks).toContain('event: dial');
      expect(a.chunks).toContain('"number":"+94771234567"');
      expect(a.chunks).toContain(`"requestId":"${REQUEST_ID}"`);
      expect(b.chunks).not.toContain('event: dial');
    } finally {
      a.req.destroy();
      b.req.destroy();
    }
  });

  test('revoking a phone closes its stream at once', async () => {
    const a = await openStream(TOKEN_A);
    const closed = new Promise(r => a.res.on('end', r));
    try {
      installDb([[/UPDATE staff_devices SET revoked_at = now\(\)\s+WHERE id = \$1/, () => row([{ id: DEVICE_A, staff_id: AGENT_A }])]]);
      STAFF.admin1 = { id: 'admin1', name: 'Admin', role: 'admin', active: true };
      const res = await request(server)
        .delete(`/api/devices/${DEVICE_A}`)
        .set(authHeader('admin', { id: 'admin1' }));

      expect(res.status).toBe(200);
      await expect(closed).resolves.toBeUndefined();
    } finally {
      a.req.destroy();
    }
  });
});

// ── Migration 051: each call records whose phone logged it ──────────────────
describe('call attribution (who actually made the call)', () => {
  const { schemaFlags } = require('../index');
  const sampleCall = { number: '+94771234567', date: 1790000000000, duration: 42, callType: 'OUTGOING', simSlot: 1 };

  beforeEach(() => {
    schemaFlags.callEventStaff = true;
    installDb([[/SELECT \* FROM customers WHERE whatsapp_number=\$1/, () => row([{ id: CUSTOMER }])]]);
  });
  afterAll(() => {
    schemaFlags.callEventStaff = false;
  });

  const insertParams = () => {
    const [[sql, params]] = sqlCalls(/INSERT INTO call_events/);
    const cols = sql.match(/\(([^)]*)\) VALUES/)[1].split(',').map(c => c.trim());
    return Object.fromEntries(cols.map((c, i) => [c, params[i]]));
  };

  test("a paired phone's call records its owner AND the phone — verified", async () => {
    const res = await request(app).post('/api/calls').set('Authorization', `Device ${TOKEN_B}`).send({ calls: [sampleCall] });
    expect(res.status).toBe(200);
    expect(insertParams()).toMatchObject({ staff_id: AGENT_B, device_id: DEVICE_B });
  });

  test('it records the caller even when the customer already has ANOTHER agent’s open lead', async () => {
    // The existing open lead belongs to Agent A; Agent B's phone makes the call.
    installDb([
      [/SELECT \* FROM customers WHERE whatsapp_number=\$1/, () => row([{ id: CUSTOMER }])],
      [/FROM leads WHERE customer_id=\$1 AND ticket_state='open'/, () => row([{ id: LEAD, assigned_staff_id: AGENT_A }])],
    ]);
    await request(app).post('/api/calls').set('Authorization', `Device ${TOKEN_B}`).send({ calls: [sampleCall] });
    expect(sqlCalls(/INSERT INTO leads/)).toHaveLength(0); // A's lead is reused…
    expect(insertParams().staff_id).toBe(AGENT_B); // …but the call is B's
  });

  test('a legacy unpaired app records the claimed owner with NO device — unverified', async () => {
    installDb([
      [/SELECT \* FROM customers WHERE whatsapp_number=\$1/, () => row([{ id: CUSTOMER }])],
      [/SELECT id FROM staff_users WHERE phone=\$1 AND active=true/, () => row([{ id: AGENT_A }])],
    ]);
    process.env.CALL_TRACKER_ALLOW_LEGACY_KEY = 'true';
    try {
      await request(app)
        .post('/api/calls')
        .set('X-API-Key', process.env.CALL_TRACKER_API_KEY)
        .send({ calls: [sampleCall], ownerPhone: '94700000001' });
    } finally {
      delete process.env.CALL_TRACKER_ALLOW_LEGACY_KEY;
    }
    expect(insertParams()).toMatchObject({ staff_id: AGENT_A, device_id: null });
  });

  test('without migration 051 the sync still works and writes the old columns only', async () => {
    schemaFlags.callEventStaff = false;
    const res = await request(app).post('/api/calls').set('Authorization', `Device ${TOKEN_B}`).send({ calls: [sampleCall] });
    expect(res.status).toBe(200);
    expect(insertParams()).not.toHaveProperty('staff_id');
  });

  // Picking an agent is an admin/viewer ability; a sales agent only ever gets
  // their own calls (058, tests/per-agent-visibility.test.js).
  test('GET /api/calls returns who made each call, and an admin can filter by agent', async () => {
    const res = await request(app)
      .get(`/api/calls?staffId=${AGENT_B}`)
      .set(authHeader('admin', { id: ADMIN_C }));
    expect(res.status).toBe(200);
    const [[sql, params]] = sqlCalls(/FROM call_events ce\s+LEFT JOIN customers c ON c.id = ce.customer_id\s+LEFT JOIN staff_users s/);
    expect(sql).toMatch(/s\.name AS staff_name/);
    expect(sql).toMatch(/\(ce\.device_id IS NOT NULL\) AS staff_verified/);
    expect(sql).toMatch(/ce\.staff_id = \$1/);
    expect(params[0]).toBe(AGENT_B);
  });

  test("GET /api/calls?staffId=none finds calls with no recorded agent; a malformed id is ignored", async () => {
    await request(app).get('/api/calls?staffId=none').set(authHeader('admin', { id: ADMIN_C }));
    expect(sqlCalls(/SELECT count\(\*\)::int AS total FROM call_events/)[0][0]).toMatch(/ce\.staff_id IS NULL/);
    jest.clearAllMocks();
    installDb();
    await request(app).get("/api/calls?staffId=1'--").set(authHeader('admin', { id: ADMIN_C }));
    expect(sqlCalls(/SELECT count\(\*\)::int AS total FROM call_events/)[0][0]).not.toMatch(/staff_id/);
  });

  test('GET /api/calls/callbacks returns who missed and who called back', async () => {
    const res = await request(app).get('/api/calls/callbacks').set(authHeader('sales_agent', { id: AGENT_A }));
    expect(res.status).toBe(200);
    const [[sql]] = sqlCalls(/FROM v_missed_call_callbacks v/);
    expect(sql).toMatch(/v\.missed_on_staff_name, v\.called_back_by_staff_id, v\.called_back_by_name/);
  });
});
