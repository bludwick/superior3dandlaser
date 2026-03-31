/**
 * One-time script to generate a bcrypt hash of your admin password.
 *
 * Usage:
 *   node scripts/gen-password-hash.js
 *
 * Copy the printed hash into your .env file as ADMIN_PASSWORD_HASH
 * and into the Netlify dashboard under Site > Environment variables.
 */

const bcrypt   = require('bcryptjs');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Enter admin password: ', async (password) => {
  rl.close();

  if (!password.trim()) {
    console.error('Error: password cannot be empty.');
    process.exit(1);
  }

  console.log('\nGenerating hash (cost factor 12)…');
  const hash = await bcrypt.hash(password, 12);

  console.log('\n──────────────────────────────────────────────────');
  console.log('ADMIN_PASSWORD_HASH=' + hash);
  console.log('──────────────────────────────────────────────────');
  console.log('\nAdd this to your .env file and Netlify environment variables.');
  console.log('Never commit this value to git.');
});
