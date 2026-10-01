require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const name = process.env.SEED_ADMIN_NAME || 'Admin';
  const phone = process.env.SEED_ADMIN_PHONE;
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!phone || !password) {
    console.error('Set SEED_ADMIN_PHONE and SEED_ADMIN_PASSWORD env vars before running this script.');
    process.exitCode = 1;
    return pool.end();
  }

  const { rows } = await pool.query('SELECT id FROM staff_users WHERE phone=$1', [phone]);
  if (rows.length > 0) {
    console.log(`Staff user with phone ${phone} already exists — nothing to do.`);
    return pool.end();
  }

  const password_hash = await bcrypt.hash(password, 10);
  await pool.query('INSERT INTO staff_users (name, phone, password_hash, role) VALUES ($1,$2,$3,$4)', [
    name,
    phone,
    password_hash,
    'admin',
  ]);
  console.log(`Admin account created for ${phone}.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
