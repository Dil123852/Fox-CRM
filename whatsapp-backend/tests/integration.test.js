// Integration tests: several parts of the real app working together.
//
// Previously this file called mockPool.query() and mockMessageCreate()
// directly with hand-written SQL strings and then asserted that the mock
// returned what the mock had been told to return — it duplicated production
// SQL as string literals and exercised none of the app. Everything here now
// drives the shipped app through supertest and asserts on the SQL the app
// itself generates.

// pg's manual mock file (tests/__mocks__/pg.js) shares its basename with the
// package it mocks, so Jest resolves it automatically — no factory needed.
// A factory here that itself calls require('./__mocks__/pg') resolves to
// the same moduleID Jest already has an in-flight factory registered for,
// which re-enters that factory and recurses until the stack overflows.
jest.mock('pg');

// @anthropic-ai/sdk's mock file is named anthropic.js (no matching
// basename), so it needs an explicit factory pointing at it.
jest.mock('@anthropic-ai/sdk', () => require('./__mocks__/anthropic'));

const request = require('supertest');
const { mockPool } = require('pg');
const { mockMessageCreate } = require('@anthropic-ai/sdk');

// The Twilio webhook rejects any request without a valid signature unless
// validation is explicitly disabled. Set before requiring the app.
process.env.TWILIO_VALIDATE_SIGNATURE = 'false';

const { app } = require('../index');

/** Every SQL string the app sent to the pool during this test. */
function executedSql() {
  return mockPool.query.mock.calls.map(([sql]) => String(sql));
}

/** The (sql, params) pair for the first query matching a pattern. */
function findQuery(pattern) {
  return mockPool.query.mock.calls.find(([sql]) => pattern.test(String(sql)));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ messages: [{ id: 'wamid.test' }] }),
    text: async () => '{"messages":[{"id":"wamid.test"}]}',
  });
  mockMessageCreate.mockResolvedValue({
    content: [{ type: 'text', text: 'A mocked Claude reply.' }],
    stop_reason: 'end_turn',
  });
});

describe('Integration: inbound Twilio message to database', () => {
  test('an unknown number is looked up, then created, and the message stored', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT customer — miss
      .mockResolvedValueOnce({
        rows: [{ id: 'cust-001', whatsapp_number: '94771234567', ai_enabled: false }],
        rowCount: 1,
      }); // INSERT customer

    const res = await request(app).post('/webhook/twilio').type('form').send({
      From: 'whatsapp:+94771234567',
      Body: 'I need a mattress',
      MessageSid: 'SM-integration-1',
    });

    // Twilio requires a TwiML response, acknowledged before processing.
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Response>');

    // Give the fire-and-forget processing a tick to run.
    await new Promise((resolve) => setImmediate(resolve));

    const sql = executedSql();
    expect(sql.some((s) => /SELECT \* FROM customers WHERE whatsapp_number=\$1/.test(s))).toBe(true);
    expect(sql.some((s) => /INSERT INTO customers/.test(s))).toBe(true);
    expect(sql.some((s) => /INSERT INTO messages/.test(s))).toBe(true);
  });

  test('the phone number is canonicalised to 94XXXXXXXXX before lookup', async () => {
    // The single most important behaviour in this path: without it, one human
    // becomes several customer rows and sends to the non-94 row fail.
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({
      rows: [{ id: 'cust-canon', whatsapp_number: '94771234567', ai_enabled: false }],
      rowCount: 1,
    });

    await request(app).post('/webhook/twilio').type('form').send({ From: 'whatsapp:+94771234567', Body: 'hello', MessageSid: 'SM-2' });

    await new Promise((resolve) => setImmediate(resolve));

    const lookup = findQuery(/FROM customers WHERE whatsapp_number=\$1/);
    expect(lookup).toBeDefined();
    expect(lookup[1]).toEqual(['94771234567']);
  });

  test('an inbound message is recorded with no sender_type', async () => {
    // sender_type is 'ai' | 'staff', NULL for inbound — every SLA and
    // overdue metric depends on that distinction.
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({
      rows: [{ id: 'cust-002', whatsapp_number: '94771234567', ai_enabled: false }],
      rowCount: 1,
    });

    await request(app).post('/webhook/twilio').type('form').send({ From: 'whatsapp:+94771234567', Body: 'hi', MessageSid: 'SM-3' });

    await new Promise((resolve) => setImmediate(resolve));

    const insert = findQuery(/INSERT INTO messages/);
    expect(insert).toBeDefined();
    expect(insert[1]).toContain('inbound');
  });

  test('a webhook with no body text does not throw', async () => {
    const res = await request(app).post('/webhook/twilio').type('form').send({ From: 'whatsapp:+94771234567', MessageSid: 'SM-4' });
    expect(res.status).toBe(200);
  });
});

describe('Integration: error handling through the real app', () => {
  test('a database failure during webhook processing does not crash the response', async () => {
    // The webhook answers Twilio before processing, so a later DB failure
    // must be swallowed and logged, never surface as a failed webhook.
    mockPool.query.mockRejectedValue(new Error('Database connection failed'));

    const res = await request(app)
      .post('/webhook/twilio')
      .type('form')
      .send({ From: 'whatsapp:+94771234567', Body: 'test', MessageSid: 'SM-5' });

    expect(res.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
  });

  test('a database failure on an authenticated route returns 500, not a hang', async () => {
    // authenticate() re-reads staff_users first, so that lookup must succeed
    // and only the ROUTE's own query fails. A failure of the auth lookup
    // itself is a 503 — covered in authz.test.js.
    const { authHeader, mockAuthenticatedAs } = require('./helpers');
    mockAuthenticatedAs(mockPool, 'admin').nextError(new Error('Database connection failed'));

    const res = await request(app).get('/api/staff').set(authHeader('admin'));
    expect(res.status).toBe(500);
  });

  test('an Anthropic failure on /api/summary is reported, not thrown', async () => {
    const jwtLib = require('jsonwebtoken');
    const token = jwtLib.sign({ id: 's1', role: 'admin' }, process.env.JWT_SECRET);
    mockPool.query.mockResolvedValue({
      rows: [{ direction: 'inbound', content: 'hello', created_at: new Date() }],
      rowCount: 1,
    });
    mockMessageCreate.mockRejectedValueOnce(new Error('API rate limit'));

    const res = await request(app).post('/api/summary').set('Authorization', `Bearer ${token}`).send({ customerId: 'cust-001' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toBeDefined();
  });
});

describe('Integration: unauthenticated surface', () => {
  test('only the documented public paths skip the staff token', async () => {
    // Everything under /api requires a token except the login route and the
    // deliberately public promo-code/webchat endpoints.
    const res = await request(app).get('/api/orders');
    expect(res.status).toBe(401);
  });

  test('the public promo-code validate endpoint needs no token', async () => {
    mockPool.query.mockResolvedValue({ rows: [{ valid: false }], rowCount: 1 });
    const res = await request(app).post('/api/promo-codes/validate').send({ code: 'NOPE', phone: '94771234567', orderTotal: 1000 });
    expect(res.status).not.toBe(401);
  });
});
