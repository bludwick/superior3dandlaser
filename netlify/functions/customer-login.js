const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { getStore } = require('@netlify/blobs');

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS   = 15 * 60 * 1000; // 15 minutes

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

  // ── Parse body ─────────────────────────────────────────────────────────────
  let email, password;
  try {
    ({ email, password } = JSON.parse(event.body || '{}'));
  } catch {
    return jsonResponse(400, { error: 'Invalid request body' });
  }

  if (!email || !password) {
    return jsonResponse(400, { error: 'Email and password are required' });
  }

  // ── Rate limiting (persisted via Netlify Blobs) ────────────────────────────
  const ip    = (event.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  const rlKey = `rl_${ip.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

  let store;
  let attempts = { count: 0, firstAt: Date.now() };

  try {
    store = blobStore('customer-auth');
    const stored = await store.get(rlKey, { type: 'json' });
    if (stored) attempts = stored;
  } catch {
    // Blobs unavailable — proceed without rate limiting
  }

  // Reset window if expired
  if (Date.now() - attempts.firstAt > LOCKOUT_MS) {
    attempts = { count: 0, firstAt: Date.now() };
  }

  if (attempts.count >= MAX_ATTEMPTS) {
    return jsonResponse(429, { error: 'Too many attempts. Try again in 15 minutes.' });
  }

  // ── Demo mode shortcut ────────────────────────────────────────────────────
  const emailLower = email.toLowerCase();
  if (emailLower === 'demo@example.com') {
    const token = jwt.sign({ sub: emailLower, name: 'Demo Customer' }, process.env.JWT_SECRET || '', { expiresIn: '8h' });
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
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookieParts.join('; ') },
      body: JSON.stringify({ ok: true, name: 'Demo Customer' }),
    };
  }

  // ── Lookup customer credentials ─────────────────────────────────────────────
  let customer = null;
  try {
    store = blobStore('customer-auth');
    const stored = await store.get(emailLower, { type: 'json' });
    customer = stored;
  } catch {
    // Customer not found or error reading
  }

  let passwordOk = false;
  if (customer) {
    try {
      passwordOk = await bcrypt.compare(password, customer.passwordHash);
    } catch {
      // Invalid hash or comparison error
    }
  } else {
    // Run dummy bcrypt to prevent timing-based email enumeration
    try {
      await bcrypt.compare(password, '$2b$12$invalidhashxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    } catch { /* no-op */ }
  }

  const success = customer && passwordOk;

  if (!success) {
    attempts.count += 1;
    if (store) {
      try { await store.set(rlKey, attempts, { metadata: { version: 1 } }); } catch { /* best-effort */ }
    }
    return jsonResponse(401, { error: 'Invalid email or password' });
  }

  // ── Success ────────────────────────────────────────────────────────────────
  if (store) {
    try { await store.delete(rlKey); } catch { /* best-effort */ }
  }

  const jwtSecret = process.env.JWT_SECRET || '';
  const token = jwt.sign({ sub: email.toLowerCase(), name: customer.name }, jwtSecret, { expiresIn: '8h' });

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
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': cookieParts.join('; '),
    },
    body: JSON.stringify({ ok: true, name: customer.name }),
  };
};

function jsonResponse(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
