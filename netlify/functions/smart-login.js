const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { getStore } = require('@netlify/blobs');

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS   = 15 * 60 * 1000;

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

  let email, password;
  try {
    ({ email, password } = JSON.parse(event.body || '{}'));
  } catch {
    return jsonResponse(400, { error: 'Invalid request body' });
  }

  if (!email || !password) {
    return jsonResponse(400, { error: 'Email and password are required' });
  }

  const emailLower  = email.toLowerCase();
  const jwtSecret   = process.env.JWT_SECRET || '';
  const isProd      = (process.env.URL || '').startsWith('https://');

  // ── Rate limiting ──────────────────────────────────────────────────────────
  const ip    = (event.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  const rlKey = `rl_${ip.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

  let rlStore;
  let attempts = { count: 0, firstAt: Date.now() };
  try {
    rlStore = blobStore('admin-auth');
    const stored = await rlStore.get(rlKey, { type: 'json' });
    if (stored) attempts = stored;
  } catch { /* proceed without rate limiting */ }

  if (Date.now() - attempts.firstAt > LOCKOUT_MS) {
    attempts = { count: 0, firstAt: Date.now() };
  }
  if (attempts.count >= MAX_ATTEMPTS) {
    return jsonResponse(429, { error: 'Too many attempts. Try again in 15 minutes.' });
  }

  // ── 1. Check admin credentials ─────────────────────────────────────────────
  const adminEmail    = process.env.ADMIN_EMAIL         || '';
  const adminHash     = process.env.ADMIN_PASSWORD_HASH || '';
  const adminPassword = process.env.ADMIN_PASSWORD      || '';

  let adminOk = false;
  if (emailLower === adminEmail.toLowerCase()) {
    if (adminHash) {
      try { adminOk = await bcrypt.compare(password, adminHash); } catch { /* invalid hash */ }
    } else if (adminPassword) {
      adminOk = password === adminPassword;
    }
  }

  if (adminOk) {
    if (rlStore) try { await rlStore.delete(rlKey); } catch { /* best-effort */ }

    const token = jwt.sign({ sub: adminEmail }, jwtSecret, { expiresIn: '8h' });
    const cookieParts = [
      `admin_token=${token}`,
      'HttpOnly', 'Path=/', 'SameSite=Strict',
      `Max-Age=${8 * 60 * 60}`,
    ];
    if (isProd) cookieParts.push('Secure');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookieParts.join('; ') },
      body: JSON.stringify({ ok: true, role: 'admin' }),
    };
  }

  // ── 2. Check customer credentials ──────────────────────────────────────────
  let customer = null;
  try {
    customer = await blobStore('customer-auth').get(emailLower, { type: 'json' });
  } catch { /* not found */ }

  let customerOk = false;
  if (customer) {
    try { customerOk = await bcrypt.compare(password, customer.passwordHash); } catch { /* bad hash */ }
  } else {
    // Dummy bcrypt to prevent timing-based enumeration
    try { await bcrypt.compare(password, '$2b$12$invalidhashxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'); } catch { /* no-op */ }
  }

  if (customerOk && !customer.verified) {
    return jsonResponse(403, { error: 'Please verify your email before signing in. Check your inbox for the verification link.' });
  }

  if (customerOk) {
    if (rlStore) try { await rlStore.delete(rlKey); } catch { /* best-effort */ }

    const token = jwt.sign({ sub: emailLower, name: customer.name }, jwtSecret, { expiresIn: '8h' });
    const cookieParts = [
      `customer_token=${token}`,
      'HttpOnly', 'Path=/', 'SameSite=Strict',
      `Max-Age=${8 * 60 * 60}`,
    ];
    if (isProd) cookieParts.push('Secure');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookieParts.join('; ') },
      body: JSON.stringify({ ok: true, role: 'customer', name: customer.name }),
    };
  }

  // ── 3. Failure ─────────────────────────────────────────────────────────────
  attempts.count += 1;
  if (rlStore) try { await rlStore.set(rlKey, attempts); } catch { /* best-effort */ }

  return jsonResponse(401, { error: 'Invalid email or password' });
};

function jsonResponse(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
