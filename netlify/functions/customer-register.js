const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { getStore } = require('@netlify/blobs');

function blobStore(name) {
  const opts = { name, consistency: 'strong' };
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;
  if (siteID && token) { opts.siteID = siteID; opts.token = token; }
  return getStore(opts);
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let name, email, password;
  try {
    ({ name, email, password } = JSON.parse(event.body || '{}'));
  } catch {
    return jsonResponse(400, { error: 'Invalid request body' });
  }

  if (!name || !email || !password) {
    return jsonResponse(400, { error: 'Name, email, and password are required' });
  }
  if (password.length < 8) {
    return jsonResponse(400, { error: 'Password must be at least 8 characters' });
  }

  const emailLower = email.toLowerCase().trim();

  // Block demo account registration
  if (emailLower === 'demo@example.com') {
    return jsonResponse(409, { error: 'An account with this email already exists' });
  }

  const store = blobStore('customer-auth');

  // Check if account already exists
  try {
    const existing = await store.get(emailLower, { type: 'json' });
    if (existing) {
      return jsonResponse(409, { error: 'An account with this email already exists' });
    }
  } catch {
    // Not found — proceed
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const record = { name: name.trim(), email: emailLower, passwordHash, createdAt: new Date().toISOString() };

  try {
    await store.set(emailLower, record, { metadata: { version: 1 } });
  } catch (err) {
    console.error('Failed to save customer account:', err);
    return jsonResponse(500, { error: 'Failed to create account. Please try again.' });
  }

  const jwtSecret = process.env.JWT_SECRET || '';
  const token = jwt.sign({ sub: emailLower, name: name.trim() }, jwtSecret, { expiresIn: '8h' });

  const isProd = (process.env.URL || '').startsWith('https://');
  const cookieParts = [
    `customer_token=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${8 * 60 * 60}`,
  ];
  if (isProd) cookieParts.push('Secure');

  return {
    statusCode: 201,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': cookieParts.join('; '),
    },
    body: JSON.stringify({ ok: true, name: name.trim() }),
  };
};

function jsonResponse(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
