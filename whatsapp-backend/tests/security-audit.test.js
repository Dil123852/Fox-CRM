// Fixes from the Call Tracker security audit (click-to-call + mobile app).
// Each describe block names the finding it pins down, so a regression fails
// with the reason attached.

jest.mock('pg');
jest.mock('@anthropic-ai/sdk', () => require('./__mocks__/anthropic'));

const http = require('http');
const crypto = require('crypto');
const request = require('supertest');
const { mockPool } = require('pg');
const { authHeader, tokenFor } = require('./helpers');

const { app } = require('../index');

const AGENT_A = '00000000-0000-0000-0000-00000000000a';
const AGENT_B = '00000000-0000-0000-0000-00000000000b';
const ADMIN = '00000000-0000-0000-0000-0000000000ad';
const CUSTOMER = '00000000-0000-0000-0000-0000000000c1';
const sha = t => crypto.createHash('sha256').update(t).digest('hex');

const STAFF = {
  [AGENT_A]: { id: AGENT_A, name: 'Agent A', role: 'sales_agent', active: true },
  [AGENT_B]: { id: AGENT_B, name: 'Agent B', role: 'sales_agent', active: true },
  [ADMIN]: { id: ADMIN, name: 'Admin', role: 'admin', active: true },
};

// token -> device row. Filled per test so every test gets fresh rate-limit
// buckets (the limiter keys on the token).
let devices;
let customerNumber;
let dialsLastHour;
let extra;

const row = r => ({ rows: r, rowCount: r.length });

beforeEach(() => {
  jest.clearAllMocks();
  devices = {};
  customerNumber = '94771234567';
  dialsLastHour = 0;
  extra = [];
  mockPool.query.mockImplementation((sql, params = []) => {
    const q = typeof sql === 'string' ? sql : sql.text;
    for (const [re, fn] of extra) if (re.test(q)) return Promise.resolve(fn(params, q));
    if (/FROM staff_users WHERE id=\$1/.test(q)) return Promise.resolve(row(STAFF[params[0]] ? [STAFF[params[0]]] : []));
    if (/WHERE d.token_hash = \$1/.test(q)) {
      const d = Object.values(devices).find(x => sha(x.token) === params[0]);
      return Promise.resolve(row(d ? [d.row] : []));
    }
    if (/SELECT id, name, whatsapp_number FROM customers WHERE id = \$1/.test(q)) {
      return Promise.resolve(row([{ id: CUSTOMER, name: 'Chaminda', whatsapp_number: customerNumber }]));
    }
    if (/SELECT id FROM staff_devices WHERE staff_id = \$1 AND revoked_at IS NULL/.test(q)) {
      return Promise.resolve(row([{ id: `dev-of-${params[0]}` }]));
    }
    if (/count\(\*\)::int AS n FROM dial_requests/.test(q)) return Promise.resolve(row([{ n: dialsLastHour }]));
    if (/INSERT INTO dial_requests/.test(q)) {
      return Promise.resolve(row([{ id: 'req-1', staff_id: params[0], phone_number: params[4], expires_at: new Date(Date.now() + 60000) }]));
    }
    return Promise.resolve(row([]));
  });
});

let seq = 0;
/** A paired phone with its own, never-before-used token. */
function phone(staffId, overrides = {}) {
  const token = `${String(++seq).padStart(4, '0')}${'x'.repeat(39)}`;
  const id = `00000000-0000-0000-0000-${String(seq).padStart(12, '0')}`;
  devices[token] = { token, row: { id, staff_id: staffId, staff_name: STAFF[staffId].name, role: 'sales_agent', ...overrides } };
  return { token, id };
}

const dial = (staffId = AGENT_A) =>
  request(app).post('/api/dial').set(authHeader('sales_agent', { id: staffId })).send({ customerId: CUSTOMER });

// ── #2 ───────────────────────────────────────────────────────────────────────
describe('#2 automatic dialing is limited to allowed countries and an hourly cap', () => {
  afterEach(() => {
    delete process.env.DIAL_ALLOWED_PREFIXES;
    delete process.env.DIAL_MAX_PER_HOUR;
  });

  test('a Sri Lankan number is dialled', async () => {
    expect((await dial()).status).toBe(200);
  });

  test.each([
    ['a premium/international number', '882123456789'],
    ['a UK number while only +94 is allowed', '447700900123'],
    ['a malformed Sri Lankan number', '9477123'],
  ])('%s is refused', async (_label, number) => {
    customerNumber = number;
    const res = await dial();
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NOT_DIALABLE');
    expect(res.body.error).toMatch(/\+94/);
    expect(mockPool.query.mock.calls.some(([s]) => /INSERT INTO dial_requests/.test(String(s)))).toBe(false);
  });

  test('another country can be allowed by configuration', async () => {
    process.env.DIAL_ALLOWED_PREFIXES = '94,44';
    customerNumber = '447700900123';
    expect((await dial()).status).toBe(200);
  });

  test('the hourly cap stops a script dialling on and on', async () => {
    dialsLastHour = 60;
    const res = await dial();
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('HOURLY_LIMIT');
    expect(mockPool.query.mock.calls.some(([s]) => /INSERT INTO dial_requests/.test(String(s)))).toBe(false);
  });

  test('the cap is configurable', async () => {
    process.env.DIAL_MAX_PER_HOUR = '100';
    dialsLastHour = 60;
    expect((await dial()).status).toBe(200);
  });
});

// ── #3 ───────────────────────────────────────────────────────────────────────
describe('#3 phones are rate-limited per phone, not per shared office network', () => {
  const beat = p => request(app).post('/api/devices/heartbeat').set('Authorization', `Device ${p.token}`);

  test('20 phones on one office Wi-Fi (one IP) all get their heartbeats through', async () => {
    const phones = Array.from({ length: 20 }, () => phone(AGENT_A));
    const statuses = [];
    // 4 heartbeats each = 80 requests from one IP in under a minute. The old
    // per-IP limit of 60/min refused the last 20.
    for (let round = 0; round < 4; round++) {
      for (const p of phones) statuses.push((await beat(p)).status);
    }
    expect(statuses.filter(s => s === 429)).toHaveLength(0);
    expect(new Set(statuses)).toEqual(new Set([204]));
  });

  test('one phone flooding is still stopped at 60 a minute', async () => {
    const p = phone(AGENT_A);
    const statuses = [];
    for (let i = 0; i < 62; i++) statuses.push((await beat(p)).status);
    expect(statuses.slice(0, 60).every(s => s === 204)).toBe(true);
    expect(statuses.slice(60)).toEqual([429, 429]);
  });
});

// ── #6 ───────────────────────────────────────────────────────────────────────
describe('#6 the server log never records a customer’s full number or name', () => {
  test('a call entry that fails to save is logged masked', async () => {
    const p = phone(AGENT_A);
    extra = [[/SELECT \* FROM customers WHERE whatsapp_number=\$1/, () => { throw new Error('db down'); }]];
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await request(app)
        .post('/api/calls')
        .set('Authorization', `Device ${p.token}`)
        .send({ calls: [{ number: '+94771234567', name: 'Chaminda Perera', date: 1790000000000, duration: 5, callType: 'INCOMING' }, { name: 'Missing Number' }] });
      const logged = JSON.stringify(spy.mock.calls);
      expect(logged).not.toMatch(/94771234567|771234567/);
      expect(logged).not.toMatch(/Chaminda|Missing Number/);
      expect(logged).toMatch(/…567/); // still findable by its last digits
    } finally {
      spy.mockRestore();
    }
  });
});

// ── #8 ───────────────────────────────────────────────────────────────────────
describe('#8 a phone key unused for 30 days stops working', () => {
  test('an idle phone is refused and revoked, so it shows as signed out', async () => {
    const p = phone(AGENT_A, { idle_expired: true });
    const res = await request(app).post('/api/devices/heartbeat').set('Authorization', `Device ${p.token}`);
    expect(res.status).toBe(401);
    const revoke = mockPool.query.mock.calls.find(([s]) => /UPDATE staff_devices SET revoked_at = now\(\) WHERE id = \$1/.test(String(s)));
    expect(revoke[1]).toEqual([p.id]);
  });

  test('the idle window is passed to the lookup (default 30 days, configurable)', async () => {
    const p = phone(AGENT_A);
    process.env.DEVICE_TOKEN_IDLE_DAYS = '7';
    try {
      await request(app).post('/api/devices/heartbeat').set('Authorization', `Device ${p.token}`);
      const lookup = mockPool.query.mock.calls.find(([s]) => /WHERE d.token_hash = \$1/.test(String(s)));
      expect(lookup[1][1]).toBe('7');
    } finally {
      delete process.env.DEVICE_TOKEN_IDLE_DAYS;
    }
  });
});

// ── #9 ───────────────────────────────────────────────────────────────────────
describe('#9 call progress and phone status go only to the people concerned', () => {
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

  function dashboard(staffId) {
    const role = STAFF[staffId].role;
    return new Promise(resolve => {
      const s = { text: '' };
      s.req = http.get(`${base}/api/events?token=${tokenFor(role, { id: staffId })}`, res => {
        res.setEncoding('utf8');
        res.on('data', c => (s.text += c));
        resolve(s);
      });
    });
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  test("A's phone connecting is told to A and to admins — not to agent B", async () => {
    const a = await dashboard(AGENT_A);
    const b = await dashboard(AGENT_B);
    const admin = await dashboard(ADMIN);
    const p = phone(AGENT_A);
    const stream = await new Promise(resolve => {
      const r = http.get(`${base}/api/devices/stream`, { headers: { Authorization: `Device ${p.token}` } }, res => resolve({ r, res }));
    });
    await sleep(200);
    stream.r.destroy();
    await sleep(200);
    [a, b, admin].forEach(s => s.req.destroy());

    expect(a.text).toMatch(/event: device_status/);
    expect(admin.text).toMatch(/event: device_status/);
    expect(b.text).not.toMatch(/event: device_status/);
  });

  test("A's call progress is sent to A only", async () => {
    const a = await dashboard(AGENT_A);
    const b = await dashboard(AGENT_B);
    const admin = await dashboard(ADMIN);
    const p = phone(AGENT_A);
    extra = [[/UPDATE dial_requests\s+SET status = \$1/, () => row([{ id: 'req-9', staff_id: AGENT_A }])]];
    await request(server)
      .post('/api/devices/dial/00000000-0000-0000-0000-0000000000f9/status')
      .set('Authorization', `Device ${p.token}`)
      .send({ status: 'dialing' });
    await sleep(150);
    [a, b, admin].forEach(s => s.req.destroy());

    expect(a.text).toMatch(/event: dial_status/);
    expect(b.text).not.toMatch(/event: dial_status/);
    expect(admin.text).not.toMatch(/event: dial_status/);
  });
});

// ── Second audit (2026-09-28) ────────────────────────────────────────────────
describe('/api/calls bounds what one phone can send', () => {
  const insertCall = () => mockPool.query.mock.calls.filter(([q]) => /INSERT INTO call_events/.test(q));
  beforeEach(() => {
    // findOrCreateCustomerByPhone -> an existing customer, so each entry reaches the INSERT.
    extra.push([/FROM customers WHERE whatsapp_number/, () => row([{ id: CUSTOMER, whatsapp_number: '94771234567' }])]);
  });
  const sync = (token, calls) =>
    request(app).post('/api/calls').set('Authorization', `Device ${token}`).send({ calls });

  test('a batch over 500 calls is refused before any work is done', async () => {
    const { token } = phone(AGENT_A);
    const calls = Array.from({ length: 501 }, (_, i) => ({ number: '0771234567', date: 1_700_000_000_000 + i }));
    const res = await sync(token, calls);
    expect(res.status).toBe(413);
    expect(mockPool.query.mock.calls.some(([q]) => /call_events/.test(q))).toBe(false);
  });

  test('stored fields are bounded: long name cut, unknown call type and bad SIM/duration dropped', async () => {
    const { token } = phone(AGENT_A);
    const res = await sync(token, [{
      number: '+94 77 123 4567', name: 'N'.repeat(5000), date: 1_700_000_000_000,
      duration: 'lots', callType: '<script>', simSlot: 99,
    }]);
    expect(res.status).toBe(200);
    const [, vals] = insertCall()[0];
    expect(vals[1]).toBeNull(); // call_type
    expect(vals[2]).toBeNull(); // duration_seconds
    expect(vals[5]).toHaveLength(200); // contact_name
    expect(vals[6]).toBeNull(); // sim_slot
  });

  test('an entry whose "number" is not a phone number is skipped', async () => {
    const { token } = phone(AGENT_A);
    const res = await sync(token, [{ number: 'x'.repeat(40), date: 1_700_000_000_000 }, { number: '1'.repeat(40), date: 1_700_000_000_001 }]);
    expect(res.body.count).toBe(0);
    expect(insertCall()).toHaveLength(0);
  });
});

describe('/api/calls/start does not log the full customer number', () => {
  test('only the last 3 digits reach the log', async () => {
    extra.push([/FROM customers WHERE whatsapp_number/, () => row([{ id: CUSTOMER, whatsapp_number: '94771234567' }])]);
    const { token } = phone(AGENT_A);
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await request(app).post('/api/calls/start').set('Authorization', `Device ${token}`).send({ number: '+94771234567' });
    const lines = log.mock.calls.map(a => a.join(' ')).filter(l => /call start/.test(l));
    log.mockRestore();
    expect(lines.length).toBe(1);
    expect(lines[0]).not.toMatch(/771234567/);
    expect(lines[0]).toMatch(/…567$/);
  });
});
