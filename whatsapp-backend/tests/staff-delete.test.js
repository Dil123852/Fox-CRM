// DELETE /api/staff/:id — permanently deleting a staff account.
//
// The things that must hold: nobody deletes themselves or the last admin, a
// super admin is only deleted by a super admin, open leads never lose an owner
// silently (the admin picks a person or 'auto'), and the references that have
// no ON DELETE rule are cleared first so the delete cannot fail half way.
// The real foreign keys were also exercised against a Postgres clone; this
// file pins the rules.

jest.mock('pg');
jest.mock('@anthropic-ai/sdk', () => require('./__mocks__/anthropic'));

const request = require('supertest');
const { mockPool } = require('pg');
const { authHeader } = require('./helpers');
const { app, schemaFlags } = require('../index');

const ADMIN = '00000000-0000-0000-0000-0000000000d1';
const ADMIN2 = '00000000-0000-0000-0000-0000000000d2';
const SUPER = '00000000-0000-0000-0000-0000000000d3';
const AGENT = '00000000-0000-0000-0000-0000000000d4';
const AGENT2 = '00000000-0000-0000-0000-0000000000d5';
const AGENT3 = '00000000-0000-0000-0000-0000000000d6';
const VIEWER = '00000000-0000-0000-0000-0000000000d7';

let staff; // id -> row
let leads; // [{ id, assigned_staff_id, ticket_state, deleted_at }]
let log; // every SQL statement run, in order

const t0 = Date.now();
function person(id, name, role, active = true) {
  staff[id] = { id, name, role, active, phone: `9477000${id.slice(-4)}`, created_at: new Date(t0 + Object.keys(staff).length) };
}

beforeEach(() => {
  staff = {};
  person(ADMIN, 'Anura Admin', 'admin');
  person(SUPER, 'Sunil Super', 'super_admin');
  person(AGENT, 'Kasun Agent', 'sales_agent');
  person(AGENT2, 'Nimal Agent', 'sales_agent');
  person(AGENT3, 'Ruwan Agent', 'sales_agent');
  person(VIEWER, 'Vishaka Viewer', 'viewer');
  leads = [];
  log = [];

  mockPool.connect = jest.fn().mockResolvedValue({ query: (...a) => mockPool.query(...a), release: jest.fn() });
  mockPool.query.mockImplementation((sql, params = []) => {
    const q = typeof sql === 'string' ? sql : sql.text;
    log.push(q);
    const ok = (rows, rowCount = rows.length) => Promise.resolve({ rows, rowCount });
    if (/SELECT id, name, role, active FROM staff_users WHERE id=\$1/.test(q)) return ok(staff[params[0]] ? [staff[params[0]]] : []);
    if (/WHERE id = \$1 OR role = ANY/.test(q)) {
      return ok(Object.values(staff).filter((u) => u.id === params[0] || params[1].includes(u.role)));
    }
    if (/SELECT l.id, c.priority_label FROM leads_all l/.test(q)) {
      return ok(leads.filter((l) => l.assigned_staff_id === params[0] && l.ticket_state === 'open' && !l.deleted_at)
        .map((l) => ({ id: l.id, priority_label: 'medium' })));
    }
    if (/SELECT su.id, su.name, count\(l.id\)/.test(q)) {
      return ok(Object.values(staff)
        .filter((u) => u.role === 'sales_agent' && u.active && u.id !== params[0])
        .sort((a, b) => a.created_at - b.created_at)
        .map((u) => ({ id: u.id, name: u.name, open_count: leads.filter((l) => l.assigned_staff_id === u.id && l.ticket_state === 'open').length })));
    }
    if (/SELECT id, name, role, active FROM staff_users WHERE id = \$1/.test(q)) return ok(staff[params[0]] ? [staff[params[0]]] : []);
    if (/UPDATE leads_all SET assigned_staff_id = \$2, assigned_at = now\(\)/.test(q)) {
      leads.find((l) => l.id === params[0]).assigned_staff_id = params[1];
      return ok([], 1);
    }
    if (/UPDATE leads_all SET assigned_staff_id = NULL WHERE assigned_staff_id = \$1/.test(q)) {
      const hit = leads.filter((l) => l.assigned_staff_id === params[0]);
      hit.forEach((l) => { l.assigned_staff_id = null; });
      return ok([], hit.length);
    }
    if (/SELECT id, role FROM staff_users WHERE id = \$1/.test(q)) return ok(staff[params[0]] ? [staff[params[0]]] : []);
    if (/^UPDATE staff_users SET (name|role|active)/.test(q)) {
      const u = staff[params[params.length - 1]];
      const cols = q.match(/SET (.*) WHERE/)[1].split(', ').map((c) => c.split('=')[0]);
      cols.forEach((c, i) => { u[c] = params[i]; });
      return ok([u]);
    }
    if (/SELECT 1 FROM staff_users WHERE phone = ANY/.test(q)) return ok([]);
    if (/UPDATE staff_users SET password_hash=\$1 WHERE id=\$2/.test(q)) return ok(staff[params[1]] ? [{ id: params[1] }] : []);
    if (/INSERT INTO staff_users/.test(q)) return ok([{ id: 'new', name: params[0], role: params[3] }]);
    if (/DELETE FROM staff_users WHERE id = \$1/.test(q)) {
      delete staff[params[0]];
      return ok([], 1);
    }
    return ok([]);
  });
});

const del = (id, body, by = ADMIN, role = 'admin') =>
  request(app).delete(`/api/staff/${id}`).set(authHeader(role, { id: by })).send(body);
const deleted = () => log.some((q) => /DELETE FROM staff_users/.test(q));

describe('who can be deleted', () => {
  test('only admins can delete accounts', async () => {
    const res = await del(AGENT2, { confirmName: 'Nimal Agent' }, AGENT, 'sales_agent');
    expect(res.status).toBe(403);
    expect(staff[AGENT2]).toBeTruthy();
  });

  test('nobody can delete their own account', async () => {
    const res = await del(ADMIN, { confirmName: 'Anura Admin' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/own account/);
    expect(deleted()).toBe(false);
  });

  test("the person's name must be typed to confirm", async () => {
    expect((await del(VIEWER, {})).status).toBe(400);
    expect((await del(VIEWER, { confirmName: 'Vishaka' })).status).toBe(400);
    expect(deleted()).toBe(false);
    // case and surrounding spaces do not matter
    expect((await del(VIEWER, { confirmName: '  vishaka viewer ' })).status).toBe(200);
    expect(staff[VIEWER]).toBeUndefined();
  });

  test('an admin cannot delete a super admin; a super admin can', async () => {
    const res = await del(SUPER, { confirmName: 'Sunil Super' });
    expect(res.status).toBe(403);
    expect(deleted()).toBe(false);
    person(ADMIN2, 'Other Super', 'super_admin');
    expect((await del(SUPER, { confirmName: 'Sunil Super' }, ADMIN2, 'super_admin')).status).toBe(200);
  });

  // Unreachable through the API today — the caller is always an active admin
  // and cannot delete themselves — so this backstop is driven directly: the
  // locked admin rows say the target is the only active one.
  test('refuses when the target is the only active admin left', async () => {
    delete staff[ADMIN];
    person(ADMIN2, 'Only Admin', 'admin');
    staff[SUPER].active = true;
    const lockedOnlyTarget = mockPool.query.getMockImplementation();
    mockPool.query.mockImplementation((sql, params) => {
      const q = typeof sql === 'string' ? sql : sql.text;
      if (/WHERE id = \$1 OR role = ANY/.test(q)) {
        return Promise.resolve({ rows: [{ ...staff[ADMIN2] }, { ...staff[SUPER], active: false }] });
      }
      return lockedOnlyTarget(sql, params);
    });
    const res = await del(ADMIN2, { confirmName: 'Only Admin' }, SUPER, 'super_admin');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/last active admin/);
    expect(deleted()).toBe(false);
  });

  test('an unknown id is a 404; a malformed one a 400', async () => {
    expect((await del('00000000-0000-0000-0000-00000000ffff', { confirmName: 'x' })).status).toBe(404);
    expect((await del('not-a-uuid', { confirmName: 'x' })).status).toBe(400);
  });
});

describe('their open leads', () => {
  beforeEach(() => {
    leads.push(
      { id: 'L1', assigned_staff_id: AGENT, ticket_state: 'open' },
      { id: 'L2', assigned_staff_id: AGENT, ticket_state: 'open' },
      { id: 'L3', assigned_staff_id: AGENT, ticket_state: 'open' },
      { id: 'L4', assigned_staff_id: AGENT, ticket_state: 'closed' },
      { id: 'L5', assigned_staff_id: AGENT2, ticket_state: 'open' },
    );
  });

  test('must be given to someone before the account can go', async () => {
    const res = await del(AGENT, { confirmName: 'Kasun Agent' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('reassign_required');
    expect(res.body.openLeads).toBe(3);
    expect(deleted()).toBe(false);
  });

  test('go to the person the admin picked; closed leads just lose the owner', async () => {
    const res = await del(AGENT, { confirmName: 'Kasun Agent', reassignTo: AGENT3 });
    expect(res.status).toBe(200);
    expect(res.body.openLeadsReassigned).toBe(3);
    expect(res.body.reassignedTo).toEqual({ id: AGENT3, name: 'Ruwan Agent' });
    expect(res.body.otherLeadsUnlinked).toBe(1);
    expect(leads.filter((l) => l.assigned_staff_id === AGENT3).map((l) => l.id)).toEqual(['L1', 'L2', 'L3']);
    expect(leads.find((l) => l.id === 'L4').assigned_staff_id).toBeNull();
    expect(staff[AGENT]).toBeUndefined();
  });

  test("'auto' shares them out by load, like new leads", async () => {
    const res = await del(AGENT, { confirmName: 'Kasun Agent', reassignTo: 'auto' });
    expect(res.status).toBe(200);
    // AGENT2 already had 1, AGENT3 had 0: L1→AGENT3, L2→AGENT3 (tie → older), L3→AGENT2…
    const by = (id) => leads.filter((l) => l.assigned_staff_id === id && l.ticket_state === 'open').length;
    expect(by(AGENT2) + by(AGENT3)).toBe(4);
    expect(Math.abs(by(AGENT2) - by(AGENT3))).toBeLessThanOrEqual(1);
  });

  test('cannot go to a disabled person, a viewer, or the person being deleted', async () => {
    staff[AGENT3].active = false;
    expect((await del(AGENT, { confirmName: 'Kasun Agent', reassignTo: AGENT3 })).status).toBe(400);
    expect((await del(AGENT, { confirmName: 'Kasun Agent', reassignTo: VIEWER })).status).toBe(400);
    expect((await del(AGENT, { confirmName: 'Kasun Agent', reassignTo: AGENT })).status).toBe(400);
    expect((await del(AGENT, { confirmName: 'Kasun Agent', reassignTo: 'someone' })).status).toBe(400);
    expect(deleted()).toBe(false);
    expect(leads.filter((l) => l.assigned_staff_id === AGENT)).toHaveLength(4);
  });

  test("'auto' with no other sales agent asks for a person instead", async () => {
    staff[AGENT2].active = false;
    staff[AGENT3].active = false;
    const res = await del(AGENT, { confirmName: 'Kasun Agent', reassignTo: 'auto' });
    expect(res.status).toBe(409);
    expect(deleted()).toBe(false);
  });
});

test('clears every reference that would block the delete, before deleting', async () => {
  schemaFlags.auditLog = true;
  const res = await del(VIEWER, { confirmName: 'Vishaka Viewer' });
  expect(res.status).toBe(200);
  const at = (re) => log.findIndex((q) => re.test(q));
  const del_ = at(/DELETE FROM staff_users/);
  for (const re of [
    /UPDATE leads_all SET assigned_staff_id = NULL/,
    /UPDATE showroom_visits SET staff_id = NULL/,
    /UPDATE order_payments_all SET recorded_by = NULL/,
    /UPDATE bulk_message_batches SET sent_by = NULL/,
  ]) {
    expect(at(re)).toBeGreaterThan(-1);
    expect(at(re)).toBeLessThan(del_);
  }
  expect(log.indexOf('COMMIT')).toBeGreaterThan(del_);
  const audit = mockPool.query.mock.calls.find(([q]) => /INSERT INTO audit_log/.test(q));
  expect(audit[1][0]).toBe('staff.deleted');
  expect(audit[1][7]).toMatchObject({ name: 'Vishaka Viewer', role: 'viewer' });
  schemaFlags.auditLog = false;
});

test('a refused delete rolls back and changes nothing', async () => {
  leads.push({ id: 'L9', assigned_staff_id: AGENT, ticket_state: 'open' });
  await del(AGENT, { confirmName: 'Kasun Agent' });
  expect(log).toContain('ROLLBACK');
  expect(log).not.toContain('COMMIT');
  expect(log.some((q) => /SET .* = NULL/.test(q))).toBe(false);
});

test('confirmName must be text, not an array that stringifies to the name', async () => {
  expect((await del(VIEWER, { confirmName: ['Vishaka Viewer'] })).status).toBe(400);
  expect(deleted()).toBe(false);
});

// The rules DELETE relies on are worthless if the neighbouring routes let an
// admin get round them — demote a super admin, then delete them; or reset
// their password and simply become them. All five were possible before
// staffChangeRefusal() (confirmed over real HTTP on a database clone).
describe('account changes an admin may not make', () => {
  const patch = (id, body, by = ADMIN, role = 'admin') =>
    request(app).patch(`/api/staff/${id}`).set(authHeader(role, { id: by })).send(body);

  test('demote, disable or rename a super admin', async () => {
    expect((await patch(SUPER, { role: 'viewer' })).status).toBe(403);
    expect((await patch(SUPER, { active: false })).status).toBe(403);
    expect((await patch(SUPER, { name: 'x' })).status).toBe(403);
    expect(staff[SUPER]).toMatchObject({ role: 'super_admin', active: true, name: 'Sunil Super' });
  });

  test('make themselves, or anyone else, a super admin', async () => {
    expect((await patch(ADMIN, { role: 'super_admin' })).status).toBe(403);
    expect((await patch(AGENT, { role: 'super_admin' })).status).toBe(403);
    const created = await request(app).post('/api/staff').set(authHeader('admin', { id: ADMIN }))
      .send({ name: 'Evil', phone: '94771000099', password: 'Long-enough-pass-1', role: 'super_admin' });
    expect(created.status).toBe(403);
    expect(log.some((q) => /INSERT INTO staff_users/.test(q))).toBe(false);
  });

  test("reset a super admin's password (an account takeover) or clear their sign-in block", async () => {
    const reset = await request(app).patch(`/api/staff/${SUPER}/password`).set(authHeader('admin', { id: ADMIN }))
      .send({ password: 'Attacker-chosen-1' });
    expect(reset.status).toBe(403);
    expect(log.some((q) => /SET password_hash/.test(q))).toBe(false);
    const clear = await request(app).post(`/api/staff/${SUPER}/clear-signin-block`).set(authHeader('admin', { id: ADMIN }));
    expect(clear.status).toBe(403);
  });

  test('change their own role or disable themselves', async () => {
    expect((await patch(ADMIN, { role: 'viewer' })).status).toBe(400);
    expect((await patch(ADMIN, { active: false })).status).toBe(400);
    expect(staff[ADMIN]).toMatchObject({ role: 'admin', active: true });
    // their own name is fine
    expect((await patch(ADMIN, { name: 'Anura A.' })).status).toBe(200);
  });

  test('sneak a deactivation through as the string "false"', async () => {
    expect((await patch(AGENT, { active: 'false' })).status).toBe(400);
    expect(staff[AGENT].active).toBe(true);
  });

  // As with DELETE, the caller is always an active admin, so the lock result
  // is driven directly: the target is the only active admin in it.
  test('demote or disable the last active admin', async () => {
    const real = mockPool.query.getMockImplementation();
    mockPool.query.mockImplementation((sql, params) => {
      const q = typeof sql === 'string' ? sql : sql.text;
      if (/WHERE id = \$1 OR role = ANY/.test(q)) {
        return Promise.resolve({ rows: [{ ...staff[ADMIN] }, { ...staff[SUPER], active: false }] });
      }
      return real(sql, params);
    });
    for (const body of [{ role: 'viewer' }, { active: false }]) {
      const res = await patch(ADMIN, body, SUPER, 'super_admin');
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/last active admin/);
    }
    expect(staff[ADMIN]).toMatchObject({ role: 'admin', active: true });
    // promoting within the admin roles is not "losing admin"
    expect((await patch(ADMIN, { role: 'super_admin' }, SUPER, 'super_admin')).status).toBe(200);
  });

  test('a super admin can do all of it (to others)', async () => {
    person(ADMIN2, 'Other Super', 'super_admin');
    expect((await patch(SUPER, { role: 'admin' }, ADMIN2, 'super_admin')).status).toBe(200);
    expect((await patch(AGENT, { role: 'super_admin' }, ADMIN2, 'super_admin')).status).toBe(200);
    const reset = await request(app).patch(`/api/staff/${AGENT}/password`).set(authHeader('super_admin', { id: ADMIN2 }))
      .send({ password: 'Brand-new-pass-1' });
    expect(reset.status).toBe(200);
  });

  test('ordinary edits still work for an admin', async () => {
    expect((await patch(AGENT, { role: 'viewer' })).status).toBe(200);
    expect((await patch(AGENT, { active: false })).status).toBe(200);
    expect(staff[AGENT]).toMatchObject({ role: 'viewer', active: false });
  });
});
