// Shared test helpers.
//
// authenticate() re-reads staff_users on every request, so deactivation and
// demotion take effect immediately rather than waiting out a 12h token. That
// means every authenticated request issues one extra query BEFORE the route's
// own queries. `mockAuthenticatedAs` answers just that query, leaving the
// per-test mockResolvedValueOnce queue for the route under test.

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const STAFF_LOOKUP = /FROM staff_users WHERE id=\$1/;
const DEFAULT_ID = '00000000-0000-0000-0000-000000000001';

/** A signed staff token. Does not by itself make the request authenticate. */
function tokenFor(role, { id = DEFAULT_ID, name, expiresIn = '1h', secret = JWT_SECRET } = {}) {
  return jwt.sign({ id, name: name || `Test ${role}`, role }, secret, { expiresIn });
}

/** An Authorization header for `role`. */
function authHeader(role, opts) {
  return { Authorization: `Bearer ${tokenFor(role, opts)}` };
}

/**
 * Make the staff_users lookup in authenticate() resolve to an active user with
 * the given role, so requests bearing that role's token get through. Any other
 * query falls through to `rest`, which defaults to an empty result set.
 *
 * Pass `active: false` to simulate a deactivated account.
 */
function mockAuthenticatedAs(mockPool, role, { id = DEFAULT_ID, active = true, rest } = {}) {
  const staffRow = { id, name: `Test ${role}`, role, active };
  const queue = [];

  mockPool.query.mockImplementation((...args) => {
    const sql = typeof args[0] === 'string' ? args[0] : args[0] && args[0].text;
    if (sql && STAFF_LOOKUP.test(sql)) {
      return Promise.resolve({ rows: active ? [staffRow] : [], rowCount: active ? 1 : 0 });
    }
    if (queue.length > 0) return queue.shift()();
    if (rest) return rest(...args);
    return Promise.resolve({ rows: [], rowCount: 0 });
  });

  return {
    /** Queue one result for the next non-staff query (like mockResolvedValueOnce). */
    next(result) {
      queue.push(() => Promise.resolve(result));
      return this;
    },
    /** Queue one rejection for the next non-staff query. */
    nextError(err) {
      queue.push(() => Promise.reject(err));
      return this;
    },
    /** Every non-staff query the app issued, as [sql, params] pairs. */
    calls() {
      return mockPool.query.mock.calls
        .map((args) => [typeof args[0] === 'string' ? args[0] : args[0] && args[0].text, args[1] || (args[0] && args[0].values)])
        .filter(([sql]) => sql && !STAFF_LOOKUP.test(sql));
    },
  };
}

module.exports = { tokenFor, authHeader, mockAuthenticatedAs, JWT_SECRET, DEFAULT_ID, STAFF_LOOKUP };
