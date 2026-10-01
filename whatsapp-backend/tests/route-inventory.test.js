// Route inventory — the gate that catches an ungated route BEFORE it ships.
//
// WHY THIS EXISTS. authz.test.js had a test named "every /api route is
// explicitly gated" that iterated a hardcoded list of FIVE paths. There are 87.
// A new route was invisible to it, which is exactly how four ungated routes
// shipped — one of them serving every staff member's bcrypt password hash to
// any logged-in user, including the lowest-privilege `viewer` role.
//
// So this test does not take a list. It ENUMERATES the router and asserts every
// route falls into one of three declared tiers. A new route joins no tier by
// default, so it fails here until someone classifies it deliberately.
//
// HOW GATING IS DETECTED, and why the obvious approaches do not work:
//
//   * Handler NAMES are useless. requireRole() returns a bare arrow closure
//     (index.js), so every handler reports as '' / '<anonymous>'. A
//     name-based check reports all 87 routes as ungated.
//   * Authentication is POSITIONAL. `app.use('/api', authenticate)` is one
//     layer in the stack; a route registered after it is authenticated, one
//     before it is not. So the layer index is the truth, and is what this
//     reads.
//   * Role gating is detected from the gate's SOURCE TEXT. That is the one
//     brittle part, so it is pinned by a self-check below — without that, a
//     refactor of requireRole could silently turn this whole file into a no-op,
//     which is the precise failure of the test it replaces.

jest.mock('pg');
jest.mock('@anthropic-ai/sdk', () => require('./__mocks__/anthropic'));

const { app } = require('../index');

// Routes reachable with NO staff token at all. Each needs its own compensating
// control, named here so the reason survives the next reader.
const PUBLIC = [
  'POST /api/auth/login', //            loginLimiter + per-account lockout
  'POST /api/promo-codes/validate', //  promoCodeLimiter; called by nidikumba.shop
  'POST /api/promo-codes/redeem', //    promoCodeLimiter; called by nidikumba.shop
  'POST /api/webchat', //               webchatLimiter; the public site has no backend
  'POST /api/calls', //                 requireCallTrackerAuth (paired-device token, or legacy shared secret)
  'POST /api/calls/start', //           requireCallTrackerAuth (paired-device token, or legacy shared secret)
  // Click-to-call (migration 050). The Call Tracker phone has no staff JWT;
  // it signs in once and then carries its own per-device token.
  'POST /api/devices/pair', //          devicePairLimiter + verifyStaffCredentials (same lockout as login)
  'POST /api/devices/pair/qr', //       devicePairLimiter + a one-time 5-minute code issued to a logged-in staff member (migration 056)
  'GET /api/devices/stream', //         requireDeviceToken — only that phone's own dial commands
  'POST /api/devices/dial/:id/status', // requireDeviceToken, scoped to the phone owner's own requests
  'POST /api/devices/heartbeat', //     requireDeviceToken; only marks the caller's own phone alive
];

// Routes that require a token but deliberately do NOT restrict by role.
// Kept as its own tier rather than lumped in with PUBLIC: "any staff member"
// is a much weaker exposure than "anyone on the internet", and collapsing the
// two would let a route that loses its requireRole be quietly re-labelled
// public.
const AUTHENTICATED_ANY_ROLE = [
  'GET /api/auth/me', //   returns only the caller's own token payload
  'GET /api/events', //    SSE; token scoping covered by authz.test.js
  // Closes the caller's OWN session row (migration 045) using the session id
  // in their own token. Ungated on purpose: every role signs out, and a role
  // check here would mean some staff member's session could never be closed.
  // It cannot touch anyone else's session — the id comes from the verified
  // token, never from the request body.
  'POST /api/auth/logout',
];

// Matches the body of the closure requireRole() returns.
const ROLE_GATE = /roles\.includes\(req\.staff\.role\)/;

// Express 4 exposes the stack at app._router. Express 5 renames it to
// app.router — but on 4 that property is a getter that THROWS, so it cannot be
// probed with `app.router ?? app._router`. Feature-detect by version instead.
function routerStack() {
  const desc = Object.getOwnPropertyDescriptor(app, 'router');
  if (desc && typeof desc.get !== 'function' && app.router) return app.router.stack;
  return app._router.stack;
}

function inventory() {
  const stack = routerStack();
  const authIdx = stack.findIndex((l) => l.name === 'authenticate');
  const routes = [];
  stack.forEach((layer, i) => {
    if (!layer.route || typeof layer.route.path !== 'string') return;
    if (!layer.route.path.startsWith('/api')) return;
    for (const method of Object.keys(layer.route.methods)) {
      routes.push({
        id: `${method.toUpperCase()} ${layer.route.path}`,
        authenticated: i > authIdx,
        roleGated: layer.route.stack.some((h) => ROLE_GATE.test(h.handle.toString())),
      });
    }
  });
  return { routes, authIdx };
}

describe('route inventory: every /api route is classified', () => {
  // Guards the detector itself. If requireRole is refactored and ROLE_GATE
  // stops matching, this fails loudly instead of the inventory silently
  // passing everything.
  test('the gating detector still tells a gated route from an ungated one', () => {
    const { routes, authIdx } = inventory();
    expect(authIdx).toBeGreaterThan(-1);
    const gated = routes.find((r) => r.id === 'GET /api/staff');
    const ungated = routes.find((r) => r.id === 'GET /api/auth/me');
    expect(gated).toBeDefined();
    expect(ungated).toBeDefined();
    expect(gated.roleGated).toBe(true);
    expect(ungated.roleGated).toBe(false);
  });

  // Exact-set equality, not toContain: a route LEAVING a tier fails too, so the
  // allowlists cannot accumulate stale entries, and the diff in the failure
  // message names the offending route directly.
  test('only the declared routes are reachable without authentication', () => {
    const { routes } = inventory();
    const actual = routes.filter((r) => !r.authenticated).map((r) => r.id);
    expect(actual.sort()).toEqual([...PUBLIC].sort());
  });

  test('every authenticated route is role-gated unless declared otherwise', () => {
    const { routes } = inventory();
    const actual = routes.filter((r) => r.authenticated && !r.roleGated).map((r) => r.id);
    expect(actual.sort()).toEqual([...AUTHENTICATED_ANY_ROLE].sort());
  });

  // Sanity: the enumeration must actually find the app. A zero here would make
  // both assertions above pass vacuously.
  test('the inventory finds the real route table', () => {
    const { routes } = inventory();
    expect(routes.length).toBeGreaterThan(50);
  });
});
