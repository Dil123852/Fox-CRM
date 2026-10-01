// Phone presence: is each agent's Call Tracker connected to the CRM?
// Behind the "your phone is not connected" alerts — the agent's CRM banner,
// the admin overview and the Team page.
//
// Timings are shortened through env BEFORE index.js is required (the
// heartbeat timeout to 300ms, no startup grace), so these run in a second
// instead of waiting out production's 50s.

process.env.DEVICE_HEARTBEAT_TIMEOUT_MS = '300';
process.env.PRESENCE_STARTUP_GRACE_MS = '0';
// Short reconnect grace so the blip test runs fast.
process.env.DEVICE_RECONNECT_GRACE_MS = '300';

jest.mock('pg');
jest.mock('@anthropic-ai/sdk', () => require('./__mocks__/anthropic'));

const http = require('http');
const crypto = require('crypto');
const request = require('supertest');
const { mockPool } = require('pg');
const { tokenFor } = require('./helpers');

const { app } = require('../index');

const AGENT = '00000000-0000-0000-0000-00000000000a';
const NO_PHONE = '00000000-0000-0000-0000-00000000000c';
const ADMIN = '00000000-0000-0000-0000-0000000000ad';
const DEVICE = '00000000-0000-0000-0000-0000000000da';
const TOKEN = 'p'.repeat(43);
const sha = t => crypto.createHash('sha256').update(t).digest('hex');

const STAFF = {
  [AGENT]: { id: AGENT, name: 'Agent', role: 'sales_agent', active: true },
  [ADMIN]: { id: ADMIN, name: 'Admin', role: 'admin', active: true },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPool.query.mockImplementation((sql, params = []) => {
    const q = typeof sql === 'string' ? sql : sql.text;
    const rows = r => Promise.resolve({ rows: r, rowCount: r.length });
    if (/FROM staff_users WHERE id=\$1/.test(q)) return rows(STAFF[params[0]] ? [STAFF[params[0]]] : []);
    if (/WHERE d.token_hash = \$1/.test(q)) {
      return rows(params[0] === sha(TOKEN) ? [{ id: DEVICE, staff_id: AGENT, staff_name: 'Agent', role: 'sales_agent' }] : []);
    }
    // GET /api/devices/me
    if (/FROM staff_devices\s+WHERE staff_id = \$1 AND revoked_at IS NULL/.test(q)) {
      return rows(params[0] === AGENT ? [{ id: DEVICE, device_name: 'Phone', created_at: new Date(), last_seen_at: new Date() }] : []);
    }
    // GET /api/devices/status
    if (/FROM staff_users s\s+LEFT JOIN staff_devices d/.test(q)) {
      return rows([
        { staff_id: AGENT, staff_name: 'Agent', role: 'sales_agent', device_id: DEVICE, device_name: 'Phone', last_seen_at: new Date() },
        { staff_id: NO_PHONE, staff_name: 'No Phone', role: 'sales_agent', device_id: null, device_name: null, last_seen_at: null },
      ]);
    }
    return rows([]);
  });
});

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

const bearer = id => ({ Authorization: `Bearer ${tokenFor(STAFF[id].role, { id })}` });
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Open an SSE stream and collect what arrives. */
function openSse(path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}${path}`, { headers }, res => {
      const s = { text: '', req, res };
      res.setEncoding('utf8');
      res.on('data', c => {
        s.text += c;
      });
      resolve(s);
    });
    req.on('error', reject);
  });
}
const openPhone = async () => {
  const s = await openSse('/api/devices/stream', { Authorization: `Device ${TOKEN}` });
  await sleep(100);
  return s;
};

const statusOf = async id => {
  const res = await request(server).get('/api/devices/status').set(bearer(ADMIN));
  return res.body.find(r => r.staff_id === id)?.status;
};
const myStatus = async () => (await request(server).get('/api/devices/me').set(bearer(AGENT))).body.status;

test('an agent who never signed a phone in is reported, not left out', async () => {
  expect(await statusOf(NO_PHONE)).toBe('not_paired');
});

test('connecting the phone makes it online; dropping the connection makes it offline at once', async () => {
  const phone = await openPhone();
  try {
    expect(await statusOf(AGENT)).toBe('online');
    expect(await myStatus()).toBe('online');
  } finally {
    phone.req.destroy();
  }
  await sleep(100);
  expect(await statusOf(AGENT)).toBe('offline');
  expect(await myStatus()).toBe('offline');
});

test('every open CRM page is told the moment a phone goes online or offline', async () => {
  const dash = await openSse(`/api/events?token=${tokenFor('admin', { id: ADMIN })}`, {});
  const phone = await openPhone();
  phone.req.destroy();
  await sleep(150);
  dash.req.destroy();
  const events = [...dash.text.matchAll(/event: device_status\ndata: (\{.*\})/g)].map(m => JSON.parse(m[1]));
  const mine = events.filter(e => e.staffId === AGENT && e.deviceId === DEVICE);
  expect(mine.map(e => e.online)).toEqual([true, false]);
});

test('a phone whose heartbeat stops is offline even while its connection still looks open', async () => {
  const phone = await openPhone();
  try {
    const beat = await request(server).post('/api/devices/heartbeat').set('Authorization', `Device ${TOKEN}`);
    expect(beat.status).toBe(204);
    expect(await statusOf(AGENT)).toBe('online');
    await sleep(400); // past the (test) 300ms heartbeat timeout, no further beats
    expect(await statusOf(AGENT)).toBe('offline');
  } finally {
    phone.req.destroy();
  }
});

test('an app build without heartbeats is judged by its connection alone — never cut off for not beating', async () => {
  // A separate phone that never sends a heartbeat (presence remembers
  // heartbeat-capability per device, so it must not share the one above).
  const OLD_TOKEN = 'o'.repeat(43);
  const OLD_DEVICE = '00000000-0000-0000-0000-0000000000d0';
  const OLD_OWNER = '00000000-0000-0000-0000-0000000000e0';
  const inner = mockPool.query.getMockImplementation();
  mockPool.query.mockImplementation((sql, params = []) => {
    const q = typeof sql === 'string' ? sql : sql.text;
    if (/WHERE d.token_hash = \$1/.test(q) && params[0] === sha(OLD_TOKEN)) {
      return Promise.resolve({ rows: [{ id: OLD_DEVICE, staff_id: OLD_OWNER, staff_name: 'Old', role: 'sales_agent' }] });
    }
    if (/FROM staff_users s\s+LEFT JOIN staff_devices d/.test(q)) {
      return Promise.resolve({
        rows: [{ staff_id: OLD_OWNER, staff_name: 'Old', role: 'sales_agent', device_id: OLD_DEVICE, last_seen_at: new Date() }],
      });
    }
    return inner(sql, params);
  });

  const phone = await openSse('/api/devices/stream', { Authorization: `Device ${OLD_TOKEN}` });
  try {
    await sleep(500); // well past the (test) 300ms heartbeat timeout, zero beats sent
    expect(await statusOf(OLD_OWNER)).toBe('online');
  } finally {
    phone.req.destroy();
  }
});

test('the heartbeat needs the phone’s own token', async () => {
  const res = await request(server).post('/api/devices/heartbeat');
  expect(res.status).toBe(401);
});

test('only admins get the whole team’s phone status', async () => {
  const res = await request(server).get('/api/devices/status').set(bearer(AGENT));
  expect(res.status).toBe(403);
});

test('a heart-beating phone whose stream blips stays online through a quick reconnect, then goes offline if it never returns', async () => {
  const phone = await openPhone();
  const beat = await request(server).post('/api/devices/heartbeat').set('Authorization', `Device ${TOKEN}`);
  expect(beat.status).toBe(204);
  phone.req.destroy();
  await sleep(100);
  // Inside the grace: no false "not connected" for a blip.
  expect(await statusOf(AGENT)).toBe('online');
  expect(await myStatus()).toBe('online');
  await sleep(400); // past the (test) 300ms grace, never reconnected
  expect(await statusOf(AGENT)).toBe('offline');
});

test('reconnecting inside the grace simply stays online', async () => {
  const first = await openPhone();
  await request(server).post('/api/devices/heartbeat').set('Authorization', `Device ${TOKEN}`);
  first.req.destroy();
  await sleep(100);
  const second = await openPhone();
  try {
    // Past the grace, but it came back — and keeps heart-beating as the app
    // does (the test heartbeat timeout is only 300ms).
    await sleep(200);
    await request(server).post('/api/devices/heartbeat').set('Authorization', `Device ${TOKEN}`);
    await sleep(200);
    expect(await statusOf(AGENT)).toBe('online');
  } finally {
    second.req.destroy();
  }
});

