// QR sign-in for the Call Tracker app (migration 056).
//
// The dashboard asks for a one-time code for the LOGGED-IN staff member, shows
// it as a QR, and the app redeems it for a device token through the same
// issueDeviceToken() password sign-in uses. These tests pin the properties
// that make it safe without an approve step: single use, 5-minute expiry,
// only the newest code works, and the account is re-checked at scan time.

jest.mock('pg');
jest.mock('@anthropic-ai/sdk', () => require('./__mocks__/anthropic'));

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const { mockPool } = require('pg');
const { authHeader } = require('./helpers');

const { app, schemaFlags } = require('../index');

const AGENT = '00000000-0000-0000-0000-0000000000a1';
const OTHER = '00000000-0000-0000-0000-0000000000a2';
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

const PASSWORD = 'Agent-pass-123';
let passwordHash;
beforeAll(async () => { passwordHash = await bcrypt.hash(PASSWORD, 4); });

let staff; // id -> row
let codes; // the device_pair_codes table
let devices; // the staff_devices table
let seq;

function installDb() {
  mockPool.connect = jest.fn().mockResolvedValue({ query: (...a) => mockPool.query(...a), release: jest.fn() });
  mockPool.query.mockImplementation((sql, params = []) => {
    const q = typeof sql === 'string' ? sql : sql.text;
    const ok = (rows) => Promise.resolve({ rows, rowCount: rows.length });
    if (/FROM staff_users WHERE id=\$1/.test(q)) return ok(staff[params[0]] ? [staff[params[0]]] : []);
    if (/SELECT id, name, role, active FROM staff_users WHERE id = \$1/.test(q)) return ok(staff[params[0]] ? [staff[params[0]]] : []);
    if (/SELECT id, role FROM staff_users WHERE id = \$1/.test(q)) return ok(staff[params[0]] ? [{ id: params[0], role: staff[params[0]].role }] : []);
    if (/SELECT phone FROM staff_users WHERE id = \$1/.test(q)) return ok(staff[params[0]] ? [{ phone: staff[params[0]].phone }] : []);
    // verifyStaffCredentials: match any spelling of the login phone.
    if (/FROM staff_users\s+WHERE active=true AND phone = ANY/.test(q)) {
      const u = Object.values(staff).find((x) => x.active && params[0].includes(x.phone));
      return ok(u ? [{ ...u, password_hash: passwordHash, failed_login_count: 0, locked_until: null }] : []);
    }
    if (/UPDATE staff_users SET password_hash=\$1 WHERE id=\$2/.test(q)) return ok(staff[params[1]] ? [{ id: params[1] }] : []);
    if (/UPDATE staff_devices SET revoked_at = now\(\) WHERE staff_id = \$1 AND revoked_at IS NULL RETURNING id/.test(q)) {
      const hit = devices.filter((d) => d.staff_id === params[0] && !d.revoked_at);
      hit.forEach((d) => { d.revoked_at = new Date(); });
      return ok(hit.map((d) => ({ id: d.id })));
    }
    if (/UPDATE device_pair_codes SET used_at = now\(\) WHERE staff_id = \$1 AND used_at IS NULL/.test(q)) {
      codes.filter((c) => c.staff_id === params[0] && !c.used_at).forEach((c) => { c.used_at = new Date(); });
      return ok([]);
    }
    if (/INSERT INTO device_pair_codes/.test(q)) {
      codes.push({ id: `code-${++seq}`, staff_id: params[0], code_hash: params[1], expires_at: new Date(params[2]), used_at: null });
      return ok([]);
    }
    if (/UPDATE device_pair_codes SET used_at = now\(\)\s+WHERE code_hash = \$1/.test(q)) {
      const c = codes.find((x) => x.code_hash === params[0] && !x.used_at && x.expires_at > new Date());
      if (!c) return ok([]);
      c.used_at = new Date();
      return ok([{ id: c.id, staff_id: c.staff_id }]);
    }
    if (/UPDATE device_pair_codes SET used_device_id/.test(q)) {
      const c = codes.find((x) => x.id === params[1]);
      if (c) c.used_device_id = params[0];
      return ok([]);
    }
    if (/UPDATE staff_devices SET revoked_at = now\(\) WHERE staff_id = \$1 AND revoked_at IS NULL/.test(q)) {
      devices.filter((d) => d.staff_id === params[0] && !d.revoked_at).forEach((d) => { d.revoked_at = new Date(); });
      return ok([]);
    }
    if (/INSERT INTO staff_devices/.test(q)) {
      const d = { id: `00000000-0000-0000-0000-${String(++seq).padStart(12, '0')}`, staff_id: params[0], device_name: params[1], token_hash: params[2], revoked_at: null };
      devices.push(d);
      return ok([{ id: d.id }]);
    }
    return ok([]);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  schemaFlags.pairCodes = true;
  seq = 0;
  codes = [];
  devices = [];
  staff = {
    [AGENT]: { id: AGENT, name: 'Kasun', role: 'sales_agent', active: true, phone: '94770000101' },
    [OTHER]: { id: OTHER, name: 'Nimali', role: 'sales_agent', active: true, phone: '94770000102' },
  };
  installDb();
});
afterAll(() => { schemaFlags.pairCodes = false; });

let ip = 0;
const fromNewIp = (r) => r.set('X-Forwarded-For', `10.77.0.${++ip}`);
const makeCode = (id = AGENT, role = 'sales_agent', password = PASSWORD) =>
  request(app).post('/api/devices/pair-codes').set(authHeader(role, { id })).send({ password });
const redeem = (code, deviceName = 'Samsung A12') =>
  fromNewIp(request(app).post('/api/devices/pair/qr')).send({ code, deviceName });

describe('POST /api/devices/pair-codes', () => {
  test('issues a 43-char code for the logged-in staff member, storing only its hash', async () => {
    const res = await makeCode();
    expect(res.status).toBe(200);
    expect(res.body.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codes).toHaveLength(1);
    expect(codes[0].staff_id).toBe(AGENT);
    expect(codes[0].code_hash).toBe(sha(res.body.code));
    expect(JSON.stringify(codes)).not.toContain(res.body.code);
    const minutes = (new Date(res.body.expiresAt) - Date.now()) / 60000;
    expect(minutes).toBeGreaterThan(4.9);
    expect(minutes).toBeLessThanOrEqual(5);
  });

  test('needs a login, and only roles that may pair a phone', async () => {
    expect((await request(app).post('/api/devices/pair-codes')).status).toBe(401);
    staff[AGENT].role = 'viewer';
    expect((await makeCode(AGENT, 'viewer')).status).toBe(403);
  });

  test('503 before migration 056', async () => {
    schemaFlags.pairCodes = false;
    expect((await makeCode()).status).toBe(503);
  });
});

describe('POST /api/devices/pair/qr', () => {
  test('signs the phone in as the code\'s owner — same response shape as password sign-in', async () => {
    const { body } = await makeCode();
    const res = await redeem(body.code);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['device', 'staff', 'token']);
    expect(res.body.staff).toEqual({ id: AGENT, name: 'Kasun', role: 'sales_agent' });
    expect(res.body.device.name).toBe('Samsung A12');
    expect(devices).toHaveLength(1);
    expect(devices[0].token_hash).toBe(sha(res.body.token));
    expect(codes[0].used_device_id).toBe(devices[0].id);
  });

  test('single use: a second scan of the same QR is refused', async () => {
    const { body } = await makeCode();
    expect((await redeem(body.code)).status).toBe(200);
    const again = await redeem(body.code);
    expect(again.status).toBe(401);
    expect(devices).toHaveLength(1);
  });

  test('two phones scanning at once: exactly one wins', async () => {
    const { body } = await makeCode();
    const results = await Promise.all([redeem(body.code), redeem(body.code)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(devices).toHaveLength(1);
  });

  test('an expired code is refused with the same message as an unknown one', async () => {
    const { body } = await makeCode();
    codes[0].expires_at = new Date(Date.now() - 1000);
    const expired = await redeem(body.code);
    const unknown = await redeem('A'.repeat(43));
    expect(expired.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(expired.body.error).toBe(unknown.body.error);
  });

  test('making a new code voids the previous one', async () => {
    const first = (await makeCode()).body.code;
    const second = (await makeCode()).body.code;
    expect((await redeem(first)).status).toBe(401);
    expect((await redeem(second)).status).toBe(200);
  });

  test('an agent deactivated after making the code cannot redeem it', async () => {
    const { body } = await makeCode();
    staff[AGENT].active = false;
    expect((await redeem(body.code)).status).toBe(403);
    expect(devices).toHaveLength(0);
  });

  test('signs out the agent\'s previous phone, and only theirs', async () => {
    devices.push({ id: 'old-mine', staff_id: AGENT, revoked_at: null }, { id: 'old-other', staff_id: OTHER, revoked_at: null });
    const { body } = await makeCode();
    await redeem(body.code);
    expect(devices.find((d) => d.id === 'old-mine').revoked_at).not.toBeNull();
    expect(devices.find((d) => d.id === 'old-other').revoked_at).toBeNull();
  });

  test('a malformed code costs no database lookup', async () => {
    mockPool.query.mockClear();
    const res = await redeem('short');
    expect(res.status).toBe(401);
    expect(mockPool.query.mock.calls.some(([q]) => /device_pair_codes/.test(q))).toBe(false);
  });

  test('503 before migration 056', async () => {
    schemaFlags.pairCodes = false;
    expect((await redeem('A'.repeat(43))).status).toBe(503);
  });
});

describe('password sign-in still works through the shared token path', () => {
  test('POST /api/devices/pair issues the same response shape', async () => {
    const hash = await bcrypt.hash('secret-pass', 4);
    const base = mockPool.query.getMockImplementation();
    mockPool.query.mockImplementation((sql, params) => {
      if (/FROM staff_users\s+WHERE/i.test(sql) && /phone/.test(sql)) {
        return Promise.resolve({ rows: [{ ...staff[AGENT], password_hash: hash, phone: '94771234567' }], rowCount: 1 });
      }
      return base(sql, params);
    });
    const res = await fromNewIp(request(app).post('/api/devices/pair')).send({ phone: '0771234567', password: 'secret-pass', deviceName: 'Pixel' });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['device', 'staff', 'token']);
    expect(devices).toHaveLength(1);
  });
});

describe('the address put into the QR', () => {
  const { phoneServerUrl } = require('../index');
  // Its own agent: the code limiter counts per staff member, and the tests
  // above have already made several codes as AGENT.
  const FRESH = '00000000-0000-0000-0000-0000000000a9';
  // index.js loads whatsapp-backend/.env, where a developer testing on a
  // phone has CALL_TRACKER_SERVER_URL set to their ngrok tunnel — so each
  // case starts from "unset" on purpose, and the real value is put back.
  const saved = process.env.CALL_TRACKER_SERVER_URL;
  beforeEach(() => {
    delete process.env.CALL_TRACKER_SERVER_URL;
    staff[FRESH] = { id: FRESH, name: 'Fresh', role: 'sales_agent', active: true, phone: '94770000109' };
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.CALL_TRACKER_SERVER_URL;
    else process.env.CALL_TRACKER_SERVER_URL = saved;
  });

  test('unset: null, so the dashboard uses its own address (production)', async () => {
    expect(phoneServerUrl()).toBeNull();
    expect((await makeCode(FRESH)).body.server).toBeNull();
  });
  test('an https tunnel is passed to the dashboard, trailing slash trimmed', async () => {
    process.env.CALL_TRACKER_SERVER_URL = 'https://abc123.ngrok-free.app/';
    expect((await makeCode(FRESH)).body.server).toBe('https://abc123.ngrok-free.app');
  });
  test('http, credentials or a query are refused (the app would reject them anyway)', () => {
    for (const v of ['http://localhost:3000', 'https://u:p@evil.example', 'https://x.example/?a=1', 'not a url']) {
      process.env.CALL_TRACKER_SERVER_URL = v;
      expect(phoneServerUrl()).toBeNull();
    }
  });
});

describe('security review (2026-09-28)', () => {
  // Own agents per test: the code limiter counts per staff member.
  let n = 0;
  const agent = () => {
    const id = `00000000-0000-0000-0000-0000000001${String(++n).padStart(2, '0')}`;
    staff[id] = { id, name: `Agent ${n}`, role: 'sales_agent', active: true, phone: `947700002${String(n).padStart(2, '0')}` };
    return id;
  };

  test('a session alone cannot make a code: the password is required', async () => {
    const id = agent();
    const res = await request(app).post('/api/devices/pair-codes').set(authHeader('sales_agent', { id })).send({});
    expect(res.status).toBe(400);
    expect(codes).toHaveLength(0);
  });

  test('a wrong password makes no code, and is a 403 (a 401 would log the dashboard out)', async () => {
    const id = agent();
    const res = await makeCode(id, 'sales_agent', 'wrong-password');
    expect(res.status).toBe(403);
    expect(codes).toHaveLength(0);
  });

  test("another person's password does not work for you", async () => {
    const id = agent();
    const other = agent();
    // Both share PASSWORD in this fake DB; verify must still resolve to the caller.
    staff[other].phone = staff[id].phone.replace(/\d$/, '9');
    const res = await makeCode(id);
    expect(res.status).toBe(200);
    expect(codes[0].staff_id).toBe(id);
  });

  test('an admin password reset signs out every phone of that person and voids unused codes', async () => {
    const id = agent();
    const ADMIN = '00000000-0000-0000-0000-0000000000ad';
    staff[ADMIN] = { id: ADMIN, name: 'Admin', role: 'admin', active: true, phone: '94770000999' };
    devices.push({ id: 'p1', staff_id: id, revoked_at: null }, { id: 'p2', staff_id: OTHER, revoked_at: null });
    await makeCode(id);
    const res = await request(app)
      .patch(`/api/staff/${id}/password`)
      .set(authHeader('admin', { id: ADMIN }))
      .send({ password: 'Brand-new-pass-456' });
    expect(res.status).toBe(200);
    expect(res.body.phonesSignedOut).toBe(1);
    expect(devices.find((d) => d.id === 'p1').revoked_at).not.toBeNull();
    expect(devices.find((d) => d.id === 'p2').revoked_at).toBeNull(); // someone else's phone untouched
    expect(codes.every((c) => c.staff_id !== id || c.used_at)).toBe(true);
  });

  test('old codes are cleaned up when a new one is made', async () => {
    const id = agent();
    await makeCode(id);
    expect(mockPool.query.mock.calls.some(([q]) => /DELETE FROM device_pair_codes WHERE created_at < now\(\) - interval '7 days'/.test(q))).toBe(true);
  });
});

describe('sign-in block: friendly reason + admin clears it at once', () => {
  const ADMIN = '00000000-0000-0000-0000-0000000000ae';
  let n = 0;
  let lockState; // id -> { failed_login_count, locked_until }
  const agent = () => {
    const id = `00000000-0000-0000-0000-0000000002${String(++n).padStart(2, '0')}`;
    staff[id] = { id, name: `Blocked ${n}`, role: 'sales_agent', active: true, phone: `947700003${String(n).padStart(2, '0')}` };
    return id;
  };
  beforeEach(() => {
    lockState = {};
    staff[ADMIN] = { id: ADMIN, name: 'Admin', role: 'admin', active: true, phone: '94770000998' };
    const base = mockPool.query.getMockImplementation();
    mockPool.query.mockImplementation((sql, params = []) => {
      const q = typeof sql === 'string' ? sql : sql.text;
      const ok = (rows) => Promise.resolve({ rows, rowCount: rows.length });
      if (/SELECT failed_login_count, locked_until FROM staff_users WHERE id = \$1/.test(q)) return ok([lockState[params[0]] || { failed_login_count: 0, locked_until: null }]);
      if (/SELECT id, name, phone, role, active, created_at(, locked_until)? FROM staff_users ORDER BY/.test(q)) {
        return ok(Object.values(staff).map((u) => ({ ...u, created_at: new Date(), locked_until: lockState[u.id]?.locked_until || null })));
      }
      // Both forms: with and without the lockout columns (migration 035).
      if (/UPDATE staff_users SET (failed_login_count = 0, locked_until = NULL|id = id) WHERE id = \$1 RETURNING id, name/.test(q)) {
        delete lockState[params[0]];
        return ok(staff[params[0]] ? [{ id: params[0], name: staff[params[0]].name }] : []);
      }
      return base(sql, params);
    });
  });
  afterEach(() => { schemaFlags.loginLockout = false; });
  const clear = (id, as = 'admin', by = ADMIN) =>
    request(app).post(`/api/staff/${id}/clear-signin-block`).set(authHeader(as, { id: by }));

  test('the 11th code in 15 minutes gets a structured reply saying until when', async () => {
    const id = agent();
    for (let i = 0; i < 10; i++) expect((await makeCode(id)).status).toBe(200);
    const res = await makeCode(id);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('pair_code_limit');
    expect(new Date(res.body.until).getTime()).toBeGreaterThan(Date.now());
  });

  test('admins see who is blocked, and clearing lets them make a code straight away', async () => {
    const id = agent();
    for (let i = 0; i < 11; i++) await makeCode(id);
    let list = await request(app).get('/api/staff').set(authHeader('admin', { id: ADMIN }));
    expect(list.body.staff.find((u) => u.id === id).signin_block.codeLimitUntil).toBeTruthy();
    expect(list.body.staff.find((u) => u.id === ADMIN).signin_block).toBeNull();
    expect(list.body.staff.every((u) => !('locked_until' in u) && !('password_hash' in u))).toBe(true);

    expect((await clear(id)).status).toBe(200);
    expect((await makeCode(id)).status).toBe(200);
    list = await request(app).get('/api/staff').set(authHeader('admin', { id: ADMIN }));
    expect(list.body.staff.find((u) => u.id === id).signin_block).toBeNull();
  });

  test('clearing also unlocks an account locked by wrong passwords', async () => {
    schemaFlags.loginLockout = true;
    const id = agent();
    lockState[id] = { failed_login_count: 5, locked_until: new Date(Date.now() + 10 * 60000) };
    const list = await request(app).get('/api/staff').set(authHeader('admin', { id: ADMIN }));
    expect(list.body.staff.find((u) => u.id === id).signin_block.lockedUntil).toBeTruthy();
    expect((await clear(id)).status).toBe(200);
    expect(lockState[id]).toBeUndefined();
  });

  test('only admins can clear a block', async () => {
    const id = agent();
    expect((await clear(id, 'sales_agent', id)).status).toBe(403);
    expect((await clear('not-a-uuid')).status).toBe(400);
  });

  test('a wrong password says how many tries are left; a locked account says until when', async () => {
    schemaFlags.loginLockout = true;
    const id = agent();
    lockState[id] = { failed_login_count: 3, locked_until: null };
    let res = await makeCode(id, 'sales_agent', 'wrong');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'wrong_password', attemptsLeft: 2 });
    lockState[id] = { failed_login_count: 5, locked_until: new Date(Date.now() + 600000) };
    res = await makeCode(id, 'sales_agent', 'wrong');
    expect(res.body.code).toBe('account_locked');
    expect(new Date(res.body.until).getTime()).toBeGreaterThan(Date.now());
  });
});
