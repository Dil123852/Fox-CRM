// Staff login phones are matched in any equivalent spelling.
//
// staff_users.phone was stored exactly as typed, and login compared it
// exactly — so an account saved as 94771234567 could not sign in as
// 0771234567 (the right password, rejected as "Invalid credentials"). Login
// and phone pairing now look the number up in all its equivalent forms,
// WITHOUT rewriting any stored account, and new accounts are stored canonical.

jest.mock('pg');
jest.mock('@anthropic-ai/sdk', () => require('./__mocks__/anthropic'));

const request = require('supertest');
const bcrypt = require('bcryptjs');
const { mockPool } = require('pg');
const { authHeader } = require('./helpers');

const { app } = require('../index');

const HASH = bcrypt.hashSync('Correct-Pass-1', 4);
let accounts; // what staff_users holds

function installDb() {
  mockPool.query.mockImplementation((sqlOrCfg, params = []) => {
    const sql = typeof sqlOrCfg === 'string' ? sqlOrCfg : sqlOrCfg.text;
    // authenticate() for the admin creating staff
    if (/FROM staff_users WHERE id=\$1/.test(sql)) {
      return Promise.resolve({ rows: [{ id: 'admin', name: 'A', role: 'admin', active: true }] });
    }
    // the login lookup: phone = ANY($1), exact match ($2) first
    if (/FROM staff_users\s+WHERE active=true AND phone = ANY/.test(sql)) {
      const [candidates, exact] = params;
      const hits = accounts
        .filter(a => candidates.includes(a.phone))
        .sort((a, b) => Number(b.phone === exact) - Number(a.phone === exact));
      return Promise.resolve({ rows: hits.slice(0, 1) });
    }
    if (/SELECT 1 FROM staff_users WHERE phone = ANY/.test(sql)) {
      return Promise.resolve({ rows: accounts.filter(a => params[0].includes(a.phone)).map(() => ({ '?column?': 1 })) });
    }
    if (/INSERT INTO staff_users/.test(sql)) {
      return Promise.resolve({ rows: [{ id: 'new', name: params[0], phone: params[1], role: params[3], active: true }] });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

const account = (id, phone) => ({ id, name: id, phone, password_hash: HASH, role: 'sales_agent' });

// The real login rate limit (10 per IP per 15 min) is live in these tests;
// give each request its own client address so this file's dozen sign-ins
// test phone matching, not the limiter. (`trust proxy` is 1, so the app
// takes the address from X-Forwarded-For.)
let ip = 0;
const fromNewIp = r => r.set('X-Forwarded-For', `10.0.0.${++ip}`);
const login = (phone, password = 'Correct-Pass-1') =>
  fromNewIp(request(app).post('/api/auth/login')).send({ phone, password });

beforeEach(() => {
  jest.clearAllMocks();
  accounts = [account('canonical', '94771234567')];
  installDb();
});

describe('login phone format', () => {
  test.each(['94771234567', '0771234567', '771234567', '+94771234567', '+94 77 123 4567', '077-123-4567'])(
    'an account stored as 94771234567 signs in as %s',
    async typed => {
      const res = await login(typed);
      expect(res.status).toBe(200);
      expect(res.body.staff.id).toBe('canonical');
    }
  );

  test('an OLDER account stored in local format (0771234567) signs in with the canonical form too', async () => {
    accounts = [account('legacy', '0771234567')];
    const res = await login('94771234567');
    expect(res.status).toBe(200);
    expect(res.body.staff.id).toBe('legacy');
  });

  test('a different number is still refused', async () => {
    const res = await login('0779999999');
    expect(res.status).toBe(401);
  });

  test('the wrong password is still refused in every format', async () => {
    const res = await login('0771234567', 'wrong');
    expect(res.status).toBe(401);
  });

  test('if two accounts could match, the exact spelling wins — so existing logins resolve as before', async () => {
    accounts = [account('canonical', '94771234567'), account('legacy', '0771234567')];
    expect((await login('0771234567')).body.staff.id).toBe('legacy');
    expect((await login('94771234567')).body.staff.id).toBe('canonical');
  });

  test('phone pairing uses the same matching', async () => {
    const res = await fromNewIp(request(app).post('/api/devices/pair')).send({ phone: '0771234567', password: 'wrong' });
    // Reached the credential check with the candidate list (401 = wrong
    // password, not "unknown phone format").
    expect(res.status).toBe(401);
    const lookup = mockPool.query.mock.calls.find(([s]) => /phone = ANY/.test(String(s)));
    expect(lookup[1][0]).toEqual(expect.arrayContaining(['0771234567', '94771234567', '771234567', '+94771234567']));
  });
});

describe('POST /api/staff', () => {
  const create = phone =>
    request(app)
      .post('/api/staff')
      .set(authHeader('admin', { id: 'admin' }))
      .send({ name: 'New Agent', phone, password: 'Str0ng-Password!', role: 'sales_agent' });

  test('stores a new account in the canonical 94XXXXXXXXX form', async () => {
    accounts = [];
    const res = await create('0770001111');
    expect(res.status).toBe(200);
    const insert = mockPool.query.mock.calls.find(([s]) => /INSERT INTO staff_users/.test(String(s)));
    expect(insert[1][1]).toBe('94770001111');
  });

  test('refuses the same number typed in a different format', async () => {
    // Stored as 94771234567; creating 0771234567 would make two accounts the
    // login lookup cannot tell apart.
    const res = await create('0771234567');
    expect(res.status).toBe(409);
    expect(mockPool.query.mock.calls.some(([s]) => /INSERT INTO staff_users/.test(String(s)))).toBe(false);
  });
});
