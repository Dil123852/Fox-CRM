#!/usr/bin/env node
/**
 * Role access sweep — proves a role-plumbing change did not alter what any
 * EXISTING role can reach.
 *
 * Adding `super_admin` meant touching requireRole(), which gates all 83 route
 * handlers. A short-circuit there is one line, but if it were written wrongly
 * it could silently widen (or narrow) access for the other six roles, and
 * nothing in the test suite would notice. Reading the diff cannot prove that
 * either — the whole point is the behaviour at 89 endpoints x 7 roles.
 *
 * So: hit every route as every role and record the AUTHORIZATION outcome, then
 * diff that against a baseline captured before the change. Only the
 * deliberately-changed entries may differ.
 *
 * What is recorded is deliberately NOT the raw status code: a route may 400 on
 * a bad body or 404 on a fake id, and that varies with the test data. Only
 * three outcomes matter, and they are exactly what requireRole controls:
 *
 *   denied  -> 403 (the gate rejected this role)
 *   authed  -> 401 (token rejected; should not happen with a valid token)
 *   allowed -> anything else: the gate passed and the handler ran
 *
 * Usage:
 *   node scripts/role-access-sweep.js  --base http://127.0.0.1:3106 \
 *                                      --out  baseline.json
 *   node scripts/role-access-sweep.js  --base ... --out after.json
 *   node scripts/role-access-sweep.js  --compare baseline.json after.json
 *
 * Writes are sent with an empty body on purpose. They are expected to 400,
 * which still proves the gate let them through; and an empty body cannot
 * accidentally mutate real data if this is ever pointed at a live server.
 */

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const ROLES = [
  'admin',
  'sales_agent',
  'inventory_manager',
  'delivery_coordinator',
  'finance',
  'viewer',
  'super_admin',
];

// Placeholder values for :params. They need not resolve to real rows — a 404
// is an "allowed" outcome, because reaching the handler is the thing being
// asserted. A syntactically valid UUID avoids a 500 from a uuid cast, which
// would be noise rather than signal.
const UUID = '00000000-0000-0000-0000-000000000001';
const SUBS = { ':id': UUID, ':itemId': UUID, ':paymentId': UUID, ':table': 'orders', ':report': 'sales_funnel' };

function extractRoutes(indexPath) {
  const src = fs.readFileSync(indexPath, 'utf8');
  const re = /app\.(get|post|patch|put|delete)\(\s*'(\/api\/[^']*)'/g;
  const out = new Map();
  let m;
  while ((m = re.exec(src)) !== null) {
    const method = m[1].toUpperCase();
    const route = m[2];
    out.set(`${method} ${route}`, { method, route });
  }
  return [...out.values()].sort((a, b) => `${a.method} ${a.route}`.localeCompare(`${b.method} ${b.route}`));
}

const fill = route =>
  route
    .split('/')
    .map(seg => (seg.startsWith(':') ? SUBS[seg] || UUID : seg))
    .join('/');

// The sweep must not depend on a real staff row per role: authenticate()
// re-reads the role from the DB, so each role needs its own account. They are
// created by the caller (see the shell harness) and passed in as a JSON map.
function tokenFor(id, role, secret) {
  return jwt.sign({ id, name: `sweep_${role}`, role }, secret, { algorithm: 'HS256', expiresIn: '1h' });
}

function outcome(status) {
  if (status === 403) return 'denied';
  if (status === 401) return 'authed';
  return 'allowed';
}

async function sweep({ base, secret, staffByRole }) {
  const routes = extractRoutes(path.join(__dirname, '..', 'index.js'));
  const result = {};
  for (const role of ROLES) {
    const staffId = staffByRole[role];
    if (!staffId) continue; // role has no seeded account (e.g. pre-change super_admin)
    const token = tokenFor(staffId, role, secret);
    for (const { method, route } of routes) {
      const key = `${method} ${route}`;
      const url = base + fill(route);
      let status;
      try {
        const res = await fetch(url, {
          method,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
        });
        status = res.status;
      } catch (err) {
        status = 0;
      }
      (result[key] ||= {})[role] = outcome(status);
    }
  }
  return result;
}

function compare(aPath, bPath) {
  const a = JSON.parse(fs.readFileSync(aPath, 'utf8'));
  const b = JSON.parse(fs.readFileSync(bPath, 'utf8'));
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const diffs = [];
  for (const k of keys) {
    for (const role of ROLES) {
      const x = a[k]?.[role];
      const y = b[k]?.[role];
      // A role absent from the baseline (super_admin) is a pure addition, not
      // a regression, so it is reported separately rather than as a diff.
      if (x === undefined && y === undefined) continue;
      if (x === undefined) continue;
      if (x !== y) diffs.push({ route: k, role, before: x, after: y });
    }
  }
  return diffs;
}

(async () => {
  const args = process.argv.slice(2);
  const arg = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

  if (arg('--compare') !== null) {
    const [a, b] = [arg('--compare'), args[args.indexOf('--compare') + 2]];
    const diffs = compare(a, b);
    if (diffs.length === 0) {
      console.log('IDENTICAL — no existing role’s access changed.');
    } else {
      console.log(`${diffs.length} DIFFERENCE(S):`);
      for (const d of diffs) console.log(`  ${d.route}  [${d.role}]  ${d.before} -> ${d.after}`);
    }
    process.exit(diffs.length === 0 ? 0 : 1);
  }

  const base = arg('--base') || 'http://127.0.0.1:3106';
  const out = arg('--out') || 'sweep.json';
  const secret = process.env.JWT_SECRET;
  if (!secret) { console.error('JWT_SECRET must be set'); process.exit(2); }
  const staffByRole = JSON.parse(fs.readFileSync(arg('--staff') || 'staff.json', 'utf8'));

  const result = await sweep({ base, secret, staffByRole });
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  const n = Object.keys(result).length;
  console.log(`swept ${n} routes x ${Object.keys(staffByRole).length} roles -> ${out}`);
})();
