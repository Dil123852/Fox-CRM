require('dotenv').config();
const express = require('express');
const { Pool, types: pgTypes } = require('pg');
// pg's default DATE parser (OID 1082) hands back a JS Date at UTC midnight
// for the literal calendar date, which every consumer then re-renders in
// local time — shifting the displayed day back by one for any timezone
// ahead of UTC (confirmed: a DB value of 2026-08-14 round-tripped through
// the API as "2026-08-13T18:30:00.000Z" and rendered as 08/13 in the UI).
// Returning the raw 'YYYY-MM-DD' string instead sidesteps the whole
// UTC-conversion round-trip for every DATE column in this app, not just the
// follow-up dates that surfaced it.
pgTypes.setTypeParser(1082, (val) => val);
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const cron = require('node-cron');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const app = express();
// Trust exactly one hop (ngrok/reverse proxy in front of this single backend),
// not an unlimited chain — `true` lets any client spoof X-Forwarded-For and
// break IP-based rate limiting (Phase 9's promo-code endpoints depend on it).
app.set('trust proxy', 1);
// Default 100kb was too small for the call-tracker app's batch sync (POST
// /api/calls) — a real device's call log history can run into the hundreds
// of entries per batch, confirmed hitting PayloadTooLargeError in production
// at 218KB against the old default.
// verify: capture the exact bytes so the Meta webhook can HMAC the raw body.
// Recomputing it from the parsed object would not match — key order and
// whitespace are not preserved by JSON.parse/stringify.
app.use(
  express.json({
    limit: '5mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: false, limit: '5mb' })); // Twilio webhooks post form-encoded bodies

// Public routes (promo validate/redeem — called directly from nidikumba.shop
// and other third-party sites, per Phase 9) stay open to any origin.
// Everything else is the staff dashboard's own API and is locked to the
// dashboard's real origin(s) — CORS_ALLOWED_ORIGINS is a comma-separated list.
const PUBLIC_CORS_PATHS = ['/api/promo-codes/validate', '/api/promo-codes/redeem', '/api/webchat'];
const CORS_ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (PUBLIC_CORS_PATHS.includes(req.path)) {
    res.header('Access-Control-Allow-Origin', '*');
  } else if (origin && CORS_ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── who is making this request (migration 035) ───────────────────────────────
// The activity_log trigger reads the actor from the app.staff_* settings rather
// than from application code, because there is no single place in this file
// where every write passes through — 164 raw pool.query() calls, no wrapper.
//
// Getting the actor to the trigger is the one piece that cannot live in the
// database, and three things rule out the cheaper ways of doing it. All three
// were measured against the real server, not assumed:
//   1. pool.query() checks out a DIFFERENT pooled connection per call, so a SET
//      issued in middleware is not seen by the query that follows.
//   2. set_config(..., true) is transaction-local and a lone pool.query() is its
//      own implicit transaction, so setting it in a separate query on the same
//      connection does not survive into the next one (it reads back as '').
//   3. Folding the SET into the statement as a CTE does not work either:
//      Postgres does not execute a CTE nothing references, even MATERIALIZED —
//      confirmed on both SELECT and UPDATE, where the setting stayed empty.
//
// So an attributed WRITE takes one connection and runs BEGIN → set_config →
// statement → COMMIT. Reads are left completely untouched: they trigger no
// audit rows, and wrapping them would double the round trips on every page.
const requestContext = new AsyncLocalStorage();

// Only these need attribution — a SELECT never fires the audit trigger.
const WRITE_SQL = /^\s*(insert|update|delete)\b/i;

const originalPoolQuery = pool.query;

// Under test, pool.query is a jest.fn() and the suite both replaces it
// (mockImplementation) and resets it (jest.clearAllMocks) AFTER this module is
// required. Anything captured here — a bind, or a copy of the function's own
// properties — goes stale on the first reset, and the route's queries then run
// against a detached mock that records nothing. Four tests asserting on the SQL
// a route issued were reading an empty list because of exactly that.
//
// So the wrapper is only installed against a REAL pool. Against the test double
// pool.query is left completely alone, which is also the honest thing: audit
// attribution needs a live connection to set app.staff_id on, and there is
// nothing to attribute to in a unit test.
const POOL_IS_REAL = !pool.query._isMockFunction;
const rawPoolQuery = (...args) => originalPoolQuery.apply(pool, args);

if (POOL_IS_REAL) pool.query = function query(text, params, cb) {
  const staff = POOL_IS_REAL ? requestContext.getStore() : null;
  const sql = typeof text === 'string' ? text : text && text.text;
  // No staff (scheduler, public webhook, startup probe) or not a write: run it
  // exactly as before. Unattributed writes record NULL and show as "System",
  // which is honest rather than blaming whoever was last seen.
  // A callback-style call is also passed straight through — this file always
  // awaits the promise, and supporting both here would only add a second path.
  if (!staff || !sql || cb || !WRITE_SQL.test(sql)) {
    return rawPoolQuery(text, params, cb);
  }
  return (async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.staff_id', $1, true), " +
        "set_config('app.staff_name', $2, true), " +
        "set_config('app.staff_role', $3, true)",
        [staff.id || '', staff.name || '', staff.role || '']
      );
      const result = await client.query(text, params);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  })();
};
// A route that takes its own connection for a multi-statement transaction
// (the order delete) bypasses the wrapper above, because its statements run on
// a client rather than through pool.query. So stamp the actor onto the client
// itself at checkout: the first BEGIN the route issues starts a transaction
// that already knows who is acting, and every statement inside it is attributed.
// It must keep pg's own callback contract, NOT be an async function. pool.query
// internally calls pool.connect(callback); an async override returns a promise
// and ignores that callback, so every pool.query in the app hangs forever —
// measured, and it took the whole backend down before this was caught.
const rawPoolConnect = pool.connect.bind(pool);
function stampClient(client) {
  const staff = POOL_IS_REAL ? requestContext.getStore() : null;
  if (!staff || !client) return client;
  // Connections are POOLED and reused across requests, so the wrapper has to be
  // reinstalled — with THIS request's actor — on every checkout. A one-shot
  // guard flag left on the client looked right and silently attributed later
  // deletes to "System", because the first request to use a connection was the
  // only one that ever stamped it. Keep the original query function on the
  // client so repeated wrapping cannot nest.
  if (!client._rawQuery) client._rawQuery = client.query.bind(client);
  const rawQuery = client._rawQuery;
  let stamped = false;
  client.query = function query(text, params, cb) {
    const sql = typeof text === 'string' ? text : text && text.text;
    // Stamp once, immediately after the route opens its transaction. Only the
    // promise form is wrapped; a callback-style BEGIN is passed straight
    // through rather than silently changing its contract.
    if (!stamped && !cb && sql && /^\s*begin\b/i.test(sql)) {
      stamped = true;
      return rawQuery(text, params).then(r =>
        rawQuery(
          "SELECT set_config('app.staff_id', $1, true), " +
          "set_config('app.staff_name', $2, true), " +
          "set_config('app.staff_role', $3, true)",
          [staff.id || '', staff.name || '', staff.role || '']
        ).then(() => r)
      );
    }
    return rawQuery(text, params, cb);
  };
  return client;
}
pool.connect = function connect(cb) {
  if (cb) return rawPoolConnect((err, client, done) => cb(err, err ? client : stampClient(client), done));
  return rawPoolConnect().then(stampClient);
};

// ── schema feature detection ─────────────────────────────────────────────────
// Migrations in this project are applied MANUALLY (deploy.yml deliberately
// does not run them). That has repeatedly taken production pages down: code
// referencing a column from an unapplied migration makes every query on that
// route throw, so the page shows "no data" and the real cause is only visible
// in the server log.
//
// So: probe for the columns that were added late, once at startup, and let
// the affected queries fall back to a shape the older schema supports. A
// missing migration then costs a feature, not a page — and logs a loud,
// specific warning naming the migration to run.
const schemaFlags = { messageFailureReason: false, reachabilityView: false };

async function detectSchema() {
  try {
    const { rows } = await pool.query(`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'messages' AND column_name IN ('failure_code', 'failure_reason')
    `);
    schemaFlags.messageFailureReason = rows[0].n === 2;

    // v_customer_reachability also comes from 029 and is joined by the bulk
    // send — probe it separately so one missing piece can't take the other down.
    const { rows: vw } = await pool.query(`
      SELECT count(*)::int AS n FROM information_schema.views
      WHERE table_name = 'v_customer_reachability'
    `);
    schemaFlags.reachabilityView = vw[0].n === 1;

    // migration 036 — audit logging degrades to a silent no-op until applied,
    // rather than making every login fail on a missing table.
    const { rows: al } = await pool.query(`
      SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_name = 'audit_log'
    `);
    schemaFlags.auditLog = al[0].n === 1;
    if (!schemaFlags.auditLog) {
      console.warn(
        '[schema] audit_log is MISSING — run migrations/036_audit_log.sql. ' +
          'Authentication failures, permission denials and admin actions will NOT be recorded.'
      );
    }

    // migration 035 — per-account login lockout columns.
    const { rows: lk } = await pool.query(`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'staff_users' AND column_name IN ('failed_login_count', 'locked_until')
    `);
    schemaFlags.loginLockout = lk[0].n === 2;
    if (!schemaFlags.loginLockout) {
      console.warn(
        '[schema] staff_users.failed_login_count/locked_until are MISSING — run ' +
          'migrations/035_login_lockout.sql. Login stays rate-limited per IP, but ' +
          'without per-account lockout.'
      );
    }

    // migration 045 — session tracking behind the super_admin "active hours"
    // screen. Probed like the others so a server running against a database
    // that has not had 045 applied still logs people in normally; it just
    // records no sessions, rather than 500ing on every sign-in.
    const { rows: ss } = await pool.query(`
      SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_name = 'staff_sessions'
    `);
    schemaFlags.staffSessions = ss[0].n === 1;
    if (!schemaFlags.staffSessions) {
      console.warn(
        '[schema] staff_sessions is MISSING — run migrations/045_super_admin_role.sql. ' +
          'Login still works, but staff active hours will not be recorded.'
      );
    }
    // migration 051 — which agent's phone logged each call. Probed so a server
    // on a database without 051 keeps syncing calls (it just records no
    // agent) instead of failing every call-tracker sync on a missing column.
    const { rows: ces } = await pool.query(`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'call_events' AND column_name IN ('staff_id', 'device_id')
    `);
    schemaFlags.callEventStaff = ces[0].n === 2;
    if (!schemaFlags.callEventStaff) {
      console.warn(
        '[schema] call_events.staff_id/device_id are MISSING — run migrations/051_call_event_staff.sql. ' +
          'Calls still sync, but will not record which agent made them.'
      );
    }
    // migration 057 — "don't give the volume discount" flag on orders and
    // quotations. Probed so a server on an older database keeps working; only
    // a request that actually waives the discount is refused.
    const { rows: vwv } = await pool.query(`
      SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_name IN ('orders_all', 'quotations') AND column_name = 'volume_discount_waived'
    `);
    schemaFlags.volumeWaiver = vwv[0].n === 2;
    if (!schemaFlags.volumeWaiver) {
      console.warn(
        '[schema] volume_discount_waived is MISSING — run migrations/057_volume_discount_waived.sql. ' +
          'Orders still work, but the volume discount cannot be switched off.'
      );
    }
    // migration 058 — who placed each order. Probed so a server on an older
    // database keeps placing orders; a sales agent then sees only orders from
    // leads assigned to them.
    const { rows: opb } = await pool.query(`
      SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_name = 'orders_all' AND column_name = 'placed_by'
    `);
    schemaFlags.orderPlacedBy = opb[0].n === 1;
    if (!schemaFlags.orderPlacedBy) {
      console.warn(
        '[schema] orders_all.placed_by is MISSING — run migrations/058_per_agent_visibility.sql. ' +
          'Orders still work, but will not record who placed them.'
      );
    }
    // migration 053 — custom discount columns + staff_notifications. Probed so
    // a server on a database without 053 keeps placing ordinary orders; only
    // an order that actually carries a custom discount is refused.
    const { rows: cd } = await pool.query(`
      SELECT (SELECT count(*)::int FROM information_schema.columns
               WHERE table_name = 'orders_all' AND column_name IN ('custom_discount', 'custom_discount_reason', 'custom_discount_by', 'custom_discount_at'))
           + (SELECT count(*)::int FROM information_schema.tables WHERE table_name = 'staff_notifications') AS n
    `);
    schemaFlags.customDiscount = cd[0].n === 5;
    if (!schemaFlags.customDiscount) {
      console.warn(
        '[schema] orders_all.custom_discount*/staff_notifications are MISSING — run ' +
          'migrations/053_custom_discount_notifications.sql. Orders still work, but a custom discount cannot be given.'
      );
    }
    // migration 054 — quotations. Probed so the rest of the app keeps working
    // on a database without it; the Quotations routes answer 503 until then.
    const { rows: qt } = await pool.query(`
      SELECT (SELECT count(*)::int FROM information_schema.tables WHERE table_name = 'quotations')
           + (SELECT count(*)::int FROM information_schema.columns
               WHERE table_name = 'staff_notifications' AND column_name = 'quotation_id') AS n
    `);
    schemaFlags.quotations = qt[0].n === 2;
    if (!schemaFlags.quotations) {
      console.warn('[schema] quotations is MISSING — run migrations/054_quotations.sql. The Quotations page will not work until then.');
    }
    // migration 055 — a promo code on a quotation.
    const { rows: qp } = await pool.query(`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'quotations' AND column_name IN ('promo_code', 'promo_discount')
    `);
    schemaFlags.quotationPromo = qp[0].n === 2;
    // migration 056 — one-time QR codes for signing a phone in.
    const { rows: pc } = await pool.query(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'device_pair_codes'"
    );
    schemaFlags.pairCodes = pc[0].n === 1;
    if (!schemaFlags.pairCodes) {
      console.warn('[schema] device_pair_codes is MISSING — run migrations/056_device_pair_codes.sql. QR sign-in is off; password sign-in still works.');
    }
    if (schemaFlags.quotations && !schemaFlags.quotationPromo) {
      console.warn('[schema] quotations.promo_code is MISSING — run migrations/055_quotation_promo_code.sql. Quotations work, but without a promo code.');
    }
    if (!schemaFlags.reachabilityView) {
      console.warn(
        '[schema] v_customer_reachability is MISSING — run ' +
          'migrations/029_message_failure_reason.sql. Bulk sends will still work, ' +
          "but cannot pre-warn about WhatsApp's 24-hour window."
      );
    }
    if (!schemaFlags.messageFailureReason) {
      console.warn(
        '[schema] messages.failure_code/failure_reason are MISSING — run ' +
          'migrations/029_message_failure_reason.sql. Message send failures will ' +
          'still be flagged, but without the explanatory reason.'
      );
    }
  } catch (err) {
    console.error('[schema] detection failed, assuming the older schema:', err.message);
    schemaFlags.messageFailureReason = false;
  }
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// The Meta Cloud API sender id. Overridable by env so a different
// WhatsApp Business number does not need a code change; the literal is
// kept as the default so existing deployments (which do not set this)
// behave exactly as before.
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '1091734507363701';
const WHATSAPP_API_URL = `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`;

const twilioClient = process.env.TWILIO_ACCOUNT_SID ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN) : null;

// ── staff auth (Phase 1 / Module 2 — Staff Roles & Access Control) ───────────
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('JWT_SECRET is not set — refusing to start. Set it in .env (see .env.example).');
  process.exit(1);
}
// The oversight role (migration 045). Satisfies every requireRole() gate via
// the short-circuit in that function — deliberately NOT added to the lists
// below, because listing it in each would be 68 edits with 68 chances to miss
// one, and a missed one is a silent hole rather than a loud failure.
const SUPER_ADMIN = 'super_admin';

// "Does this staff member satisfy this role list?" — with the super_admin
// short-circuit folded in, exactly as requireRole() does it.
//
// WHY THIS EXISTS: requireRole() only guards a route's ENTRY. A dozen checks
// run INSIDE route handlers to gate one field or one branch (mark-paid,
// reassign, COD, call-lead visibility, …), and those never touch requireRole,
// so super_admin silently failed every one of them. The comment above claims
// the role "satisfies every gate"; that was true of the middleware and false
// of the inline checks. Routing them all through here makes it true of both.
//
// Mirrors roleAllowed() in whatsapp-dashboard/src/lib/roles.js. The two cannot
// import from each other, so they are kept deliberately identical in shape.
const hasRole = (staff, ...roles) =>
  staff?.role === SUPER_ADMIN || roles.includes(staff?.role);

// Assignable roles, used to validate the `role` field on staff create/update.
// super_admin IS included: it must be grantable once a first one exists (which
// migration 045 documents doing by hand, since only a super_admin may grant it).
const STAFF_ROLES = [SUPER_ADMIN, 'admin', 'sales_agent', 'inventory_manager', 'delivery_coordinator', 'finance', 'viewer'];

// Every role EXCEPT delivery_coordinator. That role's job is fulfillment on
// orders already placed, not the sales pipeline or customer chat, so it is
// excluded from leads/messages/calls (confirmed with the user). Named rather
// than repeated inline at each of its 5 call sites, so the intent is stated
// once and a future role cannot be added to four of five lists by accident.
// Password policy. Applied to BOTH staff creation and password reset — they
// previously disagreed: POST /api/staff enforced nothing at all (a
// one-character admin password was accepted) while the reset route required
// only 6 characters. These accounts can read the entire customer database.
const PASSWORD_MIN_LENGTH = 12;

// Rejected outright regardless of length. Not a full common-password list —
// that belongs in a dependency — but it stops the passwords people actually
// pick when a minimum length is the only rule.
const WEAK_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  '123456789012',
  'qwertyuiop',
  'qwerty123456',
  'administrator',
  'nidikumba',
  'nidikumba123',
  'letmein12345',
  'welcome12345',
  'changeme1234',
  'iloveyou1234',
]);

// Returns an error string, or null when the password is acceptable.
function validatePassword(password) {
  if (typeof password !== 'string' || password.length === 0) return 'password is required';
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  const normalized = password.trim().toLowerCase();
  if (WEAK_PASSWORDS.has(normalized)) return 'password is too common — choose something less guessable';
  if (/^(.)\1+$/.test(password)) return 'password cannot be a single repeated character';
  return null;
}

// Request-body validation on top of the existing column allowlists.
//
// The allowlists already prevent mass assignment at the DB layer — an unknown
// key simply never reaches the UPDATE. But silently DROPPING it means a
// client that sends {"name":"x","role":"admin"} gets a 200 and reasonably
// believes the role was set. Rejecting the request instead makes a
// privilege-escalation attempt visible (and audit-logged) rather than a
// no-op, and turns a caller's typo into an error instead of a silent
// non-update.
//
// Deliberately NOT a schema library: zod/joi would mean a new dependency and
// rewriting ten handlers that already work. This reuses each route's existing
// `allowed` array as the schema it already is.
function rejectUnknownFields(req, res, allowed, { ignore = [] } = {}) {
  const permitted = new Set([...allowed, ...ignore]);
  const unknown = Object.keys(req.body || {}).filter((k) => !permitted.has(k));
  if (unknown.length === 0) return false;
  recordAuditEvent(req, 'request.unknown_fields', { fields: unknown.join(','), route: req.route?.path });
  res.status(400).json({
    error: `Unknown field(s): ${unknown.join(', ')}. Allowed: ${allowed.join(', ')}`,
  });
  return true;
}

// Bounds for the free-text fields that reach the database. Postgres TEXT has
// no length limit, so without this a single request can store an arbitrarily
// large value — a cheap way to bloat the table or a WhatsApp message.
const MAX_TEXT_LENGTH = 2000;
const MAX_NAME_LENGTH = 200;

function validateFieldValues(updates) {
  for (const [key, value] of Object.entries(updates)) {
    if (typeof value !== 'string') continue;
    const limit = /name|phone|code|no$/i.test(key) ? MAX_NAME_LENGTH : MAX_TEXT_LENGTH;
    if (value.length > limit) return `${key} is too long (max ${limit} characters)`;
  }
  return null;
}

// Per-account login lockout (migration 035). The IP-based loginLimiter alone
// left a distributed attacker unlimited guesses against one known account.
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

// Append-only security event log (migration 036). NEVER throws and never
// blocks the caller: a failure to record an event must not turn a working
// request into an error, and must not mask the original outcome.
//
// `detail` takes identifiers and outcomes only. Request bodies, passwords and
// tokens must never be passed in; the redaction below is a backstop, not a
// licence to hand it a body.
const AUDIT_REDACT = /pass|secret|token|authorization|hash|api[-_]?key/i;

function auditDetail(detail) {
  const out = {};
  for (const [k, v] of Object.entries(detail || {})) {
    out[k] = AUDIT_REDACT.test(k) ? '[redacted]' : v;
  }
  return out;
}

async function recordAuditEvent(req, event, detail = {}) {
  if (!schemaFlags.auditLog) return;
  try {
    await pool.query(
      `INSERT INTO audit_log (event, staff_id, staff_phone, staff_role, ip, method, path, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        event,
        req.staff?.id ?? null,
        detail.phone ?? null,
        req.staff?.role ?? null,
        req.ip ?? null,
        req.method ?? null,
        req.originalUrl ? String(req.originalUrl).split('?')[0] : null,
        auditDetail({ ...detail, phone: undefined }),
      ]
    );
  } catch (err) {
    console.error(`audit_log write failed for '${event}':`, err.message);
  }
}

const PIPELINE_READ_ROLES = ['admin', 'sales_agent', 'inventory_manager', 'finance', 'viewer'];

// EventSource cannot set custom headers, so /api/events accepts the token as a
// query parameter. Scoped to THAT PATH ONLY (2026-09-10 audit): accepting it
// everywhere put a 12-hour, admin-capable bearer token into nginx access logs,
// browser history and any Referer header, for every route.
const QUERY_TOKEN_PATHS = new Set(['/api/events']);

// The full request path, independent of where the middleware is mounted.
// `authenticate` runs under `app.use('/api', ...)`, and Express strips the
// mount prefix from `req.path` inside a mounted handler — so `req.path` is
// '/events' there, never '/api/events'. Matching the Set against `req.path`
// therefore NEVER matched, and every EventSource connection (which cannot send
// an Authorization header) was rejected with 401, breaking live updates on the
// only two pages that subscribe to SSE. Rebuilt from baseUrl + path so the
// comparison holds wherever this is mounted.
//
// req.originalUrl is deliberately NOT used: it carries the query string, so it
// could never equal a bare path in the Set.
function fullPath(req) {
  const base = req.baseUrl || '';
  const path = req.path || '';
  // With a mount, path is relative to it; joining reconstructs the original.
  // Trailing slashes are normalized away so '/api/events/' matches too.
  const joined = `${base}${path}`.replace(/\/+$/, '');
  return joined === '' ? '/' : joined;
}

function getToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  if (req.query.token && QUERY_TOKEN_PATHS.has(fullPath(req))) return req.query.token;
  return null;
}

// The role and active flag are re-read from staff_users on every request
// rather than trusted from the token's claims. Without this, deactivating or
// demoting a staff member had NO effect until their 12h token expired — so
// `active=false` was not a working incident-response control, and a demoted
// admin kept admin rights for the rest of the token's life.
//
// One indexed primary-key lookup per request. If that ever becomes a
// bottleneck, the alternative is a token_version column bumped on
// deactivation/demotion and compared against a claim.
// Heartbeat behind "active hours" (migration 045).
//
// THROTTLED IN MEMORY, deliberately: without this every authenticated request
// would add an UPDATE, and a dashboard that polls turns one page view into
// hundreds of writes a minute. A session only needs to be accurate to within
// the staleness window the view uses (30 min), so 5 minutes is ample and costs
// ~1 write per user per 5 min.
//
// The map is per-process and lost on restart, which is harmless: the worst case
// is one extra UPDATE per session after a deploy. It is bounded by the number
// of live sessions and entries are dropped once stale, so it cannot grow
// without limit.
const HEARTBEAT_MS = 5 * 60 * 1000;
const lastHeartbeat = new Map();

function touchSession(sid) {
  if (!sid || !schemaFlags.staffSessions) return;
  const now = Date.now();
  const prev = lastHeartbeat.get(sid);
  if (prev && now - prev < HEARTBEAT_MS) return;
  lastHeartbeat.set(sid, now);

  // Opportunistic cleanup: drop entries older than twice the interval, so a
  // long-running process does not accumulate one per session ever seen.
  if (lastHeartbeat.size > 500) {
    for (const [k, t] of lastHeartbeat) if (now - t > HEARTBEAT_MS * 2) lastHeartbeat.delete(k);
  }

  // Fire-and-forget: a heartbeat must never delay or fail the request it rode
  // in on. Only touches a session that is still open, so a logged-out session
  // is never resurrected by a stale token still being used.
  pool
    .query(`UPDATE staff_sessions SET last_seen_at = now() WHERE id = $1 AND ended_at IS NULL`, [sid])
    .catch(err => console.error('session heartbeat failed:', err.message));
}

async function authenticate(req, res, next) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'Missing or invalid Authorization header' });

  let claims;
  try {
    claims = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  try {
    const { rows } = await pool.query('SELECT id, name, role, active FROM staff_users WHERE id=$1', [claims.id]);
    const user = rows[0];
    if (!user || user.active === false) {
      return res.status(401).json({ error: 'Account is inactive or no longer exists' });
    }
    // DB is authoritative for role — never the claim.
    req.staff = { id: user.id, name: user.name, role: user.role, sid: claims.sid || null };
    touchSession(claims.sid);
    next();
  } catch (err) {
    console.error('authenticate: staff lookup failed:', err.message);
    return res.status(503).json({ error: 'Authentication temporarily unavailable' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.staff) return res.status(401).json({ error: 'Not authenticated' });
    // super_admin satisfies every gate (migration 045). Done HERE rather than
    // by adding the role to all 68 call sites that name 'admin': one place
    // cannot be partially applied, and a missed call site would be an
    // invisible hole. Verified by grep that every requireRole() gate in this
    // file includes 'admin', so this reaches genuinely everything.
    //
    // Placed AFTER the req.staff check on purpose: an unauthenticated request
    // must still get 401. Reversing these two lines would turn a missing token
    // into a role check against undefined rather than a rejection.
    //
    // req.staff.role is re-read from the database by authenticate() on every
    // request, never taken from the JWT claim, so a revoked super_admin loses
    // this immediately rather than at token expiry.
    if (req.staff.role === SUPER_ADMIN) return next();
    if (!roles.includes(req.staff.role)) {
      // Recorded: a permission denial is the signal that someone is probing
      // for routes their role should not reach. Fire-and-forget.
      recordAuditEvent(req, 'authz.denied', { required: roles.join(','), actual: req.staff.role });
      return res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
    }
    next();
  };
}

// ── outbound send dispatch (routes by the customer's inbound channel) ────────
// Turns a provider send error into something a staff member can act on.
// The common case by far is Twilio 63016: WhatsApp only accepts a free-form
// (non-template) message within 24h of the customer's OWN last inbound
// message. Outside that window Twilio accepts the API call and WhatsApp
// discards it — so "Not delivered" with no explanation is the default
// experience unless we translate it. Verified against real Twilio records.
function describeSendFailure(err) {
  const raw = String(err?.message || err || '');
  const code = err?.code ?? (raw.match(/\b(6[0-9]{4})\b/) || [])[1] ?? null;
  const map = {
    63016:
      "Outside WhatsApp's 24-hour window — the customer hasn't messaged us in 24h, so WhatsApp only accepts a pre-approved template, not free text.",
    63024: 'WhatsApp rejected the number as invalid.',
    63015: 'WhatsApp could not send the media (a known limit of the Twilio Sandbox number).',
    63003: 'No WhatsApp account found for that number.',
    21211: 'The phone number is not a valid destination.',
    63007: 'The sending WhatsApp number is not configured correctly.',
  };
  return {
    code: code ? String(code) : null,
    reason: (code && map[code]) || raw.slice(0, 300) || 'Unknown send error',
  };
}

// The number to actually MESSAGE, which is not always the customer's identity
// number. customers.whatsapp_number holds the number a call came from (the
// call path writes it there), and that is often a landline or a mobile with no
// WhatsApp — so staff can record the customer's real WhatsApp number
// separately (migration 027). Resolved here, at the single choke point every
// outbound path already goes through, so AI replies, order confirmations,
// follow-up promos, campaigns and bulk sends all pick it up without each call
// site knowing about it.
function whatsappTarget(customer) {
  const alt = (customer.contact_whatsapp_number || '').trim();
  return alt || customer.whatsapp_number;
}

// Is the Meta Cloud API actually usable in this deployment? WHATSAPP_TOKEN is
// a placeholder here, so it is not — Twilio is the only real sender.
// Evaluated per-call rather than cached so setting a real token later takes
// effect on restart without touching this logic.
function metaConfigured() {
  const t = process.env.WHATSAPP_TOKEN;
  return !!t && !/^your-|placeholder/i.test(t);
}

// Which API to SEND through. Deliberately NOT `customer.channel` alone.
//
// customers.channel records how a customer FIRST CONTACTED US (call /
// webchat / showroom / twilio / meta) — it is origin history, and it is shown
// as such on the Customers page and used by campaign segments. It must not
// decide whether we can message them, which is what it used to do: a
// customer created by the call-tracker sync got channel='call', took the
// unconfigured Meta branch, and 401'd. On real production data that made
// 312 of 314 customers unmessageable.
//
// Every number this system holds IS a WhatsApp number by design (confirmed
// with the user): a call number is normally on WhatsApp, staff collect the
// real one into contact_whatsapp_number when it isn't (migration 027), and
// web chat asks for a WhatsApp number before the conversation starts. So the
// sender is chosen by what is CONFIGURED, not by origin.
function sendChannelFor(customer) {
  if (customer.channel === 'meta' && metaConfigured()) return 'meta';
  if (twilioClient) return 'twilio';
  return metaConfigured() ? 'meta' : 'none';
}

async function sendWhatsAppMessage(customer, text) {
  const via = sendChannelFor(customer);
  if (via === 'none') {
    throw new Error(
      'No WhatsApp sender is configured: set TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN, or a real WHATSAPP_TOKEN for the Meta Cloud API.'
    );
  }
  if (via === 'twilio') {
    if (!twilioClient) throw new Error('Twilio is not configured (missing TWILIO_ACCOUNT_SID/TOKEN)');
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: `whatsapp:+${whatsappTarget(customer)}`,
      body: text,
    });
    return;
  }

  // Meta Cloud API — only reached when sendChannelFor() resolved to 'meta',
  // which requires a real WHATSAPP_TOKEN.
  const waResponse = await fetch(WHATSAPP_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: whatsappTarget(customer),
      type: 'text',
      text: { body: text },
    }),
  });
  if (!waResponse.ok) {
    const errBody = await waResponse.text();
    throw new Error(`WhatsApp send failed: ${waResponse.status} ${errBody}`);
  }
}

// Image + caption send (added for the automated follow-up promo, migration
// 018). imageUrl must be a real publicly-reachable URL — Twilio fetches
// media from it server-side, it does not accept a file upload here. Meta's
// Cloud API path mirrors the existing text-send branch's shape but is
// unreachable in practice (WHATSAPP_TOKEN is still a placeholder — see
// CLAUDE.md); Twilio is the only channel this is confirmed against.
async function sendWhatsAppImage(customer, imageUrl, caption) {
  const via = sendChannelFor(customer);
  if (via === 'none') throw new Error('No WhatsApp sender is configured (Twilio or Meta).');
  if (via === 'twilio') {
    if (!twilioClient) throw new Error('Twilio is not configured (missing TWILIO_ACCOUNT_SID/TOKEN)');
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: `whatsapp:+${whatsappTarget(customer)}`,
      body: caption || '',
      mediaUrl: [imageUrl],
    });
    return;
  }

  const waResponse = await fetch(WHATSAPP_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: whatsappTarget(customer),
      type: 'image',
      image: { link: imageUrl, caption: caption || undefined },
    }),
  });
  if (!waResponse.ok) {
    const errBody = await waResponse.text();
    throw new Error(`WhatsApp image send failed: ${waResponse.status} ${errBody}`);
  }
}

// ── typing indicator (Phase 8, REQ-6.4) ───────────────────────────────────────
// Twilio-only: real API (v3, public beta -> GA), confirmed against Twilio's
// current docs rather than assumed. Meta's Cloud API has a different typing-
// indicator mechanism and that channel is unconfigured/placeholder anyway
// (see CLAUDE.md) — not implemented for Meta this phase. Best-effort: never
// blocks or fails the main reply flow.
async function sendTypingIndicator(customer, whatsappMessageId) {
  // Twilio-specific API, so gate on the sender actually in use rather than
  // the customer's origin channel.
  if (sendChannelFor(customer) !== 'twilio' || !whatsappMessageId) return;
  try {
    await fetch('https://messaging.twilio.com/v3/Indicators/Typing.json', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'),
      },
      body: JSON.stringify({ channel: 'WHATSAPP', messageId: whatsappMessageId }),
    });
  } catch (err) {
    console.error('Typing indicator failed (non-critical):', err.message);
  }
}

// ── markdown -> WhatsApp formatting (Phase 8, REQ-6.1) ────────────────────────
// WhatsApp doesn't render markdown tables or headers at all (they'd show as
// raw pipes/hashes) — this is a real bug already observed in this exact
// codebase (an early test reply used a markdown price table). Bold syntax
// conveniently overlaps (**x** -> *x*, both markdown and WhatsApp use single
// asterisks for bold), so only tables/headers/links actually need rewriting.
function markdownToWhatsApp(text) {
  let out = text;

  // Tables: "| A | B |" -> "A — B"; drop separator rows ("|---|---|")
  out = out.replace(/^\|.*\|$/gm, (line) => {
    if (/^\|[\s:|-]+\|$/.test(line)) return '';
    const cells = line
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean);
    return cells.join(' — ');
  });

  out = out.replace(/^#{1,6}\s*(.+)$/gm, '*$1*'); // headers -> bold line
  out = out.replace(/\*\*(.+?)\*\*/g, '*$1*'); // **bold** -> *bold*
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)'); // [text](url) -> text (url)
  out = out.replace(/\n{3,}/g, '\n\n'); // collapse gaps left by stripped rows

  return out.trim();
}

// ── escalate_to_human tool (Phase 8, REQ-6.8/6.9, Appendix A.5) ──────────────
const ESCALATE_TOOL = {
  name: 'escalate_to_human',
  description:
    'Call when the customer explicitly asks for a human, sounds frustrated, raises a complaint, or needs something outside your authorization (custom discounts, refunds).',
  input_schema: {
    type: 'object',
    properties: {
      reason: { type: 'string' },
      urgency: { type: 'string', enum: ['normal', 'high'] },
    },
    required: ['reason'],
  },
};

// REQ-6.11: a single consistent bridge message, not an ad hoc AI-generated one.
const ESCALATION_BRIDGE_MESSAGE = "Got it — I'm connecting you with one of our team members now, they'll follow up with you shortly! 🙏";

// ── apply_promo_code tool (Phase 9) ───────────────────────────────────────────
// Unlike escalate_to_human (terminal — fixed bridge message, no reply needed
// from Claude), this is a look-up-and-continue tool: the result is fed back
// to Claude in a second turn so it can phrase a natural reply. Calls the
// read-only validate_promo_code (not redeem) — checking a code in chat
// shouldn't consume a real customer's redemption slot; actual redemption
// happens at checkout via POST /api/promo-codes/redeem.
const APPLY_PROMO_CODE_TOOL = {
  name: 'apply_promo_code',
  description: "Call when the customer mentions a promo or discount code, to check whether it's valid and what discount it gives.",
  input_schema: {
    type: 'object',
    properties: { code: { type: 'string' } },
    required: ['code'],
  },
};

async function checkPromoCode(code, phone) {
  try {
    const { rows } = await pool.query('SELECT * FROM validate_promo_code($1, $2)', [code, phone]);
    const result = rows[0];
    if (!result?.valid) return result;
    // So the AI can say "LKR 2,500 off each mattress" rather than implying a
    // flat amount (migration 052).
    const { rows: extra } = await pool.query(
      'SELECT discount_scope, max_units_per_order, eligible_product_names FROM promo_codes WHERE id=$1',
      [result.promo_code_id]
    );
    const scope = extra[0]?.discount_scope || 'order';
    return {
      ...result,
      applies: scope === 'per_unit' ? 'per mattress (discount_amount is given once for each mattress bought)' : 'once per order',
      max_mattresses_counted: extra[0]?.max_units_per_order ?? null,
      only_for_products: extra[0]?.eligible_product_names || null,
    };
  } catch (err) {
    return { valid: false, message: 'Could not check that code right now.' };
  }
}

// ── check_warranty_status tool (Phase 10, Appendix A.7) ───────────────────────
// No input params — "the backend resolves this by querying v_warranty_status
// for the customer already identified in the conversation" (Appendix A.7's
// own note), not by anything the AI supplies.
const CHECK_WARRANTY_TOOL = {
  name: 'check_warranty_status',
  description:
    "Look up warranty status and details for the customer's own purchases. Call when they ask about warranty, coverage, or how long their mattress is covered.",
  input_schema: { type: 'object', properties: {}, required: [] },
};

async function checkWarrantyStatus(customerId) {
  try {
    const { rows } = await pool.query(
      `SELECT product_name, start_date, end_date, effective_status, days_remaining
       FROM v_warranty_status WHERE customer_id=$1 ORDER BY end_date DESC`,
      [customerId]
    );
    return { warranties: rows };
  } catch (err) {
    return { warranties: [], error: 'Could not check warranty status right now.' };
  }
}

// ── SSE real-time broadcast ───────────────────────────────────────────────────
// res -> { staffId, role } of the signed-in dashboard user on that connection,
// so an event about ONE person (their call's progress, their phone's status)
// can go to them — and admins — instead of every logged-in browser.
const sseClients = new Map();

/**
 * Sends an SSE event to open dashboards. `audience`, when given, picks who
 * receives it: (client: { staffId, role }) => boolean. Without it the event
 * goes to everyone, as before (lead/customer/message updates are team-wide).
 */
function broadcastEvent(event, data = {}, audience = null) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [res, client] of sseClients) {
    if (audience && !audience(client)) continue;
    try {
      res.write(payload);
    } catch (_) {
      sseClients.delete(res);
    }
  }
}

const isAdminClient = client => client.role === 'admin' || client.role === SUPER_ADMIN;

// ── SQL helpers ───────────────────────────────────────────────────────────────
const CUSTOMER_JSON = `json_build_object(
  'id', c.id, 'whatsapp_number', c.whatsapp_number, 'name', c.name,
  'priority_score', c.priority_score, 'priority_label', c.priority_label,
  'ai_enabled', c.ai_enabled,
  -- channel identifies a call-originated customer ('call'), whose
  -- whatsapp_number is the number they phoned from and may have no WhatsApp
  -- at all; contact_whatsapp_number (migration 027) is the real one staff
  -- collect on the ticket in that case.
  'channel', c.channel,
  'contact_whatsapp_number', c.contact_whatsapp_number
) as customers`;

// ── product catalog (cached, backs the AI system prompt) ─────────────────────
let catalogCache = { text: null, fetchedAt: 0 };
const CATALOG_CACHE_MS = 5 * 60 * 1000;

// variants shape (migration 015): [{size, dimension, price}] — dimension is
// the exact WxL in inches (e.g. "72x36"), the real per-unit variant now that
// each product has one fixed thickness. Grouped into a per-size price range
// here rather than listing all ~4-5 exact dimensions per size — keeps the
// catalog text usable in a chat prompt; staff/the order form resolve the
// exact dimension and exact price.
function formatProductCatalog(products) {
  const mattresses = products.filter((p) => p.category === 'mattress');
  const pillows = products.filter((p) => p.category === 'pillow');

  const mattressText = mattresses
    .map((p) => {
      const bySize = {};
      for (const v of p.variants) (bySize[v.size] ??= []).push(v.price);
      const priceLines = Object.entries(bySize)
        .map(([size, prices]) => {
          const min = Math.min(...prices),
            max = Math.max(...prices);
          const range = min === max ? `LKR ${min.toLocaleString()}` : `LKR ${min.toLocaleString()}–${max.toLocaleString()}`;
          return `${size}: ${range}`;
        })
        .join(', ');
      const pillowTop =
        p.has_pillow_top_option && p.pillow_top_addon_price
          ? ` Optional pillow-top upgrade: +LKR ${Number(p.pillow_top_addon_price).toLocaleString()}.`
          : '';
      // Kept as a general selling point (confirmed with the user) but no
      // longer per-product: products.free_pillows_included was dropped in
      // migration 039 because the giveaway is negotiated per order now, so
      // staff decide the real quantity on the order screen.
      const freeGift = p.category === 'mattress' ? '\n  Free gift: pillows included — ask us' : '';
      return `• ${p.name} (${p.spring_type})\n  ${p.description}${pillowTop}\n  Prices by size: ${priceLines}\n  (Exact price depends on the exact bed dimension within each size — confirm with staff for the final quote.)${freeGift}`;
    })
    .join('\n\n');

  const pillowText = pillows
    .map((p) => {
      const price = p.variants[0]?.price;
      return `• ${p.name} — LKR ${Number(price).toLocaleString()} (also given free with qualifying mattress purchases)`;
    })
    .join('\n');

  return `${mattressText}\n\nStandalone pillows:\n${pillowText}`;
}

async function getProductCatalogText() {
  if (catalogCache.text && Date.now() - catalogCache.fetchedAt < CATALOG_CACHE_MS) {
    return catalogCache.text;
  }
  const { rows } = await pool.query('SELECT * FROM products WHERE active=true ORDER BY category, name');
  const text = formatProductCatalog(rows);
  catalogCache = { text, fetchedAt: Date.now() };
  return text;
}

// ── Shared get-or-create logic (Phase 14) ────────────────────────────────────
// Previously duplicated three ways: inline in processIncomingMessage (WhatsApp),
// inline in the handle_call_event Postgres trigger (Dialog calls), and about to
// be needed a third time for showroom visits. The Dialog side's version lived
// in a DB trigger and couldn't be called from JS, so that trigger has been
// removed (see migration 012) and its logic now lives here instead — the one
// customer/ticket code path all three channels share.
// ONE canonical phone format: 94XXXXXXXXX — what WhatsApp/Twilio actually
// delivers to (`whatsapp:+94...`). Nothing normalized before migration 030,
// so the same person became several customer records ('94716218191',
// '716218191', '0744061971'), each with its own chat history, and a send to
// the non-94 record failed because that string is not the WhatsApp identity.
//
// Mirrors the SQL normalize_lk_phone() exactly. Returns the input's digits
// unchanged when the shape isn't recognised — never guesses a country code.
function normalizePhone(phone) {
  const d = String(phone ?? '').replace(/[^0-9]/g, '');
  if (/^94[0-9]{9}$/.test(d)) return d; // already canonical
  // '940771234567' — 94 prepended to a number that kept its local trunk '0'.
  // Unambiguous at 12 digits, so repair it rather than leave the record
  // unmessageable. Must stay in sync with SQL normalize_lk_phone().
  if (/^940[0-9]{9}$/.test(d)) return '94' + d.slice(3);
  if (/^0[0-9]{9}$/.test(d)) return '94' + d.slice(1); // 0771234567
  if (/^[0-9]{9}$/.test(d)) return '94' + d; // 771234567
  return d || String(phone ?? '').trim();
}

// Every spelling of a staff login phone that means the same number:
// 94771234567, 0771234567, 771234567 and +94771234567 (plus whatever was
// typed, and its digits-only form for non-Sri-Lankan numbers).
//
// Deliberately a list for `phone = ANY(...)` rather than normalize_lk_phone()
// on the column: staff_users.phone was stored EXACTLY as typed before this
// (no normalization anywhere), so existing accounts hold a mix of formats.
// Matching the candidates finds them all without rewriting a single stored
// login — nobody's sign-in changes — and still uses the column's unique index.
function staffPhoneCandidates(input) {
  const raw = String(input ?? '').trim();
  const canonical = normalizePhone(raw);
  const candidates = new Set([raw, canonical]);
  if (/^94[0-9]{9}$/.test(canonical)) {
    const local = canonical.slice(2);
    candidates.add(`0${local}`);
    candidates.add(local);
    candidates.add(`+${canonical}`);
  }
  return [...candidates].filter(Boolean);
}

async function findOrCreateCustomerByPhone(phone, channel) {
  // Normalize FIRST: this is the single choke point every channel uses to
  // find-or-create a customer, so canonicalising here is what stops the same
  // human becoming several records with different number formats.
  const canonical = normalizePhone(phone);
  const { rows } = await pool.query('SELECT * FROM customers WHERE whatsapp_number=$1', [canonical]);
  if (rows.length > 0) return { customer: rows[0], created: false };
  const { rows: newRows } = await pool.query('INSERT INTO customers (whatsapp_number, channel) VALUES ($1, $2) RETURNING *', [
    canonical,
    channel,
  ]);
  return { customer: newRows[0], created: true };
}

// "Open" means ticket_state='open' — the same convention the Dialog call
// trigger always used. WhatsApp's analyzeConversation previously matched ANY
// lead for the customer regardless of ticket_state, which meant a returning
// customer whose only lead was closed/won/lost got that old lead silently
// updated instead of a fresh ticket opened. Fixed here to match Dialog's
// (correct) behavior — a deliberate behavior change, confirmed with the user.
// assignedStaffId (migration 025): when a call's device owner is known
// (whatsapp-backend's call routes matched the device's registered owner
// phone against staff_users.phone), pass their id straight through so the
// new lead is force-assigned to them instead of round-robin — see
// handle_new_lead_assignment(), which now skips its own round-robin logic
// whenever assigned_staff_id already arrives non-null. Every other caller
// (WhatsApp, web chat, showroom visits) leaves this undefined and keeps the
// existing round-robin behavior untouched.
async function getOrCreateOpenTicket(customerId, { source, assignedStaffId } = {}) {
  const { rows } = await pool.query("SELECT * FROM leads WHERE customer_id=$1 AND ticket_state='open' LIMIT 1", [customerId]);
  if (rows.length > 0) return { lead: rows[0], created: false };
  const { rows: newRows } = await pool.query(
    "INSERT INTO leads (customer_id, status, source, assigned_staff_id) VALUES ($1, 'new', $2, $3) RETURNING *",
    [customerId, source, assignedStaffId || null]
  );
  return { lead: newRows[0], created: true };
}

// Resolves which staff member owns the phone that placed/received a call
// (migration 025) — matches the call-tracker app's registered device-owner
// phone against staff_users.phone. Returns null (fall back to round-robin)
// when there's no match: an unregistered device, a landline, or a staff
// member who hasn't set their owner phone in the app yet (confirmed with
// the user — round-robin is the correct fallback, not "leave unassigned").
async function findStaffIdByOwnerPhone(ownerPhone) {
  if (!ownerPhone) return null;
  const normalized = normalizeCallTrackerNumber(ownerPhone);
  if (!normalized) return null;
  const { rows } = await pool.query('SELECT id FROM staff_users WHERE phone=$1 AND active=true', [normalized]);
  return rows[0]?.id || null;
}

// ── analyzeConversation ───────────────────────────────────────────────────────
// Scoring criteria below follow spec Section 4.2, minus signals this function
// has no data for: reply latency and delivery-zone status (conversationMessages
// carries no timestamps or zone lookup). Catalog swapped Phase — migration
// 015: each product now has ONE fixed thickness (no more per-order height
// choice); the real per-unit variant is now the exact bed dimension (e.g.
// "72x36") within a nominal size, not a spring-thickness pick.
async function analyzeConversation(customerId, conversationMessages) {
  const transcript = conversationMessages.map((m) => `${m.role === 'user' ? 'Customer' : 'AI'}: ${m.content}`).join('\n');

  try {
    const catalogText = await getProductCatalogText();
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [
        {
          role: 'user',
          content: `Analyze this WhatsApp conversation for Nidikumba Mattresses, a Sri Lankan mattress company.

Our current catalog:
${catalogText}

Extract the following as a JSON object (use null for any field not yet mentioned):
{
  "score": 1,
  "label": "low",
  "customer_name": null,
  "product_type": null,
  "bed_size": null,
  "qty": null,
  "unit_price": null,
  "location": null,
  "delivery_address": null,
  "status": null
}

Determine "score" and "label" using this points system — do not guess, add up the points.

INTENT signals (how close to a buying decision):
  +4  asked the price of a specific mattress
  +3  asked about payment or installment options
  +3  asked how to place an order / said they're ready to buy
  +2  asked about delivery timeline
  +2  asked about warranty, trial period, or return policy
  +2  mentioned a genuine health need (back pain, firmness preference, sleep issues)
  -2  said "just looking", "comparing", or "will decide later"

VALUE signals (how commercially worth pursuing):
  +3  asked about Nidikumba Ayu Spring (our premium pocketed-spring line)
  +3  bulk or business inquiry (guesthouse, hotel, multiple units)
  +1  stated budget matches a mid/high-tier price from the catalog above

Sum every signal that applies (a conversation can match several). Map the total to:
  total >= 8   → label "high", score 3
  total 4-7    → label "medium", score 2
  total < 4     → label "low", score 1

product_type: the mattress name mentioned (e.g. "Ayu Sleep 6", "Nidikumba Rise", "Nidikumba Signature", "Nidikumba Ayu Spring")
bed_size: the exact bed dimension mentioned if given (e.g. "72x36"), otherwise the nominal size (Single, Double, Queen, King, or Extra Large)
status: only set to "won" or "lost" if conversation explicitly mentions it — otherwise null

Reply with the JSON object ONLY, no other text.

Conversation:
${transcript}`,
        },
      ],
    });

    const match = response.content[0].text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in Claude response');
    const parsed = JSON.parse(match[0]);

    // Update customer priority + optional name
    const custParams = [parsed.score, parsed.label, new Date().toISOString()];
    let custSql = 'UPDATE customers SET priority_score=$1, priority_label=$2, priority_updated_at=$3';
    if (parsed.customer_name) {
      custParams.push(parsed.customer_name);
      custSql += `, name=$${custParams.length}`;
    }
    custParams.push(customerId);
    custSql += ` WHERE id=$${custParams.length}`;
    await pool.query(custSql, custParams);
    broadcastEvent('customer_update', { id: customerId });

    // Build lead field updates from extracted data
    const extracted = {};
    for (const f of ['product_type', 'bed_size', 'location', 'delivery_address']) {
      if (parsed[f] !== null && parsed[f] !== undefined) extracted[f] = String(parsed[f]);
    }
    if (parsed.qty !== null && parsed.qty !== undefined) extracted.qty = Number(parsed.qty);
    if (parsed.unit_price !== null && parsed.unit_price !== undefined) extracted.unit_price = Number(parsed.unit_price);
    // Phase 15: 'showroom' retired as a pipeline status — it's a source/origin
    // concept now (customers.channel / leads.source / showroom_visits), not a
    // stage a lead passes through. A customer mentioning they'll visit a
    // showroom is no longer auto-recorded here; it's captured for real if
    // staff log an actual visit via POST /api/showroom-visits.
    if (['won', 'lost'].includes(parsed.status)) extracted.status = parsed.status;

    const { lead, created } = await getOrCreateOpenTicket(customerId, { source: 'Facebook' });
    if (!created && ['won', 'lost'].includes(lead.status)) delete extracted.status;
    const entries = Object.entries({ ...extracted, updated_at: new Date().toISOString() });
    if (entries.length > 0) {
      const setClauses = entries.map(([k], i) => `${k}=$${i + 1}`).join(', ');
      await pool.query(`UPDATE leads SET ${setClauses} WHERE id=$${entries.length + 1}`, [...entries.map(([, v]) => v), lead.id]);
    }
    broadcastEvent('lead_update', { customer_id: customerId });

    console.log(
      `Analyzed: priority=${parsed.score} (${parsed.label}), status=${parsed.status || 'unchanged'}, product=${parsed.product_type || '?'}`
    );
  } catch (err) {
    console.error('analyzeConversation failed (non-critical):', err.message);
  }
}

// Returns { type: 'text', text } or { type: 'escalate', reason, urgency } —
// the caller decides what to send (chunked reply vs. the fixed bridge message).
// customerPhone is needed for apply_promo_code's once-per-customer check.
// customer is the full row (whatsapp_number for apply_promo_code's
// once-per-customer check, id for check_warranty_status's lookup).
async function callClaudeWithRetry(messages, customer, retries = 3) {
  const system = await buildSystemPrompt();
  const tools = [ESCALATE_TOOL, APPLY_PROMO_CODE_TOOL, CHECK_WARRANTY_TOOL];

  // Look-up-and-continue tools (not terminal like escalate_to_human): each
  // resolves to a JSON-serializable result fed back to Claude for a second
  // turn, so it can phrase a natural reply instead of the AI just guessing.
  const LOOKUP_TOOLS = {
    apply_promo_code: (use) => checkPromoCode(use.input.code, customer.whatsapp_number),
    check_warranty_status: () => checkWarrantyStatus(customer.id),
  };

  for (let i = 0; i < retries; i++) {
    try {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system,
        messages,
        tools,
      });

      const escalateUse = response.content.find((b) => b.type === 'tool_use' && b.name === 'escalate_to_human');
      if (escalateUse) {
        return { type: 'escalate', reason: escalateUse.input.reason, urgency: escalateUse.input.urgency || 'normal' };
      }

      const lookupUse = response.content.find((b) => b.type === 'tool_use' && LOOKUP_TOOLS[b.name]);
      if (lookupUse) {
        const toolResult = await LOOKUP_TOOLS[lookupUse.name](lookupUse);
        const followUp = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 500,
          system,
          tools,
          messages: [
            ...messages,
            { role: 'assistant', content: response.content },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: lookupUse.id, content: JSON.stringify(toolResult) }] },
          ],
        });
        const followUpText = followUp.content.find((b) => b.type === 'text');
        return { type: 'text', text: followUpText ? followUpText.text : '' };
      }

      const textBlock = response.content.find((b) => b.type === 'text');
      return { type: 'text', text: textBlock ? textBlock.text : '' };
    } catch (err) {
      const isOverloaded = err.status === 529;
      const isLast = i === retries - 1;
      if (isOverloaded && !isLast) {
        const delay = (i + 1) * 3000;
        console.log(`Claude overloaded, retrying in ${delay / 1000}s... (attempt ${i + 1}/${retries})`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

async function buildSystemPrompt() {
  const catalogText = await getProductCatalogText();
  return `You are Nidikumbear, the friendly AI assistant for Nidikumba Mattresses, a Sri Lankan mattress company founded in 2019.

Our current catalog:
${catalogText}

Sizes available for every mattress: Single, Double, Queen, King, Extra Large — each size has a few exact bed dimensions (e.g. Single includes 72x36, 75x36, 78x36, 84x36) at slightly different prices; a final quotation confirms the exact one.
Free pillow gifts and the optional pillow-top upgrade vary by product — see each product's own line in the catalog above, don't assume they're the same across products.

Product benefits — use these to answer "which one helps with X" or "why is this good" ON THE FIRST ASK, not after several qualifying questions:
- Ayu Sleep 6: firm therapeutic foam, no soft comfort layer — the go-to answer for back pain or anyone who wants firm, direct support with no sinking
- Nidikumba Rise: firm continuous-spring support at the most affordable price — good back support for budget-conscious customers
- Nidikumba Signature: classic bouncy, responsive spring feel — for customers who want a traditional springy mattress, not specifically a firmness/orthopedic pick
- Nidikumba Ayu Spring: individually-wrapped pocket springs — the best all-round pick for back pain WITH comfort (motion isolation, contouring, orthopedic support), our premium option

Size-first flow — when the customer asks about mattress types/sizes in general, OR expresses buying intent without having stated a size yet (e.g. "I want to buy a mattress", "what mattresses do you have"):
1. First, reply with ONLY the 5 available sizes (Single, Double, Queen, King, Extra Large) and ask which one they need — do not list the 4 product categories yet.
2. Once they state a size (in this message or anywhere earlier in the conversation), THEN reply with all 4 mattress categories (Ayu Sleep 6, Nidikumba Rise, Nidikumba Signature, Nidikumba Ayu Spring), each with a short one-line detail (use the product benefits above), so they can pick which one fits. You may mention the price range for their chosen size from the catalog above.
Apply this every time the customer asks about type/size or buying intent without a known size — not just the first time in the conversation. If they've already stated both a size and a product preference, skip straight to answering their actual question instead of restarting this flow.

Your goals during conversation:
1. Greet warmly and introduce yourself as Nidikumbear, Nidikumba's mattress consultant
2. Understand what the customer needs — new bed, replacement, size, usage type
3. Naturally collect: customer name, location, delivery address, product preference, size, quantity
4. Help them choose the right mattress by comparing options briefly, using the catalog above
5. Mention each product's free pillow gift and pillow-top upgrade (if it has one) when relevant — check the catalog above, don't assume every product has the same offer
6. Once you have their details, let them know a sales representative will follow up with a formal quotation

Tone:
- Respond in the SAME language AND register the customer uses — formal Sinhala gets formal Sinhala back, a casual Sinhala-English mix gets a casual mix back, not textbook-formal English regardless of how they actually write
- Every reply is sent as ONE single WhatsApp message — there is no multi-message follow-up, so say everything relevant in this one message. For a quick question, keep it to 1-3 short sentences. For something that genuinely needs more (e.g. listing the catalog), write the complete answer in one message, using line breaks between items for readability — never split it into multiple separate replies
- Never use corporate/robotic stock phrases — avoid things like "I understand your concern", "Thank you for your patience", "We value your business", "I apologize for any inconvenience", "Please note that", "As per our policy", "Rest assured"
- Ask ONE question at a time, never multiple
- You MAY quote the example prices from the catalog above when asked — mention they are estimates and a final quotation will confirm the exact price
- If they mention wanting to visit a showroom, confirm our showrooms are available and a rep will contact them
- If they confirm they want to order, thank them warmly and say our team will call shortly to finalize
- Do not ask for payment details

Answer directly, don't stall with more questions — this is the single most important rule below:
- If the customer asks a direct question about a product ("which one helps with back pain", "why is this good", "what's the difference for my problem"), ANSWER IT using the product benefits above. Never deflect with "a doctor would know better" or similar — you DO have enough information to give a real, useful answer.
- If the customer has already told you their concern or need (e.g. they mentioned back pain, a budget, a preference) anywhere earlier in the conversation, USE that — do not ask a qualifying question you already have the answer to.
- If the customer repeats a question or asks the same thing again, that means your last reply didn't actually answer it — give a direct answer this time, don't repeat the same qualifying question again.
- Only ask a follow-up question when you genuinely lack information needed to help (e.g. you don't yet know their budget AND it's actually relevant to what they asked) — never as a substitute for an answer you're able to give right now.

If the customer sounds frustrated or uses harsh language because they feel unheard or unanswered:
- Do not mirror it with jokes, laughing emojis (😂 etc.), or repeated questions — that reads as mocking, not friendly
- Give ONE brief, warm acknowledgement (e.g. "Sorry, let me actually answer that —"), then immediately give the direct, useful answer to what they asked. Don't dwell on the apology.

Escalation — call the escalate_to_human tool instead of replying yourself when:
- The customer explicitly asks to speak to a human, a person, or an agent
- The customer is raising a real complaint — about an order, a delivered product, or a service issue you can't resolve (NOT simply annoyance that you haven't answered their question yet — fix that by answering, per the rules above, not by escalating)
- They ask for something outside your authorization — custom discounts, refunds, order cancellations
Do not try to handle these yourself or write an apologetic message first — just call the tool.

Promo codes — if the customer mentions a promo/discount code, call apply_promo_code with it rather than guessing whether it's valid. Tell them the result plainly (valid + discount, or why it isn't) once you get the answer back.

Warranty — if they ask about warranty, coverage, or how long their mattress is covered, call check_warranty_status rather than guessing. Report what it actually says, including if there's nothing on file.`;
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Rate-limited to blunt credential-stuffing/brute-force against staff_users —
// this is the one unauthenticated /api route, reachable by anyone on the internet.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' },
});

// Checks a staff phone + password, with the per-account lockout and audit
// trail. Shared by the dashboard login and by pairing a Call Tracker phone
// (POST /api/devices/pair), so a phone sign-in can never be a softer target
// for password guessing than the dashboard — the same lockout counter covers
// both. Resolves to the staff row on success, or null for EVERY failure mode
// (wrong password, unknown phone, inactive, locked), so callers can only ever
// return one vague error.
async function verifyStaffCredentials(req, phone, password) {
  const lockCols = schemaFlags.loginLockout ? ', failed_login_count, locked_until' : '';
  // The login phone is matched in ANY of its equivalent spellings (see
  // staffPhoneCandidates): staff type 0771234567 as often as 94771234567, and
  // an exact-string match rejected the right password for the wrong format.
  // An exact match still wins if two accounts could both match, so an account
  // that signed in before this change resolves to the same row as before.
  const { rows } = await pool.query(
    `SELECT id, name, phone, password_hash, role${lockCols} FROM staff_users
      WHERE active=true AND phone = ANY($1::text[])
      ORDER BY (phone = $2) DESC, created_at
      LIMIT 1`,
    [staffPhoneCandidates(phone), String(phone ?? '').trim()]
  );
  const user = rows[0];

  // Locked accounts are refused before the password is even compared, so a
  // lockout cannot be probed by timing the bcrypt call.
  if (user && schemaFlags.loginLockout && user.locked_until && new Date(user.locked_until) > new Date()) {
    await recordAuditEvent(req, 'login.locked', { phone, staffId: user.id });
    return null;
  }

  const valid = user && (await bcrypt.compare(password, user.password_hash));

  if (!valid) {
    // Count the failure against the ACCOUNT, not just the IP. Without this
    // a distributed attacker had unlimited guesses against one known phone.
    if (user && schemaFlags.loginLockout) {
      const count = Number(user.failed_login_count || 0) + 1;
      const lock = count >= MAX_FAILED_LOGINS;
      await pool.query(
        `UPDATE staff_users
            SET failed_login_count = $1,
                last_failed_login_at = now(),
                locked_until = CASE WHEN $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
          WHERE id = $4`,
        [lock ? 0 : count, lock, String(LOCKOUT_MINUTES), user.id]
      );
      await recordAuditEvent(req, lock ? 'login.lockout_triggered' : 'login.failure', {
        phone,
        staffId: user.id,
        attempt: count,
      });
    } else {
      await recordAuditEvent(req, 'login.failure', { phone, reason: user ? 'bad_password' : 'unknown_phone' });
    }
    return null;
  }

  // Success clears the counter, so the threshold only ever counts
  // CONSECUTIVE failures.
  if (schemaFlags.loginLockout && (Number(user.failed_login_count || 0) > 0 || user.locked_until)) {
    await pool.query('UPDATE staff_users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [user.id]);
  }
  return user;
}

// ── POST /api/auth/login — the one unauthenticated /api route ────────────────
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'phone and password are required' });

  // One deliberately vague message for every failure mode — wrong password,
  // unknown phone, inactive account, locked account. Distinguishing them
  // would confirm which phone numbers are real staff accounts.
  const invalid = () => res.status(401).json({ error: 'Invalid credentials' });

  try {
    const user = await verifyStaffCredentials(req, phone, password);
    if (!user) return invalid();

    // Open a session row (migration 045) and put its id in the token, so the
    // heartbeat and logout can find THIS session rather than guessing at the
    // staff member's most recent one — which would attribute a second device's
    // activity to the first device's session.
    //
    // Never fails the login: a sign-in must not break because the hours screen
    // could not record it. A missing session id simply means that login is not
    // counted towards active hours, which is visible in the data rather than
    // silently wrong.
    let sessionId = null;
    if (schemaFlags.staffSessions) {
      try {
        const { rows: sess } = await pool.query(
          `INSERT INTO staff_sessions (staff_id, ip, user_agent) VALUES ($1, $2, $3) RETURNING id`,
          [user.id, req.ip || null, (req.headers['user-agent'] || '').slice(0, 400) || null]
        );
        sessionId = sess[0].id;
      } catch (err) {
        console.error('staff_sessions insert failed (login still succeeded):', err.message);
      }
    }

    const token = jwt.sign(
      { id: user.id, name: user.name, role: user.role, sid: sessionId },
      JWT_SECRET,
      { expiresIn: '12h' }
    );
    await recordAuditEvent(req, 'login.success', { phone, staffId: user.id, role: user.role });
    // phone: the person's own login number, so screens that ask for the
    // password again (Connect my phone) can give the browser's password
    // manager the right username. Not put in the JWT.
    res.json({ token, staff: { id: user.id, name: user.name, role: user.role, phone: user.phone } });
  } catch (err) {
    console.error('Login failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Promo code validate/redeem — PUBLIC, rate-limited (Phase 9) ──────────────
// nidikumba.shop has no backend of its own (CLAUDE.md) — anonymous website
// visitors call these directly at checkout, so they're deliberately defined
// before the blanket staff-auth middleware below, same as /api/auth/login.
// Rate-limited because this is real discount logic exposed with no auth at all.
const promoCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please try again later.' },
});

// Product-scoped codes (migration 017): eligible_product_names is matched
// against cart item names in JS, not inside redeem_promo_code/validate_promo_code
// — those functions only ever take a single total number, no line-item
// concept. items is optional for backward compatibility (a caller that only
// ever sends orderTotal, like an older website integration, still gets the
// unscoped behavior against an unscoped code; a caller that sends items
// against a scoped code gets the real eligible-subtotal computation).
// Matching by name mirrors the same fragile-but-established convention
// order-item-to-product matching already uses everywhere else in this
// codebase (no product_id on line items).
function computeEligibleSubtotal(items, eligibleProductNames, fallbackTotal) {
  if (!eligibleProductNames || eligibleProductNames.length === 0) {
    return fallbackTotal;
  }
  if (!Array.isArray(items)) return 0; // scoped code, no items sent — nothing verifiably eligible
  const eligible = new Set(eligibleProductNames.map((n) => n.toLowerCase()));
  return items.reduce((sum, it) => {
    const name = (it.name || it.product || '').toLowerCase();
    if (!eligible.has(name)) return sum;
    // A free line (negative unit_price, free: true) costs the customer nothing,
    // so it is not part of what a promo can discount.
    if (it.free === true || (parseFloat(it.unit_price) || 0) < 0) return sum;
    return sum + (parseFloat(it.unit_price) || 0) * (parseInt(it.qty) || 1);
  }, 0);
}

// Per-mattress codes (migration 052): discount_scope='per_unit' gives
// discount_amount once per eligible unit. A scoped code counts units of its
// own products; an unscoped one counts mattresses only (mattressNames), so
// pillows on the same bill don't multiply a per-mattress discount. Free lines
// never count. Returns null when no items were sent — the caller then treats
// it as one unit, which is exactly what the code gave before 052.
function countEligibleUnits(items, eligibleProductNames, mattressNames) {
  if (!Array.isArray(items)) return null;
  const names = eligibleProductNames && eligibleProductNames.length > 0 ? eligibleProductNames : mattressNames || [];
  const eligible = new Set(names.map((n) => n.toLowerCase()));
  return items.reduce((units, it) => {
    const name = (it.name || it.product || '').toLowerCase();
    if (!eligible.has(name)) return units;
    if (it.free === true || (parseFloat(it.unit_price) || 0) < 0) return units;
    return units + (parseInt(it.qty) || 1);
  }, 0);
}

// Units a per_unit code actually pays out on, after its optional cap.
function cappedPromoUnits(units, maxUnitsPerOrder) {
  const u = units == null ? 1 : units;
  return maxUnitsPerOrder != null ? Math.min(u, Number(maxUnitsPerOrder)) : u;
}

// Mirrors redeem_promo_code's arithmetic so the preview matches what gets stored.
function previewPromoDiscount(promo, eligibleSubtotal, units) {
  if (promo.discount_type === 'percent') {
    return Math.min((eligibleSubtotal * promo.discount_percent) / 100, eligibleSubtotal);
  }
  const perUnit = promo.discount_scope === 'per_unit';
  const amount = Number(promo.discount_amount) * (perUnit ? cappedPromoUnits(units, promo.max_units_per_order) : 1);
  return Math.min(amount, eligibleSubtotal);
}

// Inactive products included: an edit to an old order still has to recognise
// a discontinued mattress by its name.
async function loadMattressNames() {
  const { rows } = await pool.query("SELECT name FROM products WHERE category = 'mattress'");
  return rows.map((r) => r.name);
}

// The p_units to pass into redeem_promo_code for this code and cart.
async function resolvePromoUnits(promo, items) {
  if (promo?.discount_scope !== 'per_unit') return 1;
  const mattressNames = promo.eligible_product_names?.length > 0 ? [] : await loadMattressNames();
  const units = countEligibleUnits(items, promo.eligible_product_names, mattressNames);
  return units == null ? 1 : units;
}

// The whole promo check, as one function: is the code usable by this phone,
// and what would it take off this cart. Read-only — never uses a redemption
// slot. Shared by the public /validate route and by quotations (migration
// 055), so a quotation shows exactly the discount the website or an order
// screen would preview for the same cart.
async function evaluatePromoCode({ code, phone, orderTotal, items }) {
  const { rows } = await pool.query('SELECT * FROM validate_promo_code($1, $2)', [code, phone]);
  const result = rows[0];
  if (!result.valid) return { valid: false, message: result.message };

  const { rows: promoRows } = await pool.query(
    'SELECT eligible_product_names, discount_scope, max_units_per_order FROM promo_codes WHERE id=$1',
    [result.promo_code_id]
  );
  const eligibleProductNames = promoRows[0]?.eligible_product_names || null;
  const promo = {
    ...result,
    eligible_product_names: eligibleProductNames,
    discount_scope: promoRows[0]?.discount_scope || 'order',
    max_units_per_order: promoRows[0]?.max_units_per_order ?? null,
  };
  const perUnit = promo.discount_scope === 'per_unit';

  let previewDiscount = null;
  let eligibleSubtotal = null;
  let eligibleUnits = null;
  if (orderTotal != null || items != null) {
    eligibleSubtotal = computeEligibleSubtotal(items, eligibleProductNames, Number(orderTotal) || 0);
    if (eligibleProductNames?.length > 0 && eligibleSubtotal === 0) {
      return { valid: false, message: `This code only applies to: ${eligibleProductNames.join(', ')}` };
    }
    if (perUnit) {
      eligibleUnits = Array.isArray(items) ? await resolvePromoUnits(promo, items) : null;
      if (eligibleUnits === 0) {
        return { valid: false, message: 'This code gives a discount per mattress — add a mattress to the order' };
      }
    }
    previewDiscount = previewPromoDiscount(promo, eligibleSubtotal, eligibleUnits);
  }

  return {
    valid: true,
    discountType: result.discount_type,
    discountPercent: result.discount_percent,
    discountAmount: result.discount_amount,
    discountScope: promo.discount_scope,
    maxUnitsPerOrder: promo.max_units_per_order,
    eligibleProductNames,
    eligibleSubtotal,
    eligibleUnits,
    // Units the discount is actually multiplied by, after the code's cap.
    countedUnits: perUnit ? cappedPromoUnits(eligibleUnits, promo.max_units_per_order) : null,
    previewDiscount,
  };
}

// Read-only preview — doesn't consume a redemption slot.
app.post('/api/promo-codes/validate', promoCodeLimiter, async (req, res) => {
  const { code, phone, orderTotal, items } = req.body;
  if (!code || !phone) return res.status(400).json({ error: 'code and phone are required' });

  try {
    res.json(await evaluatePromoCode({ code, phone, orderTotal, items }));
  } catch (err) {
    console.error('POST /api/promo-codes/validate failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Race-safe — see redeem_promo_code's row-level lock (migration 007_promo_codes.sql).
// orderTotal here is repurposed as "the amount the discount should be computed
// against" — the caller (both dashboard flows) is responsible for passing the
// already-scoped eligible subtotal, exactly what validate above just previewed.
// items (optional) lets a per-mattress code (migration 052) count its units
// server-side; without items, `units` is used, and without either the code
// counts as one unit — the pre-052 behaviour an older integration expects.
app.post('/api/promo-codes/redeem', promoCodeLimiter, async (req, res) => {
  const { code, phone, orderTotal, items, units } = req.body;
  if (!code || !phone || orderTotal == null) {
    return res.status(400).json({ error: 'code, phone, and orderTotal are required' });
  }

  try {
    const { rows: promoRows } = await pool.query(
      'SELECT eligible_product_names, discount_scope FROM promo_codes WHERE code=$1',
      [code]
    );
    let pUnits = 1;
    if (promoRows[0]?.discount_scope === 'per_unit') {
      if (Array.isArray(items)) pUnits = await resolvePromoUnits(promoRows[0], items);
      else if (Number.isInteger(Number(units)) && Number(units) >= 0) pUnits = Number(units);
    }
    const { rows } = await pool.query('SELECT * FROM redeem_promo_code($1, $2, $3, $4)', [code, phone, orderTotal, pUnits]);
    const result = rows[0];
    if (!result.success) return res.status(400).json({ success: false, message: result.message });
    res.json({ success: true, discountAmount: result.discount_amount, redemptionId: result.redemption_id });
  } catch (err) {
    console.error('POST /api/promo-codes/redeem failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Rate-limited like the promo-code endpoints — this is the other real
// public/unauthenticated route (nidikumba.shop has no backend of its own,
// so the website's chat widget calls this directly from a visitor's
// browser, same pattern as promo validate/redeem).
const webchatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many messages. Please wait a moment and try again.' },
});

// ── POST /api/webchat — nidikumba.shop AI chat widget ────────────────────────
// Same AI logic as WhatsApp (findOrCreateCustomerByPhone, getOrCreateOpenTicket,
// callClaudeWithRetry, escalation, analyzeConversation) under channel='webchat'
// (migration 021) — a website visitor becomes a real customers/leads row like
// any other channel, visible in the same staff dashboard. The one real
// difference from processIncomingMessage: no WhatsApp delivery step (no
// sendWhatsAppMessage/sendTypingIndicator, no markdownToWhatsApp formatting —
// this reply is JSON in an HTTP response, not a WhatsApp message), so the
// reply text is returned directly rather than pushed out and polled via SSE.
// The website has no way to collect a phone number implicitly, so the widget
// asks for one before the first message — confirmed with the user rather than
// making customers.whatsapp_number nullable, which the entire schema assumes
// is always present. Must be registered before the blanket /api authenticate
// middleware below, same as /api/auth/login and /api/promo-codes/*.
app.post('/api/webchat', webchatLimiter, async (req, res) => {
  const { phone, text } = req.body;
  if (!phone || !text) return res.status(400).json({ error: 'phone and text are required' });

  try {
    const { customer } = await findOrCreateCustomerByPhone(phone, 'webchat');
    const customerId = customer.id;
    await getOrCreateOpenTicket(customerId, { source: 'website chat' });

    const aiEnabled = customer.ai_enabled !== false;

    await pool.query('INSERT INTO messages (customer_id, direction, content) VALUES ($1, $2, $3)', [customerId, 'inbound', text]);
    broadcastEvent('message_insert', { customer_id: customerId });

    if (!aiEnabled) {
      return res.json({ reply: null, humanTakeover: true });
    }

    const { rows: history } = await pool.query(
      'SELECT direction, content FROM messages WHERE customer_id=$1 ORDER BY received_at DESC LIMIT 10',
      [customerId]
    );
    const conversationMessages = history.reverse().map((m) => ({
      role: m.direction === 'inbound' ? 'user' : 'assistant',
      content: m.content,
    }));

    let aiResult;
    try {
      aiResult = await callClaudeWithRetry(conversationMessages, customer);
    } catch (aiError) {
      console.error('Claude API error (webchat):', aiError.message);
      return res.status(502).json({ error: 'AI is temporarily unavailable. Please try again.' });
    }

    if (aiResult.type === 'escalate') {
      await pool.query(
        `UPDATE customers SET ai_enabled=false, priority_score=3, priority_label='high', priority_updated_at=NOW() WHERE id=$1`,
        [customerId]
      );
      broadcastEvent('customer_update', { id: customerId });

      await pool.query('INSERT INTO messages (customer_id, direction, content, sender_type) VALUES ($1, $2, $3, $4)', [
        customerId,
        'outbound',
        ESCALATION_BRIDGE_MESSAGE,
        'ai',
      ]);
      broadcastEvent('message_insert', { customer_id: customerId });

      return res.json({ reply: ESCALATION_BRIDGE_MESSAGE, humanTakeover: true });
    }

    const aiReply = aiResult.text;
    await pool.query('INSERT INTO messages (customer_id, direction, content, sender_type) VALUES ($1, $2, $3, $4)', [
      customerId,
      'outbound',
      aiReply,
      'ai',
    ]);
    broadcastEvent('message_insert', { customer_id: customerId });

    analyzeConversation(customerId, conversationMessages);

    res.json({ reply: aiReply, humanTakeover: false });
  } catch (err) {
    console.error('Webchat error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Own limiter rather than reusing webhookLimiter — that const is declared
// later in this file (kept near the other webhook routes), and this route
// had to move earlier to sit before the blanket /api authenticate middleware.
// Rate limits for the Call Tracker phone routes, in TWO layers:
//
//  * Per PHONE (keyed by its device token): 60/min — ~20x what one phone
//    actually sends (a heartbeat every 20s plus the odd sync/status).
//  * Per NETWORK ADDRESS, as a much higher ceiling (1200/min): one office's
//    phones usually share a single public IP behind Wi-Fi. A per-IP limit of
//    60/min — what this was before — was exhausted by about 15 phones'
//    heartbeats alone, refusing their requests and raising false "phone
//    offline" alerts. The IP layer still exists so a flood of made-up tokens
//    (each of which would otherwise get its own per-phone bucket) is capped.
//
// Requests without a device token (the legacy shared key) are keyed by IP.
function callTrackerRateKey(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Device ')) return `device:${hashDeviceToken(header.slice(7).trim())}`;
  return `ip:${ipKeyGenerator(req.ip)}`;
}

const callTrackerLimiter = [
  rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 1200,
    standardHeaders: true,
    legacyHeaders: false,
  }),
  rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 60,
    keyGenerator: callTrackerRateKey,
    standardHeaders: true,
    legacyHeaders: false,
  }),
];

// ── POST /api/calls — Android call-tracker app sync (Phase 17) ───────────────
// Replaces the Dwesk/Dialog webhook (never received a real request in
// testing — confirmed via ngrok's request log showing zero deliveries from
// Dwesk's servers). This app reads the phone's own call log and POSTs a
// batch on each manual "Sync Calls" tap: { calls: [{ number, name, date
// (epoch ms), duration (seconds), callType: INCOMING|OUTGOING|MISSED,
// simSlot }] }. Must be registered before the blanket /api authenticate
// middleware below, same as /api/webchat and /api/promo-codes/* — the app
// has no staff JWT, it authenticates with its own API key instead.
//
// Auth: requires X-API-Key matching CALL_TRACKER_API_KEY — unlike Dwesk's
// webhook (no documented auth scheme to match), this endpoint accepts real
// names+numbers from an app we control both ends of, so a shared secret is
// straightforward. Checked with a constant-time comparison to avoid a
// timing side-channel on the key.
//
// number arrives with a real country code already attached (e.g.
// "+919876543210") — unlike Dwesk's customerCli, which had none — so
// normalization here only strips non-digits, it never assumes/prepends a
// country code (that would corrupt a genuinely non-Sri-Lankan number).
//
// The app has no since-cursor and may resend previously-synced call log
// entries on a later batch; dedup_key (number+date+duration+callType) makes
// each insert idempotent via the unique partial index from migration 023.
//
// Every call type opens/touches a ticket (confirmed with the user — not
// just missed calls), through the same findOrCreateCustomerByPhone/
// getOrCreateOpenTicket helpers every other channel uses, so it gets Phase
// 5's round-robin assignment + SLA clock and Phase 14's ticket_state='open'
// dedup for free.
// What the server log may say about a call: enough to find it (last 3
// digits, the time, the type) and nothing that identifies the customer.
// Server logs are read by more people, and kept longer, than the database.
function maskedCall(call) {
  const digits = String(call?.number ?? '').replace(/\D/g, '');
  return {
    number: digits ? `…${digits.slice(-3)}` : null,
    date: call?.date ?? null,
    callType: call?.callType ?? null,
  };
}

function normalizeCallTrackerNumber(number) {
  return String(number).replace(/\D/g, '');
}

function requireCallTrackerApiKey(req, res, next) {
  const expected = process.env.CALL_TRACKER_API_KEY;
  const provided = req.headers['x-api-key'];
  if (!expected || !provided || typeof provided !== 'string') {
    return res.status(401).json({ error: 'Missing or invalid API key' });
  }
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  const isValid = expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf);
  if (!isValid) return res.status(401).json({ error: 'Missing or invalid API key' });
  next();
}

// ── Paired Call Tracker phones (migration 050) ───────────────────────────────
// Each phone signs in once with its owner's CRM login and gets its OWN random
// token, sent as `Authorization: Device <token>`. Only the SHA-256 is stored.
// This replaces the shared CALL_TRACKER_API_KEY (extractable from any APK) and
// the self-typed ownerPhone as the way the CRM knows whose phone is talking —
// which click-to-call depends on: a dial command must reach exactly the
// clicker's phone and nobody else's.

// Roles that make calls. A delivery_coordinator/finance/viewer has no reason
// to pair a phone that the CRM can make dial customers.
const DEVICE_ROLES = ['admin', 'sales_agent', SUPER_ADMIN];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const deviceTokenIdleDays = () => {
  const n = parseInt(process.env.DEVICE_TOKEN_IDLE_DAYS, 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
};

function hashDeviceToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// last_seen_at is throttled in memory for the same reason as touchSession():
// the stream reconnects and the phone syncs often, and an UPDATE per request
// is pure write amplification for a value only shown to the minute.
const DEVICE_SEEN_MS = 60 * 1000;
const lastDeviceSeen = new Map();

function touchDevice(deviceId) {
  const now = Date.now();
  const prev = lastDeviceSeen.get(deviceId);
  if (prev && now - prev < DEVICE_SEEN_MS) return;
  lastDeviceSeen.set(deviceId, now);
  pool
    .query('UPDATE staff_devices SET last_seen_at = now() WHERE id = $1', [deviceId])
    .catch(err => console.error('device last_seen update failed:', err.message));
}

/**
 * Resolves `Authorization: Device <token>` to { id, staff_id, staff_name }, or
 * null. The owner's active flag and role are re-checked on every request —
 * same principle as authenticate(): deactivating or demoting a staff member
 * must cut their phone off immediately, not whenever someone remembers to
 * revoke it.
 */
async function lookupDevice(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Device ')) return null;
  const token = header.slice(7).trim();
  // base64url, as issued by /api/devices/pair. Anything else is not ours and
  // is rejected before it costs a query.
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return null;
  const { rows } = await pool.query(
    `SELECT d.id, d.staff_id, s.name AS staff_name, s.role,
            COALESCE(d.last_seen_at, d.created_at) < now() - ($2 || ' days')::interval AS idle_expired
       FROM staff_devices d
       JOIN staff_users s ON s.id = d.staff_id
      WHERE d.token_hash = $1 AND d.revoked_at IS NULL AND s.active = true`,
    [hashDeviceToken(token), String(deviceTokenIdleDays())]
  );
  const device = rows[0];
  if (!device || !DEVICE_ROLES.includes(device.role)) return null;
  // A phone that has not been in touch for DEVICE_TOKEN_IDLE_DAYS (default 30)
  // is signed out for good — a phone forgotten in a drawer must not keep a
  // working credential forever. Revoked (not just refused) so the Team page
  // shows it as "Not signed in" rather than an offline phone that never returns.
  if (device.idle_expired) {
    await pool.query('UPDATE staff_devices SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [device.id]);
    return null;
  }
  touchDevice(device.id);
  return { id: device.id, staff_id: device.staff_id, staff_name: device.staff_name };
}

async function requireDeviceToken(req, res, next) {
  try {
    const device = await lookupDevice(req);
    if (!device) return res.status(401).json({ error: 'This phone is not signed in. Sign in again in the Call Tracker app.' });
    req.device = device;
    next();
  } catch (err) {
    console.error('device lookup failed:', err.message);
    res.status(503).json({ error: 'Authentication temporarily unavailable' });
  }
}

// POST /api/calls and /api/calls/start accept EITHER a paired-device token
// (preferred — the owner comes from the device, never from the body) OR the
// legacy shared X-API-Key, so phones still running an older app build keep
// syncing until they are updated and paired. A request that PRESENTS a device
// token that turns out to be invalid is rejected outright rather than falling
// back to the shared key: a revoked phone must stay revoked.
//
// The shared key is OFF unless CALL_TRACKER_ALLOW_LEGACY_KEY=true. It is baked
// into every Call Tracker APK released before per-phone sign-in, and can be
// pulled out of one in seconds — accepting it means anyone with an old APK
// can create fake calls, customers and leads and attribute them to any agent.
// Turn it on only briefly while the last phones are updated, then off again.
// Read per request, so flipping it needs no code change (just a restart after
// editing .env, since dotenv loads it at startup).
const legacyCallTrackerKeyAllowed = () => process.env.CALL_TRACKER_ALLOW_LEGACY_KEY === 'true';
if (legacyCallTrackerKeyAllowed()) {
  console.warn(
    '[security] CALL_TRACKER_ALLOW_LEGACY_KEY=true — the shared call-tracker key is accepted. ' +
      'It is extractable from old APKs; turn this off once every phone runs the signed-in app.'
  );
}

function requireCallTrackerAuth(req, res, next) {
  if ((req.headers.authorization || '').startsWith('Device ')) return requireDeviceToken(req, res, next);
  if (!legacyCallTrackerKeyAllowed()) {
    return res.status(401).json({
      error: 'This version of Call Tracker is no longer supported. Update the app and sign in with your CRM login.',
    });
  }
  return requireCallTrackerApiKey(req, res, next);
}

// The owner a call is attributed to: the paired phone's staff member, or —
// for a legacy unpaired app — the self-typed ownerPhone, as before.
function callOwnerStaffId(req, ownerPhone) {
  if (req.device) return Promise.resolve(req.device.staff_id);
  return findStaffIdByOwnerPhone(ownerPhone);
}

// One open stream per paired phone: deviceId -> { res, staffId }.
const deviceClients = new Map();

function closeDeviceStreams(predicate) {
  for (const [deviceId, client] of deviceClients) {
    if (predicate(deviceId, client)) {
      deviceClients.delete(deviceId);
      try {
        client.res.end();
      } catch (_) {
        /* already gone */
      }
      publishPresence(deviceId, client.staffId);
    }
  }
}

// ── Phone presence: is each agent's Call Tracker connected right now? ────────
// Drives the "your phone is not connected" alerts (the agent's CRM banner, the
// admin overview, the Team page). A phone is ONLINE when its command stream is
// open AND — for app builds that send one — its heartbeat is recent.
//
// Why a heartbeat and not just the stream: when a phone dies silently (switched
// off, signal lost), nothing tells the server. ngrok or nginx sits between the
// phone and this process and can keep the upstream connection looking open for
// minutes. The app therefore posts a heartbeat every 20s, and missing ~50s of
// them marks the phone offline (and closes its zombie stream).
//
// Older app builds send no heartbeat. For those — `heartbeats` never set — the
// stream alone decides, so a phone still on an old build is never wrongly
// marked offline and cut off every 50 seconds.
// Overridable by env only so tests can shorten it; production uses the default.
const DEVICE_HEARTBEAT_TIMEOUT_MS = Number(process.env.DEVICE_HEARTBEAT_TIMEOUT_MS) || 50 * 1000;

// A phone that WAS heart-beating a moment ago and whose stream just dropped is
// almost always reconnecting (a network blip, a proxy recycling the
// connection) — it is back within seconds. Treating it as offline the instant
// its stream closed raised a false "your phone is not connected" popup on
// every blip. For this long it stays online; if it has not reconnected by
// then, the 10-second sweep reports it offline. Phones that never sent a
// heartbeat (older builds), and streams the SERVER closed (revoked, re-paired,
// zombie), get no grace — see where closedAt is set.
const DEVICE_RECONNECT_GRACE_MS = process.env.DEVICE_RECONNECT_GRACE_MS !== undefined
  ? Number(process.env.DEVICE_RECONNECT_GRACE_MS)
  : 15 * 1000;

// Every phone drops its stream when this process restarts and reconnects within
// seconds. Without a grace period every agent would get an "offline" alert on
// every deploy or nodemon restart. During it, a phone seen recently is reported
// as 'unknown' (no alert) rather than 'offline'.
const PRESENCE_STARTUP_GRACE_MS = process.env.PRESENCE_STARTUP_GRACE_MS !== undefined
  ? Number(process.env.PRESENCE_STARTUP_GRACE_MS)
  : 45 * 1000;
const PRESENCE_RECENT_MS = 2 * 60 * 1000;
const SERVER_STARTED_AT = Date.now();

const devicePresence = new Map(); // deviceId -> { staffId, lastBeat, heartbeats }
const reportedOnline = new Map(); // deviceId -> the last online value broadcast

function isDeviceOnline(deviceId) {
  const p = devicePresence.get(deviceId);
  if (!deviceClients.has(deviceId)) {
    // Just dropped, but was alive a moment ago: give it DEVICE_RECONNECT_GRACE_MS.
    const now = Date.now();
    return Boolean(
      p?.closedAt && p.heartbeats &&
      now - p.closedAt < DEVICE_RECONNECT_GRACE_MS &&
      now - p.lastBeat < DEVICE_HEARTBEAT_TIMEOUT_MS
    );
  }
  if (!p || !p.heartbeats) return true; // older app build: the open stream is all we have
  return Date.now() - p.lastBeat < DEVICE_HEARTBEAT_TIMEOUT_MS;
}

const inPresenceGrace = () => Date.now() - SERVER_STARTED_AT < PRESENCE_STARTUP_GRACE_MS;

/** 'online' | 'offline' | 'unknown' (just restarted; recently seen phone may still be reconnecting). */
function presenceStatus(deviceId, lastSeenAt) {
  if (isDeviceOnline(deviceId)) return 'online';
  const recent = lastSeenAt && Date.now() - new Date(lastSeenAt).getTime() < PRESENCE_RECENT_MS;
  return inPresenceGrace() && recent ? 'unknown' : 'offline';
}

/**
 * Broadcasts `device_status` when a phone flips online/offline, so every open
 * CRM page updates at once — the agent's banner, the admin overview. Carries
 * staffId; each browser picks out its own. Offline is held back during the
 * startup grace; the sweep reports it once the grace ends.
 */
function publishPresence(deviceId, staffId) {
  const online = isDeviceOnline(deviceId);
  if (reportedOnline.get(deviceId) === online) return;
  if (!online && inPresenceGrace()) return;
  reportedOnline.set(deviceId, online);
  // Only the phone's owner and admins need this (their popup / side note);
  // other staff have no business knowing whose phone is offline.
  broadcastEvent(
    'device_status',
    { deviceId, staffId, online, at: new Date().toISOString() },
    c => c.staffId === staffId || isAdminClient(c)
  );
}

// Catches what no event reports: a heartbeat that silently stopped, and the end
// of the startup grace. Closing a zombie stream frees the slot, and a phone
// that is in fact alive simply reconnects. unref() so it never keeps a test
// run or a shutting-down process alive.
setInterval(() => {
  for (const [deviceId, p] of devicePresence) {
    if (deviceClients.has(deviceId) && !isDeviceOnline(deviceId)) {
      closeDeviceStreams(id => id === deviceId);
    }
    publishPresence(deviceId, p.staffId);
  }
}, 10 * 1000).unref();

// Customer numbers are stored canonical, digits only (migration 030:
// 94XXXXXXXXX). The phone's dialer wants E.164 with a leading '+'.
//
// Only numbers in DIAL_ALLOWED_PREFIXES (default "94" — Sri Lanka) may be
// dialled automatically. The phone places these calls with no tap, and a
// customer record can be created with any number, so without this a stolen
// staff login could make an agent's phone ring premium-rate or international
// numbers unattended. Comma-separated country codes, e.g. "94,44".
// A Sri Lankan number must also be the exact 94XXXXXXXXX shape.
const dialAllowedPrefixes = () =>
  (process.env.DIAL_ALLOWED_PREFIXES || '94')
    .split(',')
    .map(p => p.replace(/\D/g, ''))
    .filter(Boolean);

function dialableNumber(stored) {
  const digits = String(stored || '').replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  if (!dialAllowedPrefixes().some(p => digits.startsWith(p))) return null;
  if (digits.startsWith('94') && !/^94[0-9]{9}$/.test(digits)) return null;
  return `+${digits}`;
}

// Automatic calls per agent per hour (DIAL_MAX_PER_HOUR, default 60). A
// person clicking Call does a handful an hour; this only ever stops a script.
const dialMaxPerHour = () => {
  const n = parseInt(process.env.DIAL_MAX_PER_HOUR, 10);
  return Number.isFinite(n) && n > 0 ? n : 60;
};

/** Writes one dial command to a phone's stream. Returns false if it could not. */
function sendDialCommand(res, row) {
  const ttlSeconds = Math.max(1, Math.round((new Date(row.expires_at).getTime() - Date.now()) / 1000));
  const payload = {
    requestId: row.id,
    number: dialableNumber(row.phone_number),
    customerName: row.customer_name || null,
    ttlSeconds,
  };
  try {
    res.write(`event: dial\ndata: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch (_) {
    return false;
  }
}

async function markDialDelivered(row) {
  await pool.query(
    `UPDATE dial_requests SET status = 'delivered', delivered_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'pending'`,
    [row.id]
  );
  // A call's progress is the clicker's business only.
  broadcastEvent(
    'dial_status',
    { requestId: row.id, staffId: row.staff_id, status: 'delivered' },
    c => c.staffId === row.staff_id
  );
}

// Pairing is a password check, so it gets the same brute-force floor as login
// (and verifyStaffCredentials applies the same per-account lockout).
const devicePairLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Try again later.' },
});

/**
 * Issues a new device token for [user] inside the caller's open transaction,
 * signing out that person's previous phone — the one path both sign-in
 * methods (password and QR) go through, so they cannot drift apart.
 *
 * Revoke-then-insert as TWO statements. A single statement (a data-modifying
 * CTE revoking the old row, then INSERT) does NOT work: the INSERT's unique
 * check still sees the old phone as active, so re-pairing failed on
 * staff_devices_one_active_per_staff — verified against real Postgres. Locking
 * the staff row serializes two pairings of the same person, which would
 * otherwise race to the same violation.
 */
async function issueDeviceToken(client, user, deviceName) {
  const token = crypto.randomBytes(32).toString('base64url');
  const name = typeof deviceName === 'string' ? deviceName.trim().slice(0, 100) || null : null;
  await client.query('SELECT id FROM staff_users WHERE id = $1 FOR UPDATE', [user.id]);
  await client.query('UPDATE staff_devices SET revoked_at = now() WHERE staff_id = $1 AND revoked_at IS NULL', [user.id]);
  const { rows } = await client.query(
    'INSERT INTO staff_devices (staff_id, device_name, token_hash) VALUES ($1, $2, $3) RETURNING id',
    [user.id, name, hashDeviceToken(token)]
  );
  return { token, deviceId: rows[0].id, name };
}

const pairResponse = (issued, user) => ({
  token: issued.token,
  device: { id: issued.deviceId, name: issued.name },
  staff: { id: user.id, name: user.name, role: user.role },
});

// ── POST /api/devices/pair — sign a Call Tracker phone in ────────────────────
// Returns the device token ONCE; only its hash is kept. Pairing a new phone
// revokes the staff member's previous one in the same statement (one active
// phone per person — migration 050's partial unique index), and closes that
// old phone's stream so it stops receiving dial commands immediately.
app.post('/api/devices/pair', devicePairLimiter, async (req, res) => {
  const { phone, password, deviceName } = req.body || {};
  if (!phone || !password) return res.status(400).json({ error: 'phone and password are required' });

  try {
    const user = await verifyStaffCredentials(req, phone, password);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (!DEVICE_ROLES.includes(user.role)) {
      return res.status(403).json({ error: 'Only sales agents and admins can sign in on the Call Tracker app.' });
    }

    const client = await pool.connect();
    let issued;
    try {
      await client.query('BEGIN');
      issued = await issueDeviceToken(client, user, deviceName);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    closeDeviceStreams((id, c) => c.staffId === user.id && id !== issued.deviceId);

    await recordAuditEvent(req, 'device.paired', { staffId: user.id, deviceId: issued.deviceId, method: 'password' });
    res.json(pairResponse(issued, user));
  } catch (err) {
    console.error('Device pairing failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── QR sign-in (migration 056) ───────────────────────────────────────────────
// The agent, already logged into the dashboard, asks for a one-time code
// (POST /api/devices/pair-codes) and the dashboard shows it as a QR; the
// Call Tracker app scans it and redeems it (POST /api/devices/pair/qr) for a
// device token — the same token password sign-in issues, through the same
// issueDeviceToken(). See the migration for why this is safe without an
// approve step (confirmed with the user).
const PAIR_CODE_TTL_MS = 5 * 60 * 1000;
const PAIR_CODES_UNAVAILABLE = 'QR sign-in is not available until database migration 056 is applied';
// The app checks this shape before it sends anything, and so does the server:
// 32 random bytes as base64url is always 43 characters.
const PAIR_CODE_RE = /^[A-Za-z0-9_-]{43}$/;
// Deliberately ONE message for unknown, used and expired: telling them apart
// would only help someone guessing codes.
const PAIR_CODE_INVALID = 'This sign-in code has expired or was already used. Make a new one on the dashboard.';

app.post('/api/devices/pair/qr', devicePairLimiter, async (req, res) => {
  if (!schemaFlags.pairCodes) return res.status(503).json({ error: PAIR_CODES_UNAVAILABLE });
  const { code, deviceName } = req.body || {};
  if (typeof code !== 'string' || !PAIR_CODE_RE.test(code)) {
    return res.status(401).json({ error: PAIR_CODE_INVALID });
  }

  const client = await pool.connect();
  let issued;
  let user;
  try {
    await client.query('BEGIN');
    // Single use, even when two phones scan the same QR at once: only one
    // UPDATE can flip used_at from NULL.
    const { rows: redeemed } = await client.query(
      `UPDATE device_pair_codes SET used_at = now()
        WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING id, staff_id`,
      [hashDeviceToken(code)]
    );
    if (redeemed.length === 0) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: PAIR_CODE_INVALID });
    }
    // Re-checked now, not when the code was made: an agent deactivated or
    // moved to another role in the last five minutes must not get a phone.
    const { rows: staff } = await client.query(
      'SELECT id, name, role, active FROM staff_users WHERE id = $1',
      [redeemed[0].staff_id]
    );
    user = staff[0];
    if (!user || !user.active || !DEVICE_ROLES.includes(user.role)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This account can no longer sign in on the Call Tracker app.' });
    }
    issued = await issueDeviceToken(client, user, deviceName);
    await client.query('UPDATE device_pair_codes SET used_device_id = $1 WHERE id = $2', [issued.deviceId, redeemed[0].id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/devices/pair/qr failed:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }

  closeDeviceStreams((id, c) => c.staffId === user.id && id !== issued.deviceId);
  // Tells the agent's own dashboard the QR worked, so its window can close.
  broadcastEvent(
    'device_paired',
    { staffId: user.id, deviceId: issued.deviceId, deviceName: issued.name },
    (c) => c.staffId === user.id
  );
  await recordAuditEvent(req, 'device.paired', { staffId: user.id, deviceId: issued.deviceId, method: 'qr' });
  res.json(pairResponse(issued, user));
});

// ── GET /api/devices/stream — the phone's own command channel ────────────────
// The Call Tracker app's foreground service keeps this open. It is how the CRM
// reaches ONE specific phone: dial commands are written only to the stream of
// the clicker's paired device, never broadcast. Plain SSE over a long-lived
// GET, so it passes through ngrok and nginx unchanged; X-Accel-Buffering stops
// nginx from buffering it (the dashboard's /api/events has a dedicated nginx
// block for that; this header makes one unnecessary).
app.get('/api/devices/stream', callTrackerLimiter, requireDeviceToken, async (req, res) => {
  const { id: deviceId, staff_id: staffId, staff_name: staffName } = req.device;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // A reconnect from the same phone replaces its previous stream.
  const previous = deviceClients.get(deviceId);
  if (previous && previous.res !== res) {
    try {
      previous.res.end();
    } catch (_) {
      /* already gone */
    }
  }
  deviceClients.set(deviceId, { res, staffId });
  // A fresh connection counts as a beat; `heartbeats` is kept from any earlier
  // connection so a heartbeat-capable app stays judged by its heartbeat.
  const prevPresence = devicePresence.get(deviceId);
  devicePresence.set(deviceId, { staffId, lastBeat: Date.now(), heartbeats: Boolean(prevPresence?.heartbeats) });
  res.write(`event: ready\ndata: ${JSON.stringify({ staffName })}\n\n`);
  publishPresence(deviceId, staffId);

  // A click made while this phone was briefly offline is delivered now — but
  // only if still inside its 60-second window. An older one is never sent:
  // the agent has moved on, and a surprise call would be worse than none.
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.staff_id, r.phone_number, r.expires_at, c.name AS customer_name
         FROM dial_requests r
         LEFT JOIN customers_all c ON c.id = r.customer_id
        WHERE r.staff_id = $1 AND r.status = 'pending' AND r.expires_at > now()
        ORDER BY r.created_at`,
      [staffId]
    );
    for (const row of rows) {
      if (sendDialCommand(res, row)) await markDialDelivered(row);
    }
  } catch (err) {
    console.error('pending dial redelivery failed:', err.message);
  }

  // 25s keeps idle-timeout proxies (ngrok, nginx) from closing the stream.
  // Sent as a real (ignored) event, NOT an SSE comment line (": ping"): ngrok
  // was measured dropping comment-only writes entirely, so the phone received
  // nothing for 70s, hit its read timeout and reconnected every ~72 seconds —
  // each drop a false "phone not connected" alert. Every app build ignores an
  // unknown event, so this needs no app change.
  const ping = setInterval(() => {
    try {
      res.write('event: ping\ndata: {}\n\n');
      touchDevice(deviceId);
    } catch (_) {
      clearInterval(ping);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    // Only remove the entry if it is still THIS connection — a reconnect may
    // already have replaced it.
    const current = deviceClients.get(deviceId);
    if (current && current.res === res) {
      deviceClients.delete(deviceId);
      // The phone's side dropped (not a server-side close, which removes the
      // entry first): start the reconnect grace.
      const p = devicePresence.get(deviceId);
      if (p) devicePresence.set(deviceId, { ...p, closedAt: Date.now() });
      // Written now, not through touchDevice's throttle, so "offline since"
      // on the CRM is the moment the phone actually dropped.
      pool
        .query('UPDATE staff_devices SET last_seen_at = now() WHERE id = $1', [deviceId])
        .catch(err => console.error('device last_seen update failed:', err.message));
      publishPresence(deviceId, staffId);
    }
  });
});

// ── POST /api/devices/heartbeat — "this phone is still here" ────────────────
// Sent every 20s by the app while its stream is open; see devicePresence for
// why the open stream alone is not proof a phone is alive. Deliberately tiny:
// no body, no response body, one Map update.
app.post('/api/devices/heartbeat', callTrackerLimiter, requireDeviceToken, (req, res) => {
  const p = devicePresence.get(req.device.id) || { staffId: req.device.staff_id };
  devicePresence.set(req.device.id, { ...p, lastBeat: Date.now(), heartbeats: true });
  publishPresence(req.device.id, req.device.staff_id);
  res.status(204).end();
});

// Statuses a phone may report. 'pending' is the server's own starting state
// and is never accepted from a phone.
const DEVICE_DIAL_STATUSES = ['delivered', 'dialing', 'busy', 'needs_tap', 'failed'];

// ── POST /api/devices/dial/:id/status — the phone reports what happened ──────
// Scoped to the phone owner's own requests (staff_id in the WHERE), so one
// phone cannot rewrite another agent's dial history. Relayed to the dashboard
// as a dial_status SSE event carrying staffId, and the clicker's browser
// filters on it.
app.post('/api/devices/dial/:id/status', callTrackerLimiter, requireDeviceToken, async (req, res) => {
  const { id } = req.params;
  const { status, error } = req.body || {};
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid request id' });
  if (!DEVICE_DIAL_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${DEVICE_DIAL_STATUSES.join(', ')}` });
  }
  const message = typeof error === 'string' ? error.slice(0, 200) : null;

  try {
    const { rows } = await pool.query(
      `UPDATE dial_requests
          SET status = $1, error = $2, updated_at = now(),
              delivered_at = COALESCE(delivered_at, now())
        WHERE id = $3 AND staff_id = $4
        RETURNING id, staff_id`,
      [status, message, id, req.device.staff_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Dial request not found' });
    broadcastEvent(
      'dial_status',
      { requestId: id, staffId: rows[0].staff_id, status, error: message },
      c => c.staffId === rows[0].staff_id
    );
    res.json({ success: true });
  } catch (err) {
    console.error('dial status update failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Most calls one sync may carry. The app sends at most 200 per request
// (CallSyncHelper.SYNC_BATCH_SIZE). Without a cap the 5 MB body limit let one
// request hold ~50,000 entries, each costing several sequential queries — a
// single paired phone (or a stolen phone token) could keep the database busy
// for minutes.
const MAX_CALLS_PER_SYNC = 500;
const CALL_TYPES = new Set(['INCOMING', 'OUTGOING', 'MISSED', 'UNKNOWN']);

app.post('/api/calls', callTrackerLimiter, requireCallTrackerAuth, async (req, res) => {
  const { calls, ownerPhone } = req.body;
  if (!Array.isArray(calls)) {
    return res.status(400).json({ error: 'calls must be an array' });
  }
  if (calls.length > MAX_CALLS_PER_SYNC) {
    return res.status(413).json({ error: `Send at most ${MAX_CALLS_PER_SYNC} calls per sync` });
  }

  // Resolved once per batch (migration 025) — every call in a single sync
  // came from the same device, so the same owner applies to all of them.
  // Falls back to round-robin (undefined) when unmatched.
  const assignedStaffId = await callOwnerStaffId(req, ownerPhone);

  let savedCount = 0;
  const touchedCustomerIds = new Set();

  for (const call of calls) {
    try {
      const { number, name, date, duration, callType, simSlot } = call;
      if (!number || !date) {
        console.error('Call tracker sync: skipping entry missing number/date', maskedCall(call));
        continue;
      }

      const rawPhoneNumber = normalizeCallTrackerNumber(number);
      // A phone number is at most 15 digits (E.164); anything else is not a call.
      if (rawPhoneNumber.length < 3 || rawPhoneNumber.length > 15) {
        console.error('Call tracker sync: skipping entry with an invalid number', maskedCall(call));
        continue;
      }
      const occurredAt = new Date(date).toISOString();
      const dedupKey = `${rawPhoneNumber}|${date}|${duration ?? ''}|${callType || ''}`;
      // Stored as sent by the phone, so bounded here: the contact name is
      // free text from the call log, and call type / SIM / duration have
      // fixed shapes.
      const safeName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 200) : null;
      const safeType = CALL_TYPES.has(callType) ? callType : null;
      const safeSim = Number.isInteger(simSlot) && simSlot >= 1 && simSlot <= 4 ? simSlot : null;
      const durationNum = Number(duration);
      const safeDuration = Number.isFinite(durationNum) && durationNum >= 0 && durationNum < 86400 * 7
        ? Math.round(durationNum) : null;

      const { rows: existing } = await pool.query('SELECT id FROM call_events WHERE dedup_key=$1', [dedupKey]);
      if (existing.length > 0) continue;

      const { customer } = await findOrCreateCustomerByPhone(rawPhoneNumber, 'call');
      const customerId = customer.id;
      await getOrCreateOpenTicket(customerId, { source: 'Call tracker app', assignedStaffId });

      // Who logged the call is recorded on the call itself (migration 051),
      // not only through the lead: when the customer already has an open lead
      // with another agent, the lead above is that agent's, and without this
      // nothing would show that THIS phone's owner made the call.
      // assignedStaffId is the paired phone's owner (verified) or, for a
      // legacy unpaired app, the self-typed ownerPhone match — device_id is
      // what tells the two apart.
      const cols = ['raw_phone_number', 'call_type', 'duration_seconds', 'occurred_at', 'customer_id', 'contact_name', 'sim_slot', 'dedup_key'];
      const vals = [rawPhoneNumber, safeType, safeDuration, occurredAt, customerId, safeName, safeSim, dedupKey];
      if (schemaFlags.callEventStaff) {
        cols.push('staff_id', 'device_id');
        vals.push(assignedStaffId || null, req.device ? req.device.id : null);
      }
      await pool.query(
        `INSERT INTO call_events (${cols.join(', ')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(',')})`,
        vals
      );

      touchedCustomerIds.add(customerId);
      savedCount++;
    } catch (err) {
      console.error('Call tracker sync: error processing entry', maskedCall(call), err.message);
    }
  }

  for (const customerId of touchedCustomerIds) {
    broadcastEvent('customer_update', { id: customerId });
    broadcastEvent('lead_update', { customer_id: customerId });
  }

  console.log(`Call tracker sync: received ${calls.length}, saved ${savedCount}`);
  res.json({ success: true, message: `Received and saved ${savedCount} calls`, count: savedCount });
});

// ── POST /api/calls/start — open a ticket the moment a call starts ───────────
// The full /api/calls sync above can only ever run AFTER a call ends —
// Android's CallLog provider has no "call in progress" row, only a finished
// one. Confirmed with the user this created a real gap: staff want the
// lead/ticket to exist WHILE they're on the call (so they can type notes
// into it live), not after. This route is the fix: the app's
// PhoneStateListener fires it the instant a call starts ringing (incoming)
// or goes off-hook (outgoing/answered), with just the phone number — no
// call details yet, those still arrive later via the existing /api/calls
// batch sync, which finds this same ticket already open (via
// getOrCreateOpenTicket's existing ticket_state='open' dedup) and attaches
// to it rather than creating a second one.
app.post('/api/calls/start', callTrackerLimiter, requireCallTrackerAuth, async (req, res) => {
  const { number, ownerPhone } = req.body;
  if (!number) {
    return res.status(400).json({ error: 'number is required' });
  }

  try {
    const rawPhoneNumber = normalizeCallTrackerNumber(number);
    const assignedStaffId = await callOwnerStaffId(req, ownerPhone);
    const { customer } = await findOrCreateCustomerByPhone(rawPhoneNumber, 'call');
    const customerId = customer.id;
    await getOrCreateOpenTicket(customerId, { source: 'Call tracker app', assignedStaffId });

    broadcastEvent('customer_update', { id: customerId });
    broadcastEvent('lead_update', { customer_id: customerId });

    // Masked like every other call-tracker log line (maskedCall): a full
    // customer number in the server log is personal data nobody reads.
    console.log(`Call tracker: ticket opened at call start for …${rawPhoneNumber.slice(-3)}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Call tracker start error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// ── everything else under /api requires a valid staff token ──────────────────
app.use('/api', authenticate);

// Every write made while handling this request is attributed to this staff
// member in activity_log (migration 035). Bound here, once, rather than passed
// down through 164 query call sites — and it covers writes made by code this
// route calls into (order confirmation, promo redemption) for free.
app.use('/api', (req, res, next) => {
  requestContext.run({ id: req.staff?.id, name: req.staff?.name, role: req.staff?.role }, next);
});

app.get('/api/auth/me', (req, res) => res.json({ staff: req.staff }));

// ── POST /api/auth/logout — close the session ────────────────────────────────
// Signing out was purely client-side before migration 045: the dashboard
// cleared localStorage and the server never knew, so a session had a start and
// no end. That is exactly the gap "active hours" needed closed.
//
// This does NOT invalidate the JWT — there is no token blocklist in this
// codebase (see the note on authenticate()), so a copied token stays valid
// until it expires. What it does is record when the person stopped working,
// which is what the screen reports. Said plainly here so nobody mistakes this
// for a security control it isn't.
//
// Always 200, even when there is no session to close: the client is signing
// out either way, and an error would only strand it on a screen it has already
// discarded its credentials for.
app.post('/api/auth/logout', async (req, res) => {
  const sid = req.staff?.sid;
  if (sid && schemaFlags.staffSessions) {
    try {
      await pool.query(
        `UPDATE staff_sessions SET ended_at = now(), end_reason = 'logout'
          WHERE id = $1 AND ended_at IS NULL`,
        [sid]
      );
      lastHeartbeat.delete(sid);
    } catch (err) {
      console.error('logout session close failed:', err.message);
    }
  }
  res.json({ ok: true });
});

// ── GET /api/calls — call log for the dashboard (Phase 18) ───────────────────
// Same role gate as Pipeline/Chats (leads.source/messages) — delivery_coordinator's
// job is fulfillment on placed orders, not the sales/call pipeline. Reads straight
// from call_events (Phase 17's Android call-tracker sync is the only writer), with
// the customer's name and the id of their current open ticket (if any) so the
// dashboard can offer a one-click "Open lead" — falls back to raw_phone_number/
// contact_name when no customers row matched (shouldn't normally happen, since
// /api/calls always finds-or-creates one, but the FK is nullable).
// PAGINATED, AND FILTERED HERE RATHER THAN IN THE BROWSER. This route used to
// return a flat `LIMIT 500` and the page filtered that array client-side. With
// a lifetime call log that silently lied twice over: the 501st call did not
// exist as far as the dashboard was concerned, and a search only ever looked
// inside whatever had been loaded — a customer further back read as "no
// results" rather than "not on this page".
//
// So every filter the page offers is applied in SQL, against the WHOLE table,
// and only one page comes back. `total` is the count of rows MATCHING THE
// FILTERS (not the table size), because that is what the pager must divide
// into pages and what "N calls" under the table has to say to stay honest.
//
// The count is a second query rather than a window function: it does not need
// the LEFT JOIN or the open-ticket subquery, so counting stays cheap as the
// log grows.
app.get('/api/calls', requireRole(...PIPELINE_READ_ROLES), async (req, res) => {
  try {
    // Clamped exactly like GET /api/customers: a caller cannot ask for the
    // whole table with ?limit=999999, and cannot send a negative offset.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    // Built as a shared WHERE so the page query and the count query can never
    // disagree about what matches — a drift there would show the wrong page
    // count, or a last page that renders empty.
    const where = [];
    const params = [];

    const type = req.query.type;
    if (type && type !== 'all' && ['INCOMING', 'OUTGOING', 'MISSED'].includes(type)) {
      params.push(type);
      where.push(`ce.call_type = $${params.length}`);
    }

    // Date bounds compare on the LOCAL calendar day, matching localDay() in the
    // dashboard: a From/To of the same day must cover that whole day as staff
    // experience it. Comparing the raw timestamptz would cut the day short by
    // the UTC offset and drop that evening's calls.
    if (req.query.dateFrom) {
      params.push(req.query.dateFrom);
      where.push(`(ce.occurred_at AT TIME ZONE 'Asia/Colombo')::date >= $${params.length}::date`);
    }
    if (req.query.dateTo) {
      params.push(req.query.dateTo);
      where.push(`(ce.occurred_at AT TIME ZONE 'Asia/Colombo')::date <= $${params.length}::date`);
    }

    // "Connected" is the same rule the page already used: a MISSED call never
    // connected, and a 0-second call did not really connect either.
    if (req.query.answered === 'answered') {
      where.push(`(ce.call_type <> 'MISSED' AND COALESCE(ce.duration_seconds, 0) > 0)`);
    } else if (req.query.answered === 'unanswered') {
      where.push(`(ce.call_type = 'MISSED' OR COALESCE(ce.duration_seconds, 0) = 0)`);
    }

    // One customer's calls — the call-history card behind the Pipeline and
    // lead-page dots. Still under the agent scope below, so a sales agent
    // only ever gets their own calls with that customer.
    if (req.query.customerId) {
      if (!UUID_RE.test(req.query.customerId)) return res.status(400).json({ error: 'customerId is not valid' });
      params.push(req.query.customerId);
      where.push(`ce.customer_id = $${params.length}`);
    }

    // Whose phone logged the call (migration 051). Admins/viewers may pick
    // an agent ('none' = calls with no recorded agent — every call synced
    // before 051); everyone else only ever gets their own calls (058), and
    // any staffId they send is ignored.
    const staffWhere = staffScopeWhere(req, 'ce.staff_id', params, schemaFlags.callEventStaff);
    if (staffWhere) where.push(staffWhere);

    // Search matches the two names and the number, mirroring the client-side
    // version it replaces. The number is ALSO matched in canonical form so
    // typing 0771234567 finds a stored 94771234567 — the same courtesy
    // GET /api/customers already extends, and staff should not have to know
    // which format the call tracker happened to send.
    const search = (req.query.search || '').trim();
    if (search) {
      const canon = normalizePhone(search);
      params.push(`%${search}%`);
      const like = `$${params.length}`;
      params.push(`%${canon}%`);
      const likeCanon = `$${params.length}`;
      where.push(`(
        c.name ILIKE ${like}
        OR ce.contact_name ILIKE ${like}
        OR ce.raw_phone_number ILIKE ${like}
        OR ce.raw_phone_number ILIKE ${likeCanon}
      )`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // The count needs the customers join only when the search touches c.name.
    const countJoin = search ? 'LEFT JOIN customers c ON c.id = ce.customer_id' : '';
    const { rows: countRows } = await pool.query(
      `SELECT count(*)::int AS total FROM call_events ce ${countJoin} ${whereSql}`,
      params
    );
    const total = countRows[0]?.total ?? 0;

    // staff_name: whose phone logged the call. staff_verified: it came from a
    // phone signed in with that agent's own login (device_id set) — false for
    // an older app build that only CLAIMED an owner by a typed phone number.
    const staffCols = schemaFlags.callEventStaff
      ? `ce.staff_id, s.name AS staff_name, (ce.device_id IS NOT NULL) AS staff_verified,`
      : `NULL::uuid AS staff_id, NULL::text AS staff_name, false AS staff_verified,`;
    const staffJoin = schemaFlags.callEventStaff ? 'LEFT JOIN staff_users s ON s.id = ce.staff_id' : '';

    const { rows } = await pool.query(
      `
      SELECT
        ce.id, ce.raw_phone_number, ce.contact_name, ce.call_type,
        ce.duration_seconds, ce.occurred_at, ce.sim_slot, ce.customer_id,
        c.name AS customer_name,
        ${staffCols}
        (
          SELECT l.id FROM leads l
          WHERE l.customer_id = ce.customer_id AND l.ticket_state = 'open'
          ORDER BY l.created_at DESC LIMIT 1
        ) AS open_lead_id
      FROM call_events ce
      LEFT JOIN customers c ON c.id = ce.customer_id
      ${staffJoin}
      ${whereSql}
      ORDER BY ce.occurred_at DESC NULLS LAST, ce.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `,
      [...params, limit, offset]
    );
    res.json({ calls: rows, total, limit, offset });
  } catch (err) {
    console.error('GET /api/calls failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/calls/callbacks — missed-call callback tracker (migration 043) ──
// One row per phone number that has ever missed us, with whether we have rung
// them back since their LATEST miss. Narrower than GET /api/calls above: this
// is a sales accountability worklist, so admin/sales_agent only.
//
// The done/pending decision and the 15s threshold both live in
// v_missed_call_callbacks, NOT here — the threshold is admin-editable and must
// re-evaluate all history the moment it changes, which it does because the view
// reads app_settings on every read. Reimplementing the rollup in this route
// would let the two drift.
//
// The only query param is an admin's ?staffId= (058); status, dates and
// search are filtered client-side, which is safe because collapsing to one
// row per agent + number keeps this result set small.
app.get('/api/calls/callbacks', requireRole('admin', 'sales_agent'), async (req, res) => {
  try {
    // Whose phone missed it / called back (migration 051's view columns).
    const staffCols = schemaFlags.callEventStaff
      ? 'v.missed_on_staff_id, v.missed_on_staff_name, v.called_back_by_staff_id, v.called_back_by_name,'
      : 'NULL::uuid AS missed_on_staff_id, NULL::text AS missed_on_staff_name, NULL::uuid AS called_back_by_staff_id, NULL::text AS called_back_by_name,';
    // Since 058 the view has one row per (agent's phone, number): a sales
    // agent gets only the misses on their own phone; an admin may pick one
    // agent (?staffId=) or see everyone.
    const params = [];
    const staffWhere = staffScopeWhere(req, 'v.missed_on_staff_id', params, schemaFlags.callEventStaff);
    const { rows } = await pool.query(`
      SELECT
        v.phone_canon, v.raw_phone_number, v.missed_count,
        v.first_missed_at, v.latest_missed_at,
        v.customer_id, v.customer_name, v.contact_name,
        v.called_back_at, v.callback_duration_seconds,
        v.is_called_back, v.callback_status,
        ${staffCols}
        -- time_to_callback is an INTERVAL; pg would serialize it as an object,
        -- so it is flattened to int seconds here and formatted once client-side.
        EXTRACT(EPOCH FROM v.time_to_callback)::int AS time_to_callback_seconds,
        v.threshold_seconds,
        (
          SELECT l.id FROM leads l
          WHERE l.customer_id = v.customer_id AND l.ticket_state = 'open'
          ORDER BY l.created_at DESC LIMIT 1
        ) AS open_lead_id
      FROM v_missed_call_callbacks v
      ${staffWhere ? `WHERE ${staffWhere}` : ''}
      -- Pending first (false sorts before true): the worklist opens on the work.
      ORDER BY v.is_called_back ASC, v.latest_missed_at DESC
      LIMIT 500
    `, params);
    res.json({ callbacks: rows });
  } catch (err) {
    console.error('GET /api/calls/callbacks failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/dial — click-to-call from the CLICKER's own phone (migration 050)
// The number is resolved HERE from the customer record; the browser never
// supplies it, so this cannot be used to make an agent's phone ring an
// arbitrary number. A lead, when given, must be one the caller can see —
// the same call-ownership rule GET /api/leads applies (callVisibilityFilter).
// Without a lead (Customers page, Callbacks page) any customer is dialable,
// matching GET /api/customers-directory, which shows sales agents every
// customer already.
//
// The request is recorded even when the phone is offline: if it reconnects
// within the 60-second window it dials then (see /api/devices/stream);
// after that it never will. The response says which case applies so the
// button can tell the agent.
const DIAL_REPEAT_GUARD_SECONDS = 10;

app.post('/api/dial', requireRole('admin', 'sales_agent'), async (req, res) => {
  const { customerId, leadId } = req.body || {};
  if (!UUID_RE.test(String(customerId || ''))) return res.status(400).json({ error: 'customerId is required' });
  if (leadId != null && !UUID_RE.test(String(leadId))) return res.status(400).json({ error: 'Invalid leadId' });

  try {
    if (leadId) {
      const params = [leadId, customerId];
      const visibility = callVisibilityFilter(req, params);
      const { rows: leadRows } = await pool.query(
        `SELECT l.id FROM leads l WHERE l.id = $1 AND l.customer_id = $2${visibility}`,
        params
      );
      if (leadRows.length === 0) return res.status(404).json({ error: 'Lead not found' });
    }

    const { rows: customerRows } = await pool.query(
      'SELECT id, name, whatsapp_number FROM customers WHERE id = $1',
      [customerId]
    );
    const customer = customerRows[0];
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    if (!dialableNumber(customer.whatsapp_number)) {
      return res.status(422).json({
        code: 'NOT_DIALABLE',
        error: `This number can't be called from the CRM — only numbers starting +${dialAllowedPrefixes().join(' or +')} are allowed.`,
      });
    }

    const { rows: deviceRows } = await pool.query(
      'SELECT id FROM staff_devices WHERE staff_id = $1 AND revoked_at IS NULL',
      [req.staff.id]
    );
    const device = deviceRows[0];
    if (!device) {
      return res.status(409).json({
        code: 'NO_DEVICE',
        error: 'No phone paired. Sign in on the Call Tracker app on your phone first.',
      });
    }

    // A double-click, or two quick clicks on different rows, must not stack
    // up calls on the phone.
    const { rows: recent } = await pool.query(
      `SELECT 1 FROM dial_requests
        WHERE staff_id = $1 AND created_at > now() - ($2 || ' seconds')::interval
        LIMIT 1`,
      [req.staff.id, String(DIAL_REPEAT_GUARD_SECONDS)]
    );
    if (recent.length > 0) {
      return res.status(429).json({ code: 'TOO_SOON', error: 'A call was just sent to your phone. Wait a few seconds.' });
    }

    const { rows: lastHour } = await pool.query(
      `SELECT count(*)::int AS n FROM dial_requests
        WHERE staff_id = $1 AND created_at > now() - interval '1 hour'`,
      [req.staff.id]
    );
    if ((Number(lastHour[0]?.n) || 0) >= dialMaxPerHour()) {
      await recordAuditEvent(req, 'dial.hourly_limit', { limit: dialMaxPerHour() });
      return res.status(429).json({
        code: 'HOURLY_LIMIT',
        error: `You've reached the limit of ${dialMaxPerHour()} calls from the CRM in an hour. Try again later, or dial from your phone directly.`,
      });
    }

    const { rows: inserted } = await pool.query(
      `INSERT INTO dial_requests (staff_id, device_id, customer_id, lead_id, phone_number)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, staff_id, phone_number, expires_at`,
      [req.staff.id, device.id, customer.id, leadId || null, customer.whatsapp_number]
    );
    const row = { ...inserted[0], customer_name: customer.name };

    // Only write to a stream that is really live: a zombie stream (heartbeat
    // stopped) would swallow the command. Left pending instead, it is
    // delivered if the phone reconnects inside the 60-second window.
    const client = isDeviceOnline(device.id) ? deviceClients.get(device.id) : null;
    const delivered = Boolean(client) && sendDialCommand(client.res, row);
    if (delivered) await markDialDelivered(row);

    await recordAuditEvent(req, 'dial.requested', { requestId: row.id, customerId: customer.id, leadId: leadId || null });
    res.json({ requestId: row.id, deviceOnline: delivered, status: delivered ? 'delivered' : 'pending' });
  } catch (err) {
    console.error('POST /api/dial failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/devices/me — does the caller have a phone ready to dial? ────────
// Lets the Call button explain itself before it is clicked ("No phone
// paired" / "Phone offline") instead of only after.
// ── POST /api/devices/pair-codes — a one-time QR code (migration 056) ─────────
// Registered AFTER app.use('/api', authenticate): the code is issued to the
// logged-in staff member (req.staff), never to anyone named in the request.
// The address phones should use, put into the QR. Normally unset: the
// dashboard then uses its own address, which in production IS the API
// (nginx serves both at crm.nidikumba.shop). Set it when the dashboard's
// address is not one a phone can reach — local development, where the
// dashboard is http://localhost:5173 and the API http://localhost:3000 — to an
// https tunnel to this backend (e.g. https://abc123.ngrok-free.app). Must be
// https: the app refuses anything else.
function phoneServerUrl() {
  const raw = (process.env.CALL_TRACKER_SERVER_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash ? u.origin + u.pathname.replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}
if (process.env.CALL_TRACKER_SERVER_URL && !phoneServerUrl()) {
  console.warn('[config] CALL_TRACKER_SERVER_URL is not a plain https:// address — ignored; QR codes will use the dashboard address.');
}

// A person makes a code every few minutes at most; this stops a script.
// Wrong-password tries count too. An admin can clear it at once from User
// Management (POST /api/staff/:id/clear-signin-block), which is why the key is
// derived from the staff id alone.
const PAIR_CODE_MAX = 10;
const pairCodeKey = (staffId) => `pair-code:${staffId}`;
const pairCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: PAIR_CODE_MAX,
  keyGenerator: (req) => pairCodeKey(req.staff?.id),
  standardHeaders: true,
  legacyHeaders: false,
  // Structured, so the dashboard can say WHEN it clears and offer the fix
  // instead of showing a bare sentence.
  handler: (req, res) => {
    const until = req.rateLimit?.resetTime ? new Date(req.rateLimit.resetTime) : null;
    res.status(429).json({
      error: 'Too many sign-in codes were made in a short time.',
      code: 'pair_code_limit',
      until: until ? until.toISOString() : null,
    });
  },
});

/**
 * What currently stops this person making a sign-in code, if anything:
 * the code limit (in memory, this process) and/or the account lockout (DB,
 * migration 035 — which also blocks their dashboard login). Shown to admins
 * in User Management next to the "Clear sign-in block" button.
 */
async function signinBlockFor(staffId, lockedUntil) {
  const info = await pairCodeLimiter.getKey(pairCodeKey(staffId));
  const codeLimitUntil = info && info.totalHits >= PAIR_CODE_MAX && info.resetTime && new Date(info.resetTime) > new Date()
    ? new Date(info.resetTime).toISOString()
    : null;
  const lockUntil = lockedUntil && new Date(lockedUntil) > new Date() ? new Date(lockedUntil).toISOString() : null;
  return codeLimitUntil || lockUntil ? { codeLimitUntil, lockedUntil: lockUntil } : null;
}

// The password is asked for AGAIN here (security review, 2026-09-28,
// confirmed with the user). Without it a dashboard session alone could mint a
// phone credential: a stolen 12-hour session token, or a PC left logged in,
// became a device token that works for weeks and — before the password-reset
// fix below — even survived a password reset. Password sign-in on the phone
// always needed the password; QR sign-in now needs it too, just typed on the
// PC instead of the phone. Goes through verifyStaffCredentials(), so wrong
// guesses count toward the same per-account lockout as the login page.
app.post('/api/devices/pair-codes', requireRole(...DEVICE_ROLES), pairCodeLimiter, async (req, res) => {
  if (!schemaFlags.pairCodes) return res.status(503).json({ error: PAIR_CODES_UNAVAILABLE });
  const { password } = req.body || {};
  if (typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Confirm your CRM password to make a sign-in code' });
  }
  try {
    const { rows: me } = await pool.query('SELECT phone FROM staff_users WHERE id = $1', [req.staff.id]);
    const verified = me[0] ? await verifyStaffCredentials(req, me[0].phone, password) : null;
    // 403, not 401: the dashboard treats any 401 as "your session ended" and
    // logs the user out, which a mistyped password must not do.
    if (!verified || verified.id !== req.staff.id) {
      recordAuditEvent(req, 'device.pair_code_denied', {});
      // Say which it is: "locked" needs an admin or a wait, "wrong password"
      // needs another try — and how many are left before the lock.
      const lockCols = schemaFlags.loginLockout ? 'failed_login_count, locked_until' : 'NULL AS failed_login_count, NULL AS locked_until';
      const { rows: st } = await pool.query(`SELECT ${lockCols} FROM staff_users WHERE id = $1`, [req.staff.id]);
      const lockedUntil = st[0]?.locked_until && new Date(st[0].locked_until) > new Date() ? new Date(st[0].locked_until) : null;
      if (lockedUntil) {
        return res.status(403).json({
          error: 'Your account is locked after too many wrong passwords.',
          code: 'account_locked',
          until: lockedUntil.toISOString(),
        });
      }
      const failed = Number(st[0]?.failed_login_count) || 0;
      return res.status(403).json({
        error: 'Incorrect password.',
        code: 'wrong_password',
        attemptsLeft: schemaFlags.loginLockout ? Math.max(0, MAX_FAILED_LOGINS - failed) : null,
      });
    }

    const code = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + PAIR_CODE_TTL_MS);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serializes two "make a code" clicks by the same person, which could
      // otherwise both insert and leave two live codes.
      await client.query('SELECT id FROM staff_users WHERE id = $1 FOR UPDATE', [req.staff.id]);
      // Only the newest code works: a QR left on screen, or photographed
      // earlier, stops working the moment a new one is made.
      await client.query(
        'UPDATE device_pair_codes SET used_at = now() WHERE staff_id = $1 AND used_at IS NULL',
        [req.staff.id]
      );
      // Housekeeping: nothing reads codes older than a week (the audit log
      // already records each sign-in), so the table cannot grow forever.
      await client.query("DELETE FROM device_pair_codes WHERE created_at < now() - interval '7 days'");
      await client.query(
        'INSERT INTO device_pair_codes (staff_id, code_hash, expires_at) VALUES ($1, $2, $3)',
        [req.staff.id, hashDeviceToken(code), expiresAt.toISOString()]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    recordAuditEvent(req, 'device.pair_code_created', {});
    res.json({ code, expiresAt: expiresAt.toISOString(), server: phoneServerUrl() });
  } catch (err) {
    console.error('POST /api/devices/pair-codes failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/devices/me', requireRole('admin', 'sales_agent'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, device_name, created_at, last_seen_at FROM staff_devices
        WHERE staff_id = $1 AND revoked_at IS NULL`,
      [req.staff.id]
    );
    const device = rows[0];
    if (!device) return res.json({ paired: false, online: false, status: 'not_paired' });
    const status = presenceStatus(device.id, device.last_seen_at);
    res.json({
      paired: true,
      online: status === 'online',
      // 'online' | 'offline' | 'unknown' — drives the agent's CRM banner.
      status,
      deviceId: device.id,
      deviceName: device.device_name,
      pairedAt: device.created_at,
      lastSeenAt: device.last_seen_at,
    });
  } catch (err) {
    console.error('GET /api/devices/me failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/devices — every paired phone, for the Team page (admin) ─────────
app.get('/api/devices', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.id, d.staff_id, s.name AS staff_name, s.role, d.device_name, d.created_at, d.last_seen_at
         FROM staff_devices d
         JOIN staff_users s ON s.id = d.staff_id
        WHERE d.revoked_at IS NULL
        ORDER BY s.name`
    );
    res.json(rows.map(r => ({ ...r, online: isDeviceOnline(r.id) })));
  } catch (err) {
    console.error('GET /api/devices failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/devices/status — whose phone is not connected (admin) ──────────
// One row per active sales agent — INCLUDING agents who never signed a phone
// in, since "no phone at all" is the most disconnected an agent can be —
// plus any admin who has paired one. Feeds the admin's "phones not
// connected" alert and the Team page. status: 'online' | 'offline' |
// 'unknown' (just restarted) | 'not_paired'.
app.get('/api/devices/status', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id AS staff_id, s.name AS staff_name, s.role,
              d.id AS device_id, d.device_name, d.created_at AS paired_at, d.last_seen_at
         FROM staff_users s
         LEFT JOIN staff_devices d ON d.staff_id = s.id AND d.revoked_at IS NULL
        WHERE s.active = true AND (s.role = 'sales_agent' OR d.id IS NOT NULL)
        ORDER BY s.name`
    );
    res.json(
      rows.map(r => ({
        ...r,
        status: r.device_id ? presenceStatus(r.device_id, r.last_seen_at) : 'not_paired',
      }))
    );
  } catch (err) {
    console.error('GET /api/devices/status failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/devices/:id — un-pair a phone (lost, replaced, staff left) ───
// Admins can revoke anyone's; a sales agent only their own. Revoked, not
// deleted: dial_requests keep pointing at the device that made each call.
// Its open stream is closed at once, so it stops receiving dial commands now
// rather than at its next reconnect.
app.delete('/api/devices/:id', requireRole('admin', 'sales_agent'), async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid device id' });
  try {
    const params = [id];
    let ownOnly = '';
    if (!hasRole(req.staff, 'admin')) {
      params.push(req.staff.id);
      ownOnly = ' AND staff_id = $2';
    }
    const { rows } = await pool.query(
      `UPDATE staff_devices SET revoked_at = now()
        WHERE id = $1 AND revoked_at IS NULL${ownOnly}
        RETURNING id, staff_id`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Paired phone not found' });
    closeDeviceStreams(deviceId => deviceId === id);
    await recordAuditEvent(req, 'device.revoked', { deviceId: id, staffId: rows[0].staff_id });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/devices/:id failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── staff management (Admin only — REQ-2.3) ───────────────────────────────────
const ADMIN_ROLES = ['admin', SUPER_ADMIN];

// Rules for any change to someone's account, shared by create, edit, password
// reset, clear-sign-in-block and delete so they cannot disagree. Before this,
// only DELETE protected a super admin — an admin could simply demote one, reset
// their password (a full takeover), promote themselves, or create a new super
// admin, which made "only a super admin may grant it" a comment, not a rule.
// Returns [status, message] when the change is refused, else null.
function staffChangeRefusal(req, target, { role, disabling } = {}) {
  const bySuper = req.staff.role === SUPER_ADMIN;
  if (!bySuper && (target?.role === SUPER_ADMIN || role === SUPER_ADMIN)) {
    return [403, 'Only a super admin can create or change a super admin account'];
  }
  if (target && target.id === req.staff.id && ((role && role !== target.role) || disabling)) {
    return [400, "You can't change your own role or disable your own account. Ask another admin."];
  }
  return null;
}

// True when `target` is an active admin and no OTHER active admin would be
// left if they lost admin rights. `admins` must be the locked admin rows.
function isLastActiveAdmin(target, admins) {
  if (!target.active || !ADMIN_ROLES.includes(target.role)) return false;
  return !admins.some(u => u.id !== target.id && u.active && ADMIN_ROLES.includes(u.role));
}

app.get('/api/staff', requireRole('admin'), async (req, res) => {
  try {
    const lockCol = schemaFlags.loginLockout ? ', locked_until' : '';
    const { rows } = await pool.query(`SELECT id, name, phone, role, active, created_at${lockCol} FROM staff_users ORDER BY created_at DESC`);
    // signin_block: set when this person can't make a phone sign-in code
    // right now (and, for a lock, can't log in either) — drives the badge and
    // the "Clear sign-in block" button. locked_until itself is not sent.
    const staff = await Promise.all(rows.map(async ({ locked_until: lockedUntil, ...u }) => ({
      ...u,
      signin_block: await signinBlockFor(u.id, lockedUntil),
    })));
    res.json({ staff });
  } catch (err) {
    console.error('GET /api/staff failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/staff/roster — names for the admin "which agent?" filters (058)
// Just id/name/role/active of the people who make calls and place orders, for
// the agent dropdowns on Calls, Callbacks and Orders. Viewers get it too (they
// see every agent's rows); GET /api/staff above is admin-only and carries
// phone numbers and sign-in state a dropdown has no use for.
app.get('/api/staff/roster', requireRole('admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, role, active FROM staff_users
        WHERE role IN ('sales_agent', 'admin', $1)
        ORDER BY active DESC, name ASC`,
      [SUPER_ADMIN]
    );
    res.json({ staff: rows });
  } catch (err) {
    console.error('GET /api/staff/roster failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/staff', requireRole('admin'), async (req, res) => {
  const { name, phone, password, role } = req.body;
  if (!name || !phone || !password || !STAFF_ROLES.includes(role)) {
    return res.status(400).json({ error: `name, phone, password, and role (one of: ${STAFF_ROLES.join(', ')}) are required` });
  }
  // Same policy as the reset route below. This route previously enforced
  // nothing, so a one-character password was accepted on an account that can
  // read every customer record.
  const pwError = validatePassword(password);
  if (pwError) return res.status(400).json({ error: pwError });
  const refused = staffChangeRefusal(req, null, { role });
  if (refused) return res.status(refused[0]).json({ error: refused[1] });

  try {
    // Stored in the canonical 94XXXXXXXXX form, so new accounts are
    // consistent. The duplicate check covers every spelling of the number:
    // the unique index alone would let 0771234567 and 94771234567 become two
    // accounts that the login lookup could not tell apart.
    const { rows: taken } = await pool.query('SELECT 1 FROM staff_users WHERE phone = ANY($1::text[])', [
      staffPhoneCandidates(phone),
    ]);
    if (taken.length > 0) return res.status(409).json({ error: 'Phone number already registered' });

    const password_hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO staff_users (name, phone, password_hash, role)
       VALUES ($1,$2,$3,$4) RETURNING id, name, phone, role, active, created_at`,
      [name, normalizePhone(phone), password_hash, role]
    );
    res.json({ success: true, staff: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Phone number already registered' });
    console.error('POST /api/staff failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/staff/:id', requireRole('admin'), async (req, res) => {
  const allowed = ['name', 'role', 'active'];
  // Reject rather than silently drop: a request sending `password_hash` or a
  // field this route does not own should fail loudly, not return 200 having
  // ignored it.
  if (rejectUnknownFields(req, res, allowed)) return;
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  const lengthError = validateFieldValues(updates);
  if (lengthError) return res.status(400).json({ error: lengthError });
  if (updates.role !== undefined && !STAFF_ROLES.includes(updates.role)) {
    return res.status(400).json({ error: `role must be one of: ${STAFF_ROLES.join(', ')}` });
  }
  // Strictly typed: Postgres would happily cast the STRING "false" to false,
  // slipping a deactivation past the checks below, which look for false.
  if (updates.active !== undefined && typeof updates.active !== 'boolean') {
    return res.status(400).json({ error: 'active must be true or false' });
  }
  if (updates.name !== undefined && (typeof updates.name !== 'string' || !updates.name.trim())) {
    return res.status(400).json({ error: 'name must be a non-empty string' });
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update' });
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid staff id' });

  const entries = Object.entries(updates);
  const setClauses = entries.map(([k], i) => `${k}=$${i + 1}`).join(', ');
  const vals = [...entries.map(([, v]) => v), req.params.id];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Same lock as DELETE: the target plus every admin row, so demoting or
    // disabling two admins at once cannot leave nobody.
    const { rows: locked } = await client.query(
      `SELECT id, name, role, active FROM staff_users
        WHERE id = $1 OR role = ANY($2::text[])
        ORDER BY id FOR UPDATE`,
      [req.params.id, ADMIN_ROLES]
    );
    const target = locked.find(u => u.id === req.params.id);
    if (!target) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Staff user not found' });
    }
    const losesAdmin = updates.active === false || (updates.role !== undefined && !ADMIN_ROLES.includes(updates.role));
    const refused = staffChangeRefusal(req, target, { role: updates.role, disabling: updates.active === false })
      || (losesAdmin && isLastActiveAdmin(target, locked)
        ? [409, `${target.name} is the last active admin — make someone else an admin first`]
        : null);
    if (refused) {
      await client.query('ROLLBACK');
      return res.status(refused[0]).json({ error: refused[1] });
    }
    const { rows } = await client.query(
      `UPDATE staff_users SET ${setClauses} WHERE id=$${entries.length + 1} RETURNING id, name, phone, role, active, created_at`,
      vals
    );
    await client.query('COMMIT');
    if (updates.role !== undefined && updates.role !== target.role) {
      recordAuditEvent(req, 'staff.role_changed', { staffId: target.id, from: target.role, to: updates.role });
    }
    if (updates.active !== undefined && updates.active !== target.active) {
      recordAuditEvent(req, updates.active ? 'staff.enabled' : 'staff.disabled', { staffId: target.id });
    }
    res.json({ success: true, staff: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('PATCH /api/staff/:id failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── POST /api/staff/:id/clear-signin-block — Admin only ──────────────────────
// The immediate way out of "Too many sign-in codes" / "account locked": clears
// this person's sign-in-code limit AND their account lockout (which also
// blocks their dashboard login). Nothing else changes — their password, phones
// and existing sessions are untouched. An admin may clear their own block too.
app.post('/api/staff/:id/clear-signin-block', requireRole('admin'), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid staff id' });
  try {
    const { rows: found } = await pool.query('SELECT id, role FROM staff_users WHERE id = $1', [req.params.id]);
    if (found.length === 0) return res.status(404).json({ error: 'Staff user not found' });
    const refused = staffChangeRefusal(req, found[0]);
    if (refused) return res.status(refused[0]).json({ error: refused[1] });
    const sets = schemaFlags.loginLockout ? 'failed_login_count = 0, locked_until = NULL' : 'id = id';
    const { rows } = await pool.query(`UPDATE staff_users SET ${sets} WHERE id = $1 RETURNING id, name`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Staff user not found' });
    pairCodeLimiter.resetKey(pairCodeKey(rows[0].id));
    recordAuditEvent(req, 'staff.signin_block_cleared', { staffId: rows[0].id });
    res.json({ success: true, staff: { id: rows[0].id, name: rows[0].name } });
  } catch (err) {
    console.error('POST /api/staff/:id/clear-signin-block failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/staff/:id — permanently delete a staff account (Admin only) ──
// Removes the staff_users row for good. What that person DID stays: orders,
// payments, calls and quotations remain, and the audit/activity logs keep
// their name. Only the link from those records to the account goes (it shows
// as no one / "deleted user") — the four references that would otherwise block
// the delete are set to NULL here, the rest are ON DELETE SET NULL / CASCADE
// already (their phones, dial history, notifications and sign-in codes go with
// the account).
//
// Their OPEN leads are the one thing that must not lose an owner silently, so
// the admin chooses: body.reassignTo = a staff id, or 'auto' (round-robin to
// the least-loaded active sales agent, the same rule new leads use). Closed
// leads just lose the owner. body.confirmName must equal the person's name —
// the same "type the name" the dialog asks for, enforced here too because
// this cannot be undone.
//
// Refused: deleting yourself, a super admin (unless you are one), and the last
// active admin. The admin rows are locked first so two admins deleting each
// other at the same moment are serialized: the second sees the first's result
// and is refused as the last admin (verified against Postgres).

// What deleting this person touches — for the dialog, before anyone commits.
app.get('/api/staff/:id/delete-preview', requireRole('admin'), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid staff id' });
  try {
    const { rows } = await pool.query('SELECT id, name, role FROM staff_users WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Staff user not found' });
    const { rows: counts } = await pool.query(
      `SELECT
         (SELECT count(*) FROM leads_all WHERE assigned_staff_id = $1 AND ticket_state = 'open' AND deleted_at IS NULL)::int AS open_leads,
         (SELECT count(*) FROM leads_all WHERE assigned_staff_id = $1 AND NOT (ticket_state = 'open' AND deleted_at IS NULL))::int AS other_leads,
         (SELECT count(*) FROM staff_devices WHERE staff_id = $1 AND revoked_at IS NULL)::int AS phones`,
      [req.params.id]
    );
    res.json({ staff: rows[0], ...counts[0] });
  } catch (err) {
    console.error('GET /api/staff/:id/delete-preview failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/staff/:id', requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid staff id' });
  const { reassignTo, confirmName } = req.body || {};
  if (typeof confirmName !== 'string') {
    return res.status(400).json({ error: "Type the person's name to confirm" });
  }
  if (id === req.staff.id) {
    return res.status(400).json({ error: "You can't delete your own account. Ask another admin to do it." });
  }
  if (reassignTo !== undefined && reassignTo !== 'auto' && !UUID_RE.test(String(reassignTo))) {
    return res.status(400).json({ error: "reassignTo must be a staff id or 'auto'" });
  }
  if (reassignTo === id) return res.status(400).json({ error: "Open leads can't be given to the person being deleted" });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock every admin row (plus the target) in one statement, in id order, so
    // the last-admin check below cannot race another admin's delete.
    const { rows: locked } = await client.query(
      `SELECT id, name, phone, role, active FROM staff_users
        WHERE id = $1 OR role = ANY($2::text[])
        ORDER BY id FOR UPDATE`,
      [id, ADMIN_ROLES]
    );
    const target = locked.find(u => u.id === id);
    if (!target) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Staff user not found' });
    }
    if (confirmName.trim().toLowerCase() !== String(target.name || '').trim().toLowerCase()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Type the person's name exactly (${target.name}) to confirm` });
    }
    if (target.role === SUPER_ADMIN && req.staff.role !== SUPER_ADMIN) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only a super admin can delete a super admin' });
    }
    if (isLastActiveAdmin(target, locked)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `${target.name} is the last active admin — make someone else an admin first` });
    }

    // ── their open leads get a new owner ──
    const { rows: openLeads } = await client.query(
      `SELECT l.id, c.priority_label FROM leads_all l
         LEFT JOIN customers_all c ON c.id = l.customer_id
        WHERE l.assigned_staff_id = $1 AND l.ticket_state = 'open' AND l.deleted_at IS NULL
        ORDER BY l.created_at FOR UPDATE OF l`,
      [id]
    );
    let reassignedTo = null;
    if (openLeads.length > 0) {
      if (reassignTo === undefined) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `${target.name} has ${openLeads.length} open lead(s). Choose who takes them over.`,
          code: 'reassign_required',
          openLeads: openLeads.length,
        });
      }
      // Each lead gets a fresh SLA clock from now, as if newly assigned (the
      // same priority rule as trg_new_lead_assignment) — otherwise the new
      // owner inherits the deleted person's overdue tickets as instantly late.
      const assign = (leadId, staffId, priority) =>
        client.query(
          `UPDATE leads_all SET assigned_staff_id = $2, assigned_at = now(), updated_at = now(),
                  sla_deadline = now() + CASE $3::text WHEN 'high' THEN INTERVAL '1 hour'
                                                      WHEN 'medium' THEN INTERVAL '4 hours'
                                                      ELSE INTERVAL '24 hours' END
            WHERE id = $1`,
          [leadId, staffId, priority]
        );
      if (reassignTo === 'auto') {
        const { rows: agents } = await client.query(
          `SELECT su.id, su.name, count(l.id)::int AS open_count
             FROM staff_users su
             LEFT JOIN leads_all l ON l.assigned_staff_id = su.id AND l.ticket_state = 'open' AND l.deleted_at IS NULL
            WHERE su.role = 'sales_agent' AND su.active = true AND su.id <> $1
            GROUP BY su.id, su.name, su.created_at
            ORDER BY su.created_at`,
          [id]
        );
        if (agents.length === 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'There is no other active sales agent to share the leads with — pick a person instead' });
        }
        // Round-robin by load: each lead goes to whoever has the fewest now.
        for (const lead of openLeads) {
          const next = agents.reduce((a, b) => (b.open_count < a.open_count ? b : a));
          await assign(lead.id, next.id, lead.priority_label);
          next.open_count += 1;
        }
        reassignedTo = 'auto';
      } else {
        const { rows: dest } = await client.query(
          'SELECT id, name, role, active FROM staff_users WHERE id = $1',
          [reassignTo]
        );
        const to = dest[0];
        if (!to || !to.active || !['sales_agent', ...ADMIN_ROLES].includes(to.role)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Leads can only go to an active sales agent or admin' });
        }
        for (const lead of openLeads) await assign(lead.id, to.id, lead.priority_label);
        reassignedTo = { id: to.id, name: to.name };
      }
    }

    // ── references with no ON DELETE rule: keep the record, drop the link ──
    const { rowCount: otherLeads } = await client.query(
      'UPDATE leads_all SET assigned_staff_id = NULL WHERE assigned_staff_id = $1', [id]
    );
    await client.query('UPDATE showroom_visits SET staff_id = NULL WHERE staff_id = $1', [id]);
    await client.query('UPDATE order_payments_all SET recorded_by = NULL WHERE recorded_by = $1', [id]);
    await client.query('UPDATE bulk_message_batches SET sent_by = NULL WHERE sent_by = $1', [id]);
    // Sessions have no foreign key; without this they would point at nobody.
    if (schemaFlags.staffSessions) await client.query('DELETE FROM staff_sessions WHERE staff_id = $1', [id]);

    const { rows: phones } = await client.query(
      'SELECT id FROM staff_devices WHERE staff_id = $1 AND revoked_at IS NULL', [id]
    );
    await client.query('DELETE FROM staff_users WHERE id = $1', [id]);
    await client.query('COMMIT');

    // Signed out everywhere, now: their phone's stream, and any open
    // dashboard (authenticate() already refuses the next request, since the
    // row is gone; this also stops live events reaching that browser).
    closeDeviceStreams((_, c) => c.staffId === id);
    for (const [sseRes, c] of sseClients) {
      if (c.staffId === id) {
        sseClients.delete(sseRes);
        try { sseRes.end(); } catch (_) { /* already closed */ }
      }
    }
    pairCodeLimiter.resetKey(pairCodeKey(id));
    await recordAuditEvent(req, 'staff.deleted', {
      staffId: id,
      name: target.name,
      deletedPhone: target.phone,
      role: target.role,
      openLeadsReassigned: openLeads.length,
      reassignedTo: reassignedTo === 'auto' ? 'auto' : reassignedTo?.id || null,
    });
    if (openLeads.length > 0) broadcastEvent('lead_update', { reassigned: openLeads.length });

    res.json({
      success: true,
      deleted: { id, name: target.name },
      openLeadsReassigned: openLeads.length,
      reassignedTo,
      otherLeadsUnlinked: otherLeads,
      phonesSignedOut: phones.length,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('DELETE /api/staff/:id failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── PATCH /api/staff/:id/password — Admin only ────────────────────────────────
// The user management page needs a way to reset a staff member's password
// (e.g. they forgot it, or it needs rotating) without going through the
// normal PATCH /api/staff/:id above, which only ever touches
// name/role/active — keeping password reset as its own explicit route rather
// than folding it into that allowlist.
app.patch('/api/staff/:id/password', requireRole('admin'), async (req, res) => {
  const { password } = req.body;
  const pwError = validatePassword(password);
  if (pwError) return res.status(400).json({ error: pwError });

  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid staff id' });

  try {
    // Resetting someone's password IS taking over their account, so a super
    // admin's may only be reset by a super admin.
    const { rows: found } = await pool.query('SELECT id, role FROM staff_users WHERE id = $1', [req.params.id]);
    if (found.length === 0) return res.status(404).json({ error: 'Staff user not found' });
    const refused = staffChangeRefusal(req, found[0]);
    if (refused) return res.status(refused[0]).json({ error: refused[1] });
    const password_hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query('UPDATE staff_users SET password_hash=$1 WHERE id=$2 RETURNING id', [password_hash, req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Staff user not found' });
    // A password is usually reset because it leaked. Every phone signed in as
    // this person — by password OR by QR — is signed out, and any sign-in code
    // not yet scanned is voided, so nothing obtained with the old password (or
    // with a session it opened) keeps working. Before this, a reset left the
    // phones signed in for up to 30 idle days.
    const staffId = rows[0].id;
    const { rows: revoked } = await pool.query(
      'UPDATE staff_devices SET revoked_at = now() WHERE staff_id = $1 AND revoked_at IS NULL RETURNING id',
      [staffId]
    );
    if (schemaFlags.pairCodes) {
      await pool.query('UPDATE device_pair_codes SET used_at = now() WHERE staff_id = $1 AND used_at IS NULL', [staffId]);
    }
    if (revoked.length > 0) closeDeviceStreams((id, c) => c.staffId === staffId);
    recordAuditEvent(req, 'staff.password_reset', { staffId, phonesSignedOut: revoked.length });
    res.json({ success: true, phonesSignedOut: revoked.length });
  } catch (err) {
    console.error('PATCH /api/staff/:id/password failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/performance — staff performance dashboard (Section 7.4) ────────
// Sales Agent sees only their own row (REQ-4.10); Admin/Viewer see every sales
// agent, ranked by overdue count then conversion rate (REQ-4.9).
app.get('/api/performance', requireRole('admin', 'viewer', 'sales_agent'), async (req, res) => {
  try {
    if (req.staff.role === 'sales_agent') {
      const { rows } = await pool.query('SELECT * FROM v_staff_performance WHERE staff_id=$1', [req.staff.id]);
      return res.json({ performance: rows });
    }
    const { rows } = await pool.query('SELECT * FROM v_staff_performance ORDER BY overdue_count DESC, conversion_pct DESC');
    res.json({ performance: rows });
  } catch (err) {
    console.error('GET /api/performance failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET/PATCH /api/settings/auto-assign (Phase 15.3, admin only) ────────────
// A global on/off switch for round-robin lead assignment — checked by
// handle_new_lead_assignment before assigning a new ticket.
app.get('/api/settings/auto-assign', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT value FROM app_settings WHERE key='auto_assign_enabled'");
    res.json({ enabled: rows[0]?.value !== 'false' });
  } catch (err) {
    console.error('GET /api/settings/auto-assign failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/settings/auto-assign', requireRole('admin'), async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) is required' });

  try {
    await pool.query(
      "INSERT INTO app_settings (key, value) VALUES ('auto_assign_enabled', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
      [String(enabled)]
    );
    res.json({ success: true, enabled });
  } catch (err) {
    console.error('PATCH /api/settings/auto-assign failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET/PATCH /api/settings/callback-threshold (migration 043, admin only) ───
// The "more than N seconds" bar an outgoing call must clear to count as a real
// callback. Read live by v_missed_call_callbacks on every query, so changing it
// re-evaluates every number's status immediately — there is nothing to rebuild.
app.get('/api/settings/callback-threshold', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT value FROM app_settings WHERE key='callback_min_seconds'");
    // Same defaulting as the view's own coercion, so the number the admin sees
    // can never disagree with the number the view actually applied.
    const parsed = parseInt(rows[0]?.value, 10);
    res.json({ seconds: Number.isInteger(parsed) && parsed >= 0 ? parsed : 15 });
  } catch (err) {
    console.error('GET /api/settings/callback-threshold failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/settings/callback-threshold', requireRole('admin'), async (req, res) => {
  const { seconds } = req.body;
  // The view coerces junk to the default rather than erroring, but a value
  // stored here is one an admin will later read back and trust — so reject it
  // at the door instead of silently ignoring it later. 3600 is a sanity
  // ceiling: no real callback threshold is an hour.
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600) {
    return res.status(400).json({ error: 'seconds (integer 0-3600) is required' });
  }

  try {
    await pool.query(
      "INSERT INTO app_settings (key, value) VALUES ('callback_min_seconds', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
      [String(seconds)]
    );
    res.json({ success: true, seconds });
  } catch (err) {
    console.error('PATCH /api/settings/callback-threshold failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET/PATCH /api/settings/promo (migration 018, admin only) ───────────────
// One fixed promo image+caption, read by runFollowUpScheduler on every tick.
// promo_image_url must be a real public URL (Twilio/Meta fetch media from
// it server-side) — confirmed with the user: pasting an already-hosted
// image URL, not uploading a file through this backend.
app.get('/api/settings/promo', requireRole('admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT key, value FROM app_settings WHERE key IN ('promo_image_url', 'promo_caption')");
    const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    res.json({ imageUrl: settings.promo_image_url || '', caption: settings.promo_caption || '' });
  } catch (err) {
    console.error('GET /api/settings/promo failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/settings/promo', requireRole('admin'), async (req, res) => {
  const { imageUrl, caption } = req.body;
  if (imageUrl === undefined && caption === undefined) return res.status(400).json({ error: 'imageUrl and/or caption required' });

  try {
    if (imageUrl !== undefined) {
      await pool.query("INSERT INTO app_settings (key, value) VALUES ('promo_image_url', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [
        imageUrl,
      ]);
    }
    if (caption !== undefined) {
      await pool.query("INSERT INTO app_settings (key, value) VALUES ('promo_caption', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [
        caption,
      ]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('PATCH /api/settings/promo failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/events — SSE stream ──────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  sseClients.set(res, { staffId: req.staff?.id, role: req.staff?.role });

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (_) {
      clearInterval(ping);
    }
  }, 25000);

  req.on('close', () => {
    sseClients.delete(res);
    clearInterval(ping);
  });
});

// Rate-limited per IP as a floor against flooding/abuse hitting these
// endpoints directly — generous enough for real Twilio/Meta/Dialog traffic,
// which arrives from a small, known set of provider IPs, not end users.
// Meta signs every webhook delivery with an HMAC-SHA256 of the raw body,
// keyed on the app secret. Without checking it, POST /webhook accepts any
// unauthenticated POST and feeds it straight into processIncomingMessage —
// which creates customers, inserts messages, and calls the PAID Claude API.
//
// Fails CLOSED when META_APP_SECRET is set. When it is NOT set the request is
// rejected too, with an explicit log naming the missing variable: the Meta
// channel is unconfigured in this deployment (WHATSAPP_TOKEN is still a
// placeholder — see CLAUDE.md), so refusing is correct and costs nothing,
// whereas accepting unsigned traffic is exactly the vulnerability. Twilio is
// the live channel and has its own signature check on its own route.
function verifyMetaSignature(req) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return { ok: false, reason: 'META_APP_SECRET is not set — refusing unsigned Meta webhook' };

  const header = req.get('X-Hub-Signature-256');
  if (!header) return { ok: false, reason: 'missing X-Hub-Signature-256' };
  if (!req.rawBody) return { ok: false, reason: 'raw body unavailable' };

  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, so compare lengths first.
  if (a.length !== b.length) return { ok: false, reason: 'signature length mismatch' };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'signature mismatch' };
  return { ok: true };
}

const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

// ── GET /webhook — Meta webhook verification ──────────────────────────────────
app.get('/webhook', webhookLimiter, (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('Webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ── shared inbound handler (used by both Meta and Twilio webhooks) ───────────
async function processIncomingMessage({ from, text, whatsappMessageId, channel }) {
  if (!from || !text) return;

  console.log(`\n--- [${channel}] Message from ${from} ---`);
  console.log(`Customer: "${text}"`);

  // 1. Find or create customer
  const { customer, created } = await findOrCreateCustomerByPhone(from, channel);
  if (created) console.log('New customer created:', customer.id);

  const customerId = customer.id;
  const aiEnabled = customer.ai_enabled !== false;

  // 2. Save inbound message
  await pool.query('INSERT INTO messages (customer_id, direction, content, whatsapp_message_id) VALUES ($1, $2, $3, $4)', [
    customerId,
    'inbound',
    text,
    whatsappMessageId,
  ]);
  broadcastEvent('message_insert', { customer_id: customerId });

  if (!aiEnabled) {
    console.log(`AI disabled for ${from} — message saved, awaiting human reply`);
    return;
  }

  // 3. Fetch last 10 messages as conversation history
  const { rows: history } = await pool.query(
    'SELECT direction, content FROM messages WHERE customer_id=$1 ORDER BY received_at DESC LIMIT 10',
    [customerId]
  );

  const conversationMessages = history.reverse().map((m) => ({
    role: m.direction === 'inbound' ? 'user' : 'assistant',
    content: m.content,
  }));

  // Show typing while Claude thinks (Twilio only, best-effort, REQ-6.4)
  await sendTypingIndicator(customer, whatsappMessageId);

  // 4. Call Claude with retry
  let aiResult;
  try {
    aiResult = await callClaudeWithRetry(conversationMessages, customer);
  } catch (aiError) {
    console.error('Claude API error:', aiError.message);
    return;
  }

  // 4a. Escalation (REQ-6.8/6.9/6.11) — fixed bridge message, not AI text;
  // priority set directly rather than waiting on analyzeConversation's own
  // scoring, which has no "asked for a human" signal and could undercut it.
  if (aiResult.type === 'escalate') {
    console.log(`Escalating to human: ${aiResult.reason} (urgency: ${aiResult.urgency})`);

    await pool.query(
      `UPDATE customers SET ai_enabled=false, priority_score=3, priority_label='high', priority_updated_at=NOW() WHERE id=$1`,
      [customerId]
    );
    broadcastEvent('customer_update', { id: customerId });

    let bridgeSent = false;
    try {
      await sendWhatsAppMessage(customer, ESCALATION_BRIDGE_MESSAGE);
      bridgeSent = true;
    } catch (waError) {
      console.error(`WhatsApp send FAILED (escalation bridge) for ${customer.whatsapp_number}:`, waError.message);
    }

    await pool.query('INSERT INTO messages (customer_id, direction, content, sender_type, delivery_failed) VALUES ($1, $2, $3, $4, $5)', [
      customerId,
      'outbound',
      ESCALATION_BRIDGE_MESSAGE,
      'ai',
      !bridgeSent,
    ]);
    broadcastEvent('message_insert', { customer_id: customerId });
    if (bridgeSent) console.log('Escalation bridge message delivered.');
    return; // no analyzeConversation this turn — nothing new to score, priority already set
  }

  const aiReply = aiResult.text;
  console.log(`AI reply: "${aiReply}"`);

  // 5. Format for WhatsApp and send as ONE message — no chunking/pacing.
  // (Previously split into paragraph/sentence chunks with paced delays,
  // REQ-6.1/6.2/6.3; removed per explicit user feedback — a multi-product
  // catalog reply arriving as 4 separate bubbles read as fragmented, not
  // "natural." One complete message every time now.)
  const formatted = markdownToWhatsApp(aiReply);
  let sent = false;
  try {
    await sendWhatsAppMessage(customer, formatted);
    sent = true;
  } catch (waError) {
    console.error(`WhatsApp send FAILED for ${customer.whatsapp_number}:`, waError.message);
  }

  await pool.query('INSERT INTO messages (customer_id, direction, content, sender_type, delivery_failed) VALUES ($1, $2, $3, $4, $5)', [
    customerId,
    'outbound',
    formatted,
    'ai',
    !sent,
  ]);
  broadcastEvent('message_insert', { customer_id: customerId });

  if (sent) console.log('Delivered reply to WhatsApp.');
  else console.error(`WhatsApp delivery FAILED for ${customer.whatsapp_number}.`);

  // 7. Analyze conversation in background
  analyzeConversation(customerId, conversationMessages);
}

// ── POST /webhook — receive incoming WhatsApp messages (Meta Cloud API) ──────
app.post('/webhook', webhookLimiter, async (req, res) => {
  const sig = verifyMetaSignature(req);
  if (!sig.ok) {
    console.error(`Rejected Meta webhook: ${sig.reason}`);
    return res.sendStatus(403);
  }

  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const messages = body.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages || messages.length === 0) return;

    for (const message of messages) {
      if (message.type !== 'text') continue;

      await processIncomingMessage({
        from: message.from,
        text: message.text?.body,
        whatsappMessageId: message.id,
        channel: 'meta',
      });
    }
  } catch (err) {
    console.error('Unexpected error:', err);
  }
});

// ── POST /webhook/twilio — receive incoming WhatsApp Sandbox messages ────────
app.post('/webhook/twilio', webhookLimiter, async (req, res) => {
  // The disable switch is honoured ONLY outside production, so a stray
  // TWILIO_VALIDATE_SIGNATURE=false in a production environment cannot turn
  // signature checking off. Tests set NODE_ENV=test and use the switch.
  const skipSignature = process.env.TWILIO_VALIDATE_SIGNATURE === 'false' && process.env.NODE_ENV !== 'production';
  if (!skipSignature) {
    const signature = req.get('X-Twilio-Signature');
    const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const valid = signature && twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, fullUrl, req.body);
    if (!valid) {
      console.error('Invalid Twilio signature — rejecting webhook');
      return res.sendStatus(403);
    }
  }

  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');

  try {
    const from = req.body.From?.replace('whatsapp:+', '');
    const text = req.body.Body;
    const whatsappMessageId = req.body.MessageSid;

    await processIncomingMessage({ from, text, whatsappMessageId, channel: 'twilio' });
  } catch (err) {
    console.error('Unexpected error (Twilio webhook):', err);
  }
});

app.post('/api/summary', requireRole('admin', 'sales_agent'), async (req, res) => {
  const { customerId } = req.body;
  if (!customerId) return res.status(400).json({ error: 'customerId is required' });

  const { rows: messages, rowCount } = await pool.query(
    'SELECT direction, content, received_at FROM messages WHERE customer_id=$1 ORDER BY received_at ASC',
    [customerId]
  );

  if (rowCount === 0) return res.json({ summary: 'No messages found for this customer.' });

  const transcript = messages.map((m) => `${m.direction === 'inbound' ? 'Customer' : 'AI'}: ${m.content}`).join('\n');

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: 'You are a helpful assistant that summarizes WhatsApp sales conversations for managers. Be concise, clear, and structured.',
      messages: [
        {
          role: 'user',
          content: `Summarize this customer conversation so the manager can reply quickly without reading everything.\n\nConversation:\n${transcript}\n\nProvide a short structured summary with these sections:\n👤 Customer: name if given\n🛍️ Looking for: what product or service\n💰 Budget: if mentioned\n📋 Requirements: any specific needs\n📍 Stage: where in the conversation they are\n✅ Suggested next step for manager`,
        },
      ],
    });
    res.json({ summary: response.content[0].text });
  } catch (err) {
    console.error('Summary error:', err.message);
    res.status(500).json({ error: 'Failed to generate summary' });
  }
});

app.post('/api/send-message', requireRole('admin', 'sales_agent'), async (req, res) => {
  const { customerId, message } = req.body;
  if (!customerId || !message?.trim()) {
    return res.status(400).json({ error: 'customerId and message are required' });
  }

  const { rows } = await pool.query('SELECT whatsapp_number, contact_whatsapp_number, channel FROM customers WHERE id=$1', [customerId]);
  if (rows.length === 0) return res.status(404).json({ error: 'Customer not found' });

  const customer = rows[0];

  let waSent = false;
  try {
    await sendWhatsAppMessage(customer, message.trim());
    waSent = true;
    console.log(`Manual message delivered to ${customer.whatsapp_number}`);
  } catch (err) {
    console.error(`WhatsApp send FAILED for ${customer.whatsapp_number}:`, err.message);
  }

  await pool.query('INSERT INTO messages (customer_id, direction, content, sender_type, delivery_failed) VALUES ($1, $2, $3, $4, $5)', [
    customerId,
    'outbound',
    message.trim(),
    'staff',
    !waSent,
  ]);
  broadcastEvent('message_insert', { customer_id: customerId });

  await pool.query('UPDATE customers SET ai_enabled=false WHERE id=$1', [customerId]);
  broadcastEvent('customer_update', { id: customerId });

  console.log(`AI disabled for customer ${customerId} — human agent took over`);
  res.json({ success: true, waSent });
});

// ── POST /api/bulk-messages/send — Admin only ─────────────────────────────────
// Direct staff-initiated bulk send to a hand-picked set of leads' customers
// (filtered client-side on the new Bulk Messages page by priority/product/
// source — all live on `leads`, not `customers`). Deliberately NOT the
// campaigns/consent_for_marketing path (Phase 7) — that system is for
// scheduled, segment-based marketing sends; this is the same authority level
// as the existing single POST /api/send-message (admin/sales_agent, no
// consent gate), just fanned out to many customers at once, restricted to
// admin only per the user's explicit ask. imageUrl is optional and, like the
// existing follow-up promo image (migration 018), must be a real publicly
// reachable URL — this backend has no file-serving of any kind, Twilio
// fetches media from the URL itself rather than accepting an upload.
app.post('/api/bulk-messages/send', requireRole('admin'), async (req, res) => {
  const { customerIds, message, imageUrl } = req.body;
  if (!Array.isArray(customerIds) || customerIds.length === 0) {
    return res.status(400).json({ error: 'customerIds must be a non-empty array' });
  }
  if (!message?.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  try {
    // Pull reachability alongside the customer: WhatsApp only accepts a
    // free-form (non-template) message within 24h of the customer's OWN last
    // inbound message. Outside it, Twilio ACCEPTS the API call and WhatsApp
    // discards it asynchronously with error 63016 — verified directly against
    // Twilio, whose record showed status=undelivered/63016 for a send this
    // codebase saw succeed. A try/catch therefore cannot detect it; the only
    // honest signal available at send time is the window itself.
    const { rows: customers } = schemaFlags.reachabilityView
      ? await pool.query(
          `
          SELECT c.id, c.whatsapp_number, c.contact_whatsapp_number, c.channel,
                 r.reachable_freeform, r.reachability_note
          FROM customers c
          LEFT JOIN v_customer_reachability r ON r.customer_id = c.id
          WHERE c.id = ANY($1::uuid[])
        `,
          [customerIds]
        )
      : // Pre-029 schema: no reachability data, so reachable_freeform stays
        // undefined and the window checks below treat it as "unknown" rather
        // than "outside" — the send behaves exactly as it did before 029.
        await pool.query('SELECT id, whatsapp_number, contact_whatsapp_number, channel FROM customers WHERE id = ANY($1::uuid[])', [
          customerIds,
        ]);

    const results = [];
    for (const customer of customers) {
      let waSent = false;
      let failure = null;
      try {
        if (imageUrl?.trim()) {
          await sendWhatsAppImage(customer, imageUrl.trim(), message.trim());
        } else {
          await sendWhatsAppMessage(customer, message.trim());
        }
        waSent = true;
      } catch (err) {
        failure = describeSendFailure(err);
        console.error(`Bulk message FAILED for ${customer.whatsapp_number} [${failure.code || 'no code'}]:`, failure.reason);
      }

      // Recorded as failed when Twilio rejected it OR when it was accepted
      // outside the 24h window (WhatsApp will drop it), so the chat bubble
      // tells staff the truth rather than showing a delivered-looking message.
      const outside = customer.reachable_freeform === false;
      const rowFailed = !waSent || outside;
      const rowCode = failure?.code || (outside ? '63016' : null);
      const rowReason =
        failure?.reason ||
        (outside
          ? `WhatsApp will not deliver this — ${customer.reachability_note}. A pre-approved template is required outside the 24-hour window.`
          : null);
      // Falls back to the pre-029 column set when that migration hasn't been
      // applied, so a bulk send still works (just without the stored reason).
      if (schemaFlags.messageFailureReason) {
        await pool.query(
          `INSERT INTO messages (customer_id, direction, content, sender_type, delivery_failed, failure_code, failure_reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [customer.id, 'outbound', message.trim(), 'staff', rowFailed, rowCode, rowReason]
        );
      } else {
        await pool.query(
          `INSERT INTO messages (customer_id, direction, content, sender_type, delivery_failed)
           VALUES ($1,$2,$3,$4,$5)`,
          [customer.id, 'outbound', message.trim(), 'staff', rowFailed]
        );
      }
      await pool.query('UPDATE customers SET ai_enabled=false WHERE id=$1', [customer.id]);
      broadcastEvent('message_insert', { customer_id: customer.id });
      broadcastEvent('customer_update', { id: customer.id });

      // `sent` means "Twilio accepted it", which is NOT the same as
      // delivered. `likelyDelivered` is the honest answer, because a send
      // outside the 24h window is accepted and then dropped by WhatsApp.
      const outsideWindow = customer.reachable_freeform === false;
      results.push({
        customerId: customer.id,
        phone: whatsappTarget(customer),
        sent: waSent,
        likelyDelivered: waSent && !outsideWindow,
        failureCode: failure?.code || (waSent && outsideWindow ? '63016' : null),
        failureReason:
          failure?.reason ||
          (waSent && outsideWindow ? `Accepted by Twilio but WhatsApp will discard it — ${customer.reachability_note}` : null),
      });
    }

    // Count what will actually arrive, not what Twilio accepted.
    const sentCount = results.filter((r) => r.likelyDelivered).length;
    const blockedByWindow = results.filter((r) => r.sent && !r.likelyDelivered).length;
    const { rows: batchRows } = await pool.query(
      `INSERT INTO bulk_message_batches (sent_by, message, image_url, sent_count, total_count)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
      [req.staff.id, message.trim(), imageUrl?.trim() || null, sentCount, results.length]
    );
    const batch = batchRows[0];
    for (const r of results) {
      await pool.query('INSERT INTO bulk_message_recipients (batch_id, customer_id, sent) VALUES ($1,$2,$3)', [
        batch.id,
        r.customerId,
        r.sent,
      ]);
    }

    console.log(`Bulk message: sent ${sentCount}/${results.length}`);
    res.json({
      success: true,
      batchId: batch.id,
      sentCount,
      totalCount: results.length,
      blockedByWindow,
      note:
        blockedByWindow > 0
          ? `${blockedByWindow} recipient(s) have not messaged in 24 hours — WhatsApp accepts only pre-approved templates for them, so those messages will not arrive.`
          : null,
      results,
    });
  } catch (err) {
    console.error('POST /api/bulk-messages/send failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/bulk-messages/history — Admin only ───────────────────────────────
// Past bulk sends for the new history tab: one row per batch (who sent it,
// when, the message/image, sent/total counts) plus its recipient list (name,
// phone, sent status) so staff can see exactly who got a given send.
// ── GET /api/bulk-messages/reachability ───────────────────────────────────────
// Who can actually receive a free-form WhatsApp message right now. Lets the
// Bulk Messages page warn BEFORE a send instead of reporting failures after:
// WhatsApp only accepts non-template text within 24h of the customer's own
// last inbound message, so a broadcast to a quiet list is mostly discarded.
app.get('/api/bulk-messages/reachability', requireRole('admin'), async (req, res) => {
  try {
    if (!schemaFlags.reachabilityView) {
      return res.status(503).json({
        error: 'Reachability data is unavailable — migrations/029_message_failure_reason.sql has not been applied to this database.',
      });
    }
    const { rows } = await pool.query(`
      SELECT customer_id, whatsapp_number, name, reachable_freeform,
             reachability_note, last_inbound_at
      FROM v_customer_reachability
    `);
    const reachable = rows.filter((r) => r.reachable_freeform).length;
    res.json({
      customers: rows,
      reachableCount: reachable,
      totalCount: rows.length,
    });
  } catch (err) {
    console.error('GET /api/bulk-messages/reachability failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/bulk-messages/history', requireRole('admin'), async (req, res) => {
  try {
    const { rows: batches } = await pool.query(`
      SELECT b.id, b.message, b.image_url, b.sent_count, b.total_count, b.created_at,
             su.name AS sent_by_name
      FROM bulk_message_batches b
      LEFT JOIN staff_users su ON su.id = b.sent_by
      ORDER BY b.created_at DESC
      LIMIT 200
    `);

    const { rows: recipients } = await pool.query(
      `
      SELECT r.batch_id, r.customer_id, r.sent, c.name AS customer_name, c.whatsapp_number
      FROM bulk_message_recipients r
      JOIN customers c ON c.id = r.customer_id
      WHERE r.batch_id = ANY($1::uuid[])
    `,
      [batches.map((b) => b.id)]
    );

    const byBatch = {};
    for (const r of recipients) (byBatch[r.batch_id] ??= []).push(r);

    res.json({ batches: batches.map((b) => ({ ...b, recipients: byBatch[b.id] || [] })) });
  } catch (err) {
    console.error('GET /api/bulk-messages/history failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/toggle-ai', requireRole('admin', 'sales_agent'), async (req, res) => {
  const { customerId, enabled } = req.body;
  if (!customerId || typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'customerId and enabled (boolean) required' });
  }

  const { rowCount } = await pool.query('UPDATE customers SET ai_enabled=$1 WHERE id=$2', [enabled, customerId]);

  if (rowCount === 0) return res.status(404).json({ error: 'Customer not found' });

  broadcastEvent('customer_update', { id: customerId });
  console.log(`AI ${enabled ? 'enabled' : 'disabled'} for customer ${customerId}`);
  res.json({ success: true, ai_enabled: enabled });
});

// ── GET /api/customers ────────────────────────────────────────────────────────
// ?search= matches name or whatsapp_number (case-insensitive, partial) — used
// by the showroom order flow to look up a walk-in customer by phone/name
// before deciding whether to create a new one.
// Gated to the roles that actually need customer lookup: admin/viewer for
// oversight, sales_agent for the order flows that search by phone or name.
// delivery_coordinator and inventory_manager are excluded — this returns the
// whole customer table (names, both phone numbers, lifetime value, marketing
// consent) and neither role has a reason to read it.
app.get('/api/customers', requireRole('admin', 'viewer', 'sales_agent'), async (req, res) => {
  try {
    const { search } = req.query;
    // Clamped so a caller cannot ask for the whole table (or a negative
    // offset) by passing ?limit=999999.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
    const offset = Math.min(Math.max(parseInt(req.query.offset, 10) || 0, 0), 100000);
    // Search by name OR number. The number term is also matched in canonical
    // form, so typing '0771234567' or '771234567' finds 94771234567 — staff
    // should not have to know the stored format.
    const canonTerm = search ? normalizePhone(search) : '';
    const query = search
      ? {
          text: `SELECT * FROM customers
                  WHERE name ILIKE $1 OR whatsapp_number ILIKE $1 OR whatsapp_number ILIKE $2
                  ORDER BY created_at DESC LIMIT 20`,
          values: [`%${search}%`, `%${canonTerm}%`],
        }
      : {
          // Bounded: this used to return every row. The dashboard's own
          // directory page uses GET /api/customers-directory; this route
          // backs type-ahead lookups, which never need more than a page.
          text: 'SELECT * FROM customers ORDER BY created_at DESC LIMIT $1 OFFSET $2',
          values: [limit, offset],
        };
    const { rows } = await pool.query(query);
    res.json({ customers: rows });
  } catch (err) {
    console.error('GET /api/customers failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/customers-directory ──────────────────────────────────────────────
// Full customer directory for the Customers page — one row per customer with
// their most recent lead's product_type (their latest expressed interest)
// and delivery address, falling back to their most recent order's
// delivery_address if the lead itself has none (e.g. a showroom order placed
// with no prior ticket). channel is customers.channel directly (meta/twilio/
// call/showroom — see CLAUDE.md: there is no real Facebook channel anywhere
// in this codebase, a leads.source='Facebook' value is a historical
// misnomer for WhatsApp-originated leads, not shown here since it isn't a
// real channel value). DISTINCT ON + ORDER BY created_at DESC picks the
// latest lead per customer in one pass rather than a correlated subquery.
app.get('/api/customers-directory', requireRole('admin', 'viewer', 'sales_agent'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      WITH latest_lead AS (
        SELECT DISTINCT ON (customer_id) customer_id, product_type, delivery_address
        FROM leads
        ORDER BY customer_id, created_at DESC
      ),
      latest_order AS (
        SELECT DISTINCT ON (customer_id) customer_id, delivery_address
        FROM orders
        WHERE delivery_address IS NOT NULL
        ORDER BY customer_id, created_at DESC
      )
      SELECT
        c.id, c.name, c.whatsapp_number, c.channel, c.created_at,
        c.is_loyalty_customer, c.total_orders_count, c.lifetime_value, c.priority_label,
        ll.product_type AS interested_in,
        COALESCE(ll.delivery_address, lo.delivery_address) AS address
      FROM customers c
      LEFT JOIN latest_lead ll ON ll.customer_id = c.id
      LEFT JOIN latest_order lo ON lo.customer_id = c.id
      ORDER BY c.created_at DESC
    `);
    res.json({ customers: rows });
  } catch (err) {
    console.error('GET /api/customers-directory failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/customers ───────────────────────────────────────────────────────
// Find-or-create by phone — the only way a customers row gets created outside
// an inbound WhatsApp message or a missed-call webhook. Backs the showroom
// order flow: staff placing a walk-in order need a customerId before
// POST /api/orders will accept it (orders.customer_id is NOT NULL).
app.post('/api/customers', requireRole('admin', 'sales_agent'), async (req, res) => {
  const { phone, name } = req.body;
  if (!phone || !phone.trim()) return res.status(400).json({ error: 'phone is required' });
  // Staff type '0771234567' or '+94 77 123 4567'; both must resolve to the
  // SAME customer as the WhatsApp identity 94771234567.
  const whatsappNumber = normalizePhone(phone);

  try {
    const { rows: existing } = await pool.query('SELECT * FROM customers WHERE whatsapp_number=$1', [whatsappNumber]);
    if (existing.length > 0) {
      let customer = existing[0];
      if (name && name.trim() && !customer.name) {
        const { rows } = await pool.query('UPDATE customers SET name=$1 WHERE id=$2 RETURNING *', [name.trim(), customer.id]);
        customer = rows[0];
      }
      return res.json({ success: true, customer, created: false });
    }

    const { rows } = await pool.query('INSERT INTO customers (whatsapp_number, name, channel) VALUES ($1,$2,$3) RETURNING *', [
      whatsappNumber,
      name?.trim() || null,
      'showroom',
    ]);
    broadcastEvent('customer_update', { id: rows[0].id });
    res.json({ success: true, customer: rows[0], created: true });
  } catch (err) {
    console.error('POST /api/customers failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/showroom-visits (Phase 14) — quick-entry log for a walk-in ─────
// customer, distinct from a showroom ORDER (POST /api/orders). Goes through
// the exact same findOrCreateCustomerByPhone/getOrCreateOpenTicket helpers the
// WhatsApp and Dialog webhooks use, source='showroom' — so a showroom visit
// gets the same round-robin assignment + SLA clock as any other new ticket,
// and feeds v_customer_engagement for the new campaign segments.
app.post('/api/showroom-visits', requireRole('admin', 'sales_agent'), async (req, res) => {
  const { phone, showroomLocation, productsShown, outcome, notes } = req.body;
  const OUTCOMES = ['browsing', 'interested', 'ordered', 'not_interested'];

  if (!phone || !phone.trim()) return res.status(400).json({ error: 'phone is required' });
  if (!showroomLocation || !showroomLocation.trim()) return res.status(400).json({ error: 'showroomLocation is required' });
  if (!OUTCOMES.includes(outcome)) return res.status(400).json({ error: `outcome must be one of: ${OUTCOMES.join(', ')}` });

  const phoneTrimmed = phone.trim();

  try {
    const { customer } = await findOrCreateCustomerByPhone(phoneTrimmed, 'showroom');
    await getOrCreateOpenTicket(customer.id, { source: 'showroom' });

    const { rows } = await pool.query(
      `INSERT INTO showroom_visits (customer_id, phone, showroom_location, products_shown, outcome, staff_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [customer.id, phoneTrimmed, showroomLocation.trim(), productsShown || null, outcome, req.staff.id, notes || null]
    );

    broadcastEvent('customer_update', { id: customer.id });
    broadcastEvent('lead_update', { customer_id: customer.id });
    res.json({ success: true, visit: rows[0], customer });
  } catch (err) {
    console.error('POST /api/showroom-visits failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/showroom-visits (Phase 14) — recent visits, for the log-visit UI
app.get('/api/showroom-visits', requireRole('admin', 'sales_agent', 'viewer'), async (req, res) => {
  const { customerId } = req.query;
  try {
    const query = customerId
      ? { text: 'SELECT * FROM showroom_visits WHERE customer_id=$1 ORDER BY visited_at DESC', values: [customerId] }
      : { text: 'SELECT * FROM showroom_visits ORDER BY visited_at DESC LIMIT 100' };
    const { rows } = await pool.query(query);
    res.json({ visits: rows });
  } catch (err) {
    console.error('GET /api/showroom-visits failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Same gate as GET /api/messages: this route returns the customer's FULL
// WhatsApp transcript alongside the record, so leaving it ungated let any
// role read chat history that /api/messages deliberately withholds from
// delivery_coordinator.
// ── GET /api/customers/:id — the Customer 360 ────────────────────────────────
// One request behind the customer screen, because these panels are always shown
// together and six sequential round trips per page is the difference between a
// snappy screen and a slow one. Everything here answers "who is this person and
// what has happened with them": order history, warranty cover, which staff have
// handled them, their call log, and every past enquiry — not just the open one.
app.get('/api/customers/:id', requireRole(...PIPELINE_READ_ROLES), async (req, res) => {
  const id = req.params.id;
  try {
    // A sales agent sees only their own orders and calls here too (058) —
    // the same scope as GET /api/orders and GET /api/calls, or this page
    // would be a side door around both.
    const orderParams = [id];
    const orderScope = orderVisibilityFilter(req, orderParams);
    const leadParams = [id];
    const leadOrderScope = orderVisibilityFilter(req, leadParams);
    // ...and the enquiry list hides other agents' call leads, the same rule as
    // the Pipeline (callVisibilityFilter) — otherwise this page shows the
    // notes and history of leads the Pipeline deliberately hides.
    const leadVisibility = callVisibilityFilter(req, leadParams);
    const callParams = [id];
    const callWhere = isUnrestricted(req)
      ? ''
      : staffScopeWhere(req, 'staff_id', callParams, schemaFlags.callEventStaff);
    const [cust, msgs, leads, orders, warranties, tickets, calls, visits] = await Promise.all([
      pool.query('SELECT * FROM customers WHERE id=$1', [id]),
      pool.query(
        `SELECT id, direction, content, received_at, delivery_failed${schemaFlags.messageFailureReason ? ', failure_code, failure_reason' : ''}
           FROM messages WHERE customer_id=$1 ORDER BY received_at ASC`,
        [id]
      ),
      // EVERY enquiry, open and closed, newest first — the closed ones are the
      // history the user asked for. The assignee is joined here so the screen
      // can show who handled each one without a second lookup.
      // The converted-order link is scoped like the orders list below, so a
      // sales agent is not shown other agents' order numbers here (058).
      pool.query(
        `SELECT l.*, s.name AS assigned_staff_name, s.role AS assigned_staff_role,
                o.id AS converted_order_id, o.order_number AS converted_order_number
           FROM leads l
           LEFT JOIN staff_users s ON s.id = l.assigned_staff_id
           LEFT JOIN orders o ON o.lead_id = l.id${leadOrderScope}
          WHERE l.customer_id = $1${leadVisibility}
          ORDER BY l.created_at DESC`,
        leadParams
      ),
      // Orders carry their payment summary so the screen can show what is still
      // owed without a per-order request.
      pool.query(
        // paid_to_date takes the GREATER of the ledger and orders.amount_paid.
        // The ledger (migration 028) is the source of truth for anything paid
        // since it existed, but orders delivered before that carry their money
        // only in amount_paid and have no ledger rows at all — reading the
        // ledger alone reported a fully-paid order as owing its whole total.
        // Real case: ORD-01024 sits at payment_status='paid' with no ledger.
        `SELECT o.*,
                GREATEST(COALESCE(p.paid, 0), COALESCE(o.amount_paid, 0)) AS paid_to_date,
                GREATEST(o.total_amount - GREATEST(COALESCE(p.paid, 0), COALESCE(o.amount_paid, 0)), 0) AS balance_due
           FROM orders o
           LEFT JOIN (
             SELECT order_id, SUM(CASE WHEN kind = 'refund' THEN -amount ELSE amount END) AS paid
               FROM order_payments GROUP BY order_id
           ) p ON p.order_id = o.id
          WHERE o.customer_id = $1${orderScope}
          ORDER BY o.created_at DESC`,
        orderParams
      ),
      // effective_status is computed live by v_warranty_status (Phase 10):
      // active/expired/voided, rather than a stored value that silently goes stale.
      pool.query(
        `SELECT w.*, v.effective_status
           FROM warranties w
           LEFT JOIN v_warranty_status v ON v.id = w.id
          WHERE w.customer_id = $1
          ORDER BY w.end_date DESC`,
        [id]
      ),
      pool.query('SELECT * FROM service_tickets WHERE customer_id=$1 ORDER BY created_at DESC', [id]),
      pool.query(
        `SELECT * FROM call_events WHERE customer_id=$1${callWhere ? ` AND ${callWhere}` : ''}
          ORDER BY occurred_at DESC LIMIT 100`,
        callParams
      ),
      pool.query(
        `SELECT sv.*, s.name AS staff_name
           FROM showroom_visits sv
           LEFT JOIN staff_users s ON s.id = sv.staff_id
          WHERE sv.customer_id = $1 ORDER BY sv.visited_at DESC`,
        [id]
      ),
    ]);

    if (cust.rows.length === 0) return res.status(404).json({ error: 'Customer not found' });

    const orderRows = orders.rows;
    // customers.lifetime_value only moves on delivered+paid, so it reads 0.00
    // for a customer with real but undelivered orders. Showing that alone would
    // be misleading, so the real ordered total is sent alongside it and the UI
    // can label each honestly.
    const totalOrdered = orderRows.reduce((sum, o) => sum + (Number(o.total_amount) || 0), 0);
    const totalPaid = orderRows.reduce((sum, o) => sum + (Number(o.paid_to_date) || 0), 0);

    // Who has actually handled this customer, across every enquiry they have
    // had — the "handled team member" the user asked for, which is per-ticket
    // rather than a single owner on the customer record.
    const handledBy = [];
    for (const l of leads.rows) {
      if (!l.assigned_staff_id) continue;
      const seen = handledBy.find(h => h.id === l.assigned_staff_id);
      if (seen) { seen.tickets += 1; continue; }
      handledBy.push({
        id: l.assigned_staff_id,
        name: l.assigned_staff_name,
        role: l.assigned_staff_role,
        tickets: 1,
      });
    }

    res.json({
      customer: cust.rows[0],
      messages: msgs.rows,
      // The one currently-open enquiry, if any. Kept as `lead` because the
      // existing chat screen already reads that key.
      lead: leads.rows.find(l => l.ticket_state === 'open') || null,
      leads: leads.rows,
      orders: orderRows,
      warranties: warranties.rows,
      serviceTickets: tickets.rows,
      calls: calls.rows,
      showroomVisits: visits.rows,
      handledBy,
      stats: {
        orderCount: orderRows.length,
        totalOrdered,
        totalPaid,
        balanceDue: Math.max(totalOrdered - totalPaid, 0),
        // The stored loyalty figure, sent as-is and labelled separately in the
        // UI so it is never confused with totalOrdered above.
        lifetimeValue: Number(cust.rows[0].lifetime_value) || 0,
        enquiryCount: leads.rows.length,
        openEnquiries: leads.rows.filter(l => l.ticket_state === 'open').length,
        callCount: calls.rows.length,
        activeWarranties: warranties.rows.filter(w => (w.effective_status || w.status) === 'active').length,
      },
    });
  } catch (err) {
    console.error('GET /api/customers/:id failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/customers/:id', requireRole('admin', 'sales_agent'), async (req, res) => {
  const allowed = ['name', 'ai_enabled', 'consent_for_marketing', 'contact_whatsapp_number'];
  if (rejectUnknownFields(req, res, allowed)) return;
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  const lengthError = validateFieldValues(updates);
  if (lengthError) return res.status(400).json({ error: lengthError });
  if (updates.consent_for_marketing !== undefined) updates.consent_updated_at = new Date().toISOString();

  // contact_whatsapp_number (migration 027): the customer's real WhatsApp
  // number, when the number they called from has none. Normalized to digits
  // here rather than rejected — staff realistically type '+94 77 123 4567'
  // or '077-123-4567', and the DB CHECK only accepts digits. An empty string
  // means "clear it" (back to messaging whatsapp_number).
  if (updates.contact_whatsapp_number !== undefined) {
    const raw = String(updates.contact_whatsapp_number ?? '').trim();
    if (raw === '') {
      updates.contact_whatsapp_number = null;
      updates.contact_whatsapp_updated_at = null;
    } else {
      const digits = normalizePhone(raw);
      if (digits.length < 9 || digits.length > 15) {
        return res.status(400).json({ error: 'WhatsApp number must be 9-15 digits' });
      }
      updates.contact_whatsapp_number = digits;
      updates.contact_whatsapp_updated_at = new Date().toISOString();
    }
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update' });

  const entries = Object.entries(updates);
  const setClauses = entries.map(([k], i) => `${k}=$${i + 1}`).join(', ');
  const vals = [...entries.map(([, v]) => v), req.params.id];

  try {
    const { rows } = await pool.query(`UPDATE customers SET ${setClauses} WHERE id=$${entries.length + 1} RETURNING *`, vals);
    if (rows.length === 0) return res.status(404).json({ error: 'Customer not found' });
    broadcastEvent('customer_update', { id: req.params.id });
    res.json({ success: true, customer: rows[0] });
  } catch (err) {
    console.error('PATCH /api/customers/:id failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/messages ─────────────────────────────────────────────────────────
// Chat access is off-limits for delivery_coordinator too (confirmed with
// the user, same reasoning as Pipeline above) — every other role keeps
// this route's previous unrestricted access.
app.get('/api/messages', requireRole(...PIPELINE_READ_ROLES), async (req, res) => {
  try {
    const { customer_id } = req.query;

    if (customer_id) {
      const { rows } = await pool.query(
        `SELECT id, direction, content, received_at, delivery_failed${schemaFlags.messageFailureReason ? ', failure_code, failure_reason' : ''} FROM messages WHERE customer_id=$1 ORDER BY received_at ASC`,
        [customer_id]
      );
      return res.json({ messages: rows });
    }

    // All messages with embedded customer object
    const { rows } = await pool.query(`
      SELECT m.id, m.direction, m.content, m.received_at, m.delivery_failed,
        ${schemaFlags.messageFailureReason ? 'm.failure_code, m.failure_reason,' : ''}
        ${CUSTOMER_JSON}
      FROM messages m
      JOIN customers c ON m.customer_id = c.id
      ORDER BY m.received_at ASC
    `);
    res.json({ messages: rows });
  } catch (err) {
    console.error('GET /api/messages failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/leads ────────────────────────────────────────────────────────────
// LEAD_ENRICHMENT (Phase 15.2) — assignee name + live SLA overdue flag +
// most recent showroom_location (only meaningful when source='showroom';
// NULL otherwise) for the Pipeline card's source/assignee/SLA badges.
const LEAD_ENRICHMENT = `
  su.name AS assigned_staff_name,
  vs.is_overdue,
  (
    SELECT sv.showroom_location FROM showroom_visits sv
    WHERE sv.customer_id = l.customer_id
    ORDER BY sv.visited_at DESC LIMIT 1
  ) AS showroom_location,
  -- All products the lead asked about (migration 031). An empty array rather
  -- than NULL so the UI can map over it unconditionally. leads.product_type
  -- etc. still mirror item 0, so nothing that reads those needs to change.
  COALESCE((
    SELECT json_agg(json_build_object(
             'id', li.id, 'product_type', li.product_type, 'bed_size', li.bed_size,
             'scale', li.scale, 'qty', li.qty, 'unit_price', li.unit_price,
             'pillow_top', li.pillow_top, 'position', li.position, 'source', li.source
           ) ORDER BY li.position ASC, li.created_at ASC)
    FROM lead_items li WHERE li.lead_id = l.id
  ), '[]'::json) AS items
`;
// The last three calls with the lead's customer, newest first — the Pipeline's
// "Last calls" dots. Same scope as GET /api/calls (058): admins/viewers see
// every agent's calls, anyone else only calls logged on their own phone, so
// the dots cannot show another agent's activity. Only dated calls of the three
// real types count; a NULL call_type row (one exists in production) is skipped.
// A per-row subquery on idx_call_events_customer_id: each customer has a
// handful of calls, so it stays cheap even on the unpaged board view.
function recentCallsSql(req, params) {
  let scope = '';
  if (!isUnrestricted(req)) {
    if (!schemaFlags.callEventStaff) {
      scope = ' AND false';
    } else {
      params.push(req.staff.id);
      scope = ` AND ce.staff_id = $${params.length}`;
    }
  }
  const staffName = schemaFlags.callEventStaff
    ? '(SELECT s.name FROM staff_users s WHERE s.id = ce.staff_id)'
    : 'NULL::text';
  return `COALESCE((
    SELECT json_agg(json_build_object(
             'type', r.call_type, 'at', r.occurred_at,
             'duration', r.duration_seconds, 'staff', r.staff_name
           ) ORDER BY r.occurred_at DESC, r.id DESC)
    FROM (
      SELECT ce.id, ce.call_type, ce.occurred_at, ce.duration_seconds, ${staffName} AS staff_name
        FROM call_events ce
       WHERE ce.customer_id = l.customer_id
         AND ce.occurred_at IS NOT NULL
         AND ce.call_type IN ('INCOMING', 'OUTGOING', 'MISSED')${scope}
       ORDER BY ce.occurred_at DESC, ce.id DESC
       LIMIT 3
    ) r
  ), '[]'::json) AS recent_calls`;
}

const LEAD_ENRICHMENT_JOINS = `
  LEFT JOIN staff_users su ON su.id = l.assigned_staff_id
  LEFT JOIN v_lead_sla_status vs ON vs.lead_id = l.id
`;

// ticket_state defaults to 'open' — a closed lead drops off the Pipeline
// entirely (confirmed with the user), but the customer record itself is
// untouched and permanent; ?ticketState=closed is how the Team page's
// admin-monitoring section pulls the closed list back.
// Pipeline access is off-limits for delivery_coordinator (confirmed with
// the user) — that role's job is fulfillment/delivery on orders already
// placed, not the sales pipeline. Every other role keeps the same
// unrestricted read access this route always had.
// Call-owner visibility (migration 025) — confirmed with the user: a lead
// sourced from a call is only visible to the staff member it's assigned to
// (plus admin/viewer, who need full oversight). WhatsApp, web chat, and
// showroom-visit leads keep the existing shared visibility every role
// already had — this filter only ever narrows call-sourced rows.
// super_admin belongs here for the same reason admin does — oversight. It was
// MISSING when the role was added (migration 045): requireRole() short-circuits
// on super_admin, but this filter runs INSIDE the route and never consults it,
// so the role fell to the restrictive branch and saw only call leads assigned
// to its own id — i.e. none. Found in production with 888 open call leads
// hidden and a Pipeline showing 9.
const CALL_VISIBILITY_ROLES_UNRESTRICTED = [SUPER_ADMIN, 'admin', 'viewer'];

// BOTH strings that mean "this lead came from a phone call".
//
// 'Call tracker app' is what POST /api/calls writes today; 'Dialog call' is the
// retired webhook integration and is still the source on real historical rows
// (86 of them open in production when this was found). The filter below named
// only the first, so every 'Dialog call' lead stayed visible to every sales
// agent regardless of who it was assigned to — the exact ownership rule
// migration 025 exists to enforce, silently not applied to nearly half the
// call leads in the system.
//
// theme.js's SOURCE_BADGE and LeadsPage's call-lead check already handle both
// strings, and CLAUDE.md documents the pair; this was the one place that did
// not. Named once here so a third call source cannot be added to only some of
// them.
const CALL_SOURCES = ['Call tracker app', 'Dialog call'];

// Roles that see every agent's calls, callbacks and orders (058). Everyone
// else is scoped to their own — enforced here, never by the dashboard.
function isUnrestricted(req) {
  return CALL_VISIBILITY_ROLES_UNRESTRICTED.includes(req.staff.role);
}

// WHERE fragment scoping `column` (a staff_id) to the caller (058).
// Unrestricted: an optional ?staffId= — a UUID, or 'none' for rows with no
// recorded agent; absent means everyone. Anyone else: always their own id,
// whatever they sent. `hasColumn` false (database without 051) fails CLOSED
// for restricted callers — nothing can be attributed to them, so they get
// nothing rather than everyone's rows.
function staffScopeWhere(req, column, params, hasColumn = true) {
  if (!isUnrestricted(req)) {
    if (!hasColumn) return 'false';
    params.push(req.staff.id);
    return `${column} = $${params.length}`;
  }
  const staffId = req.query.staffId;
  if (!hasColumn || !staffId) return '';
  if (staffId === 'none') return `${column} IS NULL`;
  if (!UUID_RE.test(staffId)) return '';
  params.push(staffId);
  return `${column} = $${params.length}`;
}

// Orders a sales agent may see (058): ones they placed, or ones that came from
// a lead assigned to them — the second covers orders placed before 058, which
// record no placer. Every other role sees all orders; finance, delivery and
// inventory need them to do their jobs. Returns an ` AND (...)` fragment.
function orderVisibilityFilter(req, params, alias = 'o') {
  if (req.staff.role !== 'sales_agent') return '';
  params.push(req.staff.id);
  const me = `$${params.length}`;
  const viaLead = `${alias}.lead_id IN (SELECT id FROM leads_all WHERE assigned_staff_id = ${me})`;
  return schemaFlags.orderPlacedBy
    ? ` AND (${alias}.placed_by = ${me} OR ${viaLead})`
    : ` AND ${viaLead}`;
}

// true when the caller may see this order. A hidden order answers 404, not
// 403, so the id does not reveal that it exists.
async function orderVisible(req, orderId) {
  if (req.staff.role !== 'sales_agent') return true;
  if (!UUID_RE.test(String(orderId))) return false;
  const params = [orderId];
  const { rows } = await pool.query(
    `SELECT 1 FROM orders o WHERE o.id = $1${orderVisibilityFilter(req, params)}`,
    params
  );
  return rows.length > 0;
}

// Route middleware form of orderVisible() for every /api/orders/:id/* route.
async function requireOrderVisible(req, res, next) {
  try {
    if (await orderVisible(req, req.params.id)) return next();
    return res.status(404).json({ error: 'Order not found' });
  } catch (err) {
    console.error('order visibility check failed:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Every /api/leads/:id/* route that reads or changes ONE lead goes through
// this, so a lead hidden from the Pipeline (another agent's call lead,
// callVisibilityFilter) cannot be changed, closed, re-itemised or quoted by
// id either. 404 rather than 403, so an id does not confirm the lead exists.
async function requireLeadVisible(req, res, next) {
  try {
    if (isUnrestricted(req)) return next();
    if (!UUID_RE.test(String(req.params.id))) return res.status(404).json({ error: 'Lead not found' });
    const params = [req.params.id];
    const { rows } = await pool.query(
      `SELECT 1 FROM leads l WHERE l.id = $1${callVisibilityFilter(req, params)}`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Lead not found' });
    return next();
  } catch (err) {
    console.error('lead visibility check failed:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function callVisibilityFilter(req, params) {
  if (CALL_VISIBILITY_ROLES_UNRESTRICTED.includes(req.staff.role)) return '';
  params.push(CALL_SOURCES);
  const sources = `$${params.length}`;
  params.push(req.staff.id);
  return ` AND (NOT (l.source = ANY(${sources})) OR l.assigned_staff_id = $${params.length})`;
}

// The soonest scheduled follow-up for a lead, as SQL.
//
// Mirrors nextFollowUp() in LeadsPage.jsx: the earliest of the manual
// next_contact_date and the automated schedule (migrations 018/020), skipping
// the two calls already marked done. week_N dates have no done flag by design,
// so any that is set counts. LEAST ignores NULLs, which is exactly the
// behaviour wanted — a lead with no schedule at all yields NULL and sorts last.
//
// Duplicated from the frontend rather than shared because the two cannot
// import from each other; if the stage list changes, both must change.
const NEXT_FOLLOW_UP_SQL = `LEAST(
  l.next_contact_date,
  CASE WHEN l.follow_up_1_done THEN NULL ELSE l.follow_up_1_date END,
  CASE WHEN l.follow_up_2_done THEN NULL ELSE l.follow_up_2_date END,
  l.week_1_date, l.week_2_date, l.week_3_date, l.week_4_date
)`;

// ORDER BY is built from THIS MAP ONLY, never from the query string, so the
// sort column cannot be injected. Keys match SORT_OPTIONS in LeadsPage.jsx.
//
// Each entry ends with a NULLS LAST so a lead missing the sort field falls to
// the bottom in BOTH directions — blanks floating to the top of a descending
// sort is the classic way a sorted table looks broken, and the client-side
// sortLeads() this replaces went out of its way to avoid it.
const LEAD_SORT_COLUMNS = {
  created: 'l.created_at',
  name: 'lower(c.name)',
  followup: NEXT_FOLLOW_UP_SQL,
  // Ranked in pipeline order rather than alphabetically, matching
  // STATUS_RANK/PRIORITY_RANK in the dashboard.
  status: `array_position(ARRAY['new','quotation_sent','follow_up','not_answered','won','lost'], l.status)`,
  priority: `array_position(ARRAY['high','medium','low'], COALESCE(l.priority,'medium'))`,
};

app.get('/api/leads', requireRole(...PIPELINE_READ_ROLES), async (req, res) => {
  try {
    const ticketState = req.query.ticketState === 'closed' ? 'closed' : 'open';
    const params = [ticketState];
    let customerFilter = '';
    if (req.query.customerId) {
      params.push(req.query.customerId);
      customerFilter = ` AND l.customer_id = $${params.length}`;
    }
    const visibilityFilter = callVisibilityFilter(req, params);

    // ── filters, applied in SQL against EVERY lead ───────────────────────────
    // Previously the browser received the whole open list and filtered it. That
    // is fine while the list is short and wrong the moment it is paginated: a
    // search would only ever look inside the rows already loaded, so a customer
    // on page 8 reads as "no results" rather than "not on this page".
    const extra = [];

    if (req.query.status && req.query.status !== 'all') {
      params.push(req.query.status);
      extra.push(`l.status = $${params.length}`);
    }

    // Name, phone or location — the same three fields the client-side version
    // matched. The number is also matched in canonical form so typing
    // 0771234567 finds a stored 94771234567.
    const search = (req.query.search || '').trim();
    if (search) {
      params.push(`%${search}%`);
      const like = `$${params.length}`;
      params.push(`%${normalizePhone(search)}%`);
      const likeCanon = `$${params.length}`;
      extra.push(`(
        c.name ILIKE ${like}
        OR c.whatsapp_number ILIKE ${like}
        OR c.whatsapp_number ILIKE ${likeCanon}
        OR l.location ILIKE ${like}
      )`);
    }

    // created_at bounds compare on the local calendar day, matching how the
    // dashboard renders and filters dates.
    if (req.query.dateFrom) {
      params.push(req.query.dateFrom);
      extra.push(`(l.created_at AT TIME ZONE 'Asia/Colombo')::date >= $${params.length}::date`);
    }
    if (req.query.dateTo) {
      params.push(req.query.dateTo);
      extra.push(`(l.created_at AT TIME ZONE 'Asia/Colombo')::date <= $${params.length}::date`);
    }

    // "A call is due today" across all five scheduled dates plus the manual
    // one — the same OR the Today's-calls toggle already applied in the
    // browser, including that a won/lost lead never counts however its dates
    // read.
    if (req.query.todaysCalls === 'true') {
      extra.push(`(
        l.status NOT IN ('won','lost') AND (
          l.next_contact_date = CURRENT_DATE
          OR (l.follow_up_1_date = CURRENT_DATE AND NOT l.follow_up_1_done)
          OR (l.follow_up_2_date = CURRENT_DATE AND NOT l.follow_up_2_done)
          OR l.next_weekly_follow_up_date = CURRENT_DATE
          OR l.week_1_date = CURRENT_DATE OR l.week_2_date = CURRENT_DATE
          OR l.week_3_date = CURRENT_DATE OR l.week_4_date = CURRENT_DATE
        )
      )`);
    }

    const extraSql = extra.length ? ` AND ${extra.join(' AND ')}` : '';
    const whereSql = `WHERE l.ticket_state = $1${customerFilter}${visibilityFilter}${extraSql}`;

    // Sort column comes from the allowlist, never from the query string.
    const sortCol = LEAD_SORT_COLUMNS[req.query.sort] || 'l.created_at';
    const sortDir = req.query.dir === 'asc' ? 'ASC' : 'DESC';
    // `l.id` breaks ties so a row cannot drift between pages under LIMIT/OFFSET
    // when several share a sort value (very common on status and priority).
    const orderSql = `ORDER BY ${sortCol} ${sortDir} NULLS LAST, l.id DESC`;

    // limit=0 means "every matching row", which the board view and the export
    // both need — neither is paginated, and an export that stopped at the page
    // boundary would be worse than none. Anything else is clamped.
    const rawLimit = req.query.limit === undefined ? null : parseInt(req.query.limit, 10);
    const unlimited = rawLimit === 0;
    const limit = unlimited ? null : Math.min(Math.max(rawLimit || 50, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const { rows: countRows } = await pool.query(
      `SELECT count(*)::int AS total
       FROM leads l JOIN customers c ON l.customer_id = c.id
       ${whereSql}`,
      params
    );
    const total = countRows[0]?.total ?? 0;

    // The last three calls get their own params: the count query above must
    // not carry a parameter it never uses (Postgres cannot type it).
    const rowParams = [...params];
    const recentCalls = recentCallsSql(req, rowParams);

    const pageSql = unlimited
      ? ''
      : ` LIMIT $${rowParams.length + 1} OFFSET $${rowParams.length + 2}`;
    const pageParams = unlimited ? rowParams : [...rowParams, limit, offset];

    const { rows } = await pool.query(
      `
      SELECT l.*, ${CUSTOMER_JSON}, ${LEAD_ENRICHMENT}, ${recentCalls}
      FROM leads l
      JOIN customers c ON l.customer_id = c.id
      ${LEAD_ENRICHMENT_JOINS}
      ${whereSql}
      ${orderSql}${pageSql}
    `,
      pageParams
    );
    res.json({ leads: rows, total, limit: unlimited ? total : limit, offset });
  } catch (err) {
    console.error('GET /api/leads failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/leads/stats ──────────────────────────────────────────────────────
// The Pipeline's stat tiles, its 7-day sparkline and the per-status tab counts,
// computed over EVERY lead the caller may see rather than the page in front of
// them.
//
// These used to be derived in the browser from the full open list. Once that
// list is paginated the same code would quietly report "Overdue: 3" meaning
// "overdue among the 50 rows on screen" — a number that reads as a total and is
// not one. Counting in Postgres keeps them true at any page size.
//
// Deliberately NOT filtered by the table's own search/status filters: a tile
// reading "Follow-ups today: 12" answers "how much work is there", which is a
// question about the whole pipeline, not about the current view. The call
// visibility rule IS applied, so an agent's tiles never count leads the list
// itself hides from them.
//
// MUST be declared before '/api/leads/:id' or that route captures "stats".
app.get('/api/leads/stats', requireRole(...PIPELINE_READ_ROLES), async (req, res) => {
  try {
    const params = ['open'];
    const visibilityFilter = callVisibilityFilter(req, params);
    const where = `WHERE l.ticket_state = $1${visibilityFilter}`;
    const today = `(l.created_at AT TIME ZONE 'Asia/Colombo')::date`;
    const open = `l.status NOT IN ('won','lost')`;

    const { rows } = await pool.query(
      `
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE ${today} = CURRENT_DATE AND l.status = 'new')::int AS new_today,
        count(*) FILTER (WHERE l.next_contact_date = CURRENT_DATE AND ${open})::int AS follow_today,
        count(*) FILTER (WHERE l.next_contact_date < CURRENT_DATE AND ${open})::int AS overdue,
        count(*) FILTER (WHERE ${today} = CURRENT_DATE - 1 AND l.status = 'new')::int AS new_yesterday,
        count(*) FILTER (WHERE l.next_contact_date = CURRENT_DATE - 1 AND ${open})::int AS follow_yesterday,
        count(*) FILTER (WHERE l.next_contact_date < CURRENT_DATE - 1 AND ${open})::int AS overdue_yesterday,
        count(*) FILTER (WHERE ${open} AND (
          l.next_contact_date = CURRENT_DATE
          OR (l.follow_up_1_date = CURRENT_DATE AND NOT l.follow_up_1_done)
          OR (l.follow_up_2_date = CURRENT_DATE AND NOT l.follow_up_2_done)
          OR l.next_weekly_follow_up_date = CURRENT_DATE
          OR l.week_1_date = CURRENT_DATE OR l.week_2_date = CURRENT_DATE
          OR l.week_3_date = CURRENT_DATE OR l.week_4_date = CURRENT_DATE
        ))::int AS calls_today
      FROM leads l
      ${where}
    `,
      params
    );

    // Per-status counts for the tab bar, in one pass.
    const { rows: statusRows } = await pool.query(
      `SELECT l.status, count(*)::int AS n FROM leads l ${where} GROUP BY l.status`,
      params
    );
    const byStatus = {};
    for (const r of statusRows) byStatus[r.status] = r.n;

    // 7-day sparkline: new leads per local day, oldest first. generate_series
    // supplies the days so a day with no leads is a real zero rather than a
    // gap the chart would silently close up.
    const { rows: daily } = await pool.query(
      `
      SELECT d::date AS day, count(l.id)::int AS n
      FROM generate_series(CURRENT_DATE - 6, CURRENT_DATE, '1 day') d
      LEFT JOIN leads l
        ON (l.created_at AT TIME ZONE 'Asia/Colombo')::date = d::date
       AND l.ticket_state = 'open'
      GROUP BY d ORDER BY d
    `
    );

    res.json({ ...rows[0], byStatus, daily });
  } catch (err) {
    console.error('GET /api/leads/stats failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/leads/won-stats ──────────────────────────────────────────────────
// The two "won" counts the Pipeline's stat tile needs (this month, and the
// same window last month for its trend arrow).
//
// Why this exists: the page used to fetch the ENTIRE closed-ticket list
// (`GET /api/leads?ticketState=closed`) on every load purely to derive these
// two integers in the browser. Closed tickets accumulate forever while open
// ones do not, so that request grew without bound — the single largest cost of
// opening the Pipeline, and one that got worse every week, for two numbers.
//
// Counting happens in Postgres, which already has the index, and only a
// {thisMonth, lastMonth} pair crosses the wire.
//
// MUST be declared before '/api/leads/:id' or that route captures "won-stats"
// as an id and this is never reached.
app.get('/api/leads/won-stats', requireRole(...PIPELINE_READ_ROLES), async (req, res) => {
  try {
    const params = [];
    // Respect the same call-ownership visibility rule the list endpoint uses,
    // so a sales agent's tile never counts leads the list itself hides from
    // them. Passing `l.` aliased SQL means the filter composes unchanged.
    const visibilityFilter = callVisibilityFilter(req, params);
    // Both windows in ONE pass over the same rows rather than two queries.
    // date_trunc on the server's own clock matches how the page's other tiles
    // are bucketed; `updated_at` is when the lead reached 'won'.
    const { rows } = await pool.query(
      `
      SELECT
        count(*) FILTER (
          WHERE l.updated_at >= date_trunc('month', now())
        ) AS this_month,
        count(*) FILTER (
          WHERE l.updated_at >= date_trunc('month', now() - interval '1 month')
            AND l.updated_at <  date_trunc('month', now())
        ) AS last_month
      FROM leads l
      WHERE l.status = 'won'${visibilityFilter}
    `,
      params
    );
    // The tile also draws a 7-day sparkline, which needs a per-DAY count and
    // so cannot be derived from the two totals above. Returned as a date->count
    // map for the last 7 days; the page fills in the missing days as 0, so a
    // day with no wins is a real gap in the line rather than a hole.
    const { rows: dailyRows } = await pool.query(
      `
      SELECT to_char(l.updated_at::date, 'YYYY-MM-DD') AS day, count(*) AS n
      FROM leads l
      WHERE l.status = 'won'
        AND l.updated_at >= (CURRENT_DATE - interval '6 days')${visibilityFilter}
      GROUP BY 1
    `,
      params
    );
    const daily = {};
    for (const r of dailyRows) daily[r.day] = Number(r.n) || 0;

    // count() comes back as a bigint, which pg serializes as a STRING — the
    // UI does arithmetic on these, so they are converted here rather than
    // leaving every caller to remember.
    res.json({
      thisMonth: Number(rows[0].this_month) || 0,
      lastMonth: Number(rows[0].last_month) || 0,
      daily,
    });
  } catch (err) {
    console.error('GET /api/leads/won-stats failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/leads/:id', requireRole(...PIPELINE_READ_ROLES), async (req, res) => {
  try {
    const params = [req.params.id];
    const visibilityFilter = callVisibilityFilter(req, params);
    // The lead page header shows the same "Last calls" dots as the Pipeline.
    const recentCalls = recentCallsSql(req, params);
    const { rows } = await pool.query(
      `
      SELECT l.*, ${CUSTOMER_JSON}, ${LEAD_ENRICHMENT}, ${recentCalls}
      FROM leads l
      JOIN customers c ON l.customer_id = c.id
      ${LEAD_ENRICHMENT_JOINS}
      WHERE l.id=$1${visibilityFilter}
    `,
      params
    );

    if (rows.length === 0) return res.status(404).json({ error: 'Lead not found' });
    res.json({ lead: rows[0] });
  } catch (err) {
    console.error('GET /api/leads/:id failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/leads/:id/quotation ─────────────────────────────────────────────
// Claims a quotation number for the lead (migration 032) and returns
// everything the PDF needs. The number is issued only ONCE per lead —
// assign_quotation_number() is idempotent — so re-downloading a quotation
// keeps the reference the customer was already given.
app.post('/api/leads/:id/quotation', requireRole('admin', 'sales_agent'), requireLeadVisible, async (req, res) => {
  try {
    const { rows: leadRows } = await pool.query(
      `
      SELECT l.id, l.quotation_no, l.delivery_address, l.location, l.category,
             c.name AS customer_name, c.whatsapp_number, c.contact_whatsapp_number
      FROM leads l JOIN customers c ON c.id = l.customer_id
      WHERE l.id = $1
    `,
      [req.params.id]
    );
    if (leadRows.length === 0) return res.status(404).json({ error: 'Lead not found' });

    const { rows: numRows } = await pool.query('SELECT assign_quotation_number($1) AS no', [req.params.id]);
    const quotationNo = numRows[0].no;

    const { rows: items } = await pool.query(
      `SELECT product_type, bed_size, scale, qty, unit_price, pillow_top
       FROM lead_items WHERE lead_id = $1 ORDER BY position ASC, created_at ASC`,
      [req.params.id]
    );

    const total = items.reduce((sum, it) => sum + (Number(it.unit_price) || 0) * (Number(it.qty) || 1), 0);

    broadcastEvent('lead_update', { id: req.params.id });
    res.json({
      success: true,
      quotationNo,
      lead: leadRows[0],
      items,
      total,
      issuedAt: new Date().toISOString(),
      preparedBy: req.staff.name || null,
    });
  } catch (err) {
    console.error('POST /api/leads/:id/quotation failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── lead items (migration 031) ────────────────────────────────────────────────
// A lead can hold several products a customer asked about. lead_items is the
// real store; leads.product_type/bed_size/scale/qty/unit_price stay mirrored
// to item 0 by trg_lead_items_sync, so every existing single-product reader
// (Pipeline table, PDF/Excel export, customers-directory, Bulk Messages)
// keeps working unchanged.
const LEAD_ITEM_ROLES = ['admin', 'sales_agent'];

// GET — the whole basket for one lead, plus its total.
app.get('/api/leads/:id/items', requireRole(...PIPELINE_READ_ROLES), requireLeadVisible, async (req, res) => {
  try {
    const { rows: items } = await pool.query(`SELECT * FROM lead_items WHERE lead_id=$1 ORDER BY position ASC, created_at ASC`, [
      req.params.id,
    ]);
    const { rows: sum } = await pool.query('SELECT * FROM v_lead_items_summary WHERE lead_id=$1', [req.params.id]);
    res.json({ items, summary: sum[0] || null });
  } catch (err) {
    console.error('GET /api/leads/:id/items failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST — add a product to the lead.
app.post('/api/leads/:id/items', requireRole(...LEAD_ITEM_ROLES), requireLeadVisible, async (req, res) => {
  const { productType, bedSize, scale, qty, unitPrice, pillowTop } = req.body;
  if (!productType && !bedSize) {
    return res.status(400).json({ error: 'productType or bedSize is required' });
  }
  try {
    const { rows: pos } = await pool.query('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM lead_items WHERE lead_id=$1', [
      req.params.id,
    ]);
    const { rows } = await pool.query(
      `INSERT INTO lead_items (lead_id, product_type, bed_size, scale, qty, unit_price, pillow_top, position, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'staff') RETURNING *`,
      [
        req.params.id,
        productType || null,
        bedSize || null,
        scale || null,
        Number.isFinite(Number(qty)) && Number(qty) > 0 ? Math.trunc(Number(qty)) : null,
        // Guard NaN explicitly — Number('abc') is NaN and Postgres would
        // otherwise sort it above every price (see migration 031's CHECK).
        Number.isFinite(Number(unitPrice)) && Number(unitPrice) >= 0 ? Number(unitPrice) : null,
        !!pillowTop,
        pos[0].next,
      ]
    );
    broadcastEvent('lead_update', { id: req.params.id });
    res.json({ success: true, item: rows[0] });
  } catch (err) {
    // The unique index is what stops duplicates; report it as a conflict
    // rather than a 500 so the UI can say something useful. The key includes
    // the pillow-top choice (migration 033), so the plain and pillow-top
    // versions of one product+size are NOT duplicates of each other — this
    // only fires when that choice matches too.
    if (err.code === '23505') {
      return res.status(409).json({
        error: pillowTop
          ? 'That product and size with the pillow-top upgrade is already on this lead.'
          : 'That product and size is already on this lead.',
      });
    }
    if (err.code === '23503') {
      return res.status(404).json({ error: 'Lead not found' });
    }
    console.error('POST /api/leads/:id/items failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH — edit one item.
app.patch('/api/leads/:id/items/:itemId', requireRole(...LEAD_ITEM_ROLES), requireLeadVisible, async (req, res) => {
  const allowed = ['product_type', 'bed_size', 'scale', 'qty', 'unit_price', 'pillow_top', 'position'];
  const updates = { updated_at: new Date().toISOString() };

  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }
  for (const numCol of ['qty', 'position']) {
    if (updates[numCol] !== undefined && updates[numCol] !== null) {
      const n = Number(updates[numCol]);
      if (!Number.isFinite(n)) return res.status(400).json({ error: `${numCol} must be a number` });
      updates[numCol] = Math.trunc(n);
    }
  }
  if (updates.unit_price !== undefined && updates.unit_price !== null && updates.unit_price !== '') {
    const n = Number(updates.unit_price);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'unit_price must be 0 or more' });
    updates.unit_price = n;
  } else if (updates.unit_price === '') {
    updates.unit_price = null;
  }

  const entries = Object.entries(updates);
  const setClauses = entries.map(([k], i) => `${k}=$${i + 1}`).join(', ');
  try {
    const { rows } = await pool.query(
      `UPDATE lead_items SET ${setClauses} WHERE id=$${entries.length + 1} AND lead_id=$${entries.length + 2} RETURNING *`,
      [...entries.map(([, v]) => v), req.params.itemId, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Item not found on this lead' });
    broadcastEvent('lead_update', { id: req.params.id });
    res.json({ success: true, item: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That product and size is already on this lead.' });
    }
    console.error('PATCH /api/leads/:id/items/:itemId failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE — remove one item. The sync trigger promotes the next item onto the
// lead row, or clears those columns when the last item goes.
app.delete('/api/leads/:id/items/:itemId', requireRole(...LEAD_ITEM_ROLES), requireLeadVisible, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM lead_items WHERE id=$1 AND lead_id=$2', [req.params.itemId, req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Item not found on this lead' });
    broadcastEvent('lead_update', { id: req.params.id });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/leads/:id/items/:itemId failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/leads/:id', requireRole('admin', 'sales_agent'), requireLeadVisible, async (req, res) => {
  const allowed = [
    'status',
    'quotation_no',
    'next_contact_date',
    'follow_up_notes',
    'product_type',
    'bed_size',
    'scale',
    'qty',
    'unit_price',
    'location',
    'delivery_address',
    'source',
    'category',
    'first_call',
    'second_call',
    'week_01',
    'week_02',
    'week_03',
    'week_04',
    'assigned_staff_id',
    // Automated follow-up schedule (migration 018) — all 4 dates are staff-
    // editable at any time; the *_done flags just clear a date from the
    // "due" list without affecting the other date (confirmed with the user).
    'follow_up_1_date',
    'follow_up_1_done',
    'follow_up_2_date',
    'follow_up_2_done',
    'next_weekly_follow_up_date',
    // 4 concrete weekly dates (migration 020) — editable at any time,
    // independent of the auto-set that fires when follow_up_2_done flips.
    'week_1_date',
    'week_2_date',
    'week_3_date',
    'week_4_date',
    // Per-lead priority (migration 019) — distinct from customers.priority_label
    // (the AI-driven chat/SLA priority); user was explicit these are different.
    'priority',
    // Close/reopen (migration 020, finally wiring up Phase 3's ticket_state)
    'ticket_state',
    'closed_reason',
  ];

  // Manual reassignment (REQ-4.2) is Admin-only
  if (req.body.assigned_staff_id !== undefined && !hasRole(req.staff, 'admin')) {
    return res.status(403).json({ error: 'Only Admin can reassign a ticket' });
  }

  if (req.body.ticket_state === 'closed' && !req.body.closed_reason?.trim()) {
    return res.status(400).json({ error: 'closed_reason is required to close a lead' });
  }

  const updates = { updated_at: new Date().toISOString() };
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (updates.ticket_state === 'closed') {
    updates.closed_at = new Date().toISOString();
  } else if (updates.ticket_state === 'open') {
    // Reopening — clear the closed markers rather than leaving stale ones.
    updates.closed_at = null;
    updates.closed_reason = null;
  }

  // Setting follow_up_2_done=true auto-schedules the 4 weekly dates in the
  // same PATCH, all at once (+7/+14/+21/+28 days from today) — confirmed
  // with the user this fires on the staff action of checking "Done", not
  // on follow_up_2_date itself passing (that date-passing trigger still
  // only fires the original one-time promo, unchanged). Only auto-fills
  // dates that are currently unset, so re-checking the box after staff
  // already edited one of the 4 dates doesn't clobber their edit.
  if (updates.follow_up_2_done === true) {
    const { rows: currentRows } = await pool.query('SELECT week_1_date, week_2_date, week_3_date, week_4_date FROM leads WHERE id=$1', [
      req.params.id,
    ]);
    const current = currentRows[0];
    const addDays = (n) => {
      const d = new Date();
      d.setDate(d.getDate() + n);
      return d.toISOString().slice(0, 10);
    };
    if (current && !current.week_1_date) updates.week_1_date = addDays(7);
    if (current && !current.week_2_date) updates.week_2_date = addDays(14);
    if (current && !current.week_3_date) updates.week_3_date = addDays(21);
    if (current && !current.week_4_date) updates.week_4_date = addDays(28);
  }

  const entries = Object.entries(updates);
  const setClauses = entries.map(([k], i) => `${k}=$${i + 1}`).join(', ');
  const vals = [...entries.map(([, v]) => v), req.params.id];

  try {
    const { rowCount } = await pool.query(`UPDATE leads SET ${setClauses} WHERE id=$${entries.length + 1}`, vals);
    if (rowCount === 0) return res.status(404).json({ error: 'Lead not found' });

    const { rows } = await pool.query(
      `
      SELECT l.*, ${CUSTOMER_JSON}
      FROM leads l JOIN customers c ON l.customer_id = c.id WHERE l.id=$1
    `,
      [req.params.id]
    );

    broadcastEvent('lead_update', { id: req.params.id });
    res.json({ success: true, lead: rows[0] });
  } catch (err) {
    console.error('PATCH /api/leads/:id failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Open to every authenticated role by design: the catalog is not sensitive and
// every order/quotation screen needs it to resolve names, sizes and prices.
// Stock levels and inactive products live behind GET /api/inventory instead.
app.get('/api/products', requireRole(...STAFF_ROLES), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM products ORDER BY category, name');
    res.json({ products: rows });
  } catch (err) {
    console.error('GET /api/products failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/products/low-stock — reorder-alert pull endpoint (REQ-3.8) ──────
// No push/email infra exists yet — Inventory Manager/Admin poll this instead.
// Must be defined before /api/products/:id or Express would treat "low-stock" as an id.
app.get('/api/products/low-stock', requireRole('admin', 'inventory_manager'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, category, stock_quantity, reserved_quantity, reorder_threshold,
              (stock_quantity - reserved_quantity) AS available
       FROM products
       WHERE active = true AND (stock_quantity - reserved_quantity) <= reorder_threshold
       ORDER BY available ASC`
    );
    res.json({ products: rows });
  } catch (err) {
    console.error('GET /api/products/low-stock failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/inventory ────────────────────────────────────────────────────────
// The inventory management page's list. Distinct from GET /api/products
// (which every order form calls and which returns the catalog shape): this
// one is stock-focused, includes INACTIVE products — they're exactly what an
// inventory manager needs to see and reactivate — and computes the derived
// numbers server-side so the page and the low-stock alert can never disagree.
//
// stock_status is computed, not stored:
//   out       — nothing available to sell
//   low       — at or below the reorder threshold
//   in_stock  — above it
// available = stock_quantity - reserved_quantity, i.e. real sellable units;
// reserved_quantity is held by confirmed-but-not-yet-delivered orders
// (trg_order_stock_reservation).
app.get('/api/inventory', requireRole('admin', 'inventory_manager', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        p.id, p.name, p.category, p.collection, p.spring_type, p.description,
        p.has_pillow_top_option, p.pillow_top_addon_price,
        p.warranty_years, p.active, p.variants, p.created_at, p.updated_at,
        p.stock_quantity, p.reserved_quantity, p.reorder_threshold,
        (p.stock_quantity - p.reserved_quantity) AS available,
        CASE
          WHEN (p.stock_quantity - p.reserved_quantity) <= 0                    THEN 'out'
          WHEN (p.stock_quantity - p.reserved_quantity) <= p.reorder_threshold  THEN 'low'
          ELSE 'in_stock'
        END AS stock_status,
        jsonb_array_length(p.variants) AS variant_count,
        -- Price span across this product's variants, so the list can show
        -- what it sells for without shipping all 21 variant rows.
        (SELECT min((v->>'price')::numeric) FROM jsonb_array_elements(p.variants) v) AS price_min,
        (SELECT max((v->>'price')::numeric) FROM jsonb_array_elements(p.variants) v) AS price_max,
        -- Whether this product can be hard-deleted, computed with the same
        -- rule DELETE enforces, so the UI never offers a delete that 409s.
        (
          (SELECT count(*) FROM warranties      w  WHERE w.product_id  = p.id) +
          (SELECT count(*) FROM service_tickets st WHERE st.product_id = p.id) +
          (SELECT count(*) FROM orders o WHERE EXISTS (
             SELECT 1 FROM jsonb_array_elements(o.items) it
             WHERE COALESCE(it->>'name', it->>'product') = p.name))
        ) AS reference_count
      FROM products p
      ORDER BY p.active DESC, p.category, p.name
    `);
    res.json({ products: rows });
  } catch (err) {
    console.error('GET /api/inventory failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/products/:id/adjust-stock ───────────────────────────────────────
// Relative stock movement (delta), for the real inventory actions: a delivery
// arrived (+), breakage/write-off (-), a stock count correction. Deliberately
// relative rather than an absolute SET, so two staff adjusting at the same
// time don't clobber each other's number — the arithmetic happens in the DB
// in one statement.
app.post('/api/products/:id/adjust-stock', requireRole('admin', 'inventory_manager'), async (req, res) => {
  const { delta, reason } = req.body;
  const n = Number(delta);
  if (!Number.isFinite(n) || Math.trunc(n) === 0) {
    return res.status(400).json({ error: 'delta must be a non-zero number' });
  }

  try {
    // GREATEST(...,0) so stock can never go negative, and the reserved check
    // stops staff writing stock below what confirmed orders already hold.
    const { rows } = await pool.query(
      `UPDATE products
          SET stock_quantity = GREATEST(0, stock_quantity + $1), updated_at = NOW()
        WHERE id = $2
          AND stock_quantity + $1 >= reserved_quantity
        RETURNING *, (stock_quantity - reserved_quantity) AS available`,
      [Math.trunc(n), req.params.id]
    );

    if (rows.length === 0) {
      // Either no such product, or the adjustment would drop stock below the
      // units already reserved by confirmed orders — distinguish the two so
      // the message is actionable.
      const { rows: cur } = await pool.query('SELECT stock_quantity, reserved_quantity FROM products WHERE id=$1', [req.params.id]);
      if (cur.length === 0) return res.status(404).json({ error: 'Product not found' });
      return res.status(409).json({
        error: `Cannot reduce stock to ${cur[0].stock_quantity + Math.trunc(n)} — ${cur[0].reserved_quantity} unit(s) are reserved by confirmed orders that have not been delivered yet.`,
      });
    }

    catalogCache = { text: null, fetchedAt: 0 };
    console.log(
      `Stock adjusted for ${rows[0].name}: ${Math.trunc(n) > 0 ? '+' : ''}${Math.trunc(n)} -> ${rows[0].stock_quantity}${reason ? ` (${reason})` : ''} by ${req.staff.name || req.staff.role}`
    );
    res.json({ success: true, product: rows[0] });
  } catch (err) {
    console.error('POST /api/products/:id/adjust-stock failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PUT /api/products/:id/variants ────────────────────────────────────────────
// Replaces a product's whole size/price list in one write. A dedicated route
// rather than reusing PATCH's generic `variants` passthrough, because this
// data feeds live order forms and needs real validation:
//
//   * Two variant shapes exist in real data and BOTH must keep working —
//     the current catalog uses {size, dimension, price} (migration 015,
//     dimension = exact WxL in inches) while the 3 retired products use the
//     older {size, height, price}. The variant key is preserved per row from
//     what the caller sends, so editing a legacy product does not silently
//     rewrite its rows into the new shape and break historical reads.
//   * Order forms read v.size / v.dimension / v.price directly
//     (ShowroomOrderModal groups by size, then offers dimensions), so a row
//     missing size or price would render an unusable or free option.
//   * A duplicate size+dimension pair would show the customer two identical
//     choices at different prices, so it is rejected.
app.put('/api/products/:id/variants', requireRole('admin', 'inventory_manager'), async (req, res) => {
  const { variants } = req.body;
  if (!Array.isArray(variants)) return res.status(400).json({ error: 'variants must be an array' });

  const clean = [];
  const seen = new Set();
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i] || {};
    const row = i + 1;

    const price = Number(v.price);
    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({ error: `Row ${row}: price must be a number of 0 or more` });
    }

    // A pillow carries a single {price}-only variant (no size/dimension) —
    // that is the real shape for Gel/Bolster Pillow, so it stays valid.
    const size = (v.size ?? '').toString().trim();
    // Whichever dimension key this row already uses. 'dimension' is the
    // current one; 'height' is the legacy key still on the 3 retired
    // products, kept as-is rather than migrated.
    const dimKey = v.height !== undefined && v.dimension === undefined ? 'height' : 'dimension';
    const dimVal = dimKey === 'height' ? v.height : v.dimension;
    const dim = (dimVal ?? '').toString().trim();

    if (!size && !dim) {
      // price-only row: valid, but only as the single variant of a product
      if (variants.length > 1) {
        return res.status(400).json({ error: `Row ${row}: needs a size (only a single-variant product may omit it)` });
      }
      clean.push({ price });
      continue;
    }
    if (!size) return res.status(400).json({ error: `Row ${row}: size is required` });

    const key = `${size.toLowerCase()}|${dim.toLowerCase()}`;
    if (seen.has(key)) {
      return res.status(400).json({ error: `Duplicate size/${dimKey} combination: ${size} ${dim}`.trim() });
    }
    seen.add(key);

    const out = { size, price };
    if (dim) out[dimKey] = dim;
    clean.push(out);
  }

  try {
    const { rows } = await pool.query('UPDATE products SET variants=$1, updated_at=NOW() WHERE id=$2 RETURNING *', [
      JSON.stringify(clean),
      req.params.id,
    ]);
    if (rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    // The AI system prompt embeds the catalog price list, so it must be
    // rebuilt or the bot keeps quoting the old prices.
    catalogCache = { text: null, fetchedAt: 0 };
    console.log(`Variants updated for ${rows[0].name}: ${clean.length} size(s) by ${req.staff.name || req.staff.role}`);
    res.json({ success: true, product: rows[0] });
  } catch (err) {
    console.error('PUT /api/products/:id/variants failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/products', requireRole('admin', 'inventory_manager'), async (req, res) => {
  const {
    category,
    name,
    collection,
    springType,
    description,
    hasPillowTopOption,
    variants,
    // Previously dropped on the floor by this route, so a product created
    // through the API always landed on the column defaults (stock 0,
    // threshold 5, warranty 5) with no way to set them — the inventory page
    // needs all four at creation time.
    stockQuantity,
    reorderThreshold,
    warrantyYears,
    pillowTopAddonPrice,
  } = req.body;

  if (!category || !name) return res.status(400).json({ error: 'category and name are required' });
  if (!['mattress', 'pillow'].includes(category)) {
    return res.status(400).json({ error: "category must be 'mattress' or 'pillow'" });
  }

  // products.name has NO unique constraint anywhere in this schema, and both
  // handle_order_stock_reservation (UPDATE ... WHERE name = v_name, no LIMIT)
  // and handle_order_completed_warranty (SELECT ... WHERE name = v_name, no
  // ORDER BY/LIMIT) misbehave on a duplicate — see CLAUDE.md. Order items
  // match products by name too. So a duplicate name is rejected here rather
  // than allowed to silently corrupt stock and warranty behaviour later.
  // Checked across active AND inactive rows, since the old catalog rows are
  // deliberately kept inactive for order/warranty integrity.
  try {
    const dupe = await pool.query('SELECT id, active FROM products WHERE lower(name) = lower($1)', [String(name).trim()]);
    if (dupe.rows.length > 0) {
      return res.status(409).json({
        error: `A product named "${String(name).trim()}" already exists${dupe.rows[0].active ? '' : ' (inactive)'}. Product names must be unique — stock reservation and warranty creation both match orders to products by name.`,
      });
    }
  } catch (err) {
    console.error('POST /api/products duplicate-name check failed:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO products (
         category, name, collection, spring_type, description,
         has_pillow_top_option, variants,
         stock_quantity, reorder_threshold, warranty_years, pillow_top_addon_price
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        category,
        String(name).trim(),
        collection || null,
        springType || null,
        description || null,
        !!hasPillowTopOption,
        JSON.stringify(variants || []),
        Number.isFinite(Number(stockQuantity)) ? Math.max(0, Math.trunc(Number(stockQuantity))) : 0,
        Number.isFinite(Number(reorderThreshold)) ? Math.max(0, Math.trunc(Number(reorderThreshold))) : 5,
        Number.isFinite(Number(warrantyYears)) ? Math.max(0, Math.trunc(Number(warrantyYears))) : 5,
        // Only meaningful when has_pillow_top_option is set; NULL otherwise,
        // matching how the real catalog stores it (Ayu Sleep 6 has none).
        hasPillowTopOption && Number.isFinite(Number(pillowTopAddonPrice)) ? Number(pillowTopAddonPrice) : null,
      ]
    );
    catalogCache = { text: null, fetchedAt: 0 };
    res.json({ success: true, product: rows[0] });
  } catch (err) {
    console.error('POST /api/products failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/products/:id', requireRole('admin', 'inventory_manager'), async (req, res) => {
  const allowed = [
    'category',
    'name',
    'collection',
    'spring_type',
    'description',
    'has_pillow_top_option',
    'variants',
    'active',
    // warranty_years and pillow_top_addon_price were missing here, so the
    // inventory page could not edit either.
    'stock_quantity',
    'reorder_threshold',
    'warranty_years',
    'pillow_top_addon_price',
  ];
  const updates = { updated_at: new Date().toISOString() };
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates[key] = key === 'variants' ? JSON.stringify(req.body[key]) : req.body[key];
    }
  }

  if (updates.category !== undefined && !['mattress', 'pillow'].includes(updates.category)) {
    return res.status(400).json({ error: "category must be 'mattress' or 'pillow'" });
  }
  // reserved_quantity is deliberately NOT editable: it is owned by
  // trg_order_stock_reservation (reserve on confirm, release on cancel,
  // finalize on delivered+paid). Letting staff type over it would desync it
  // from the orders that actually hold the reservations.
  for (const intCol of ['stock_quantity', 'reorder_threshold', 'warranty_years']) {
    if (updates[intCol] !== undefined) {
      const n = Number(updates[intCol]);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ error: `${intCol} must be a number of 0 or more` });
      }
      updates[intCol] = Math.trunc(n);
    }
  }

  // Same duplicate-name hazard as POST — a RENAME can collide too.
  if (updates.name !== undefined) {
    const trimmed = String(updates.name).trim();
    if (!trimmed) return res.status(400).json({ error: 'name cannot be empty' });
    updates.name = trimmed;
    try {
      const dupe = await pool.query('SELECT id, active FROM products WHERE lower(name) = lower($1) AND id <> $2', [trimmed, req.params.id]);
      if (dupe.rows.length > 0) {
        return res.status(409).json({
          error: `Another product named "${trimmed}" already exists${dupe.rows[0].active ? '' : ' (inactive)'}. Product names must be unique — stock reservation and warranty creation both match orders to products by name.`,
        });
      }
    } catch (err) {
      console.error('PATCH /api/products/:id duplicate-name check failed:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  const entries = Object.entries(updates);
  const setClauses = entries.map(([k], i) => `${k}=$${i + 1}`).join(', ');
  const vals = [...entries.map(([, v]) => v), req.params.id];

  try {
    const { rows } = await pool.query(`UPDATE products SET ${setClauses} WHERE id=$${entries.length + 1} RETURNING *`, vals);
    if (rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    catalogCache = { text: null, fetchedAt: 0 };
    res.json({ success: true, product: rows[0] });
  } catch (err) {
    console.error('PATCH /api/products/:id failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/products/:id ──────────────────────────────────────────────────
// Hard-deletes ONLY an unreferenced product. This codebase treats "did this
// really happen" data as something you deactivate, not delete (same rule as
// promo codes with redemption history) — and here the stakes are higher
// because order items have no product_id and match products BY NAME, so
// deleting a product that appears in a past order silently breaks the stock
// trigger and warranty creation for that order's history. The 3 old catalog
// products are kept active=false for exactly this reason.
app.delete('/api/products/:id', requireRole('admin', 'inventory_manager'), async (req, res) => {
  try {
    const { rows: prodRows } = await pool.query('SELECT name, active FROM products WHERE id=$1', [req.params.id]);
    if (prodRows.length === 0) return res.status(404).json({ error: 'Product not found' });
    const productName = prodRows[0].name;

    // An INACTIVE product is one someone has already chosen to retire, and
    // retiring rather than deleting is the whole point — the 3 old catalog
    // rows are kept inactive for order/warranty integrity (see CLAUDE.md).
    // Reference-counting alone was not enough to protect them: a retired
    // product with no warranties or orders YET still counted as unreferenced,
    // and one was really deleted through the UI during testing (restored from
    // a pg_dump). Deleting is therefore only ever allowed on an ACTIVE
    // product — i.e. something just created by mistake, which is the only
    // case a hard delete is actually for.
    if (prodRows[0].active === false) {
      return res.status(409).json({
        error: `"${productName}" is already inactive and is kept as historical catalog data — it cannot be deleted. Inactive products stay out of the catalog and order forms while past orders, warranties and price history keep working.`,
      });
    }

    // Checked explicitly rather than left to the FK to throw, so the message
    // can say WHY and point staff at the Inactive toggle. Orders are matched
    // by name (with the older 'product' key fallback some historical rows
    // use) since there is no product_id on a line item.
    const { rows: refRows } = await pool.query(
      `
      SELECT
        (SELECT count(*) FROM warranties      WHERE product_id = $1) AS warranties,
        (SELECT count(*) FROM service_tickets WHERE product_id = $1) AS service_tickets,
        (SELECT count(*) FROM orders o
           WHERE EXISTS (
             SELECT 1 FROM jsonb_array_elements(o.items) it
             WHERE COALESCE(it->>'name', it->>'product') = $2
           )) AS orders
    `,
      [req.params.id, productName]
    );

    const refs = refRows[0];
    const blocking = [
      Number(refs.orders) > 0 ? `${refs.orders} order(s)` : null,
      Number(refs.warranties) > 0 ? `${refs.warranties} warranty/ies` : null,
      Number(refs.service_tickets) > 0 ? `${refs.service_tickets} service ticket(s)` : null,
    ].filter(Boolean);

    if (blocking.length > 0) {
      return res.status(409).json({
        error: `"${productName}" is referenced by ${blocking.join(', ')} and cannot be deleted — that history must not disappear. Set it Inactive instead: it stays out of the catalog and order forms while past orders and warranties keep working.`,
      });
    }

    const { rowCount } = await pool.query('DELETE FROM products WHERE id=$1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Product not found' });
    catalogCache = { text: null, fetchedAt: 0 };
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/products/:id failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Order confirmation message sent to the customer's WhatsApp on placement.
// Its purpose is VERIFICATION, not just a receipt: it restates the details
// staff typed (name, items, total, payment method, delivery address) and asks
// the customer to confirm or correct them, since every one of those is
// hand-entered at the counter and a wrong address or misheard name is only
// cheap to fix before dispatch.
//
// Lives server-side so every order-creation path gets it — the showroom
// walk-in modal, the chat modal, and any future/external caller — instead of
// each front-end re-implementing the text (LeadsPage.jsx has its own
// client-side version predating this, kept as-is: it is a lead-conversion
// "Order Confirmed" message tied to that flow's single line item).
//
// Deliberately plain text, not markdown tables: WhatsApp renders only *bold*
// / _italic_ (the raw-markdown-table bug already documented in CLAUDE.md).
// Money formatter for customer-facing WhatsApp messages. Falls back to LKR,
// and renders a non-numeric or missing amount as 0.00 rather than 'NaN' —
// one live lead row really does hold a PostgreSQL NaN.
function moneyFormatterFor(order) {
  const currency = order.currency || 'LKR';
  return (v) => `${currency} ${(Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
}

function buildOrderConfirmationMessage(order, customerName) {
  const DIV = '--------------------';
  const money = moneyFormatterFor(order);
  const cod = order.delivery_method === 'cash_on_delivery';
  const name = (customerName || order.customer_name || '').trim();

  const parts = [];
  parts.push('*Order Received — Nidikumba*');
  parts.push('');
  parts.push(name ? `Hello ${name},` : 'Hello,');
  parts.push('Thank you for your order. Please check the details below and confirm they are correct.');
  parts.push('');
  parts.push(DIV);
  parts.push(`Order *#${order.order_number}*`);
  parts.push(DIV);

  const items = Array.isArray(order.items) ? order.items : [];
  if (items.length > 0) {
    parts.push('');
    parts.push('*Items*');
    for (const it of items) {
      // Same by-name/by-product key fallback every other order-item reader in
      // this codebase uses (order items have no product_id).
      const itemName = it.name || it.product || 'Item';
      const qty = Number(it.qty) || 1;
      const detail = [it.bed_size, it.pillow_top ? 'with pillow top' : null].filter(Boolean).join(', ');
      // A free line is stored with a negative unit_price; it costs nothing, so
      // it is shown as FREE rather than as a negative amount.
      const free = it.free === true || (Number(it.unit_price) || 0) < 0;
      parts.push(`• ${itemName}${detail ? ` (${detail})` : ''} × ${qty} — ${free ? 'FREE' : money((Number(it.unit_price) || 0) * qty)}`);
    }
  }

  parts.push('');
  parts.push(`*Total: ${money(order.total_amount)}*`);

  // Payment: COD is stated as one thing — what they pay and when — rather
  // than a bare "Cash" the customer would have to interpret.
  if (cod) {
    parts.push(`Payment: *Cash on Delivery* — please have ${money(order.total_amount)} ready in cash for the driver.`);
  } else if (order.payment_method) {
    parts.push(
      `Payment: *${String(order.payment_method)
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())}*`
    );
  }

  parts.push('');
  parts.push(DIV);
  if (order.delivery_method === 'pickup') {
    parts.push('*Pickup from Showroom*');
    parts.push('Our team will confirm the pickup date with you.');
  } else {
    parts.push(cod ? '*Delivery — Cash on Delivery*' : '*Delivery*');
    if (order.delivery_date) {
      // delivery_date is a DATE returned as a plain 'YYYY-MM-DD' string (the
      // global pg type-parser override, migration 018) — parsed as local noon
      // so no timezone shift can move it a day.
      const d = new Date(`${String(order.delivery_date).slice(0, 10)}T12:00:00`);
      if (!Number.isNaN(d.getTime())) {
        parts.push(`Date: ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`);
      }
    }
    parts.push(`Address: ${order.delivery_address ? order.delivery_address : '_not recorded — please send us your delivery address_'}`);
  }
  parts.push(DIV);
  parts.push('');
  parts.push('*Please reply to confirm:*');
  parts.push(
    'Reply *YES* if everything above is correct, or tell us what needs changing (name, address, or payment method) and our team will update it.'
  );
  parts.push('');
  parts.push('Thank you for choosing Nidikumba.');

  return parts.join('\n');
}

// Payment receipt: what was received, and what is still owed. Sent when a
// payment is recorded so the customer has a record of an advance — the whole
// point of taking one on a custom order. Never throws, for the same reason
// sendOrderConfirmation doesn't: a payment that is already in the ledger must
// not be reported as failed because WhatsApp was unreachable.
async function sendPaymentReceipt(order, summary, payment) {
  try {
    const { rows } = await pool.query('SELECT id, whatsapp_number, contact_whatsapp_number, channel FROM customers WHERE id=$1', [
      order.customer_id,
    ]);
    if (rows.length === 0) return { sent: false, error: 'customer not found' };
    const customer = rows[0];
    if (!whatsappTarget(customer)) return { sent: false, error: 'customer has no phone number' };

    const money = moneyFormatterFor(order);
    const isRefund = payment.kind === 'refund';
    const balance = Number(summary?.balance_due) || 0;

    const parts = [];
    parts.push(isRefund ? '*Refund Processed — Nidikumba*' : '*Payment Received — Nidikumba*');
    parts.push('');
    if (order.customer_name) parts.push(`Hello ${order.customer_name},`);
    parts.push(
      isRefund
        ? `We have processed a refund of *${money(payment.amount)}* on order *#${order.order_number}*.`
        : `Thank you. We have received your ${payment.kind === 'advance' ? '*advance payment*' : 'payment'} of *${money(payment.amount)}* for order *#${order.order_number}*.`
    );
    parts.push('');
    parts.push('--------------------');
    parts.push(`Order total: ${money(order.total_amount)}`);
    parts.push(`Received so far: ${money(summary?.amount_paid)}`);
    parts.push(balance > 0 ? `*Balance due: ${money(balance)}*` : '*Fully paid — thank you!*');
    parts.push('--------------------');
    if (payment.reference) {
      parts.push('');
      parts.push(`Reference: ${payment.reference}`);
    }
    if (balance > 0 && payment.kind === 'advance') {
      parts.push('');
      parts.push('Your order is now confirmed and we will begin preparing it. The balance is payable on delivery unless agreed otherwise.');
    }
    parts.push('');
    parts.push('Thank you for choosing Nidikumba.');
    const message = parts.join('\n');

    let waSent = false,
      sendError = null;
    try {
      await sendWhatsAppMessage(customer, message);
      waSent = true;
    } catch (err) {
      sendError = err.message;
      console.error(`Payment receipt send FAILED for ${whatsappTarget(customer)}:`, err.message);
    }

    await pool.query(
      `INSERT INTO messages (customer_id, direction, content, sender_type, delivery_failed)
       VALUES ($1,'outbound',$2,'staff',$3)`,
      [order.customer_id, message, !waSent]
    );
    broadcastEvent('message_insert', { customer_id: order.customer_id });

    return { sent: waSent, error: sendError };
  } catch (err) {
    console.error('sendPaymentReceipt failed:', err.message);
    return { sent: false, error: err.message };
  }
}

// Sends the confirmation and logs it like any other outbound message. Never
// throws: an order that is already committed must not be rolled back or
// reported as failed because WhatsApp was unreachable — the caller gets a
// flag instead and the message row records delivery_failed for follow-up.
async function sendOrderConfirmation(order, customerId, customerName) {
  try {
    const { rows } = await pool.query('SELECT id, whatsapp_number, contact_whatsapp_number, channel FROM customers WHERE id=$1', [
      customerId,
    ]);
    if (rows.length === 0) return { sent: false, error: 'customer not found' };
    const customer = rows[0];
    if (!whatsappTarget(customer)) return { sent: false, error: 'customer has no phone number' };

    const message = buildOrderConfirmationMessage(order, customerName);

    let waSent = false,
      sendError = null;
    try {
      await sendWhatsAppMessage(customer, message);
      waSent = true;
    } catch (err) {
      sendError = err.message;
      console.error(`Order confirmation send FAILED for ${customer.whatsapp_number}:`, err.message);
    }

    // Logged either way so the conversation shows what the customer was told
    // (or that the attempt failed), same as POST /api/send-message does.
    await pool.query(
      `INSERT INTO messages (customer_id, direction, content, sender_type, delivery_failed)
       VALUES ($1,'outbound',$2,'staff',$3)`,
      [customerId, message, !waSent]
    );
    broadcastEvent('message_insert', { customer_id: customerId });

    // AI off for this customer, matching POST /api/send-message's existing
    // behaviour (confirmed with the user): the customer's reply is a
    // verification of hand-entered order details, which a human should read.
    await pool.query('UPDATE customers SET ai_enabled=false WHERE id=$1', [customerId]);
    broadcastEvent('customer_update', { id: customerId });

    return { sent: waSent, error: sendError };
  } catch (err) {
    console.error('sendOrderConfirmation failed:', err.message);
    return { sent: false, error: err.message };
  }
}

// ── custom discount (migration 053) ───────────────────────────────────────────
// A discount staff give at their own discretion, ON TOP of the automatic
// volume discount and any promo code. Two things make it different from those:
// it needs a stated reason (DB CHECK orders_custom_discount_needs_reason), and
// when anyone other than an admin gives it the admins are notified. The reason
// is also written into the order's internal notes server-side, so no order
// screen or outside caller can give a discount without leaving that trail.

const CUSTOM_DISCOUNT_UNAVAILABLE =
  'Custom discounts are not available until database migration 053 is applied';

/** Validates a custom discount from a request. amount NULL = none given. */
function parseCustomDiscount(amount, reason) {
  if (amount === undefined || amount === null || amount === '') return { amount: null, reason: null };
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) return { error: 'Custom discount must be a positive amount' };
  if (n === 0) return { amount: null, reason: null };
  const r = typeof reason === 'string' ? reason.trim() : '';
  if (!r) return { error: 'A reason is required for a custom discount' };
  if (r.length > 500) return { error: 'The custom discount reason is too long (500 characters max)' };
  return { amount: Math.round(n * 100) / 100, reason: r };
}

/** Sum of the PAID lines of an order — free items (negative unit_price) excluded. */
function paidItemsSubtotal(items) {
  return (Array.isArray(items) ? items : [])
    .filter((it) => !(it.free === true || (parseFloat(it.unit_price) || 0) < 0))
    .reduce((sum, it) => sum + (parseFloat(it.unit_price) || 0) * (parseInt(it.qty) || 1), 0);
}

const lkrAmount = (v) => `LKR ${(Number(v) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const roleLabel = (role) => String(role || '').replace(/_/g, ' ');

/** The line appended to orders.notes when a custom discount is given, changed or removed. */
function customDiscountNote(staff, { amount, reason, previous }) {
  const date = new Date().toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Colombo',
  });
  const who = `${staff?.name || 'Unknown'} (${roleLabel(staff?.role)})`;
  if (!amount) return `[Custom discount removed] was ${lkrAmount(previous)} — removed by ${who}, ${date}`;
  const head = !previous
    ? `[Custom discount] ${lkrAmount(amount)}`
    : Number(previous) === Number(amount)
      ? `[Custom discount reason updated] ${lkrAmount(amount)}`
      : `[Custom discount changed] ${lkrAmount(previous)} → ${lkrAmount(amount)}`;
  return `${head} by ${who}, ${date} — Reason: ${reason}`;
}

/**
 * Tells every active admin that a non-admin gave a custom discount: a stored
 * staff_notifications row each (so an admin who is offline still sees it),
 * plus a live SSE event to exactly those admins. Never throws — the order is
 * already committed and must not be reported as failed over a notification.
 */
async function notifyCustomDiscount(req, doc, { amount, reason, previous }) {
  if (!schemaFlags.customDiscount || !amount || hasRole(req.staff, 'admin')) return;
  // An order or a quotation (migration 054) — a quotation promises the
  // customer that price just as firmly, so it is reported the same way.
  const isQuote = Boolean(doc.quotation_no);
  if (isQuote && !schemaFlags.quotations) return;
  const ref = isQuote ? `quotation ${doc.quotation_no}` : doc.order_number;
  const col = isQuote ? 'quotation_id' : 'order_id';
  try {
    const title = previous
      ? `${req.staff.name} changed a custom discount on ${ref}`
      : `${req.staff.name} gave a custom discount on ${ref}`;
    const body =
      `${previous ? `${lkrAmount(previous)} → ` : ''}${lkrAmount(amount)} off` +
      `${doc.customer_name ? ` for ${doc.customer_name}` : ''} — Reason: ${reason}`;
    const { rows } = await pool.query(
      `INSERT INTO staff_notifications (recipient_id, actor_id, kind, title, body, ${col})
       SELECT s.id, $1, 'custom_discount', $2, $3, $4
         FROM staff_users s
        WHERE s.active AND s.role IN ('admin', '${SUPER_ADMIN}') AND s.id <> $1
       RETURNING id, recipient_id, created_at`,
      [req.staff.id, title, body, doc.id]
    );
    for (const n of rows) {
      broadcastEvent(
        'notification',
        { id: n.id, kind: 'custom_discount', title, body, [col]: doc.id, created_at: n.created_at },
        (client) => client.staffId === n.recipient_id
      );
    }
  } catch (err) {
    console.error(`Custom discount notification for ${ref} failed:`, err.message);
  }
}

app.post('/api/orders', requireRole('admin', 'sales_agent'), async (req, res) => {
  const {
    customerId,
    customerName,
    customerPhone,
    items,
    totalAmount,
    currency,
    deliveryAddress,
    deliveryDate,
    deliveryMethod,
    paymentMethod,
    specialRequirements,
    notes,
    // Additional contact number for this order (migration 040) — the delivery
    // contact, or someone to call when the main number does not answer.
    // Required: confirmed with the user that every order must carry one.
    secondaryPhone,
    // The enquiry this order came from, when it was created by converting a
    // lead. Populating orders.lead_id is what lets an order show where it came
    // from and lets a customer's history join up — the column has existed
    // since Phase 3 but nothing ever wrote to it.
    leadId,
    // migration 028: a made-to-order item requiring an advance before the
    // order may be confirmed.
    isCustomOrder,
    advanceRequired,
    // migration 046: the discounts this order was actually given. `totalAmount`
    // has always arrived already NET of these, and before 046 they were then
    // discarded — which is why the invoice, having only the gross line items to
    // work from, printed a total higher than the order's own total_amount.
    // Optional: an older or external caller that omits them still places a
    // valid order, it just has no discount recorded.
    promoCode,
    promoDiscount,
    volumeDiscount,
    // migration 057: true when staff untick "Apply volume discount" — the
    // order then carries no volume discount even though the cart qualifies,
    // and the edit screen keeps it off instead of recomputing it.
    volumeDiscountWaived,
    // migration 053: a discount staff give at their discretion, with its
    // reason. Optional — an order without one is unchanged.
    customDiscount,
    customDiscountReason,
    // Opt-out for the automated WhatsApp confirmation. Defaults to sending
    // (undefined => true), so an older or external caller that doesn't know
    // about this flag still gets the confirmation; staff can uncheck it in
    // the order form when the customer is at the counter with a printed
    // receipt or gave an unreachable number.
    sendConfirmation,
  } = req.body;

  if (!customerId) return res.status(400).json({ error: 'customerId required' });

  // A total can never be negative. Free items are stored with a NEGATIVE
  // unit_price so the arithmetic works out, which means a cart of nothing but
  // giveaways sums below zero — the order screens floor it at 0, but the API
  // did not, so a malformed or hostile request could store negative revenue
  // and skew every report that sums this column. Found by testing, not by
  // review: the UI never sends such a body.
  const totalNum = Number(totalAmount);
  if (totalAmount !== undefined && (!Number.isFinite(totalNum) || totalNum < 0)) {
    return res.status(400).json({ error: 'totalAmount cannot be negative' });
  }

  // The customer's name and phone are required on every order: the order is
  // delivered and invoiced against them, and they are what identifies the
  // customer record the order is attached to. Enforced here as well as in the
  // order screens so the rule cannot be bypassed by another caller.
  if (!customerName || !String(customerName).trim()) {
    return res.status(400).json({ error: 'A customer name is required for every order' });
  }
  if (!customerPhone || !String(customerPhone).trim()) {
    return res.status(400).json({ error: 'A customer phone number is required for every order' });
  }

  // Every order must carry a second contact number (migration 040, confirmed
  // with the user). Enforced HERE as well as in the four order screens, so the
  // rule holds for any caller — the screens can be bypassed, this cannot.
  // Validated against the same canonical shape the rest of the system uses, so
  // a typo is rejected now rather than becoming an undialable number later.
  const secondary = normalizePhone(secondaryPhone);
  if (!secondary) {
    return res.status(400).json({ error: 'An additional contact number is required for every order' });
  }
  if (!/^94[0-9]{9}$/.test(secondary)) {
    return res.status(400).json({
      error: 'The additional contact number does not look like a Sri Lankan mobile number (e.g. 0771234567)',
    });
  }

  // Cash on Delivery (migration 026) is one arrangement spanning both fields:
  // the goods travel by delivery AND the cash is collected at handover, so it
  // implies payment_method='cash'. Normalized here rather than rejected —
  // every dashboard flow already sends 'cash' with it, and the DB constraint
  // orders_cod_requires_cash_payment would otherwise surface as a raw 500 for
  // any other caller. payment_status is deliberately left at its 'pending'
  // default: a COD order genuinely isn't paid until the delivery is confirmed,
  // which the existing delivered-requires-paid flow already handles.
  const resolvedDeliveryMethod = deliveryMethod || 'delivery';
  const resolvedPaymentMethod = resolvedDeliveryMethod === 'cash_on_delivery' ? 'cash' : paymentMethod || 'cash';

  // ── discounts (migration 046) ───────────────────────────────────────────────
  // NULL means "no discount of this kind was given", which is deliberately
  // distinct from 0 — so a caller that omits the field is not recorded as
  // having computed a zero discount. A non-positive or unparseable value
  // collapses to NULL rather than being stored: the DB CHECK rejects negatives
  // outright, and storing 0 would print a pointless "- LKR 0" line.
  const toDiscount = v => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const promoAmount = toDiscount(promoDiscount);
  if (volumeDiscountWaived !== undefined && typeof volumeDiscountWaived !== 'boolean') {
    return res.status(400).json({ error: 'volumeDiscountWaived must be true or false' });
  }
  const volumeWaived = volumeDiscountWaived === true;
  if (volumeWaived && !schemaFlags.volumeWaiver) {
    return res.status(503).json({ error: VOLUME_WAIVER_UNAVAILABLE });
  }
  // Waived wins over any amount the screen sent: the two cannot both be true
  // (DB CHECK, migration 057).
  const volumeAmount = volumeWaived ? null : toDiscount(volumeDiscount);
  // A promo amount without its code cannot be printed on an invoice, and the
  // DB enforces that pairing — so drop the amount rather than let the INSERT
  // fail and lose the whole order over a missing label.
  const promoLabel = typeof promoCode === 'string' && promoCode.trim() ? promoCode.trim() : null;
  const storedPromo = promoLabel ? promoAmount : null;

  // Custom discount (migration 053). Refused rather than dropped when invalid:
  // unlike a missing promo label, a discount without a reason is exactly what
  // this feature exists to prevent, and dropping it would bill the customer a
  // price they were not quoted.
  const custom = parseCustomDiscount(customDiscount, customDiscountReason);
  if (custom.error) return res.status(400).json({ error: custom.error });
  if (custom.amount && !schemaFlags.customDiscount) {
    return res.status(503).json({ error: CUSTOM_DISCOUNT_UNAVAILABLE });
  }
  if (custom.amount) {
    const room = paidItemsSubtotal(items) - (volumeAmount || 0) - (storedPromo || 0);
    if (custom.amount > Math.max(0, room)) {
      return res.status(400).json({ error: 'The custom discount is larger than what is left to pay on the order' });
    }
  }
  const discountTotal = (storedPromo || 0) + (volumeAmount || 0) + (custom.amount || 0) || null;
  // Server-written, so the trail cannot be skipped by any caller.
  const finalNotes = custom.amount
    ? [notes && String(notes).trim(), customDiscountNote(req.staff, { amount: custom.amount, reason: custom.reason })]
        .filter(Boolean)
        .join('\n')
    : notes || null;
  // Only named when used, so an order without one still inserts on a database
  // that does not have migration 053 yet.
  let customCols = custom.amount
    ? ', custom_discount, custom_discount_reason, custom_discount_by, custom_discount_at'
    : '';
  const customVals = custom.amount ? [custom.amount, custom.reason, req.staff.id, new Date().toISOString()] : [];
  // Same idea for 057: only named when set, so an ordinary order still
  // inserts on a database without the column.
  if (volumeWaived) {
    customCols += ', volume_discount_waived';
    customVals.push(true);
  }
  // 058: who placed it — always the logged-in staff member, never the body.
  if (schemaFlags.orderPlacedBy) {
    customCols += ', placed_by';
    customVals.push(req.staff.id);
  }

  // The lead this order converts must be THIS customer's, and one the caller
  // may see. Without the check any agent could pass another agent's (or
  // another customer's) lead id: the order would close that lead as won, be
  // credited to its agent's revenue (v_staff_performance joins orders.lead_id)
  // and appear in that agent's order list (058's lead rule).
  if (leadId) {
    if (!UUID_RE.test(String(leadId))) return res.status(400).json({ error: 'leadId is not valid' });
    try {
      const leadParams = [leadId, customerId];
      const { rows: leadRows } = await pool.query(
        `SELECT l.id FROM leads l WHERE l.id = $1 AND l.customer_id = $2${callVisibilityFilter(req, leadParams)}`,
        leadParams
      );
      if (leadRows.length === 0) {
        return res.status(400).json({
          error: "This enquiry belongs to a different customer (phone number), or isn't one you can see. Use the enquiry's own number, or place the order without converting the enquiry.",
        });
      }
    } catch (err) {
      console.error('POST /api/orders lead check failed:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO orders (
        customer_id, customer_name, customer_phone,
        items, total_amount, currency,
        delivery_address, delivery_date, delivery_method,
        payment_method, special_requirements, notes,
        is_custom_order, advance_required, lead_id, secondary_phone,
        promo_code, promo_discount, volume_discount, discount_total${customCols}
      ) VALUES (${Array.from({ length: 20 + customVals.length }, (_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
      [
        customerId,
        customerName || null,
        customerPhone || null,
        JSON.stringify(items || []),
        totalAmount || 0,
        currency || 'LKR',
        deliveryAddress || null,
        deliveryDate || null,
        resolvedDeliveryMethod,
        resolvedPaymentMethod,
        specialRequirements || null,
        finalNotes,
        !!isCustomOrder,
        // An advance is allowed on ANY order (migration 034), not just a
        // custom one: a customer may pay part up front and the balance cash
        // on delivery. It used to be silently dropped unless isCustomOrder,
        // matching a constraint that no longer exists.
        Number.isFinite(Number(advanceRequired)) && Number(advanceRequired) > 0 ? Number(advanceRequired) : null,
        leadId || null,
        secondary,
        promoLabel,
        storedPromo,
        volumeAmount,
        discountTotal,
        ...customVals,
      ]
    );
    let order = rows[0];
    if (order.placed_by) order.placed_by_name = req.staff.name;

    if (custom.amount) {
      recordAuditEvent(req, 'order.custom_discount', { order_id: order.id, amount: custom.amount });
      await notifyCustomDiscount(req, order, { amount: custom.amount, reason: custom.reason });
    }

    // An advance typed on the order screen MEANS the money was taken — staff
    // only enter it because the customer just handed it over at the counter.
    // So record it in the ledger straight away rather than storing an
    // "agreed" figure that someone has to go and confirm separately: there is
    // no Payments UI to do that in, which is why the old advance gate had to
    // be removed. trg_order_payment_change then derives payment_status
    // ('partial') and amount_paid from this row, so the order, the COD
    // balance and the invoice all agree with no further action.
    if (order.advance_required != null && Number(order.advance_required) > 0) {
      await pool.query(
        `INSERT INTO order_payments (order_id, amount, method, kind, note, paid_at, recorded_by)
         VALUES ($1, $2, $3, 'advance', 'Advance taken when the order was placed', NOW(), $4)`,
        [order.id, Number(order.advance_required), order.payment_method || 'cash', req.staff.id]
      );
      // Re-read so the response carries the derived payment_status and
      // amount_paid rather than the pre-trigger values.
      const { rows: fresh } = await pool.query('SELECT * FROM orders WHERE id=$1', [order.id]);
      if (fresh.length > 0) order = fresh[0];
    }

    // Converting an enquiry into an order finishes that enquiry: it is marked
    // won and its ticket CLOSED, which is what takes it off the Pipeline
    // (GET /api/leads defaults to ticket_state='open'). The lead is not
    // deleted — orders.lead_id above keeps the link, so the order can show
    // where it came from and the customer's history still joins up.
    //
    // A later call or message from the same customer opens a FRESH ticket on
    // its own: getOrCreateOpenTicket() only ever reuses a ticket that is still
    // open, so closing this one is exactly what makes the customer's next
    // contact start a new enquiry rather than reopening a finished sale.
    //
    // Never fails the order: the sale is already committed, and a lead that
    // stays open is a tidy-up problem, not a lost order.
    if (leadId) {
      try {
        await pool.query(
          `UPDATE leads
              SET status = 'won',
                  ticket_state = 'closed',
                  closed_at = NOW(),
                  closed_reason = COALESCE(closed_reason, 'Converted to order ' || $2),
                  updated_at = NOW()
            WHERE id = $1 AND ticket_state = 'open'`,
          [leadId, order.order_number]
        );
        broadcastEvent('lead_update', { id: leadId });
      } catch (err) {
        console.error(`Order ${order.order_number} created but lead ${leadId} could not be closed:`, err.message);
      }
    }

    // Verification message to the customer's WhatsApp. Awaited so the
    // response can tell the UI whether it actually went out, but its failure
    // never fails the order — sendOrderConfirmation swallows its own errors
    // and records delivery_failed on the logged message instead.
    let confirmation = { sent: false, skipped: true };
    if (sendConfirmation !== false) {
      confirmation = await sendOrderConfirmation(order, customerId, customerName);
    }

    res.json({ success: true, order, confirmation });
  } catch (err) {
    console.error('POST /api/orders failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Deliberately open to every authenticated role, including
// delivery_coordinator: /orders is that role's landing page and the list is
// how they reach an order's delivery screen (OrdersPage.jsx routes them to
// /orders/:id/delivery on row click). Gating this to the finance/sales roles
// would break their only workflow. The sensitive operations on an order are
// gated individually instead: the invoice, the payment ledger, and each
// field group inside PATCH /api/orders/:id.
// Fields a delivery_coordinator has no use for, stripped from order responses
// (2026-09-10 audit, Phase 7 response minimization). That role legitimately
// reads an order — /orders is its landing page and the row click opens the
// delivery screen — and genuinely needs total_amount and payment_status to
// collect Cash on Delivery. But it is blocked from the invoice and the payment
// ledger, so returning the internal money trail alongside is inconsistent.
//
// Verified against the two screens that role actually sees
// (OrdersPage.jsx, OrderDeliveryPage.jsx): neither renders any of these, so
// removing them changes nothing visible.
const DELIVERY_HIDDEN_ORDER_FIELDS = ['amount_paid', 'advance_required', 'is_custom_order', 'notes', 'lead_id'];

function minimizeOrderForRole(order, role) {
  if (role !== 'delivery_coordinator' || !order) return order;
  const out = { ...order };
  for (const f of DELIVERY_HIDDEN_ORDER_FIELDS) delete out[f];
  return out;
}

// Who placed the order (058), and — for orders with no recorded placer — the
// agent of the lead it came from, so admins can still see whose it was.
function placedByJoins() {
  return schemaFlags.orderPlacedBy
    ? `LEFT JOIN staff_users ps ON ps.id = o.placed_by
      LEFT JOIN leads_all pl ON pl.id = o.lead_id
      LEFT JOIN staff_users pls ON pls.id = pl.assigned_staff_id`
    : `LEFT JOIN leads_all pl ON pl.id = o.lead_id
      LEFT JOIN staff_users pls ON pls.id = pl.assigned_staff_id`;
}
function placedByCols() {
  return schemaFlags.orderPlacedBy
    ? 'ps.name AS placed_by_name, pls.name AS lead_staff_name'
    : 'NULL::text AS placed_by_name, pls.name AS lead_staff_name';
}

// A sales agent gets only their own orders (orderVisibilityFilter, 058). An
// admin/viewer may narrow to one placer with ?placedBy=<uuid> or 'none'.
app.get('/api/orders', requireRole(...STAFF_ROLES), async (req, res) => {
  try {
    const params = [];
    let where = `WHERE true${orderVisibilityFilter(req, params)}`;
    if (isUnrestricted(req) && schemaFlags.orderPlacedBy && req.query.placedBy) {
      if (req.query.placedBy === 'none') {
        where += ' AND o.placed_by IS NULL';
      } else if (UUID_RE.test(req.query.placedBy)) {
        params.push(req.query.placedBy);
        where += ` AND o.placed_by = $${params.length}`;
      }
    }
    const { rows } = await pool.query(
      `
      SELECT o.*, ${placedByCols()},
        json_build_object('id', c.id, 'whatsapp_number', c.whatsapp_number, 'name', c.name) as customers
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      ${placedByJoins()}
      ${where}
      ORDER BY o.created_at DESC
    `,
      params
    );
    res.json({ orders: rows.map((o) => minimizeOrderForRole(o, req.staff.role)) });
  } catch (err) {
    console.error('GET /api/orders failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Same reasoning as the list above — OrderDeliveryPage fetches this directly.
app.get('/api/orders/:id', requireRole(...STAFF_ROLES), async (req, res) => {
  try {
    const params = [req.params.id];
    const { rows } = await pool.query(
      `
      SELECT o.*, ${placedByCols()},
        json_build_object('id', c.id, 'whatsapp_number', c.whatsapp_number, 'name', c.name) as customers
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      ${placedByJoins()}
      WHERE o.id=$1${orderVisibilityFilter(req, params)}
    `,
      params
    );

    if (rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    res.json({ order: minimizeOrderForRole(rows[0], req.staff.role) });
  } catch (err) {
    console.error('GET /api/orders/:id failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /api/orders/:id ─────────────────────────────────────────────────────
// Field-level split per Section 5.1: Finance/Admin own payment fields (REQ-3.5),
// Sales Agent/Admin own pricing/items, Delivery Coordinator is restricted to
// status + delivery_date + delivery_address only (no pricing, no payment,
// no delivery_method/time_slot/driver/notes — narrowed further per a
// dedicated delivery-coordinator order page, see OrderDeliveryPage.jsx).
app.patch('/api/orders/:id', requireRole('admin', 'sales_agent', 'finance', 'delivery_coordinator'), requireOrderVisible, async (req, res) => {
  const allowed = [
    'status',
    'payment_status',
    'delivery_address',
    'delivery_date',
    'delivery_method',
    'payment_method',
    'special_requirements',
    'notes',
    'items',
    'total_amount',
    'customer_name',
    'customer_phone',
    // Editable after placement: the delivery contact can change before the
    // order ships. The DB CHECK keeps it canonical either way.
    'secondary_phone',
    'tax_invoice_no',
    'delivery_time_slot',
    'delivery_driver',
    'delivery_confirmation_note',
    // migration 028 — made-to-order flag; migration 034 — the advance,
    // which is allowed on ANY order, not only a custom one
    'is_custom_order',
    'advance_required',
    // migration 046 — editable after placement, so a promo code can be added,
    // changed or removed and the volume discount follows the edited cart.
    'promo_code',
    'promo_discount',
    'volume_discount',
    'discount_total',
    // migration 053 — staff-given discount; its _by/_at are stamped server-side.
    'custom_discount',
    'custom_discount_reason',
    // migration 057 — staff chose not to give the volume discount.
    'volume_discount_waived',
  ];

  const paymentFields = ['payment_status', 'payment_method'];
  // customer_name/customer_phone are grouped with pricing rather than left
  // ungated (2026-09-10 audit): finance could otherwise rewrite the customer
  // identity on any order, and orders.customer_phone is where the order
  // confirmation and payment receipt are SENT — so an edit there redirects a
  // customer's messages.
  const pricingFields = [
    'items', 'total_amount', 'customer_name', 'customer_phone',
    'promo_code', 'promo_discount', 'volume_discount', 'discount_total',
    'custom_discount', 'custom_discount_reason', 'volume_discount_waived',
  ];

  // secondary_phone is deliberately NOT in pricingFields, unlike customer_phone
  // directly above. The reason customer_phone is gated is that it is where the
  // order confirmation and payment receipt are SENT, so editing it redirects a
  // customer's messages. secondary_phone is never a send target — nothing
  // messages it, it is a number for a human to dial — so gating it the same way
  // would only stop a delivery_coordinator fixing the contact number for a
  // delivery they are about to make, which is exactly who needs to.

  // NOTE on advance_required: it is in `allowed` but deliberately in NEITHER
  // group, so a sales_agent can set it. The 2026-09-10 audit flagged this as a
  // bypass of the payment/pricing split — setting it inserts a real
  // order_payments row (see below), and trg_order_payment_change then derives
  // payment_status, which a sales_agent is otherwise 403'd from writing.
  //
  // Confirmed with the user and KEPT: sales agents take advances at the
  // counter, so this is the intended workflow, and POST /api/orders/:id/payments
  // already grants that role ledger writes for the same reason. Documented here
  // rather than left looking like an oversight — the tradeoff is real, and the
  // mitigations are that every ledger row records recorded_by and the write is
  // audit-logged. Do not "fix" this by moving the field without checking how
  // counter advances are actually taken.
  const touchesPricing = pricingFields.some((f) => req.body[f] !== undefined);

  // Marking an order PAID is now open to sales_agent as well as admin/finance
  // (confirmed with the user), because the agent at the counter is who takes
  // the money and holds the invoice book. It is gated on evidence instead of
  // role: every transition into 'paid' must carry a Tax Invoice number, from
  // anyone. Every other payment edit — a method change, moving OFF paid, a
  // refund — stays admin/finance, since those are not evidenced by an invoice.
  const markingPaid = req.body.payment_status === 'paid';
  const otherPaymentEdit = paymentFields.some(
    (f) => req.body[f] !== undefined && !(f === 'payment_status' && markingPaid)
  );
  const paidRoles = ['admin', 'finance', 'sales_agent'];

  if (markingPaid && !hasRole(req.staff, ...paidRoles)) {
    return res.status(403).json({ error: 'Only Sales, Finance or Admin can mark an order paid' });
  }
  // A sales_agent may change the payment METHOD (they choose it when placing
  // the order) but only while the order is not yet paid — confirmed with the
  // user. Once paid, the method is part of a settled record, so it stays
  // admin/finance, as does every other payment edit.
  const onlyMethodEdit = req.body.payment_method !== undefined
    && (req.body.payment_status === undefined || markingPaid);
  let currentPaymentStatus = null;
  if (hasRole(req.staff, 'sales_agent') && !hasRole(req.staff, 'admin', 'finance')
      && (onlyMethodEdit || req.body.delivery_method === 'cash_on_delivery')) {
    const { rows: cur } = await pool.query('SELECT payment_status FROM orders WHERE id=$1', [req.params.id]);
    if (cur.length === 0) return res.status(404).json({ error: 'Order not found' });
    currentPaymentStatus = cur[0].payment_status;
  }
  const agentMayEditMethod = currentPaymentStatus !== null && currentPaymentStatus !== 'paid';
  if (otherPaymentEdit && !hasRole(req.staff, 'admin', 'finance') && !(onlyMethodEdit && agentMayEditMethod)) {
    return res.status(403).json({
      error: onlyMethodEdit && currentPaymentStatus === 'paid'
        ? 'This order is already paid — only Finance or Admin can change its payment method'
        : 'Only Finance or Admin can modify payment fields',
    });
  }
  if (touchesPricing && !hasRole(req.staff, 'admin', 'sales_agent')) {
    return res.status(403).json({ error: 'Only Sales Agent or Admin can modify order items/pricing' });
  }

  if (req.staff.role === 'delivery_coordinator') {
    // Narrowed further (confirmed with the user): status, delivery date,
    // and delivery address only — no delivery_method/time_slot/driver, no
    // notes. delivery_confirmation_note is the one exception, needed only
    // to satisfy orders_delivered_requires_confirmation_note when they set
    // status='delivered' — not a separately editable field otherwise.
    const deliveryAllowed = ['status', 'delivery_address', 'delivery_date', 'delivery_confirmation_note'];
    const disallowed = allowed.filter((k) => req.body[k] !== undefined && !deliveryAllowed.includes(k));
    if (disallowed.length > 0) {
      return res.status(403).json({ error: `Delivery Coordinator cannot modify: ${disallowed.join(', ')}` });
    }
  }

  // Same rule as POST /api/orders: a total can never be negative. Editing an
  // order is a different code path, so the guard is needed in both — PATCH
  // accepted -999 while POST already rejected it.
  if (req.body.total_amount !== undefined) {
    const t = Number(req.body.total_amount);
    if (!Number.isFinite(t) || t < 0) {
      return res.status(400).json({ error: 'total_amount cannot be negative' });
    }
  }

  const updates = { updated_at: new Date().toISOString() };

  // The evidence rule. A Tax Invoice number is required to mark an order paid —
  // it may come in this same request, or already be on the order from an
  // earlier one. Checked against the stored row so re-saving an order that is
  // already paid does not demand the number again.
  if (markingPaid) {
    const supplied = (req.body.tax_invoice_no || '').trim();
    const { rows: cur } = await pool.query(
      'SELECT payment_status, tax_invoice_no FROM orders WHERE id=$1',
      [req.params.id]
    );
    if (cur.length === 0) return res.status(404).json({ error: 'Order not found' });
    const alreadyPaid = cur[0].payment_status === 'paid';
    const existing = (cur[0].tax_invoice_no || '').trim();

    if (!alreadyPaid && !supplied && !existing) {
      return res.status(400).json({
        error: 'A Tax Invoice number is required to mark an order as paid',
      });
    }
    if (!alreadyPaid) {
      // Stamp who marked it and when, so the evidence has an author. Not
      // derivable from the activity log alone, which records the change but is
      // not joined into the order screen.
      updates.tax_invoice_no = supplied || existing;
      updates.paid_marked_by = req.staff.id;
      updates.paid_marked_at = new Date().toISOString();
    }
  }
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = key === 'items' ? JSON.stringify(req.body[key]) : req.body[key];
  }

  // Cash on Delivery (migration 026) requires payment_method='cash' — the two
  // fields describe one real arrangement and must not contradict, enforced by
  // orders_cod_requires_cash_payment. Switching an order INTO COD therefore
  // writes a payment field, so it needs the same admin/finance rights the
  // payment checks above already demand for payment edits — otherwise
  // sending delivery_method alone would slip past that check and have
  // payment_method written on the caller's behalf. Rejected explicitly rather
  // than left to surface as a raw 500 from the constraint. An order already
  // stored as COD can still have its date/address edited by anyone allowed to,
  // since that leaves the pairing untouched.
  if (updates.delivery_method === 'cash_on_delivery') {
    if (!hasRole(req.staff, 'admin', 'finance') && !agentMayEditMethod) {
      return res
        .status(403)
        .json({ error: 'Only Finance or Admin can set a paid order to Cash on Delivery (it sets the payment method to cash)' });
    }
    if (updates.payment_method !== undefined && updates.payment_method !== 'cash') {
      return res.status(400).json({ error: "Cash on Delivery requires payment_method 'cash'" });
    }
    updates.payment_method = 'cash';
  }

  // NOTE: an unpaid advance no longer blocks confirmation.
  //
  // Until migration 034 this route refused to move an order out of 'pending'
  // while advance_required was not yet satisfied (v_order_payment_summary
  // .advance_satisfied, counting real order_payments rows of kind='advance').
  // Removed at the user's request, because there is NO dashboard UI for
  // recording a payment — POST /api/orders/:id/payments has been
  // backend-only since migration 028 — so the gate blocked staff with no way
  // to clear it.
  //
  // advance_required is still stored, still shown on the order and still
  // deducted on the invoice; it is simply advisory now. Restore the gate here
  // once a Payments UI exists, otherwise a custom order can go into
  // production before its deposit is in — which is what the rule was for.

  // Marking an order delivered is exactly when Cash on Delivery cash changes
  // hands, so the payment is recorded here rather than demanded from the
  // client. This matters because orders_delivered_requires_paid means
  // status='delivered' is only legal with payment_status='paid', while a
  // delivery_coordinator is forbidden from sending payment fields at all —
  // without this they could never complete a delivery, and a COD order is
  // unpaid by definition right up to the handover. Only fills in what the
  // caller did not set explicitly, so a finance user recording a partial or
  // refunded amount still wins.
  if (updates.status === 'delivered' && updates.payment_status === undefined) {
    const { rows: existing } = await pool.query(
      'SELECT total_amount, payment_status, amount_paid, payment_method, delivery_method FROM orders WHERE id=$1',
      [req.params.id]
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Order not found' });

    // Gated on Cash on Delivery. This used to fire on EVERY order, so a
    // card-prepaid or disputed order marked delivered was silently recorded as
    // fully collected in cash, in the delivery coordinator's name (found by the
    // 2026-09-10 audit). COD is the only arrangement where money genuinely
    // changes hands at the door; for anything else the payment must already be
    // recorded, and orders_delivered_requires_paid then refuses the transition
    // with a clear constraint error rather than inventing a payment.
    const isCodOrder = existing[0].delivery_method === 'cash_on_delivery';

    if (existing[0].payment_status !== 'paid' && isCodOrder) {
      const deliveredMethod = existing[0].payment_method || 'cash';
      const total = Number(existing[0].total_amount) || 0;
      const paid = Number(existing[0].amount_paid) || 0;
      const owing = total - paid;

      // Record the money handed over as a REAL ledger row rather than only
      // moving amount_paid, so the ledger is a true statement: an order
      // part-paid by advance and settled at the door shows both payments,
      // which is exactly what a customer or an auditor asks about. Writing
      // amount_paid directly also fought trg_order_payment_change, which
      // DERIVES amount_paid and payment_status from order_payments — the two
      // would disagree the moment anyone touched the ledger afterwards.
      if (owing > 0) {
        await pool.query(
          `INSERT INTO order_payments (order_id, amount, method, kind, note, paid_at, recorded_by)
           VALUES ($1, $2, $3, 'balance', $4, NOW(), $5)`,
          [
            req.params.id,
            owing,
            // Whatever the order says it is paid by; order_payments.method
            // has its own CHECK, and a COD order is pinned to cash already by
            // orders_cod_requires_cash_payment.
            deliveredMethod,
            paid > 0 ? 'Balance collected on delivery' : 'Collected on delivery',
            req.staff.id,
          ]
        );
        // The trigger has now derived payment_status and amount_paid from the
        // ledger, so neither is sent in this PATCH.
      } else {
        // Nothing outstanding but the status still says otherwise — set it
        // directly, since there is no payment to record.
        updates.payment_status = 'paid';
      }
    }
  }

  // Promo code edited after placement. Checked BEFORE the order is written, so
  // an expired, capped or already-used code is refused with its real reason
  // instead of saving a discount the customer is not entitled to. The actual
  // redemption (which uses up a slot) happens after the UPDATE succeeds.
  let promoChange = null;
  // migration 057. Waiving clears the volume discount in the same write (the
  // DB refuses both at once), and discount_total is then recomputed below
  // because volume_discount is one of the discount fields.
  if (updates.volume_discount_waived !== undefined) {
    if (typeof updates.volume_discount_waived !== 'boolean') {
      return res.status(400).json({ error: 'volume_discount_waived must be true or false' });
    }
    if (!schemaFlags.volumeWaiver) {
      if (updates.volume_discount_waived) return res.status(503).json({ error: VOLUME_WAIVER_UNAVAILABLE });
      delete updates.volume_discount_waived; // false is the only value an old database has
    } else if (updates.volume_discount_waived) {
      updates.volume_discount = null;
    }
  }

  if (updates.promo_code !== undefined) {
    const nextCode = updates.promo_code ? String(updates.promo_code).trim().toUpperCase() : null;
    updates.promo_code = nextCode;
    const { rows: cur } = await pool.query(
      'SELECT promo_code, customer_phone, items, volume_discount FROM orders WHERE id=$1',
      [req.params.id]
    );
    if (cur.length === 0) return res.status(404).json({ error: 'Order not found' });
    const prevCode = cur[0].promo_code ? String(cur[0].promo_code).trim().toUpperCase() : null;
    if (nextCode !== prevCode) {
      promoChange = { prevCode, nextCode, phone: updates.customer_phone || cur[0].customer_phone };
      if (nextCode) {
        if (!promoChange.phone) {
          return res.status(400).json({ error: 'The order has no customer phone, so a promo code cannot be applied' });
        }
        const { rows: v } = await pool.query('SELECT * FROM validate_promo_code($1, $2)', [nextCode, promoChange.phone]);
        if (!v[0]?.valid) return res.status(400).json({ error: v[0]?.message || 'Invalid promo code' });
        const { rows: pr } = await pool.query(
          'SELECT eligible_product_names, discount_scope FROM promo_codes WHERE id=$1',
          [v[0].promo_code_id]
        );
        // The discountable amount: paid lines less the volume discount, scoped
        // to the code's products if it has any — the same figure the order
        // screens redeem against at placement.
        const items = req.body.items !== undefined ? req.body.items : cur[0].items;
        const paidLines = (Array.isArray(items) ? items : []).filter(
          (it) => !(it.free === true || (parseFloat(it.unit_price) || 0) < 0)
        );
        const paid = paidLines.reduce((sum, it) => sum + (parseFloat(it.unit_price) || 0) * (parseInt(it.qty) || 1), 0);
        const vol = Number(updates.volume_discount !== undefined ? updates.volume_discount : cur[0].volume_discount) || 0;
        promoChange.eligibleTotal = computeEligibleSubtotal(paidLines, pr[0]?.eligible_product_names, Math.max(0, paid - vol));
        promoChange.units = await resolvePromoUnits(pr[0], paidLines);
      }
    }
  }
  // A promo amount cannot be stored without its code (DB CHECK, migration 046).
  if (updates.promo_code === null) updates.promo_discount = null;

  // Custom discount edited after placement (migration 053). The note and the
  // admin notification fire only on a real change, so re-saving an order with
  // the same discount adds nothing. discount_total is recomputed here from the
  // merged values rather than trusted from the client, because it is the
  // figure the invoice reconciles against.
  let customChange = null;
  if (updates.custom_discount !== undefined || updates.custom_discount_reason !== undefined) {
    if (!schemaFlags.customDiscount) return res.status(503).json({ error: CUSTOM_DISCOUNT_UNAVAILABLE });
    const { rows: cur } = await pool.query(
      `SELECT order_number, customer_name, items, volume_discount, promo_discount,
              custom_discount, custom_discount_reason
         FROM orders WHERE id=$1`,
      [req.params.id]
    );
    if (cur.length === 0) return res.status(404).json({ error: 'Order not found' });
    const c = cur[0];
    const nextAmountRaw = updates.custom_discount !== undefined ? updates.custom_discount : c.custom_discount;
    const nextReasonRaw = updates.custom_discount_reason !== undefined ? updates.custom_discount_reason : c.custom_discount_reason;
    const next = parseCustomDiscount(nextAmountRaw, nextReasonRaw);
    if (next.error) return res.status(400).json({ error: next.error });

    const pick = (k) => Number(updates[k] !== undefined ? updates[k] : c[k]) || 0;
    const items = req.body.items !== undefined ? req.body.items : c.items;
    if (next.amount && next.amount > Math.max(0, paidItemsSubtotal(items) - pick('volume_discount') - pick('promo_discount'))) {
      return res.status(400).json({ error: 'The custom discount is larger than what is left to pay on the order' });
    }

    const prevAmount = Number(c.custom_discount) || 0;
    const amountChanged = Math.round((next.amount || 0) * 100) !== Math.round(prevAmount * 100);
    const reasonChanged = (next.reason || '') !== (c.custom_discount_reason || '');
    updates.custom_discount = next.amount;
    updates.custom_discount_reason = next.reason;
    if (amountChanged || reasonChanged) {
      updates.custom_discount_by = next.amount ? req.staff.id : null;
      updates.custom_discount_at = next.amount ? new Date().toISOString() : null;
      customChange = {
        amount: next.amount,
        reason: next.reason,
        previous: prevAmount || null,
        amountChanged,
      };
    }
  }
  // Recomputed in SQL after the write (below) whenever any discount changes,
  // so a client that sends volume + promo only cannot drop a custom discount.
  const touchesDiscounts = ['promo_code', 'promo_discount', 'volume_discount', 'discount_total', 'custom_discount', 'volume_discount_waived']
    .some((k) => updates[k] !== undefined);

  const entries = Object.entries(updates);
  const setClauses = entries.map(([k], i) => `${k}=$${i + 1}`).join(', ');
  const vals = [...entries.map(([, v]) => v), req.params.id];

  try {
    const { rows } = await pool.query(`UPDATE orders SET ${setClauses} WHERE id=$${entries.length + 1} RETURNING *`, vals);
    if (rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    let order = rows[0];

    if (touchesDiscounts && schemaFlags.customDiscount) {
      const { rows: dt } = await pool.query(
        `UPDATE orders
            SET discount_total = NULLIF(COALESCE(volume_discount,0) + COALESCE(promo_discount,0) + COALESCE(custom_discount,0), 0)
          WHERE id=$1 RETURNING *`,
        [req.params.id]
      );
      if (dt.length > 0) order = dt[0];
    }

    // The internal-notes trail and the admin notification for a custom
    // discount change. Appended in SQL so it lands after whatever `notes`
    // this same request may have written.
    if (customChange) {
      const line = customDiscountNote(req.staff, customChange);
      const { rows: nr } = await pool.query(
        `UPDATE orders SET notes = concat_ws(E'\\n', NULLIF(btrim(notes), ''), $2::text)
          WHERE id=$1 RETURNING *`,
        [req.params.id, line]
      );
      if (nr.length > 0) order = nr[0];
      recordAuditEvent(req, 'order.custom_discount', {
        order_id: order.id, amount: customChange.amount, previous: customChange.previous,
      });
      if (customChange.amountChanged) await notifyCustomDiscount(req, order, customChange);
    }

    if (promoChange) {
      // The old code's redemption on THIS order is given back, the same way
      // deleting an order does, so its usage count and the influencer's
      // commission stop counting a discount the order no longer has.
      if (promoChange.prevCode) {
        await pool.query(
          `WITH gone AS (
             DELETE FROM promo_code_redemptions r
              USING promo_codes pc
              WHERE r.order_id = $1 AND r.promo_code_id = pc.id AND upper(pc.code) = $2
          RETURNING r.promo_code_id
           )
           UPDATE promo_codes pc SET redemption_count = GREATEST(0, pc.redemption_count - agg.n)
             FROM (SELECT promo_code_id, count(*) AS n FROM gone GROUP BY promo_code_id) agg
            WHERE pc.id = agg.promo_code_id`,
          [req.params.id, promoChange.prevCode]
        );
      }
      if (promoChange.nextCode) {
        // Redeemed and linked to the order here, server-side, so the link does
        // not depend on the admin/finance-only redemption PATCH route — the
        // one that silently fails for the sales agents placing orders.
        const { rows: red } = await pool.query(
          'SELECT * FROM redeem_promo_code($1, $2, $3, $4)',
          [promoChange.nextCode, promoChange.phone, promoChange.eligibleTotal, promoChange.units ?? 1]
        );
        if (red[0]?.success) {
          await pool.query('UPDATE promo_code_redemptions SET order_id=$1 WHERE id=$2', [req.params.id, red[0].redemption_id]);
          // If the real discount differs from the one previewed, the stored
          // figures follow the real one so the total is never wrong.
          const actual = Number(red[0].discount_amount) || 0;
          const shown = Number(order.promo_discount) || 0;
          if (Math.round(actual * 100) !== Math.round(shown * 100)) {
            const { rows: fixed } = await pool.query(
              `UPDATE orders SET promo_discount=$2::numeric,
                      discount_total=COALESCE(volume_discount,0)+$2::numeric${schemaFlags.customDiscount ? '+COALESCE(custom_discount,0)' : ''},
                      total_amount=GREATEST(0, total_amount + $3::numeric - $2::numeric)
                WHERE id=$1 RETURNING *`,
              [req.params.id, actual, shown]
            );
            if (fixed.length > 0) order = fixed[0];
          }
        } else {
          // Lost a race for the last slot between the check and now. The order
          // edit stands (same rule as at placement); staff are told.
          console.warn(`Order ${order.order_number}: promo ${promoChange.nextCode} not redeemed — ${red[0]?.message}`);
          order = { ...order, promo_warning: red[0]?.message || 'Promo code could not be redeemed' };
        }
      }
    }

    // Editing the advance means money changed hands, same as on creation.
    // Only the DIFFERENCE is recorded, against advances already in the
    // ledger, so re-saving the order without touching the field adds nothing
    // and raising 20,000 to 30,000 records 10,000 rather than a second
    // 30,000. A REDUCTION is deliberately not auto-reversed: taking money
    // back is a refund, which is a real decision with its own ledger kind,
    // not a side effect of correcting a number.
    if (updates.advance_required !== undefined && Number(updates.advance_required) > 0) {
      const { rows: sum } = await pool.query(
        `SELECT COALESCE(SUM(amount), 0) AS advanced
         FROM order_payments WHERE order_id = $1 AND kind = 'advance'`,
        [req.params.id]
      );
      const already = Number(sum[0]?.advanced) || 0;
      const delta = Number(updates.advance_required) - already;
      if (delta > 0) {
        await pool.query(
          `INSERT INTO order_payments (order_id, amount, method, kind, note, paid_at, recorded_by)
           VALUES ($1, $2, $3, 'advance', $4, NOW(), $5)`,
          [req.params.id, delta, order.payment_method || 'cash', already > 0 ? 'Additional advance taken' : 'Advance taken', req.staff.id]
        );
        const { rows: fresh } = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
        if (fresh.length > 0) order = fresh[0];
      }
    }

    res.json({ success: true, order });
  } catch (err) {
    console.error('PATCH /api/orders/:id failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── staff notifications (migration 053) ───────────────────────────────────────
// Every staff member reads and clears only their OWN notifications — the
// recipient is always req.staff.id, never a parameter. Today only admins
// receive any (a custom discount given by a non-admin), but the table is
// per-recipient so other kinds can be added without a new route. Degrades to
// an empty list on a database without 053, so the bell never breaks a page.
app.get('/api/notifications', requireRole(...STAFF_ROLES), async (req, res) => {
  if (!schemaFlags.customDiscount) return res.json({ notifications: [], unread: 0 });
  try {
    const { rows } = await pool.query(
      `SELECT n.id, n.kind, n.title, n.body, n.order_id, n.created_at, n.read_at,
              a.name AS actor_name, o.order_number
              ${schemaFlags.quotations ? ', n.quotation_id, qt.quotation_no' : ''}
         FROM staff_notifications n
         LEFT JOIN staff_users a ON a.id = n.actor_id
         LEFT JOIN orders o ON o.id = n.order_id
         ${schemaFlags.quotations ? 'LEFT JOIN quotations qt ON qt.id = n.quotation_id' : ''}
        WHERE n.recipient_id = $1
        ORDER BY n.created_at DESC
        LIMIT 50`,
      [req.staff.id]
    );
    const { rows: cnt } = await pool.query(
      'SELECT count(*)::int AS n FROM staff_notifications WHERE recipient_id=$1 AND read_at IS NULL',
      [req.staff.id]
    );
    res.json({ notifications: rows, unread: cnt[0]?.n || 0 });
  } catch (err) {
    console.error('GET /api/notifications failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/notifications/read-all', requireRole(...STAFF_ROLES), async (req, res) => {
  if (!schemaFlags.customDiscount) return res.json({ success: true, updated: 0 });
  try {
    const { rowCount } = await pool.query(
      'UPDATE staff_notifications SET read_at=NOW() WHERE recipient_id=$1 AND read_at IS NULL',
      [req.staff.id]
    );
    res.json({ success: true, updated: rowCount });
  } catch (err) {
    console.error('POST /api/notifications/read-all failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/notifications/:id/read', requireRole(...STAFF_ROLES), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid notification id' });
  if (!schemaFlags.customDiscount) return res.status(404).json({ error: 'Notification not found' });
  try {
    const { rows } = await pool.query(
      `UPDATE staff_notifications SET read_at = COALESCE(read_at, NOW())
        WHERE id=$1 AND recipient_id=$2 RETURNING id`,
      [req.params.id, req.staff.id]
    );
    // Someone else's notification is a 404, not a 403: its existence is not
    // this caller's business.
    if (rows.length === 0) return res.status(404).json({ error: 'Notification not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/notifications/:id/read failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── quotations (migration 054) ────────────────────────────────────────────────
// A priced quotation built on the Quotations page, stored under the customer
// the phone number belongs to. The screen resolves (or creates) that customer
// with POST /api/customers first — the same find-or-create a showroom order
// uses — so a number that matches an existing customer files the quotation
// under them instead of creating a duplicate.
//
// The volume discount is computed by the screen (lib/orderItems.js holds the
// one copy of that rule) and sent in; the TOTAL is computed here from the
// lines and discounts, never taken from the request, because it is the figure
// printed in front of the customer.

const QUOTATION_READ_ROLES = ['admin', 'sales_agent', 'viewer'];
const QUOTATION_WRITE_ROLES = ['admin', 'sales_agent'];
const QUOTATIONS_UNAVAILABLE = 'Quotations are not available until database migration 054 is applied';
const VOLUME_WAIVER_UNAVAILABLE =
  'Switching off the volume discount is not available until database migration 057 is applied';

/**
 * Validates and normalises the editable body of a quotation. `promoAmount` is
 * the promo code's already-validated discount (resolveQuotation), applied
 * after the volume discount and before the custom one — the same order the
 * order screens and the invoice use.
 */
function parseQuotationBody(body, promoAmount = 0) {
  const b = body || {};
  const customerName = typeof b.customerName === 'string' ? b.customerName.trim() : '';
  if (!customerName) return { error: 'A customer name is required' };
  if (customerName.length > 200) return { error: 'The customer name is too long' };

  if (!Array.isArray(b.items) || b.items.length === 0) return { error: 'Add at least one product' };
  if (b.items.length > 50) return { error: 'A quotation can hold at most 50 lines' };
  const items = [];
  for (const raw of b.items) {
    const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
    const qty = Number(raw?.qty);
    const unit = Number(raw?.unit_price);
    const free = raw?.free === true;
    if (!name || name.length > 200) return { error: 'Every line needs a product name' };
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) return { error: `Invalid quantity for ${name}` };
    if (!Number.isFinite(unit)) return { error: `Invalid price for ${name}` };
    // Free lines are stored NEGATIVE (migration 049); nothing else may be.
    if (unit < 0 && !free) return { error: `Invalid price for ${name}` };
    const bedSize = raw?.bed_size == null ? null : String(raw.bed_size).trim().slice(0, 50) || null;
    items.push({
      name,
      bed_size: bedSize,
      qty,
      unit_price: free ? -Math.abs(unit) : unit,
      ...(raw?.pillow_top ? { pillow_top: true } : {}),
      ...(free ? { free: true } : {}),
    });
  }

  if (b.volumeDiscountWaived !== undefined && typeof b.volumeDiscountWaived !== 'boolean') {
    return { error: 'volumeDiscountWaived must be true or false' };
  }
  const volumeWaived = b.volumeDiscountWaived === true;
  // Waived (migration 057) wins over any amount sent, so the promo code and
  // the total are worked out on the full price.
  const vol = volumeWaived || b.volumeDiscount == null || b.volumeDiscount === '' ? 0 : Number(b.volumeDiscount);
  if (!Number.isFinite(vol) || vol < 0) return { error: 'Invalid volume discount' };
  const custom = parseCustomDiscount(b.customDiscount, b.customDiscountReason);
  if (custom.error) return { error: custom.error };

  const paid = paidItemsSubtotal(items);
  if (vol > paid) return { error: 'The volume discount is larger than the quotation' };
  const promo = Number(promoAmount) > 0 ? Math.round(Number(promoAmount) * 100) / 100 : 0;
  if (custom.amount && custom.amount > paid - vol - promo) {
    return { error: 'The custom discount is larger than what is left on the quotation' };
  }

  let secondaryPhone = null;
  if (b.secondaryPhone != null && String(b.secondaryPhone).trim()) {
    secondaryPhone = normalizePhone(b.secondaryPhone);
    if (!/^94[0-9]{9}$/.test(secondaryPhone)) {
      return { error: 'The additional contact number does not look like a Sri Lankan mobile number (e.g. 0771234567)' };
    }
  }
  const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

  const volume = vol > 0 ? Math.round(vol * 100) / 100 : null;
  const discounts = (volume || 0) + promo + (custom.amount || 0);
  return {
    customerName,
    items,
    secondaryPhone,
    deliveryAddress: text(b.deliveryAddress, 500),
    notes: text(b.notes, 4000),
    volume,
    volumeWaived,
    custom,
    discountTotal: discounts > 0 ? discounts : null,
    total: Math.round(Math.max(0, paid - discounts) * 100) / 100,
  };
}

/**
 * parseQuotationBody plus the promo code (migration 055). The code is checked
 * with the same evaluatePromoCode() the website's /validate uses, against the
 * customer's own number and the after-volume cart — so the quotation shows
 * exactly what an order screen would preview. Never redeemed here: that uses
 * up the customer's one go at the code, which belongs to placing the order.
 */
async function resolveQuotation(body, phone) {
  const base = parseQuotationBody(body);
  if (base.error) return base;
  if (base.volumeWaived && !schemaFlags.volumeWaiver) return { status: 503, error: VOLUME_WAIVER_UNAVAILABLE };
  const code = typeof body?.promoCode === 'string' ? body.promoCode.trim() : '';
  if (!code) return { ...base, promoCode: null, promoAmount: null };
  if (!schemaFlags.quotationPromo) {
    return { status: 503, error: 'A promo code on a quotation needs database migration 055' };
  }
  const paid = paidItemsSubtotal(base.items);
  const r = await evaluatePromoCode({ code, phone, orderTotal: Math.max(0, paid - (base.volume || 0)), items: base.items });
  if (!r.valid) return { error: `Promo code ${code}: ${r.message}` };
  const amount = Math.round((Number(r.previewDiscount) || 0) * 100) / 100;
  const q = parseQuotationBody(body, amount);
  if (q.error) return q;
  return { ...q, promoCode: code, promoAmount: amount > 0 ? amount : null };
}

// The code's live terms come along for the PDF (expiry, cap, uses so far);
// promo_codes_all.code is UNIQUE across deleted rows, so the join is exact.
function quotationSelect() {
  const promo = schemaFlags.quotationPromo
    ? `, pc.expires_at AS promo_expires_at, pc.max_redemptions AS promo_max_redemptions,
         pc.redemption_count AS promo_redemption_count, pc.discount_type AS promo_discount_type,
         pc.discount_percent AS promo_discount_percent, pc.discount_amount AS promo_unit_amount,
         pc.discount_scope AS promo_discount_scope, pc.max_units_per_order AS promo_max_units,
         pc.eligible_product_names AS promo_eligible_products`
    : '';
  return `
  SELECT q.*,
         cb.name AS created_by_name,
         ub.name AS updated_by_name,
         src.quotation_no AS recreated_from_no${promo}
    FROM quotations q
    LEFT JOIN staff_users cb ON cb.id = q.created_by
    LEFT JOIN staff_users ub ON ub.id = q.updated_by
    LEFT JOIN quotations src ON src.id = q.recreated_from_id
    ${schemaFlags.quotationPromo ? 'LEFT JOIN promo_codes_all pc ON pc.code = q.promo_code' : ''}`;
}

app.get('/api/quotations', requireRole(...QUOTATION_READ_ROLES), async (req, res) => {
  if (!schemaFlags.quotations) return res.status(503).json({ error: QUOTATIONS_UNAVAILABLE });
  const where = [];
  const params = [];
  const { customerId, search } = req.query;
  if (customerId) {
    if (!UUID_RE.test(String(customerId))) return res.status(400).json({ error: 'Invalid customerId' });
    params.push(customerId);
    where.push(`q.customer_id = $${params.length}`);
  }
  if (typeof search === 'string' && search.trim()) {
    const term = search.trim().slice(0, 100);
    params.push(`%${term}%`);
    const p = `$${params.length}`;
    // A phone typed as 0771234567 must find the stored 94771234567.
    params.push(`%${normalizePhone(term)}%`);
    where.push(`(q.quotation_no ILIKE ${p} OR q.customer_name ILIKE ${p} OR q.customer_phone LIKE $${params.length})`);
  }
  try {
    const { rows } = await pool.query(
      `${quotationSelect()} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY q.created_at DESC LIMIT 500`,
      params
    );
    res.json({ quotations: rows });
  } catch (err) {
    console.error('GET /api/quotations failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/quotations/:id', requireRole(...QUOTATION_READ_ROLES), async (req, res) => {
  if (!schemaFlags.quotations) return res.status(503).json({ error: QUOTATIONS_UNAVAILABLE });
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid quotation id' });
  try {
    const { rows } = await pool.query(`${quotationSelect()} WHERE q.id = $1`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Quotation not found' });
    res.json({ quotation: rows[0] });
  } catch (err) {
    console.error('GET /api/quotations/:id failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/quotations', requireRole(...QUOTATION_WRITE_ROLES), async (req, res) => {
  if (!schemaFlags.quotations) return res.status(503).json({ error: QUOTATIONS_UNAVAILABLE });
  const { customerId, recreatedFromId } = req.body || {};
  if (!UUID_RE.test(String(customerId || ''))) return res.status(400).json({ error: 'customerId is required' });
  if (recreatedFromId != null && !UUID_RE.test(String(recreatedFromId))) {
    return res.status(400).json({ error: 'Invalid recreatedFromId' });
  }
  const pre = parseQuotationBody(req.body);
  if (pre.error) return res.status(400).json({ error: pre.error });

  try {
    // The number printed on the quotation is the customer's own record, not
    // whatever the request says — so a quotation can never be filed under one
    // customer while showing another's number.
    const { rows: cust } = await pool.query('SELECT id, whatsapp_number FROM customers WHERE id=$1', [customerId]);
    if (cust.length === 0) return res.status(404).json({ error: 'Customer not found' });
    const q = await resolveQuotation(req.body, cust[0].whatsapp_number);
    if (q.error) return res.status(q.status || 400).json({ error: q.error });
    if (recreatedFromId) {
      const { rows: src } = await pool.query('SELECT 1 FROM quotations WHERE id=$1', [recreatedFromId]);
      if (src.length === 0) return res.status(404).json({ error: 'The quotation being recreated was not found' });
    }

    const notes = q.custom.amount
      ? [q.notes, customDiscountNote(req.staff, { amount: q.custom.amount, reason: q.custom.reason })].filter(Boolean).join('\n')
      : q.notes;
    const { rows } = await pool.query(
      `INSERT INTO quotations (
         customer_id, customer_name, customer_phone, secondary_phone, delivery_address,
         items, volume_discount, custom_discount, custom_discount_reason,
         custom_discount_by, custom_discount_at, discount_total, total_amount,
         notes, recreated_from_id, created_by, updated_by${q.promoCode ? ', promo_code, promo_discount' : ''}${q.volumeWaived ? ', volume_discount_waived' : ''}
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16${q.promoCode ? ',$17,$18' : ''}${q.volumeWaived ? `,$${q.promoCode ? 19 : 17}` : ''})
       RETURNING id`,
      [
        customerId, q.customerName, cust[0].whatsapp_number, q.secondaryPhone, q.deliveryAddress,
        JSON.stringify(q.items), q.volume, q.custom.amount, q.custom.reason,
        q.custom.amount ? req.staff.id : null, q.custom.amount ? new Date().toISOString() : null,
        q.discountTotal, q.total, notes, recreatedFromId || null, req.staff.id,
        ...(q.promoCode ? [q.promoCode, q.promoAmount] : []),
        ...(q.volumeWaived ? [true] : []),
      ]
    );
    const { rows: full } = await pool.query(`${quotationSelect()} WHERE q.id = $1`, [rows[0].id]);
    const quotation = full[0];
    if (q.custom.amount) {
      recordAuditEvent(req, 'quotation.custom_discount', { quotation_id: quotation.id, amount: q.custom.amount });
      await notifyCustomDiscount(req, quotation, { amount: q.custom.amount, reason: q.custom.reason });
    }
    res.json({ success: true, quotation });
  } catch (err) {
    console.error('POST /api/quotations failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Edits a quotation in place — it keeps its number. "Recreate" (a new number,
// linked back via recreated_from_id) is a POST, not this.
app.patch('/api/quotations/:id', requireRole(...QUOTATION_WRITE_ROLES), async (req, res) => {
  if (!schemaFlags.quotations) return res.status(503).json({ error: QUOTATIONS_UNAVAILABLE });
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid quotation id' });
  const pre = parseQuotationBody(req.body);
  if (pre.error) return res.status(400).json({ error: pre.error });

  try {
    const { rows: cur } = await pool.query(
      'SELECT customer_phone, custom_discount, custom_discount_reason, custom_discount_by, custom_discount_at FROM quotations WHERE id=$1',
      [req.params.id]
    );
    if (cur.length === 0) return res.status(404).json({ error: 'Quotation not found' });
    const c = cur[0];
    // Re-checked on every save: a re-issued quotation must only show a code
    // that is still usable today.
    const q = await resolveQuotation(req.body, c.customer_phone);
    if (q.error) return res.status(q.status || 400).json({ error: q.error });

    // Same rule as an order edit: the note and the admin notification only
    // on a real change, and who/when follow the latest change.
    const prevAmount = Number(c.custom_discount) || 0;
    const amountChanged = Math.round((q.custom.amount || 0) * 100) !== Math.round(prevAmount * 100);
    const reasonChanged = (q.custom.reason || '') !== (c.custom_discount_reason || '');
    const changed = amountChanged || reasonChanged;
    const change = { amount: q.custom.amount, reason: q.custom.reason, previous: prevAmount || null };
    const by = changed ? (q.custom.amount ? req.staff.id : null) : c.custom_discount_by;
    const at = changed ? (q.custom.amount ? new Date().toISOString() : null) : c.custom_discount_at;
    const notes = changed
      ? [q.notes, customDiscountNote(req.staff, change)].filter(Boolean).join('\n')
      : q.notes;

    // The customer is deliberately NOT editable here: re-filing a quotation
    // under someone else is "Recreate" for that customer, so each customer's
    // history only ever holds documents that were really made for them.
    await pool.query(
      `UPDATE quotations SET
         customer_name=$2, secondary_phone=$3, delivery_address=$4, items=$5,
         volume_discount=$6, custom_discount=$7, custom_discount_reason=$8,
         custom_discount_by=$9, custom_discount_at=$10, discount_total=$11,
         total_amount=$12, notes=$13, updated_by=$14, updated_at=NOW()
         ${schemaFlags.quotationPromo ? ', promo_code=$15, promo_discount=$16' : ''}
         ${schemaFlags.volumeWaiver ? `, volume_discount_waived=$${schemaFlags.quotationPromo ? 17 : 15}` : ''}
       WHERE id=$1`,
      [
        req.params.id, q.customerName, q.secondaryPhone, q.deliveryAddress, JSON.stringify(q.items),
        q.volume, q.custom.amount, q.custom.reason, by, at, q.discountTotal, q.total, notes, req.staff.id,
        ...(schemaFlags.quotationPromo ? [q.promoCode, q.promoAmount] : []),
        ...(schemaFlags.volumeWaiver ? [q.volumeWaived] : []),
      ]
    );
    const { rows: full } = await pool.query(`${quotationSelect()} WHERE q.id = $1`, [req.params.id]);
    const quotation = full[0];
    if (changed) {
      recordAuditEvent(req, 'quotation.custom_discount', {
        quotation_id: quotation.id, amount: q.custom.amount, previous: change.previous,
      });
      if (amountChanged) await notifyCustomDiscount(req, quotation, change);
    }
    res.json({ success: true, quotation });
  } catch (err) {
    console.error('PATCH /api/quotations/:id failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/orders/:id/payments ──────────────────────────────────────────────
// The payment ledger for one order plus its derived summary. Same read roles
// as the order itself; finance/admin are the ones who act on it.
// The automatic "4 free pillows per mattress at LKR 1,700" rule was REMOVED
// (confirmed with the user): the giveaway is negotiated per customer, so staff
// now pick the free items themselves in the Free Product section on each order
// screen. Those picks are stored as real order items with a NEGATIVE
// unit_price, so the invoice bills and deducts exactly what was given away
// rather than a quantity the server inferred from the mattress count.

// ── GET /api/orders/:id/invoice ───────────────────────────────────────────────
// Everything the invoice PDF needs, in one call: the order, its line items,
// and the advances actually recorded against it (order_payments, migration
// 028) so the invoice matches the books rather than a typed-in figure.
//
// The free-pillow lines are computed HERE rather than in the PDF, so the
// figures on the document and any future reconciliation agree by construction.
//
// The discount columns (migration 046: promo_code, promo_discount,
// volume_discount, discount_total) arrive with the SELECT o.* below and need no
// separate query. They are what lets the PDF print the saving the customer was
// given AND land on the same total_amount the payment ledger is reconciled
// against — before 046 it had only the gross line items and so overstated the
// bill on every discounted order.
app.get('/api/orders/:id/invoice', requireRole('admin', 'finance', 'sales_agent', 'viewer'), requireOrderVisible, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.*, c.name AS customer_full_name, c.contact_whatsapp_number,
              pc.discount_scope AS promo_discount_scope, pc.discount_amount AS promo_unit_amount
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN promo_codes pc ON o.promo_code IS NOT NULL AND upper(pc.code) = upper(o.promo_code)
       WHERE o.id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = rows[0];

    // Advances only — a balance payment is not shown as a deduction on the
    // invoice, and a refund is not an advance.
    const { rows: advances } = await pool.query(
      `SELECT amount, paid_at, method, reference
       FROM order_payments WHERE order_id = $1 AND kind = 'advance'
       ORDER BY paid_at ASC`,
      [req.params.id]
    );

    // No server-side free-pillow calculation any more. Giveaways are real
    // items on order.items, carrying a negative unit_price and free: true, so
    // the invoice renders them from the order itself — what was actually
    // agreed, rather than a count derived from how many mattresses were bought.
    res.json({
      success: true,
      order,
      advances,
      issuedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('GET /api/orders/:id/invoice failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/orders/:id/payments', requireRole('admin', 'finance', 'sales_agent', 'viewer'), requireOrderVisible, async (req, res) => {
  try {
    const { rows: summary } = await pool.query('SELECT * FROM v_order_payment_summary WHERE order_id=$1', [req.params.id]);
    if (summary.length === 0) return res.status(404).json({ error: 'Order not found' });
    const { rows: payments } = await pool.query(
      `
      SELECT p.*, s.name AS recorded_by_name
      FROM order_payments p
      LEFT JOIN staff_users s ON p.recorded_by = s.id
      WHERE p.order_id = $1
      ORDER BY p.paid_at ASC, p.created_at ASC
    `,
      [req.params.id]
    );
    res.json({ summary: summary[0], payments });
  } catch (err) {
    console.error('GET /api/orders/:id/payments failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/orders/:id/payments ─────────────────────────────────────────────
// Records one real payment (advance, balance or refund). orders.amount_paid
// and payment_status are NOT set here — trg_order_payment_change derives them
// from the ledger, so the two can never drift.
//
// Payment fields are finance/admin territory per this file's existing role
// split (the same rule PATCH /api/orders/:id enforces via touchesPayment),
// with sales_agent allowed because they are the ones taking an advance from a
// walk-in customer at the counter.
// ── GET /api/orders/:id/detail — everything attached to one order ────────────
// The order screen previously showed only the orders row itself. This gathers
// what actually hangs off an order across the schema, so staff do not have to
// visit four pages to answer "what is the state of this sale": the customer,
// the enquiry it came from (orders.lead_id), the payment ledger, the warranties
// it generated, any service tickets raised against it, and the promo code used.
app.get('/api/orders/:id/detail', requireRole(...STAFF_ROLES), requireOrderVisible, async (req, res) => {
  const id = req.params.id;
  // Mirrors GET /api/orders/:id/payments' own role list.
  const canSeeMoney = hasRole(req.staff, 'admin', 'finance', 'sales_agent', 'viewer');
  try {
    const { rows: orderRows } = await pool.query(
      `SELECT o.*, ${placedByCols()}
         FROM orders o ${placedByJoins()}
        WHERE o.id=$1`,
      [id]
    );
    if (orderRows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderRows[0];

    const [customer, lead, payments, warranties, tickets, promo] = await Promise.all([
      order.customer_id
        ? pool.query('SELECT * FROM customers WHERE id=$1', [order.customer_id])
        : { rows: [] },
      // The enquiry this order was converted from. NULL on an order placed
      // directly (a showroom walk-in) and on every order created before
      // orders.lead_id started being written.
      order.lead_id
        ? pool.query(
            `SELECT l.*, s.name AS assigned_staff_name, s.role AS assigned_staff_role
               FROM leads l LEFT JOIN staff_users s ON s.id = l.assigned_staff_id
              WHERE l.id = $1`,
            [order.lead_id]
          )
        : { rows: [] },
      pool.query(
        `SELECT p.*, s.name AS recorded_by_name
           FROM order_payments p LEFT JOIN staff_users s ON s.id = p.recorded_by
          WHERE p.order_id = $1 ORDER BY p.paid_at ASC`,
        [id]
      ),
      pool.query(
        `SELECT w.*, v.effective_status, v.days_remaining
           FROM warranties w LEFT JOIN v_warranty_status v ON v.id = w.id
          WHERE w.order_id = $1 ORDER BY w.end_date DESC`,
        [id]
      ),
      pool.query('SELECT * FROM service_tickets WHERE order_id=$1 ORDER BY created_at DESC', [id]),
      pool.query(
        `SELECT r.*, pc.code, pc.discount_type
           FROM promo_code_redemptions r
           JOIN promo_codes pc ON pc.id = r.promo_code_id
          WHERE r.order_id = $1`,
        [id]
      ),
    ]);

    // Same rule as the Customer 360: the ledger is authoritative for anything
    // paid since migration 028, but an order settled before that has its money
    // only in orders.amount_paid and no ledger rows — taking the ledger alone
    // would report a fully-paid order as still owing everything.
    const ledgerPaid = payments.rows.reduce(
      (sum, p) => sum + (p.kind === 'refund' ? -Number(p.amount) : Number(p.amount)), 0
    );
    const paid = Math.max(ledgerPaid, Number(order.amount_paid) || 0);

    res.json({
      // Same minimiser every other order read applies. Without it this route
      // handed a delivery_coordinator exactly the fields
      // DELIVERY_HIDDEN_ORDER_FIELDS exists to strip — an aggregate endpoint
      // must not be a way around a per-field rule.
      order: minimizeOrderForRole(order, req.staff.role),
      customer: customer.rows[0] || null,
      lead: lead.rows[0] || null,
      // The payment ledger and money totals follow the same roles that
      // GET /api/orders/:id/payments allows; other roles get the order and its
      // fulfilment detail without the financials.
      payments: canSeeMoney ? payments.rows : [],
      warranties: warranties.rows,
      serviceTickets: tickets.rows,
      promo: canSeeMoney ? promo.rows[0] || null : null,
      totals: !canSeeMoney ? null : {
        total: Number(order.total_amount) || 0,
        paid,
        balanceDue: Math.max((Number(order.total_amount) || 0) - paid, 0),
        advanceRequired: Number(order.advance_required) || 0,
      },
    });
  } catch (err) {
    console.error('GET /api/orders/:id/detail failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/orders/:id/payments', requireRole('admin', 'finance', 'sales_agent'), requireOrderVisible, async (req, res) => {
  const { amount, method, kind, reference, note, paidAt, notifyCustomer } = req.body;

  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return res.status(400).json({ error: 'amount must be greater than 0' });
  }
  const payKind = kind || 'balance';
  if (!['advance', 'balance', 'refund'].includes(payKind)) {
    return res.status(400).json({ error: "kind must be 'advance', 'balance' or 'refund'" });
  }

  try {
    const { rows: orderRows } = await pool.query(
      'SELECT id, customer_id, order_number, customer_name, total_amount, amount_paid, currency FROM orders WHERE id=$1',
      [req.params.id]
    );
    if (orderRows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderRows[0];

    // Guard against recording more than is owed — a real data-entry mistake
    // (a mistyped extra zero) that would otherwise silently flip the order to
    // 'paid' and let it be delivered. A refund is exempt: it reduces the paid
    // total, so it can never overshoot upwards.
    if (payKind !== 'refund') {
      const total = Number(order.total_amount) || 0;
      const already = Number(order.amount_paid) || 0;
      // `total > 0` used to guard this, which meant the check was skipped
      // entirely on a zero-total order and unlimited payments could be
      // recorded against it. Totals cannot be negative any more (validated on
      // POST and PATCH), so the amount is simply compared.
      if (already + amt > total) {
        return res.status(409).json({
          error: `That would take payments to ${(already + amt).toLocaleString()} on a ${total.toLocaleString()} order. Balance outstanding is ${(total - already).toLocaleString()}.`,
        });
      }
    }
    if (payKind === 'refund' && amt > (Number(order.amount_paid) || 0)) {
      return res.status(409).json({
        error: `Cannot refund ${amt.toLocaleString()} — only ${(Number(order.amount_paid) || 0).toLocaleString()} has been received on this order.`,
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO order_payments (order_id, amount, method, kind, reference, note, paid_at, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, NOW()),$8) RETURNING *`,
      [req.params.id, amt, method || 'cash', payKind, reference || null, note || null, paidAt || null, req.staff.id]
    );

    // Re-read the order: the trigger has just recomputed amount_paid and
    // payment_status from the ledger.
    const { rows: after } = await pool.query('SELECT * FROM v_order_payment_summary WHERE order_id=$1', [req.params.id]);

    broadcastEvent('order_update', { id: req.params.id });

    // Receipt to the customer: what was received and what is still owed.
    let receipt = { sent: false, skipped: true };
    if (notifyCustomer !== false && order.customer_id) {
      receipt = await sendPaymentReceipt(order, after[0], rows[0]);
    }

    res.json({ success: true, payment: rows[0], summary: after[0], receipt });
  } catch (err) {
    console.error('POST /api/orders/:id/payments failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/orders/:id/payments/:paymentId ────────────────────────────────
// Removing a payment is correcting a data-entry error, so it is admin/finance
// only — and the ledger total is recomputed by the same trigger.
app.delete('/api/orders/:id/payments/:paymentId', requireRole('admin', 'finance'), async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM order_payments WHERE id=$1 AND order_id=$2', [req.params.paymentId, req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Payment not found on this order' });
    const { rows: after } = await pool.query('SELECT * FROM v_order_payment_summary WHERE order_id=$1', [req.params.id]);
    broadcastEvent('order_update', { id: req.params.id });
    res.json({ success: true, summary: after[0] || null });
  } catch (err) {
    console.error('DELETE /api/orders/:id/payments/:paymentId failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/orders/:id ────────────────────────────────────────────────────
// Deleting an order means the sale did not happen, so everything that hangs
// off it is unwound in ONE transaction rather than left to the FKs to throw.
// Five tables reference orders and four of them block the delete:
//
//   promo_code_redemptions  NO ACTION -> deleted, AND promo_codes
//                           .redemption_count is decremented. That count is a
//                           STORED column (redeem_promo_code increments it
//                           separately from inserting the row), so removing
//                           the row alone would leave a cap permanently
//                           consumed by a sale that never happened.
//                           Influencer commission needs no separate fix: it
//                           is computed live from these rows in
//                           GET /api/influencers/:id/payout.
//   warranties              NO ACTION -> deleted; a warranty exists only
//                           because this order was delivered and paid.
//   service_tickets         NO ACTION -> deleted. Unlinking was the intent
//                           (a complaint reads as the customer's record), but
//                           service_tickets.order_id is NOT NULL, so a ticket
//                           cannot outlive its order — verified against the
//                           live schema after a NOT-NULL violation rolled the
//                           whole delete back. Deleting the order therefore
//                           deletes its tickets.
//   campaign_sends          NO ACTION -> resulted_in_order_id cleared. The
//                           send really happened; only the attribution goes.
//   order_payments          CASCADE   -> removed by the FK itself.
//
// Confirmed with the user: a deleted order must decrease the promo's usage
// count and the influencer's commission.
app.delete('/api/orders/:id', requireRole('admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the row first so a concurrent PATCH cannot change the order
    // underneath the unwind. Also doubles as the existence check.
    const { rows: orderRows } = await client.query(
      'SELECT id, order_number FROM orders WHERE id=$1 FOR UPDATE',
      [req.params.id]
    );
    if (orderRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    // Give back one slot per redemption being removed. Grouped so a code
    // redeemed twice against this order gives back two, and floored at 0 so
    // a historically inconsistent count can never go negative.
    const { rows: freed } = await client.query(
      `UPDATE promo_codes pc
          SET redemption_count = GREATEST(0, pc.redemption_count - agg.n)
         FROM (SELECT promo_code_id, count(*) AS n
                 FROM promo_code_redemptions
                WHERE order_id = $1
             GROUP BY promo_code_id) agg
        WHERE pc.id = agg.promo_code_id
    RETURNING pc.code, agg.n`,
      [req.params.id]
    );

    const { rowCount: redemptions } = await client.query(
      'DELETE FROM promo_code_redemptions WHERE order_id=$1', [req.params.id]
    );
    const { rowCount: warranties } = await client.query(
      'DELETE FROM warranties WHERE order_id=$1', [req.params.id]
    );
    const { rowCount: tickets } = await client.query(
      'DELETE FROM service_tickets WHERE order_id=$1', [req.params.id]
    );
    const { rowCount: campaigns } = await client.query(
      'UPDATE campaign_sends SET resulted_in_order_id=NULL WHERE resulted_in_order_id=$1', [req.params.id]
    );

    await client.query('DELETE FROM orders WHERE id=$1', [req.params.id]);
    await client.query('COMMIT');

    console.log(
      `Order ${orderRows[0].order_number} deleted by ${req.staff.name || req.staff.role}: ` +
      `${redemptions} redemption(s) removed${freed.length ? ` (freed ${freed.map(f => `${f.code} x${f.n}`).join(', ')})` : ''}, ` +
      `${warranties} warranty/ies removed, ${tickets} service ticket(s) removed, ${campaigns} campaign send(s) unlinked`
    );
    broadcastEvent('order_update', { id: req.params.id, deleted: true });
    res.json({
      success: true,
      unwound: { redemptions, warranties, serviceTickets: tickets, campaignSendsUnlinked: campaigns },
    });
  } catch (err) {
    // A merge conflict resolution had left the error handling split across
    // catch and finally: `err` is out of scope in finally (the lint error that
    // caught this), and it would have sent a SECOND response after catch had
    // already replied. Both halves belong here.
    await client.query('ROLLBACK').catch(() => {});
    console.error('DELETE /api/orders/:id failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── GET /api/campaigns — list campaigns (Module 5) ────────────────────────────
app.get('/api/campaigns', requireRole('admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM campaigns ORDER BY created_at DESC');
    res.json({ campaigns: rows });
  } catch (err) {
    console.error('GET /api/campaigns failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/campaigns — define a campaign (REQ-5.6, Admin only) ────────────
app.post('/api/campaigns', requireRole('admin'), async (req, res) => {
  const { name, targetSegment, triggerType, triggerOffsetDays, messageTemplate } = req.body;
  // showroom_no_purchase/multi_channel_no_conversion/gone_quiet added Phase 14
  // (migration 012) — see v_campaign_eligible_customers for the query logic.
  const SEGMENTS = ['loyalty', 'potential', 'all', 'showroom_no_purchase', 'multi_channel_no_conversion', 'gone_quiet'];
  const TRIGGER_TYPES = ['referral_ask', 'comfort_checkin', 'accessory_upsell', 'anniversary', 'replacement_reminder', 'ad_hoc'];

  if (!name || !SEGMENTS.includes(targetSegment) || !TRIGGER_TYPES.includes(triggerType) || !messageTemplate) {
    return res.status(400).json({
      error: `name, messageTemplate, targetSegment (one of: ${SEGMENTS.join(', ')}), and triggerType (one of: ${TRIGGER_TYPES.join(', ')}) are required`,
    });
  }
  if (triggerType !== 'ad_hoc' && !Number.isInteger(triggerOffsetDays)) {
    return res.status(400).json({ error: 'triggerOffsetDays (integer) is required for delivery-relative trigger types' });
  }
  // gone_quiet's "N days of cross-channel silence" is core to the segment
  // itself, not delivery-relative like the other trigger types — it must be
  // set even when triggerType is 'ad_hoc', or v_campaign_eligible_customers'
  // gone_quiet timing check would never apply and the segment would match
  // every non-loyalty customer regardless of how recently they engaged.
  if (targetSegment === 'gone_quiet' && !Number.isInteger(triggerOffsetDays)) {
    return res
      .status(400)
      .json({ error: 'triggerOffsetDays (integer) is required for the gone_quiet segment — it defines "quiet for how many days"' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO campaigns (name, target_segment, trigger_type, trigger_offset_days, message_template)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [
        name,
        targetSegment,
        triggerType,
        triggerType === 'ad_hoc' && targetSegment !== 'gone_quiet' ? null : triggerOffsetDays,
        messageTemplate,
      ]
    );
    res.json({ success: true, campaign: rows[0] });
  } catch (err) {
    console.error('POST /api/campaigns failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /api/campaigns/:id — Admin only ─────────────────────────────────────
app.patch('/api/campaigns/:id', requireRole('admin'), async (req, res) => {
  const allowed = ['name', 'message_template', 'status'];
  if (rejectUnknownFields(req, res, allowed)) return;
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (updates.status && !['draft', 'active', 'paused'].includes(updates.status)) {
    return res.status(400).json({ error: 'status must be one of: draft, active, paused' });
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update' });

  const entries = Object.entries(updates);
  const setClauses = entries.map(([k], i) => `${k}=$${i + 1}`).join(', ');
  const vals = [...entries.map(([, v]) => v), req.params.id];

  try {
    const { rows } = await pool.query(`UPDATE campaigns SET ${setClauses} WHERE id=$${entries.length + 1} RETURNING *`, vals);
    if (rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ success: true, campaign: rows[0] });
  } catch (err) {
    console.error('PATCH /api/campaigns/:id failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/campaigns/:id/eligible — who v_campaign_eligible_customers says
// is due right now (REQ-5.4 as a live query — no scheduler exists) ──────────
app.get('/api/campaigns/:id/eligible', requireRole('admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.whatsapp_number, c.name
       FROM v_campaign_eligible_customers v
       JOIN customers c ON c.id = v.customer_id
       WHERE v.campaign_id = $1`,
      [req.params.id]
    );
    res.json({ eligible: rows });
  } catch (err) {
    console.error('GET /api/campaigns/:id/eligible failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/campaigns/:id/send — Admin only ─────────────────────────────────
// With no customerId: sends to every currently-eligible customer (the view
// already filters on consent_for_marketing=true and status='active').
// With a customerId: sends to that one customer specifically — and RE-CHECKS
// consent explicitly here (REQ-5.7 "enforced in code, not just documented"),
// rejecting with an explicit error rather than silently skipping, so a caller
// that bypasses the eligibility view still can't send to a non-consenting
// customer.
app.post('/api/campaigns/:id/send', requireRole('admin'), async (req, res) => {
  const { customerId } = req.body;

  try {
    const { rows: campRows } = await pool.query('SELECT * FROM campaigns WHERE id=$1', [req.params.id]);
    const campaign = campRows[0];
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    let targets;
    if (customerId) {
      const { rows } = await pool.query(
        'SELECT id, whatsapp_number, contact_whatsapp_number, channel, consent_for_marketing FROM customers WHERE id=$1',
        [customerId]
      );
      const customer = rows[0];
      if (!customer) return res.status(404).json({ error: 'Customer not found' });
      if (!customer.consent_for_marketing) {
        return res.status(403).json({ error: 'Customer has not given marketing consent — cannot send' });
      }
      targets = [customer];
    } else {
      const { rows } = await pool.query(
        `SELECT c.id, c.whatsapp_number, c.contact_whatsapp_number, c.channel, c.consent_for_marketing
         FROM v_campaign_eligible_customers v JOIN customers c ON c.id = v.customer_id
         WHERE v.campaign_id = $1`,
        [req.params.id]
      );
      targets = rows;
    }

    const results = [];
    for (const customer of targets) {
      if (!customer.consent_for_marketing) continue; // belt-and-suspenders, REQ-5.7
      try {
        await sendWhatsAppMessage(customer, campaign.message_template);
        await pool.query('INSERT INTO campaign_sends (campaign_id, customer_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [
          campaign.id,
          customer.id,
        ]);
        results.push({ customerId: customer.id, sent: true });
      } catch (err) {
        results.push({ customerId: customer.id, sent: false, error: err.message });
      }
    }

    res.json({ success: true, sentCount: results.filter((r) => r.sent).length, results });
  } catch (err) {
    console.error('POST /api/campaigns/:id/send failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Influencers (Phase 9, Admin only) ─────────────────────────────────────────
app.get('/api/influencers', requireRole('admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM influencers ORDER BY created_at DESC');
    res.json({ influencers: rows });
  } catch (err) {
    console.error('GET /api/influencers failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/influencers', requireRole('admin'), async (req, res) => {
  const { name, handle, commissionPercent } = req.body;
  if (!name || commissionPercent == null) return res.status(400).json({ error: 'name and commissionPercent are required' });

  try {
    const { rows } = await pool.query('INSERT INTO influencers (name, handle, commission_percent) VALUES ($1,$2,$3) RETURNING *', [
      name,
      handle || null,
      commissionPercent,
    ]);
    res.json({ success: true, influencer: rows[0] });
  } catch (err) {
    console.error('POST /api/influencers failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/influencers/:id', requireRole('admin'), async (req, res) => {
  const allowed = ['name', 'handle', 'commission_percent', 'active'];
  if (rejectUnknownFields(req, res, allowed)) return;
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update' });

  const entries = Object.entries(updates);
  const setClauses = entries.map(([k], i) => `${k}=$${i + 1}`).join(', ');
  const vals = [...entries.map(([, v]) => v), req.params.id];

  try {
    const { rows } = await pool.query(`UPDATE influencers SET ${setClauses} WHERE id=$${entries.length + 1} RETURNING *`, vals);
    if (rows.length === 0) return res.status(404).json({ error: 'Influencer not found' });
    res.json({ success: true, influencer: rows[0] });
  } catch (err) {
    console.error('PATCH /api/influencers/:id failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Commission computed only from redemptions that have been manually linked to
// an order (see migration 007_promo_codes.sql — no auto-backfill exists).
app.get('/api/influencers/:id/payout', requireRole('admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
        i.id, i.name, i.commission_percent,
        count(r.id) AS total_redemptions,
        count(r.id) FILTER (WHERE r.order_id IS NOT NULL) AS linked_redemptions,
        coalesce(sum(o.total_amount) FILTER (WHERE r.order_id IS NOT NULL), 0) AS linked_revenue,
        round(coalesce(sum(o.total_amount) FILTER (WHERE r.order_id IS NOT NULL), 0) * i.commission_percent / 100.0, 2) AS commission_owed
      FROM influencers i
      LEFT JOIN promo_codes pc ON pc.influencer_id = i.id
      LEFT JOIN promo_code_redemptions r ON r.promo_code_id = pc.id
      LEFT JOIN orders o ON o.id = r.order_id
      WHERE i.id = $1
      GROUP BY i.id, i.name, i.commission_percent`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Influencer not found' });
    res.json({ payout: rows[0] });
  } catch (err) {
    console.error('GET /api/influencers/:id/payout failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Per-order breakdown behind an influencer's payout total — every redemption
// of any of their promo codes, which code, whether it's linked to an order
// yet, and the commission on that specific order (same no-auto-backfill
// caveat as the payout aggregate above: unlinked redemptions show with no
// order/commission, since only a manual link via PATCH .../redemptions/:id
// connects a redemption to a real sale).
app.get('/api/influencers/:id/orders', requireRole('admin', 'viewer'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
        r.id AS redemption_id, r.redeemed_phone, r.redeemed_at, r.discount_applied, r.order_id,
        pc.code AS promo_code,
        o.order_number, o.status AS order_status, o.total_amount AS order_total, o.created_at AS order_created_at,
        c.name AS customer_name,
        CASE WHEN r.order_id IS NOT NULL THEN round(o.total_amount * i.commission_percent / 100.0, 2) ELSE NULL END AS commission
      FROM influencers i
      JOIN promo_codes pc ON pc.influencer_id = i.id
      JOIN promo_code_redemptions r ON r.promo_code_id = pc.id
      LEFT JOIN orders o ON o.id = r.order_id
      LEFT JOIN customers c ON c.id = r.customer_id
      WHERE i.id = $1
      ORDER BY r.redeemed_at DESC`,
      [req.params.id]
    );
    res.json({ orders: rows });
  } catch (err) {
    console.error('GET /api/influencers/:id/orders failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Promo codes (Phase 9, Admin only for management) ──────────────────────────
// sales_agent can READ (the read-only /promo-codes page, and the code
// suggestions in the order screens' promo field). Every write stays admin.
app.get('/api/promo-codes', requireRole('admin', 'viewer', 'sales_agent'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM promo_codes ORDER BY created_at DESC');
    res.json({ promoCodes: rows });
  } catch (err) {
    console.error('GET /api/promo-codes failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/promo-codes', requireRole('admin'), async (req, res) => {
  const {
    code, discountType, discountPercent, discountAmount, maxRedemptions, expiresAt, influencerId, eligibleProductNames,
    discountScope = 'order', maxUnitsPerOrder,
  } = req.body;

  if (!code || !['percent', 'amount'].includes(discountType)) {
    return res.status(400).json({ error: "code and discountType ('percent' or 'amount') are required" });
  }
  const scopeError = promoScopeError(discountType, discountScope, maxUnitsPerOrder);
  if (scopeError) return res.status(400).json({ error: scopeError });
  if (discountType === 'percent' && discountPercent == null) {
    return res.status(400).json({ error: 'discountPercent is required for a percent-off code' });
  }
  if (discountType === 'amount' && discountAmount == null) {
    return res.status(400).json({ error: 'discountAmount is required for an amount-off code' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO promo_codes (code, discount_type, discount_percent, discount_amount, max_redemptions, expires_at, influencer_id,
                                eligible_product_names, discount_scope, max_units_per_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        code,
        discountType,
        discountType === 'percent' ? discountPercent : null,
        discountType === 'amount' ? discountAmount : null,
        maxRedemptions ?? null,
        expiresAt || null,
        influencerId || null,
        eligibleProductNames?.length > 0 ? eligibleProductNames : null,
        discountScope,
        discountScope === 'per_unit' && maxUnitsPerOrder ? Number(maxUnitsPerOrder) : null,
      ]
    );
    res.json({ success: true, promoCode: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That code already exists' });
    console.error('POST /api/promo-codes failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Per-code redemption detail — who used it, when, discount applied, and
// whether it's been linked to an order (see the manual-link route below).
app.get('/api/promo-codes/:id/redemptions', requireRole('admin', 'viewer', 'finance', 'sales_agent'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
        r.id, r.redeemed_phone, r.customer_id, r.order_id, r.discount_applied, r.redeemed_at,
        c.name AS customer_name,
        o.status AS order_status, o.total_amount AS order_total
      FROM promo_code_redemptions r
      LEFT JOIN customers c ON c.id = r.customer_id
      LEFT JOIN orders o ON o.id = r.order_id
      WHERE r.promo_code_id = $1
      ORDER BY r.redeemed_at DESC`,
      [req.params.id]
    );
    res.json({ redemptions: rows });
  } catch (err) {
    console.error('GET /api/promo-codes/:id/redemptions failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Per-mattress codes (migration 052): only an amount can be multiplied per
// unit, and the unit cap must be a whole number >= 1. The same rules are DB
// CHECKs; checked here too so staff get a sentence instead of a 500.
function promoScopeError(discountType, discountScope, maxUnitsPerOrder) {
  if (!['order', 'per_unit'].includes(discountScope)) return "discountScope must be 'order' or 'per_unit'";
  if (discountScope === 'per_unit' && discountType !== 'amount') {
    return 'Only a fixed-amount code can apply per mattress — a percent is already the same on every mattress';
  }
  if (maxUnitsPerOrder != null && maxUnitsPerOrder !== '') {
    if (discountScope !== 'per_unit') return 'A mattress limit only applies to a per-mattress code';
    if (!Number.isInteger(Number(maxUnitsPerOrder)) || Number(maxUnitsPerOrder) < 1) {
      return 'The mattress limit must be a whole number of at least 1';
    }
  }
  return null;
}

// discount_type is deliberately not editable here — flipping a code between
// percent-off and amount-off after it may already have been redeemed would
// retroactively misrepresent what past customers actually got. Editing the
// value within its existing type (discount_percent for a percent code,
// discount_amount for an amount code) is allowed; code text, cap, expiry,
// active flag, and influencer are too.
app.patch('/api/promo-codes/:id', requireRole('admin'), async (req, res) => {
  const allowed = [
    'code',
    'max_redemptions',
    'expires_at',
    'active',
    'influencer_id',
    'discount_percent',
    'discount_amount',
    'eligible_product_names',
    'discount_scope',
    'max_units_per_order',
  ];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (Array.isArray(updates.eligible_product_names) && updates.eligible_product_names.length === 0) {
    updates.eligible_product_names = null;
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update' });

  try {
    const { rows: existingRows } = await pool.query(
      `SELECT discount_type, discount_scope, max_units_per_order,
              (SELECT count(*) FROM promo_code_redemptions r WHERE r.promo_code_id = pc.id)::int AS redemptions
         FROM promo_codes pc WHERE id=$1`,
      [req.params.id]
    );
    if (existingRows.length === 0) return res.status(404).json({ error: 'Promo code not found' });
    const { discount_type } = existingRows[0];

    // Per bill vs per mattress changes what the code is worth, so — like
    // discount_type — it is fixed once anyone has redeemed it.
    if (updates.discount_scope !== undefined && updates.discount_scope !== existingRows[0].discount_scope) {
      if (existingRows[0].redemptions > 0) {
        return res.status(400).json({ error: 'This code has already been redeemed — per bill / per mattress can no longer be changed' });
      }
    }
    const nextScope = updates.discount_scope ?? existingRows[0].discount_scope;
    if (nextScope === 'order') updates.max_units_per_order = null; // a cap is meaningless per bill
    if (updates.max_units_per_order === '') updates.max_units_per_order = null;
    const nextMax = updates.max_units_per_order !== undefined ? updates.max_units_per_order : existingRows[0].max_units_per_order;
    const scopeError = promoScopeError(discount_type, nextScope, nextMax);
    if (scopeError) return res.status(400).json({ error: scopeError });

    if (updates.discount_percent !== undefined && discount_type !== 'percent') {
      return res.status(400).json({ error: 'This code is amount-off — cannot set discount_percent' });
    }
    if (updates.discount_amount !== undefined && discount_type !== 'amount') {
      return res.status(400).json({ error: 'This code is percent-off — cannot set discount_amount' });
    }
    if (updates.code !== undefined) updates.code = updates.code.trim().toUpperCase();

    const entries = Object.entries(updates);
    const setClauses = entries.map(([k], i) => `${k}=$${i + 1}`).join(', ');
    const vals = [...entries.map(([, v]) => v), req.params.id];

    const { rows } = await pool.query(`UPDATE promo_codes SET ${setClauses} WHERE id=$${entries.length + 1} RETURNING *`, vals);
    res.json({ success: true, promoCode: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That code already exists' });
    console.error('PATCH /api/promo-codes/:id failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Hard delete only if the code has never been redeemed — the FK from
// promo_code_redemptions has no ON DELETE CASCADE, deliberately: a code
// with real redemption history is audit data and must not disappear.
// Staff should deactivate (PATCH active:false) instead in that case.
app.delete('/api/promo-codes/:id', requireRole('admin'), async (req, res) => {
  try {
    const { rows: redemptionRows } = await pool.query('SELECT count(*) FROM promo_code_redemptions WHERE promo_code_id=$1', [
      req.params.id,
    ]);
    if (Number(redemptionRows[0].count) > 0) {
      return res.status(409).json({ error: 'This code has redemptions and cannot be deleted — deactivate it instead' });
    }
    const { rows } = await pool.query('DELETE FROM promo_codes WHERE id=$1 RETURNING id', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Promo code not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/promo-codes/:id failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Manually link an earlier website redemption to a WhatsApp-negotiated order
// once staff notice the connection (e.g. matching phone number) — see the
// no-auto-backfill limitation note in migration 007_promo_codes.sql.
app.patch('/api/promo-codes/redemptions/:id', requireRole('admin', 'finance'), async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'orderId is required' });

  try {
    const { rows } = await pool.query('UPDATE promo_code_redemptions SET order_id=$1 WHERE id=$2 RETURNING *', [orderId, req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Redemption not found' });
    res.json({ success: true, redemption: rows[0] });
  } catch (err) {
    console.error('PATCH /api/promo-codes/redemptions/:id failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Warranties (Phase 10, read-only via API — created only by the trigger) ───
app.get('/api/warranties', requireRole('admin', 'viewer', 'sales_agent'), async (req, res) => {
  const { customerId } = req.query;
  try {
    const query = customerId
      ? { text: 'SELECT * FROM v_warranty_status WHERE customer_id=$1 ORDER BY end_date DESC', values: [customerId] }
      : { text: 'SELECT * FROM v_warranty_status ORDER BY end_date DESC' };
    const { rows } = await pool.query(query);
    res.json({ warranties: rows });
  } catch (err) {
    console.error('GET /api/warranties failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Service tickets (Phase 10) ────────────────────────────────────────────────
app.get('/api/service-tickets', requireRole('admin', 'viewer', 'sales_agent'), async (req, res) => {
  const { status, customerId } = req.query;
  const conditions = [];
  const values = [];
  if (status) {
    values.push(status);
    conditions.push(`status=$${values.length}`);
  }
  if (customerId) {
    values.push(customerId);
    conditions.push(`customer_id=$${values.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const { rows } = await pool.query(`SELECT * FROM service_tickets ${where} ORDER BY created_at DESC`, values);
    res.json({ serviceTickets: rows });
  } catch (err) {
    console.error('GET /api/service-tickets failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/service-tickets', requireRole('admin', 'sales_agent'), async (req, res) => {
  const { orderId, customerId, productId, warrantyId, issueType, description } = req.body;
  const ISSUE_TYPES = ['warranty_claim', 'defect', 'delivery_damage', 'general_complaint'];

  if (!orderId || !customerId || !ISSUE_TYPES.includes(issueType)) {
    return res.status(400).json({ error: `orderId, customerId, and issueType (one of: ${ISSUE_TYPES.join(', ')}) are required` });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO service_tickets (order_id, customer_id, product_id, warranty_id, issue_type, description)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [orderId, customerId, productId || null, warrantyId || null, issueType, description || null]
    );
    if (rows[0].priority === 'high') broadcastEvent('customer_update', { id: customerId });
    res.json({ success: true, serviceTicket: rows[0] });
  } catch (err) {
    console.error('POST /api/service-tickets failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/service-tickets/:id', requireRole('admin', 'sales_agent'), async (req, res) => {
  const allowed = ['status', 'resolution_notes'];
  if (rejectUnknownFields(req, res, allowed)) return;
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (updates.status && ['resolved', 'closed'].includes(updates.status)) {
    updates.resolved_at = new Date().toISOString();
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update' });

  const entries = Object.entries(updates);
  const setClauses = entries.map(([k], i) => `${k}=$${i + 1}`).join(', ');
  const vals = [...entries.map(([, v]) => v), req.params.id];

  try {
    const { rows } = await pool.query(`UPDATE service_tickets SET ${setClauses} WHERE id=$${entries.length + 1} RETURNING *`, vals);
    if (rows.length === 0) return res.status(404).json({ error: 'Service ticket not found' });
    res.json({ success: true, serviceTicket: rows[0] });
  } catch (err) {
    console.error('PATCH /api/service-tickets/:id failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Business Intelligence reports (Phase 11, Appendix A.6) ───────────────────
// Management-level data — Admin/Viewer only, same roles as the staff
// performance dashboard (Phase 5). REQ-8.7's staff leaderboard isn't
// duplicated here: GET /api/performance already is it, with real data.
const REPORT_VIEWS = {
  'sales-funnel': 'v_sales_funnel',
  'channel-attribution': 'v_channel_attribution',
  'revenue-daily': 'v_revenue_daily',
  'product-performance': 'v_product_performance',
  'loyalty-summary': 'v_loyalty_summary',
};

app.get('/api/reports/:report', requireRole('admin', 'viewer'), async (req, res) => {
  const view = REPORT_VIEWS[req.params.report];
  if (!view) return res.status(404).json({ error: `Unknown report. Available: ${Object.keys(REPORT_VIEWS).join(', ')}` });

  try {
    const { rows } = await pool.query(`SELECT * FROM ${view}`);
    res.json({ report: req.params.report, data: rows });
  } catch (err) {
    console.error('GET /api/reports/:report failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Automated follow-up scheduler (migration 018, extended by 020) ───────────
// The first real background job in this codebase — everything else time-based
// (SLA overdue, campaign eligibility, stock reservation expiry) is computed
// live on read instead, per this project's established no-scheduler pattern.
// A promo send genuinely can't work that way: it has to fire once, at a
// specific moment, whether or not anyone has the dashboard open.
//
// Runs every 15 minutes — plenty tight for a date-level (not time-level)
// schedule; the *_date columns are DATE, not TIMESTAMPTZ, so "today" is the
// real granularity regardless of how often this checks.
//
// Sends the one configured promo image+caption for every dateCol whose date
// has passed with sentCol still NULL on an open lead — used once for the
// original follow_up_2_date trigger, then once per each of the 4 concrete
// weekly dates (migration 020: the user wants the promo repeated on every
// one of those 4 scheduled weeks, not just the original single send).
// Idempotent by construction: each call only ever touches leads where its
// own sentCol IS NULL, so a lead already sent for that specific date is
// never touched again no matter how many ticks pass — and the 5 dates are
// independent columns, so one date's send/failure never blocks another's.
async function sendScheduledPromo(dateCol, sentCol, settings) {
  const { rows: dueLeads } = await pool.query(`
    SELECT l.id, c.id AS customer_id, c.whatsapp_number, c.contact_whatsapp_number, c.channel
    FROM leads l
    JOIN customers c ON c.id = l.customer_id
    WHERE l.ticket_state = 'open'
      AND l.${sentCol} IS NULL
      AND l.${dateCol} IS NOT NULL
      AND l.${dateCol} < CURRENT_DATE
  `);

  for (const lead of dueLeads) {
    try {
      await sendWhatsAppImage(
        { channel: lead.channel, whatsapp_number: lead.whatsapp_number, contact_whatsapp_number: lead.contact_whatsapp_number },
        settings.promo_image_url,
        settings.promo_caption || ''
      );
      await pool.query(`UPDATE leads SET ${sentCol} = NOW() WHERE id = $1`, [lead.id]);
      await pool.query(`INSERT INTO messages (customer_id, direction, content, sender_type) VALUES ($1, 'outbound', $2, 'staff')`, [
        lead.customer_id,
        `[Automated promo image sent] ${settings.promo_caption || ''}`.trim(),
      ]);
      broadcastEvent('lead_update', { id: lead.id });
      console.log(`Follow-up scheduler: sent promo (${dateCol}) to lead ${lead.id}`);
    } catch (sendErr) {
      console.error(`Follow-up scheduler: promo send failed (${dateCol}) for lead ${lead.id}:`, sendErr.message);
    }
  }
}

const WEEKLY_PROMO_COLUMNS = [
  ['week_1_date', 'week_1_sent_at'],
  ['week_2_date', 'week_2_sent_at'],
  ['week_3_date', 'week_3_sent_at'],
  ['week_4_date', 'week_4_sent_at'],
];

async function runFollowUpScheduler() {
  try {
    const { rows: settingsRows } = await pool.query(
      `SELECT key, value FROM app_settings WHERE key IN ('promo_image_url', 'promo_caption')`
    );
    const settings = Object.fromEntries(settingsRows.map((r) => [r.key, r.value]));

    if (settings.promo_image_url) {
      await sendScheduledPromo('follow_up_2_date', 'promo_sent_at', settings);
      for (const [dateCol, sentCol] of WEEKLY_PROMO_COLUMNS) {
        await sendScheduledPromo(dateCol, sentCol, settings);
      }
    }

    // Legacy single-rolling-date field (migration 018's original design,
    // superseded by the 4 concrete week_N_date columns above for new leads)
    // — still rolled forward for any lead that already has it set, so
    // nothing already in flight silently goes stale.
    await pool.query(`
      UPDATE leads
      SET next_weekly_follow_up_date = next_weekly_follow_up_date + INTERVAL '7 days'
      WHERE ticket_state = 'open'
        AND next_weekly_follow_up_date IS NOT NULL
        AND next_weekly_follow_up_date < CURRENT_DATE
    `);
  } catch (err) {
    console.error('Follow-up scheduler tick failed:', err.message);
  }
}

// Global Express error handler — catches anything a route's own try/catch
// missed (thrown synchronously, or an error passed to next()). Without this,
// an uncaught error inside a route handler crashes the request with Express's
// default HTML error page (or, pre-Express-5, can leave the request hanging).
// ── Activity log & soft deletes (migrations 035/036) ─────────────────────────
// Which tables a user may look at history for, and the label each one is known
// by in the UI. Also the allowlist: :table comes from the URL and is
// interpolated into SQL for the deleted/restore routes, so it must never be
// anything a caller invented.
const AUDITED = {
  leads:                  { label: 'Lead',            soft: true  },
  lead_items:             { label: 'Lead item',       soft: true  },
  orders:                 { label: 'Order',           soft: true  },
  order_payments:         { label: 'Payment',         soft: true  },
  customers:              { label: 'Customer',        soft: true  },
  products:               { label: 'Product',         soft: true  },
  promo_codes:            { label: 'Promo code',      soft: true  },
  warranties:             { label: 'Warranty',        soft: false },
  service_tickets:        { label: 'Service ticket',  soft: false },
  promo_code_redemptions: { label: 'Redemption',      soft: false },
  influencers:            { label: 'Influencer',      soft: false },
  staff_users:            { label: 'Staff user',      soft: false },
};

// The audit trigger runs on the REAL table, which migration 036 renamed to
// <name>_all for the soft-deletable ones. So a lookup by table name has to
// accept both spellings or an order's history would come back empty.
const auditNames = t => (AUDITED[t]?.soft ? [t, `${t}_all`] : [t]);

// ── GET /api/activity/:table/:id — one record's own history ──────────────────
// Powers the History panel on an order/lead/product. Same roles as the pages
// themselves: anyone who can see the record can see what happened to it.
app.get('/api/activity/:table/:id', requireRole(...PIPELINE_READ_ROLES), async (req, res) => {
  const { table, id } = req.params;
  // Object.prototype keys ('constructor', '__proto__') are truthy on a plain
  // object literal, so membership is tested with hasOwnProperty rather than a
  // bare lookup. Harmless here (the name is bound as a parameter below, never
  // interpolated) but the weaker form should not be copied to a route that
  // does interpolate.
  if (!Object.prototype.hasOwnProperty.call(AUDITED, table)) {
    return res.status(400).json({ error: 'That record type has no history' });
  }
  // staff_users history is admin-only: it holds account changes, and a leak
  // here was a real finding — an ungated version of this route let a viewer
  // read other staff members' bcrypt hashes out of the log.
  if (table === 'staff_users' && !hasRole(req.staff, 'admin')) {
    return res.status(403).json({ error: 'Only an admin can view staff account history' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, action, staff_id, staff_name, staff_role, changes, label, created_at
         FROM activity_log
        WHERE table_name = ANY($1) AND record_id = $2
        ORDER BY created_at DESC, id DESC
        LIMIT 200`,
      [auditNames(table), id]
    );
    res.json({ entries: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/activity — the admin-wide activity feed ─────────────────────────
// "What did the team do today". Admin/viewer only: it spans every record in the
// system, including ones an individual role cannot otherwise see.
app.get('/api/activity', requireRole('admin', 'viewer'), async (req, res) => {
  const { table, staffId, action, from, to } = req.query;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const where = [];
  const params = [];
  if (table) {
    if (!AUDITED[table]) return res.status(400).json({ error: 'Unknown record type' });
    params.push(auditNames(table)); where.push(`table_name = ANY($${params.length})`);
  }
  if (staffId) { params.push(staffId); where.push(`staff_id = $${params.length}`); }
  if (action)  { params.push(action);  where.push(`action = $${params.length}`); }
  if (from)    { params.push(from);    where.push(`created_at >= $${params.length}`); }
  // Inclusive of the whole end day, so a date range reads the way staff expect.
  if (to)      { params.push(to);      where.push(`created_at < ($${params.length}::date + 1)`); }
  params.push(limit);
  try {
    const { rows } = await pool.query(
      `SELECT id, table_name, record_id, action, staff_id, staff_name, staff_role,
              changes, label, created_at
         FROM activity_log
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length}`,
      params
    );
    res.json({ entries: rows, types: AUDITED });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/staff-activity — who worked when, and what they changed ─────────
// Backs the super_admin Users & hours screen. One route rather than three, so
// the screen cannot show a person's hours and their actions from two
// inconsistent reads.
//
// Three sources, each answering a different question and deliberately NOT
// merged into one number:
//   * v_staff_active_hours   — per local day: sessions, first/last seen, total
//                              time, whether they are online now (migration 045)
//   * v_staff_login_history  — sign-in attempts, including failures/lockouts;
//                              the ONLY source of history from before 045
//   * activity_log           — what they actually changed, with before/after
//
// Reads are not audited anywhere in this system (a deliberate choice — see the
// note on the pool.query wrapper), so "activity" here means WRITES. A super
// admin cannot see who merely viewed a record, and the screen says so rather
// than implying complete coverage.
app.get('/api/staff-activity', requireRole(SUPER_ADMIN), async (req, res) => {
  const { staffId, from, to } = req.query;
  const days = Math.min(Number(req.query.days) || 30, 365);
  try {
    const params = [days];
    let staffFilter = '';
    if (staffId) { params.push(staffId); staffFilter = ` AND staff_id = $${params.length}`; }

    const hours = schemaFlags.staffSessions
      ? (await pool.query(
          `SELECT * FROM v_staff_active_hours
            WHERE day >= (CURRENT_DATE - $1::int)${staffFilter}
            ORDER BY day DESC, staff_name ASC`,
          params
        )).rows
      : [];

    const logins = schemaFlags.auditLog
      ? (await pool.query(
          `SELECT * FROM v_staff_login_history
            WHERE occurred_at >= now() - ($1::int || ' days')::interval${staffFilter}
            ORDER BY occurred_at DESC
            LIMIT 500`,
          params
        )).rows
      : [];

    // The actions feed reuses the same shape GET /api/activity returns, so the
    // frontend can render both with one component.
    const actParams = [];
    const actWhere = [];
    if (staffId) { actParams.push(staffId); actWhere.push(`staff_id = $${actParams.length}`); }
    if (from)    { actParams.push(from);    actWhere.push(`created_at >= $${actParams.length}`); }
    if (to)      { actParams.push(to);      actWhere.push(`created_at < ($${actParams.length}::date + 1)`); }
    const { rows: actions } = await pool.query(
      `SELECT id, table_name, record_id, action, staff_id, staff_name, staff_role,
              changes, label, created_at
         FROM activity_log
        ${actWhere.length ? 'WHERE ' + actWhere.join(' AND ') : ''}
        ORDER BY created_at DESC, id DESC
        LIMIT 300`,
      actParams
    );

    const { rows: staff } = await pool.query(
      `SELECT id, name, role, active FROM staff_users ORDER BY active DESC, name ASC`
    );

    res.json({
      staff,
      hours,
      logins,
      actions,
      // Told to the client rather than assumed, so the screen can say "not
      // recorded yet" instead of rendering an empty table that looks like
      // "nobody worked".
      sessionsAvailable: !!schemaFlags.staffSessions,
    });
  } catch (err) {
    console.error('GET /api/staff-activity failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/deleted/:table — the bin ────────────────────────────────────────
// Reads the base table directly (the view hides exactly these rows). Listing
// stays open to admin so they can see what was removed; RESTORING is
// super_admin only (see that route below).
app.get('/api/deleted/:table', requireRole('admin'), async (req, res) => {
  const { table } = req.params;
  if (!AUDITED[table]?.soft) return res.status(400).json({ error: 'That record type is not soft-deletable' });
  try {
    const { rows } = await pool.query(
      // The table name is interpolated, never the caller's string: it is one of
      // the fixed keys of AUDITED, checked above.
      `SELECT d.*, s.name AS deleted_by_name
         FROM ${table}_all d
         LEFT JOIN staff_users s ON s.id = d.deleted_by
        WHERE d.deleted_at IS NOT NULL
        ORDER BY d.deleted_at DESC
        LIMIT 200`
    );
    res.json({ records: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/deleted/:table/:id/restore ─────────────────────────────────────
// Clearing deleted_at is itself an UPDATE on the base table, so the audit
// trigger records it as a RESTORE with this admin's name — no extra logging here.
// DELIBERATE NARROWING (migration 045, confirmed with the user): restoring a
// deleted record used to be open to `admin` and is now super_admin only.
// Bringing a record back is an oversight action — it resurrects data someone
// with delete rights decided to remove — so it sits with the role that owns
// the audit trail. This is the ONE capability an existing role loses in this
// change; every other role keeps exactly what it had. Listing the deleted
// records (GET above) stays open to admin, so an admin can still see what was
// removed and ask for it back.
app.post('/api/deleted/:table/:id/restore', requireRole(SUPER_ADMIN), async (req, res) => {
  const { table, id } = req.params;
  if (!AUDITED[table]?.soft) return res.status(400).json({ error: 'That record type is not soft-deletable' });
  try {
    const { rows } = await pool.query(
      `UPDATE ${table}_all SET deleted_at = NULL, deleted_by = NULL
        WHERE id = $1 AND deleted_at IS NOT NULL
        RETURNING id`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'No deleted record with that id — it may already have been restored' });
    }
    console.log(`${AUDITED[table].label} ${id} restored by ${req.staff.name || req.staff.role}`);
    res.json({ success: true, id: rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Payment proof attachments (migration 041) ────────────────────────────────
// A bank slip or receipt evidencing a payment — required in practice for an
// advance, where money has changed hands before anything is delivered.
//
// Uploaded as base64 in JSON rather than multipart: this backend has no file
// middleware and adding one (multer) to serve a handful of slips would be more
// moving parts than the job needs. The bytes go into Postgres so the proof is
// captured by the same pg_dump as the payment it proves — a slip on the VM's
// disk would be missing from a restore exactly when it is needed.
const ATTACHMENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

// What the bytes ACTUALLY are, from their magic number — the caller's declared
// mimeType is just a string in the request body and is never evidence of
// anything. Without this an SVG full of script, or an HTML page, could be
// stored under a declared image/png: harmless while the download route sends
// Content-Disposition: attachment and nosniff, but a stored-XSS primitive the
// moment anyone adds an inline preview of these files.
//
// Also closes a quieter hole: Node's Buffer.from(x, 'base64') silently DISCARDS
// invalid characters rather than throwing, so the try/catch around it can never
// fire and garbage input was stored as garbage bytes under a valid-looking
// type. Garbage has no valid signature, so it is now rejected here.
function sniffMimeType(buf) {
  if (buf.length < 12) return null;
  const hex4 = buf.subarray(0, 4).toString('hex');
  if (hex4.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex4 === '89504e47') return 'image/png';
  if (hex4 === '25504446') return 'application/pdf'; // %PDF
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}
const ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;

// ── POST /api/orders/:id/payments/:paymentId/attachments ─────────────────────
// Same roles as recording the payment itself: a sales agent takes the advance
// at the counter and is the one holding the slip.
app.post(
  '/api/orders/:id/payments/:paymentId/attachments',
  requireRole('admin', 'finance', 'sales_agent'),
  requireOrderVisible,
  async (req, res) => {
    const { filename, mimeType, data } = req.body;
    if (!filename || !mimeType || !data) {
      return res.status(400).json({ error: 'filename, mimeType and data are required' });
    }
    if (!ATTACHMENT_TYPES.includes(mimeType)) {
      return res.status(400).json({ error: 'Attach a JPG, PNG, WEBP or PDF' });
    }

    // Accepts a bare base64 string or a full data: URL, since a browser
    // FileReader produces the latter.
    const base64 = String(data).includes(',') ? String(data).split(',').pop() : String(data);
    let bytes;
    try {
      bytes = Buffer.from(base64, 'base64');
    } catch {
      return res.status(400).json({ error: 'Attachment data is not valid base64' });
    }
    if (bytes.length === 0) return res.status(400).json({ error: 'Attachment is empty' });
    if (bytes.length > ATTACHMENT_MAX_BYTES) {
      return res.status(400).json({ error: 'Attachment must be 4MB or smaller' });
    }

    // The declared type must match what the file really is. The DETECTED type
    // is what gets stored, so the column can never disagree with the bytes.
    const detected = sniffMimeType(bytes);
    if (!detected) {
      return res.status(400).json({ error: 'That file is not a readable JPG, PNG, WEBP or PDF' });
    }
    if (detected !== mimeType) {
      return res.status(400).json({ error: `File contents are ${detected}, not ${mimeType}` });
    }

    try {
      // Confirm the payment belongs to this order before storing anything
      // against it — the two ids come from the URL and must agree.
      const { rows: pay } = await pool.query(
        'SELECT id FROM order_payments WHERE id=$1 AND order_id=$2',
        [req.params.paymentId, req.params.id]
      );
      if (pay.length === 0) return res.status(404).json({ error: 'Payment not found on this order' });

      const { rows } = await pool.query(
        `INSERT INTO payment_attachments (payment_id, order_id, filename, mime_type, byte_size, bytes, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, filename, mime_type, byte_size, uploaded_at`,
        [
          req.params.paymentId,
          req.params.id,
          // CR/LF/quote stripped: res.setHeader throws ERR_INVALID_CHAR on a
          // newline, which would make the file permanently undownloadable
          // (a 500 on every fetch) with no way to rename it.
          String(filename).replace(/[\r\n"\\]/g, '').trim().slice(0, 200) || 'attachment',
          detected, bytes.length, bytes, req.staff.id,
        ]
      );
      console.log(`Payment proof attached to order ${req.params.id} by ${req.staff.name || req.staff.role}`);
      res.json({ success: true, attachment: rows[0] });
    } catch (err) {
      console.error('POST payment attachment failed:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ── GET /api/orders/:id/attachments — list, without the bytes ────────────────
// Deliberately omits `bytes`: a list of five slips would otherwise be megabytes
// of base64 the screen never renders.
app.get('/api/orders/:id/attachments', requireRole('admin', 'finance', 'sales_agent', 'viewer'), requireOrderVisible, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.payment_id, a.filename, a.mime_type, a.byte_size, a.uploaded_at,
              s.name AS uploaded_by_name
         FROM payment_attachments a
         LEFT JOIN staff_users s ON s.id = a.uploaded_by
        WHERE a.order_id = $1
        ORDER BY a.uploaded_at ASC`,
      [req.params.id]
    );
    res.json({ attachments: rows });
  } catch (err) {
    console.error('GET attachments failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/attachments/:id — the file itself ───────────────────────────────
// Served with Content-Disposition: attachment so a PDF or image is downloaded
// rather than rendered in the page's own origin.
app.get('/api/attachments/:id', requireRole('admin', 'finance', 'sales_agent', 'viewer'), async (req, res) => {
  try {
    // Joined to the orders VIEW, not the base table: that both proves the
    // attachment belongs to a real order and inherits the soft-delete filter,
    // so proof attached to a deleted order stops being downloadable with it.
    // ...and a sales agent only reaches proof on their own orders (058).
    const params = [req.params.id];
    const { rows } = await pool.query(
      `SELECT a.filename, a.mime_type, a.bytes
         FROM payment_attachments a
         JOIN orders o ON o.id = a.order_id
        WHERE a.id = $1${orderVisibilityFilter(req, params)}`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Attachment not found' });
    const a = rows[0];
    res.setHeader('Content-Type', a.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename="${a.filename.replace(/"/g, '')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(a.bytes);
  } catch (err) {
    console.error('GET attachment failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/attachments/:id ──────────────────────────────────────────────
// Admin/finance only: a proof is evidence, so removing one is not a routine
// correction a sales agent makes.
app.delete('/api/attachments/:id', requireRole('admin', 'finance'), async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM payment_attachments WHERE id=$1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Attachment not found' });
    console.log(`Payment proof ${req.params.id} deleted by ${req.staff.name || req.staff.role}`);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE attachment failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.use((err, req, res, next) => {
  console.error('Unhandled route error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

// Everything below is startup: it must run when this file is the entry point
// (`node index.js`) and must NOT run when it is required, which the tests do
// so they can exercise the real routes through supertest. Without the guard,
// requiring this file would bind a port, arm a 15-minute cron against a
// mocked pool, and install process-level exit handlers inside the test
// runner.
function start() {
  cron.schedule('*/15 * * * *', runFollowUpScheduler);

  // Process-level safety net — logs and exits so Docker's `restart:
  // unless-stopped` can bring the process back clean, rather than continuing
  // to run in a possibly-corrupted state after an error nothing else caught.
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason);
    process.exit(1);
  });

  const PORT = process.env.PORT || 3000;
  // Detect optional schema BEFORE serving, so the first request already knows
  // which column set this database actually has.
  return detectSchema().finally(() => {
    app.listen(PORT, () => console.log(`Backend listening on port ${PORT}`));
  });
}

if (require.main === module) start();

// Exported so the test suite can drive the REAL app rather than
// re-implementing routes inside the test file.
module.exports = {
  app, pool, start, detectSchema, schemaFlags, QUERY_TOKEN_PATHS,
  computeEligibleSubtotal, countEligibleUnits, cappedPromoUnits, previewPromoDiscount,
  parseCustomDiscount, customDiscountNote, paidItemsSubtotal, parseQuotationBody, phoneServerUrl,
};
