#!/usr/bin/env node
/**
 * Seed bulk TEST leads into the Pipeline, for load-testing the page.
 *
 * WHY THIS EXISTS
 * The Pipeline performance work (server-side won-stats + bundle splitting) was
 * written against a database holding only a handful of leads, which cannot show
 * whether the page is actually fast at real volume. This generates enough rows
 * to measure that honestly.
 *
 * SAFETY — this is test data and must never be mistaken for real business data:
 *   - Every customer it creates has whatsapp_number starting 9477000 and a name
 *     prefixed "[TEST]", so both are searchable and obvious in the UI.
 *   - Every lead it creates carries follow_up_notes starting with the marker
 *     below, which is what the cleanup deletes on. Nothing is matched by
 *     "looks like test data" guesswork.
 *   - It REFUSES to run against a database that is not local unless
 *     --i-know-this-is-not-local is passed, so a stray DATABASE_URL pointing at
 *     production cannot quietly fill the live pipeline with fake leads.
 *
 * Usage:
 *   node scripts/seed_test_leads.cjs            # insert 500 (default)
 *   node scripts/seed_test_leads.cjs --count=50
 *   node scripts/seed_test_leads.cjs --clean    # remove everything it created
 */

const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// The single marker that makes cleanup exact rather than heuristic.
const MARKER = '[SEEDED TEST LEAD]';
const PHONE_PREFIX = '9477000';
const NAME_PREFIX = '[TEST]';

const args = process.argv.slice(2);
const CLEAN = args.includes('--clean');
const FORCE_REMOTE = args.includes('--i-know-this-is-not-local');
const COUNT = Number((args.find(a => a.startsWith('--count=')) || '').split('=')[1]) || 500;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (expected in whatsapp-backend/.env)');
  process.exit(1);
}

// Refuse to touch anything that is not obviously a local database. The check is
// on the HOST rather than the database name, because a production host with a
// database also called "crm" is exactly the accident worth preventing.
const isLocal = /@(localhost|127\.0\.0\.1|db|crm-postgres)[:/]/.test(url);
if (!isLocal && !FORCE_REMOTE) {
  console.error('Refusing to run: DATABASE_URL does not look local.');
  console.error('  ' + url.replace(/:[^:@]*@/, ':***@'));
  console.error('Pass --i-know-this-is-not-local only if you really mean it.');
  process.exit(1);
}

const pool = new Pool({ connectionString: url });

// ── realistic field values, taken from what the database really uses ─────────
// Statuses are the six the UI's STATUS map defines (LeadsPage.jsx), so every
// Pipeline tab has rows to show. Weighted so the board looks plausible rather
// than uniform: most leads are new or in progress, fewer are won/lost.
const STATUSES = [
  ...Array(28).fill('new'),
  ...Array(18).fill('quotation_sent'),
  ...Array(22).fill('follow_up'),
  ...Array(10).fill('not_answered'),
  ...Array(14).fill('won'),
  ...Array(8).fill('lost'),
];
// Real source strings already present in this database. 'Facebook' is a
// historical misnomer for WhatsApp-originated leads (see CLAUDE.md) and is
// included because it is genuinely the most common value in real rows.
const SOURCES = ['Facebook', 'Call tracker app', 'website chat', 'showroom', 'Dialog call'];
const CHANNELS = ['twilio', 'webchat', 'call', 'showroom'];
const PRODUCTS = ['Ayu Sleep 6', 'Nidikumba Rise', 'Nidikumba Signature', 'Nidikumba Ayu Spring', 'Gel Pillow', 'Bolster Pillow'];
const SIZES = ['72x36', '75x36', '78x42', '72x60', '84x60', '78x72'];
const CATEGORIES = ['Retail', 'Wholesale', 'Corporate'];
const PRIORITIES = ['high', 'medium', 'low'];
const LOCATIONS = [
  'Colombo', 'Kandy', 'Galle', 'Negombo', 'Kurunegala', 'Matara', 'Jaffna',
  'Anuradhapura', 'Ratnapura', 'Badulla', 'Gampaha', 'Kalutara',
];
const FIRST = ['Nimal', 'Kamal', 'Sunil', 'Saman', 'Ruwan', 'Chamara', 'Dilshan', 'Kasun', 'Tharindu', 'Isuru', 'Nadeesha', 'Sanduni', 'Hiruni', 'Amali', 'Dinusha', 'Shanika'];
const LAST = ['Perera', 'Silva', 'Fernando', 'Bandara', 'Jayasuriya', 'Wickramasinghe', 'Rajapaksa', 'Gunawardena', 'Herath', 'Dissanayake'];

const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const int = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
// A date N days from today as YYYY-MM-DD. DATE columns are read back as plain
// strings in this codebase (the pg type-parser override for OID 1082), so a
// string is what the rest of the app expects.
const dayOffset = n => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

async function clean() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Delete against the BASE tables: `leads`/`customers` are soft-delete views
    // (migration 036), so a DELETE through them would only set deleted_at and
    // leave the rows behind for the next run to trip over.
    const { rows: leadRows } = await client.query(
      `DELETE FROM leads_all WHERE follow_up_notes LIKE $1 RETURNING customer_id`,
      [MARKER + '%']
    );
    const custIds = [...new Set(leadRows.map(r => r.customer_id).filter(Boolean))];

    let deletedCustomers = 0;
    if (custIds.length) {
      // Only remove a seeded customer that nothing else references — if a real
      // message, order or ticket somehow attached to one, keep the row rather
      // than cascade-deleting real history.
      const { rowCount } = await client.query(
        `DELETE FROM customers_all c
          WHERE c.id = ANY($1::uuid[])
            AND c.name LIKE $2
            AND NOT EXISTS (SELECT 1 FROM leads_all   l WHERE l.customer_id = c.id)
            AND NOT EXISTS (SELECT 1 FROM messages    m WHERE m.customer_id = c.id)
            AND NOT EXISTS (SELECT 1 FROM orders_all  o WHERE o.customer_id = c.id)`,
        [custIds, NAME_PREFIX + '%']
      );
      deletedCustomers = rowCount;
    }
    await client.query('COMMIT');
    console.log(`Removed ${leadRows.length} seeded leads and ${deletedCustomers} seeded customers.`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function seed() {
  const client = await pool.connect();
  let made = 0;
  try {
    await client.query('BEGIN');
    for (let i = 0; i < COUNT; i++) {
      // A unique, clearly-fake Sri Lankan-shaped number in the canonical
      // 94XXXXXXXXX format migration 030 requires.
      const phone = PHONE_PREFIX + String(i).padStart(4, '0');
      const name = `${NAME_PREFIX} ${pick(FIRST)} ${pick(LAST)}`;
      const status = pick(STATUSES);
      // Spread creation over the last 90 days so the date filters, the 7-day
      // sparklines and the month-boundary stats all have something to bite on.
      const ageDays = int(0, 90);
      const created = new Date();
      created.setDate(created.getDate() - ageDays);

      const { rows: cust } = await client.query(
        `INSERT INTO customers (whatsapp_number, name, channel, created_at)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [phone, name, pick(CHANNELS), created]
      );

      const isClosed = status === 'won' || status === 'lost';
      await client.query(
        `INSERT INTO leads (
           customer_id, status, source, product_type, bed_size, qty, unit_price,
           location, delivery_address, category, priority, next_contact_date,
           follow_up_notes, ticket_state, closed_at, closed_reason,
           created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          cust[0].id,
          status,
          pick(SOURCES),
          pick(PRODUCTS),
          pick(SIZES),
          int(1, 3),
          int(28, 140) * 500,
          pick(LOCATIONS),
          `No. ${int(1, 400)}, ${pick(LAST)} Road, ${pick(LOCATIONS)}`,
          pick(CATEGORIES),
          pick(PRIORITIES),
          // A mix of overdue, due today and upcoming, so the "Today's calls"
          // filter and the overdue stat tile both have real matches.
          dayOffset(int(-10, 21)),
          `${MARKER} generated for Pipeline load testing`,
          isClosed ? 'closed' : 'open',
          isClosed ? created : null,
          isClosed ? (status === 'won' ? 'Converted to order' : 'Customer bought elsewhere') : null,
          created,
          created,
        ]
      );
      made++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  console.log(`Inserted ${made} test leads (and ${made} customers).`);
  console.log(`Remove them with:  node scripts/seed_test_leads.cjs --clean`);
}

(async () => {
  try {
    if (CLEAN) await clean();
    else await seed();
    const { rows } = await pool.query(
      `SELECT count(*) FILTER (WHERE ticket_state='open') AS open, count(*) AS total FROM leads_all`
    );
    console.log(`Pipeline now holds ${rows[0].open} open leads (${rows[0].total} total).`);
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
