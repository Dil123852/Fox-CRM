// Exercises the REAL Express app exported by index.js, through supertest.
//
// This file previously built a throwaway express() app in beforeEach and
// re-implemented a simplified copy of each route inside the test body, so it
// asserted against code that lived only in the test file. index.js was never
// imported and coverage was 0% while the suite reported green. Every test
// here now goes through the shipped app, its real middleware chain, and its
// real route handlers; only pg and the Anthropic SDK are mocked.

jest.mock('pg');
jest.mock('@anthropic-ai/sdk', () => require('./__mocks__/anthropic'));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { mockPool } = require('pg');
const { tokenFor, authHeader, mockAuthenticatedAs, JWT_SECRET, DEFAULT_ID } = require('./helpers');

const { app } = require('../index');

const TEST_STAFF_ID = DEFAULT_ID;

// authenticate() re-reads staff_users on every request, so a token alone is
// not enough — the lookup has to resolve too. `auth(role)` does both and
// returns the handle, so the helpers below can reach the active session.
let session = null;
let pending = [];

function auth(role) {
  session = mockAuthenticatedAs(mockPool, role);
  // Replay anything queued before auth() was called, so tests can read in
  // whichever order is clearest.
  for (const [kind, arg] of pending) {
    if (kind === 'ok') session.next(arg);
    else session.nextError(arg);
  }
  pending = [];
  return authHeader(role);
}

/** Queue one result for the next query the ROUTE makes (skipping auth's). */
function queueRouteResult(result) {
  if (session) return session.next(result);
  pending.push(['ok', result]);
}

/** Queue one rejection for the next query the ROUTE makes. */
function queueRouteError(err) {
  if (session) return session.nextError(err);
  pending.push(['err', err]);
}

/** Only the queries the route issued — authenticate()'s lookup filtered out. */
function routeQueries() {
  return session ? session.calls() : [];
}

beforeEach(() => {
  jest.clearAllMocks();
  session = null;
  pending = [];
  mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ messages: [{ id: 'wamid.test' }] }),
    text: async () => '{"messages":[{"id":"wamid.test"}]}',
  });
});

describe('GET /health', () => {
  test('returns ok without authentication', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('CORS middleware', () => {
  test('echoes an allowed dashboard origin', async () => {
    const res = await request(app).get('/health').set('Origin', 'http://localhost:5173');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['vary']).toBe('Origin');
  });

  test('does not echo an origin that is not allowed', async () => {
    const res = await request(app).get('/health').set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('opens the public promo-code endpoints to any origin', async () => {
    const res = await request(app).options('/api/promo-codes/validate').set('Origin', 'https://nidikumba.shop');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  test('allows PUT in the preflight method list', async () => {
    // PUT /api/products/:id/variants is the only PUT route in the codebase;
    // it was missing from this header, so the browser preflight rejected it
    // and the request never arrived (surfacing as "Failed to fetch").
    const res = await request(app)
      .options('/api/products/1/variants')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'PUT');
    expect(res.headers['access-control-allow-methods']).toContain('PUT');
  });
});

describe('GET /webhook (Meta verification)', () => {
  test('echoes the challenge when mode and token are correct', async () => {
    const res = await request(app).get('/webhook').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': process.env.VERIFY_TOKEN,
      'hub.challenge': 'challenge-12345',
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe('challenge-12345');
  });

  test('rejects a wrong verify token with 403', async () => {
    const res = await request(app).get('/webhook').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong-token',
      'hub.challenge': 'challenge-12345',
    });
    expect(res.status).toBe(403);
  });

  test('rejects a missing mode with 403', async () => {
    const res = await request(app).get('/webhook').query({ 'hub.verify_token': process.env.VERIFY_TOKEN });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/auth/login', () => {
  test('requires both phone and password', async () => {
    const res = await request(app).post('/api/auth/login').send({ phone: '94771234567' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  test('returns a usable JWT and staff record on valid credentials', async () => {
    const password_hash = await bcrypt.hash('correct-horse', 10);
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'staff-1',
          name: 'Test Admin',
          phone: '94771234567',
          password_hash,
          role: 'admin',
        },
      ],
      rowCount: 1,
    });

    const res = await request(app).post('/api/auth/login').send({ phone: '94771234567', password: 'correct-horse' });

    expect(res.status).toBe(200);
    // phone = their own login number, for the browser's password manager on
    // screens that ask for the password again (Connect my phone).
    expect(res.body.staff).toEqual({ id: 'staff-1', name: 'Test Admin', role: 'admin', phone: '94771234567' });
    // The token must actually verify against the app's own secret.
    const decoded = jwt.verify(res.body.token, JWT_SECRET);
    expect(decoded.role).toBe('admin');
    expect(decoded.phone).toBeUndefined(); // kept out of the token
    // The password hash must never be returned to the client.
    expect(JSON.stringify(res.body)).not.toContain(password_hash);
  });

  test('rejects a wrong password with 401 and no token', async () => {
    const password_hash = await bcrypt.hash('correct-horse', 10);
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'staff-1', name: 'Test Admin', password_hash, role: 'admin' }],
      rowCount: 1,
    });

    const res = await request(app).post('/api/auth/login').send({ phone: '94771234567', password: 'wrong-password' });

    expect(res.status).toBe(401);
    expect(res.body.token).toBeUndefined();
  });

  test('rejects an unknown phone with 401', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).post('/api/auth/login').send({ phone: '94700000000', password: 'anything' });
    expect(res.status).toBe(401);
  });
});

describe('authenticate middleware', () => {
  test('rejects a request with no Authorization header', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  test('rejects a malformed Authorization header', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', 'NotBearer xyz');
    expect(res.status).toBe(401);
  });

  test('rejects a token signed with the wrong secret', async () => {
    const forged = jwt.sign({ id: 'x', role: 'admin' }, 'not-the-real-secret');
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid or expired/i);
  });

  test('rejects an expired token', async () => {
    const expired = jwt.sign({ id: 'x', role: 'admin' }, JWT_SECRET, { expiresIn: '-1s' });
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  test('accepts a valid token and exposes the staff claims', async () => {
    const res = await request(app).get('/api/auth/me').set(auth('admin'));
    expect(res.status).toBe(200);
    expect(res.body.staff.role).toBe('admin');
  });

  test('rejects a ?token= on a normal route (it is scoped to /api/events)', async () => {
    // EventSource cannot set headers, so /api/events accepts a query token.
    // Accepting it EVERYWHERE put a 12h admin-capable token into access logs,
    // browser history and Referer headers for every request — so it is now
    // scoped to that one path (2026-09-10 audit).
    mockAuthenticatedAs(mockPool, 'viewer');
    const res = await request(app)
      .get('/api/auth/me')
      .query({ token: tokenFor('viewer') });
    expect(res.status).toBe(401);
  });
});

describe('requireRole middleware', () => {
  test('admin reaches an admin-only route', async () => {
    const res = await request(app).get('/api/staff').set(auth('admin'));
    expect(res.status).toBe(200);
  });

  test('sales_agent is refused an admin-only route with 403', async () => {
    const res = await request(app).get('/api/staff').set(auth('sales_agent'));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/requires role/i);
  });

  test('delivery_coordinator is refused the sales pipeline', async () => {
    // That role's job is fulfillment on placed orders, not the pipeline.
    const res = await request(app).get('/api/leads').set(auth('delivery_coordinator'));
    expect(res.status).toBe(403);
  });

  test('sales_agent reaches the pipeline', async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await request(app).get('/api/leads').set(auth('sales_agent'));
    expect(res.status).toBe(200);
  });
});

describe('PATCH /api/staff/:id', () => {
  test('rejects an empty update with "Nothing to update"', async () => {
    const res = await request(app).patch('/api/staff/staff-1').set(auth('admin')).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Nothing to update');
  });

  test('rejects an unknown role', async () => {
    const res = await request(app).patch('/api/staff/staff-1').set(auth('admin')).send({ role: 'wizard' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/role must be one of/i);
  });

  test('REJECTS a field outside the allowlist instead of silently dropping it', async () => {
    // password_hash must never be settable through this route. It previously
    // returned "Nothing to update" — a 200-shaped no-op that let a caller
    // believe the field had been ignored harmlessly. Now the request fails
    // loudly and the attempt is audit-logged.
    const res = await request(app).patch('/api/staff/staff-1').set(auth('admin')).send({ password_hash: 'pwned' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown field/i);
    expect(res.body.error).toContain('password_hash');
    // No UPDATE was issued.
    expect(routeQueries()).toHaveLength(0);
  });

  // The edit runs in a transaction on a pooled client (it locks the admin
  // rows), so the client's queries go through the same mock.
  const useClient = () => {
    mockPool.connect = jest.fn().mockResolvedValue({ query: (...a) => mockPool.query(...a), release: jest.fn() });
  };

  test('404s when the id does not exist', async () => {
    useClient();
    const headers = auth('admin');
    queueRouteResult({ rows: [], rowCount: 0 }); // BEGIN
    queueRouteResult({ rows: [], rowCount: 0 }); // lock: no such account
    const res = await request(app).patch('/api/staff/00000000-0000-0000-0000-0000000000ff').set(headers).send({ name: 'New Name' });
    expect(res.status).toBe(404);
  });

  test('updates an allowed field using a parameterised query', async () => {
    useClient();
    const headers = auth('admin');
    queueRouteResult({ rows: [], rowCount: 0 }); // BEGIN
    queueRouteResult({ rows: [{ id: '00000000-0000-0000-0000-00000000051a', name: 'Old', role: 'viewer', active: true }], rowCount: 1 });
    queueRouteResult({
      rows: [{ id: '00000000-0000-0000-0000-00000000051a', name: 'Renamed', phone: '947', role: 'viewer', active: true }],
      rowCount: 1,
    });
    const res = await request(app).patch('/api/staff/00000000-0000-0000-0000-00000000051a').set(headers).send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.staff.name).toBe('Renamed');

    const [sql, vals] = routeQueries().find(([q]) => /^UPDATE staff_users/.test(q));
    expect(sql).toMatch(/name=\$1/);
    expect(vals).toEqual(['Renamed', '00000000-0000-0000-0000-00000000051a']);
  });
});

describe('PATCH /api/staff/:id/password', () => {
  test('rejects a password shorter than 6 characters', async () => {
    const res = await request(app).patch('/api/staff/staff-1/password').set(auth('admin')).send({ password: 'abc' });
    expect(res.status).toBe(400);
  });

  test('stores a bcrypt hash, never the plaintext', async () => {
    const headers = auth('admin');
    queueRouteResult({ rows: [{ id: '00000000-0000-0000-0000-00000000051a', role: 'viewer' }], rowCount: 1 }); // the target account
    queueRouteResult({ rows: [{ id: '00000000-0000-0000-0000-00000000051a' }], rowCount: 1 });
    const res = await request(app).patch('/api/staff/00000000-0000-0000-0000-00000000051a/password').set(headers).send({ password: 'a-good-password' });

    expect(res.status).toBe(200);
    const [, vals] = routeQueries().find(([q]) => /SET password_hash/.test(q));
    expect(vals[0]).not.toBe('a-good-password');
    expect(vals[0]).toMatch(/^\$2[aby]\$/);
    expect(await bcrypt.compare('a-good-password', vals[0])).toBe(true);
  });

  test('is refused to a non-admin', async () => {
    const res = await request(app).patch('/api/staff/staff-1/password').set(auth('sales_agent')).send({ password: 'a-good-password' });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/calls (call-tracker API-key auth)', () => {
  test('rejects a missing API key with 401', async () => {
    const res = await request(app).post('/api/calls').send({ calls: [] });
    expect(res.status).toBe(401);
  });

  test('rejects a wrong API key with 401', async () => {
    const res = await request(app).post('/api/calls').set('X-API-Key', 'not-the-key').send({ calls: [] });
    expect(res.status).toBe(401);
  });

  test('refuses even the correct shared key by default — it is in every old APK', async () => {
    delete process.env.CALL_TRACKER_ALLOW_LEGACY_KEY;
    const res = await request(app).post('/api/calls').set('X-API-Key', process.env.CALL_TRACKER_API_KEY).send({ calls: [] });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/no longer supported/);
  });

  test('accepts the correct API key only while CALL_TRACKER_ALLOW_LEGACY_KEY=true', async () => {
    process.env.CALL_TRACKER_ALLOW_LEGACY_KEY = 'true';
    try {
      const res = await request(app).post('/api/calls').set('X-API-Key', process.env.CALL_TRACKER_API_KEY).send({ calls: [] });
      expect(res.status).toBeLessThan(400);
    } finally {
      delete process.env.CALL_TRACKER_ALLOW_LEGACY_KEY;
    }
  });
});

describe('GET /api/performance role scoping', () => {
  test('a sales_agent is scoped to their own row only', async () => {
    const res = await request(app).get('/api/performance').set(auth('sales_agent'));
    expect(res.status).toBe(200);
    // REQ-4.10: the query must be filtered by the caller's own staff id.
    const [sql, vals] = routeQueries()[0];
    expect(sql).toMatch(/staff_id=\$1/);
    expect(vals).toEqual([TEST_STAFF_ID]);
  });

  test('an admin sees the ranked team view, unfiltered', async () => {
    const res = await request(app).get('/api/performance').set(auth('admin'));
    expect(res.status).toBe(200);
    const [sql] = routeQueries()[0];
    expect(sql).not.toMatch(/staff_id=\$1/);
    expect(sql).toMatch(/ORDER BY/i);
  });
});

describe('error handling', () => {
  test('a database failure returns 500, not a crash', async () => {
    // Auth succeeds; the ROUTE's query fails. (A failure of the auth lookup
    // itself returns 503 — covered in authz.test.js.)
    const headers = auth('admin');
    queueRouteError(new Error('connection refused'));
    const res = await request(app).get('/api/staff').set(headers);
    expect(res.status).toBe(500);
    expect(res.body.error).toBeDefined();
  });

  test('an unknown route does not 500', async () => {
    const res = await request(app).get('/api/no-such-route').set(auth('admin'));
    expect(res.status).toBe(404);
  });
});

// ── missed-call callback tracker (migration 043) ─────────────────────────────
describe('GET /api/calls/callbacks (missed-call callback tracker)', () => {
  const PENDING_ROW = {
    phone_canon: '94765550001', raw_phone_number: '94765550001', missed_count: '3',
    first_missed_at: '2026-09-01T10:00:00.000Z', latest_missed_at: '2026-09-11T17:41:00.000Z',
    customer_id: 'c1', customer_name: 'Anura', contact_name: 'Anura',
    called_back_at: null, callback_duration_seconds: null,
    is_called_back: false, callback_status: 'pending',
    time_to_callback_seconds: null, threshold_seconds: 15, open_lead_id: 'l1',
  };
  const DONE_ROW = {
    ...PENDING_ROW, phone_canon: '94777000003', raw_phone_number: '94777000003',
    missed_count: '1', called_back_at: '2026-09-11T19:41:00.000Z',
    callback_duration_seconds: 20, is_called_back: true, callback_status: 'done',
    time_to_callback_seconds: 7200,
  };

  test('returns the callbacks envelope', async () => {
    const header = auth('admin');
    queueRouteResult({ rows: [PENDING_ROW], rowCount: 1 });
    const res = await request(app).get('/api/calls/callbacks').set(header);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.callbacks)).toBe(true);
    expect(res.body.calls).toBeUndefined();
  });

  // The rollup and the threshold belong to the view. A route that recomputed
  // either could silently disagree with every other consumer.
  test('reads from v_missed_call_callbacks, not call_events directly', async () => {
    const header = auth('admin');
    queueRouteResult({ rows: [], rowCount: 0 });
    await request(app).get('/api/calls/callbacks').set(header);
    const [sql] = routeQueries()[0];
    expect(sql).toMatch(/FROM v_missed_call_callbacks/);
    expect(sql).not.toMatch(/FROM call_events/);
  });

  // Locks the "the view owns the threshold" decision: a caller must not be able
  // to change what counts as done by passing a query string.
  test('does not filter by a client-supplied threshold', async () => {
    const header = auth('admin');
    queueRouteResult({ rows: [], rowCount: 0 });
    await request(app).get('/api/calls/callbacks?threshold=999').set(header);
    const [sql, params] = routeQueries()[0];
    // No params at all: an admin with no ?staffId= is not scoped (058).
    expect(params).toEqual([]);
    expect(sql).not.toMatch(/999/);
  });

  test('orders pending numbers before done', async () => {
    const header = auth('admin');
    queueRouteResult({ rows: [], rowCount: 0 });
    await request(app).get('/api/calls/callbacks').set(header);
    expect(routeQueries()[0][0]).toMatch(/ORDER BY[\s\S]*is_called_back ASC/);
  });

  test('returns a 500 without leaking the driver error', async () => {
    const header = auth('admin');
    queueRouteError(new Error('relation "v_missed_call_callbacks" does not exist'));
    const res = await request(app).get('/api/calls/callbacks').set(header);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
    expect(JSON.stringify(res.body)).not.toMatch(/relation/);
  });

  test('passes through pending and done rows unchanged', async () => {
    const header = auth('admin');
    queueRouteResult({ rows: [PENDING_ROW, DONE_ROW], rowCount: 2 });
    const res = await request(app).get('/api/calls/callbacks').set(header);
    const [stillPending, done] = res.body.callbacks;
    expect(stillPending.callback_status).toBe('pending');
    expect(stillPending.missed_count).toBe('3');
    expect(stillPending.called_back_at).toBeNull();
    expect(done.callback_status).toBe('done');
    expect(done.called_back_at).toBe('2026-09-11T19:41:00.000Z');
    expect(done.time_to_callback_seconds).toBe(7200);
  });
});

describe('GET/PATCH /api/settings/callback-threshold', () => {
  test('returns the stored threshold as a number', async () => {
    const header = auth('admin');
    queueRouteResult({ rows: [{ value: '30' }], rowCount: 1 });
    const res = await request(app).get('/api/settings/callback-threshold').set(header);
    expect(res.status).toBe(200);
    expect(res.body.seconds).toBe(30);
  });

  test('defaults to 15 when the setting row is missing', async () => {
    const header = auth('admin');
    queueRouteResult({ rows: [], rowCount: 0 });
    const res = await request(app).get('/api/settings/callback-threshold').set(header);
    expect(res.body.seconds).toBe(15);
  });

  // Matches the view's own coercion of a junk app_settings value, so the number
  // the admin reads back can never disagree with the one the view applied.
  test('defaults to 15 when the stored value is not a number', async () => {
    const header = auth('admin');
    queueRouteResult({ rows: [{ value: 'abc' }], rowCount: 1 });
    const res = await request(app).get('/api/settings/callback-threshold').set(header);
    expect(res.body.seconds).toBe(15);
  });

  test('stores a new threshold', async () => {
    const header = auth('admin');
    queueRouteResult({ rows: [], rowCount: 1 });
    const res = await request(app).patch('/api/settings/callback-threshold').set(header).send({ seconds: 30 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, seconds: 30 });
    const [sql, params] = routeQueries()[0];
    expect(sql).toMatch(/ON CONFLICT \(key\) DO UPDATE/);
    expect(params).toEqual(['30']);
  });

  test('rejects a non-integer threshold', async () => {
    for (const seconds of ['30', 12.5]) {
      const header = auth('admin');
      const res = await request(app).patch('/api/settings/callback-threshold').set(header).send({ seconds });
      expect({ seconds, status: res.status }).toEqual({ seconds, status: 400 });
    }
  });

  test('rejects a negative threshold', async () => {
    const header = auth('admin');
    const res = await request(app).patch('/api/settings/callback-threshold').set(header).send({ seconds: -1 });
    expect(res.status).toBe(400);
  });

  test('rejects an absurdly large threshold', async () => {
    const header = auth('admin');
    const res = await request(app).patch('/api/settings/callback-threshold').set(header).send({ seconds: 99999 });
    expect(res.status).toBe(400);
  });

  test('rejects a missing body', async () => {
    const header = auth('admin');
    const res = await request(app).patch('/api/settings/callback-threshold').set(header).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/seconds/);
  });
});
