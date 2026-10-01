#!/usr/bin/env node
/**
 * Create the FIRST super_admin account.
 *
 * WHY THIS SCRIPT EXISTS. Only a super_admin may grant the super_admin role
 * (that is the whole point of the role — an admin promoting themselves would
 * defeat it), so the first one cannot be created through the dashboard. It has
 * to be done once, out of band, on the server.
 *
 * Doing it in SQL by hand would mean generating a bcrypt hash by hand, which
 * is the step people get wrong: pasting a plaintext password into
 * password_hash produces an account that exists, looks correct in the staff
 * list, and can never log in. This script hashes with the same bcrypt the
 * login route verifies with, and enforces the same password rules the API
 * does, so a rejected password is caught here rather than after the account
 * exists.
 *
 * Usage (from whatsapp-backend/, with .env present):
 *
 *   node scripts/create-super-admin.js --name "Name" --phone 94771234567
 *
 * The password is read from the SUPER_ADMIN_PASSWORD environment variable, not
 * from an argument, so it does not end up in the shell history or in `ps`:
 *
 *   SUPER_ADMIN_PASSWORD='...' node scripts/create-super-admin.js --name ... --phone ...
 *
 * Re-running with an existing phone number PROMOTES that account instead of
 * failing, so this is safe to run twice.
 */

// dotenv is optional here. Run on a HOST with a .env file it loads DATABASE_URL
// from there; run INSIDE the backend container (which is how this project
// deploys — the image has no .env, the values come from docker-compose's
// `environment:` block) there is nothing to load and the module may not even be
// resolvable from this path. Either way the variables are already in the
// environment by the time they are read, so a missing dotenv must not be fatal.
try {
  require('dotenv').config();
} catch {
  // no .env to load — environment variables are expected to be set already
}
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const PASSWORD_MIN_LENGTH = 12;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

// Same canonical form the rest of the system stores (migration 030). Without
// this an account created as 0771234567 would not match the 94771234567 the
// login form submits after normalization.
function normalizePhone(input) {
  const d = String(input || '').replace(/[^0-9]/g, '');
  if (/^94[0-9]{9}$/.test(d)) return d;
  if (/^940[0-9]{9}$/.test(d)) return `94${d.slice(3)}`;
  if (/^0[0-9]{9}$/.test(d)) return `94${d.slice(1)}`;
  if (/^[0-9]{9}$/.test(d)) return `94${d}`;
  return null;
}

(async () => {
  const name = arg('name');
  const phoneRaw = arg('phone');
  const password = process.env.SUPER_ADMIN_PASSWORD;

  const fail = msg => { console.error(`\n  ✗ ${msg}\n`); process.exit(1); };

  if (!name) fail('--name is required');
  if (!phoneRaw) fail('--phone is required');
  if (!password) fail('Set SUPER_ADMIN_PASSWORD in the environment (not as an argument).');
  if (password.length < PASSWORD_MIN_LENGTH) {
    fail(`Password must be at least ${PASSWORD_MIN_LENGTH} characters (the API enforces this too).`);
  }

  const phone = normalizePhone(phoneRaw);
  if (!phone) fail(`"${phoneRaw}" is not a recognisable Sri Lankan number. Use 0771234567 or 94771234567.`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // Fail early and clearly if migration 045 has not been applied — otherwise
    // the INSERT dies on the CHECK constraint with a message that does not say
    // what to do about it.
    const { rows: ck } = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'staff_users_role_check'`
    );
    if (!ck.length || !ck[0].def.includes('super_admin')) {
      fail('This database does not allow the super_admin role yet. Apply migrations/045_super_admin_role.sql first.');
    }

    const hash = await bcrypt.hash(password, 10);

    const { rows: existing } = await pool.query('SELECT id, name, role FROM staff_users WHERE phone = $1', [phone]);

    if (existing.length) {
      // Promote rather than error. The common second run is "I typed the wrong
      // password the first time" or "I want to re-run after the migration".
      const { rows } = await pool.query(
        `UPDATE staff_users SET role = 'super_admin', password_hash = $1, active = true, name = $2
          WHERE phone = $3 RETURNING id, name, phone, role`,
        [hash, name, phone]
      );
      console.log(`\n  ✓ Existing account promoted to super_admin`);
      console.log(`      ${rows[0].name}  ${rows[0].phone}  (was ${existing[0].role})`);
      console.log(`      Password was reset to the one supplied.\n`);
    } else {
      const { rows } = await pool.query(
        `INSERT INTO staff_users (name, phone, password_hash, role, active)
         VALUES ($1, $2, $3, 'super_admin', true) RETURNING id, name, phone, role`,
        [name, phone, hash]
      );
      console.log(`\n  ✓ Super admin created`);
      console.log(`      ${rows[0].name}  ${rows[0].phone}\n`);
    }

    const { rows: all } = await pool.query(
      `SELECT name, phone FROM staff_users WHERE role = 'super_admin' AND active ORDER BY name`
    );
    console.log(`  Super admins on this database (${all.length}):`);
    for (const s of all) console.log(`      ${s.name}  ${s.phone}`);
    console.log('');
  } catch (err) {
    fail(err.message);
  } finally {
    await pool.end();
  }
})();
