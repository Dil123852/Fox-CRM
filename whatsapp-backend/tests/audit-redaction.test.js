// Guards the OTHER half of the password-hash leak.
//
// WHAT HAPPENED. log_activity() (migration 035) records whole rows into
// activity_log. staff_users has a password_hash column, so every write to that
// table put a live bcrypt hash into the audit log — 15 rows by the time it was
// found. Migration 042 fixed it by stripping four columns by NAME.
//
// WHY A NAME LIST IS NOT ENOUGH. It is a denylist. The next credential column
// added to an audited table — `reset_token`, `api_key`, `mfa_secret` — repeats
// the bug exactly, silently, and is only found by the next audit.
//
// So this asserts the INVARIANT rather than the current list: no audited table
// may carry a secret-looking column that the trigger does not strip. A new
// column named like a credential fails here, at PR time, naming itself.
//
// This reads the real schema rather than parsing migration text, because the
// question is "what is actually in the database", not "what did we write down".
// It is therefore skipped when no database is reachable (CI without a
// Postgres service), so it never produces a false red.

// The suite mocks 'pg' globally (tests/__mocks__/pg.js exports only a Pool),
// so this file opts out: it must talk to a real database to inspect the real
// schema, which is the entire point of the check.
jest.unmock('pg');
const { Client } = jest.requireActual('pg');

// The same shape index.js already uses to redact audit detail keys
// (AUDIT_REDACT), kept in step deliberately.
const SECRET_ISH = /pass|secret|token|hash|api[-_]?key|salt|credential/i;

// Tables log_activity() is attached to — mirrors the AUDITED map in index.js.
const AUDITED_TABLES = [
  'leads',
  'lead_items',
  'orders',
  'order_payments',
  'customers',
  'products',
  'promo_codes',
  'warranties',
  'service_tickets',
  'promo_code_redemptions',
  'influencers',
  'staff_users',
];

// Columns migration 042's log_activity() strips from both sides of the diff.
// Extending this list is the deliberate act that makes the test pass again —
// and it must be done in the migration too, not just here.
const STRIPPED = ['password_hash', 'failed_login_count', 'locked_until', 'last_failed_login_at'];

// The real (non-view) table behind each audited name: migration 036 renamed the
// soft-deletable ones to <name>_all and put a filtering view in their place.
const candidates = (t) => [`${t}_all`, t];

describe('audit redaction: no secret column can reach activity_log', () => {
  let client;
  let reachable = false;

  beforeAll(async () => {
    // jest.mock('pg') is NOT applied in this file: it needs the real driver.
    client = new Client({
      connectionString: process.env.TEST_DATABASE_URL || 'postgresql://crm:crm_secret@127.0.0.1:5432/crm',
      // Fail fast rather than hanging a CI run that has no database.
      connectionTimeoutMillis: 3000,
    });
    try {
      await client.connect();
      reachable = true;
    } catch {
      reachable = false;
    }
  });

  afterAll(async () => {
    if (reachable) await client.end().catch(() => {});
  });

  test('every secret-looking column on an audited table is stripped by log_activity()', async () => {
    if (!reachable) {
      console.warn('audit-redaction: no database reachable — skipped. Set TEST_DATABASE_URL to run it.');
      return;
    }

    const offenders = [];
    for (const table of AUDITED_TABLES) {
      for (const name of candidates(table)) {
        const { rows } = await client.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1`,
          [name]
        );
        if (rows.length === 0) continue; // this spelling does not exist; try the other
        for (const { column_name: col } of rows) {
          if (SECRET_ISH.test(col) && !STRIPPED.includes(col)) {
            offenders.push(`${name}.${col}`);
          }
        }
        break; // only inspect the first spelling that exists
      }
    }

    // A failure here names the column. Fix it by stripping the column in
    // log_activity() (see migration 042) AND adding it to STRIPPED above —
    // never by loosening SECRET_ISH.
    expect(offenders).toEqual([]);
  });

  test('no password hash is sitting in activity_log', async () => {
    if (!reachable) return;
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM activity_log WHERE changes::text LIKE '%password_hash%'`
    );
    expect(rows[0].n).toBe(0);
  });
});
