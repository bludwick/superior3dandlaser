/**
 * Creates a customer account in the Netlify Blobs `customer-auth` store.
 *
 * Requires NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN (or NETLIFY_TOKEN) in your .env file.
 *
 * Usage:
 *   node scripts/create-customer.js
 *
 * The script will prompt for name, email, and password, then store a bcrypt hash.
 */

require('dotenv').config();

const bcrypt     = require('bcryptjs');
const readline   = require('readline');
const { getStore } = require('@netlify/blobs');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function main() {
  console.log('\n── Create Customer Account ──────────────────────────\n');

  const name     = (await ask('Full name:    ')).trim();
  const email    = (await ask('Email:        ')).trim().toLowerCase();
  const phone    = (await ask('Phone (opt):  ')).trim();
  const password = (await ask('Password:     ')).trim();

  rl.close();

  if (!name || !email || !password) {
    console.error('\nError: name, email, and password are required.');
    process.exit(1);
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('\nError: invalid email address.');
    process.exit(1);
  }

  console.log('\nHashing password (cost 12)…');
  const passwordHash = await bcrypt.hash(password, 12);

  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;

  if (!siteID || !token) {
    console.error('\nError: NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN must be set in .env');
    process.exit(1);
  }

  const store = getStore({ name: 'customer-auth', consistency: 'strong', siteID, token });

  const existing = await store.get(email, { type: 'json' }).catch(() => null);
  if (existing) {
    const overwrite = (await ask(`\nAccount for ${email} already exists. Overwrite? (y/N): `)).trim().toLowerCase();
    if (overwrite !== 'y') {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  const record = {
    email,
    name,
    phone,
    passwordHash,
    createdAt: existing?.createdAt || new Date().toISOString(),
    lastLogin: null,
  };

  await store.set(email, record);

  console.log('\n──────────────────────────────────────────────────');
  console.log(`✓ Customer account created:`);
  console.log(`  Name:  ${name}`);
  console.log(`  Email: ${email}`);
  console.log('──────────────────────────────────────────────────');
  console.log('\nCustomers can now log in at /portal/ with these credentials.');
}

main().catch(err => {
  console.error('\nError:', err.message);
  process.exit(1);
});
