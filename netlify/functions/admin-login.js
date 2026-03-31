const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { getStore } = require('@netlify/blobs');

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS   = 15 * 60 * 1000; // 15 minutes

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
    store = getStore({ name: 'admin-auth', consistency: 'strong' });
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

  // ── Credential check ───────────────────────────────────────────────────────
  const adminEmail = process.env.ADMIN_EMAIL        || '';
  const adminHash  = process.env.ADMIN_PASSWORD_HASH || '';
  const jwtSecret  = process.env.JWT_SECRET          || '';

  // Always run bcrypt to prevent timing-based email enumeration.
  // On email mismatch, compare against a dummy that will never match.
  const hashToCheck = email === adminEmail ? adminHash : '$2b$12$invalidhashxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  let passwordOk = false;
  try { passwordOk = await bcrypt.compare(password, hashToCheck); } catch { /* invalid hash → false */ }

  const success = email === adminEmail && passwordOk;

  if (!success) {
    attempts.count += 1;
    if (store) {
      try { await store.set(rlKey, attempts); } catch { /* best-effort */ }
    }
    return jsonResponse(401, { error: 'Invalid email or password' });
  }

  // ── Success ────────────────────────────────────────────────────────────────
  if (store) {
    try { await store.delete(rlKey); } catch { /* best-effort */ }
  }

  const token = jwt.sign({ sub: adminEmail }, jwtSecret, { expiresIn: '8h' });

  const isProd = (process.env.URL || '').startsWith('https://');
  const cookieParts = [
    `admin_token=${token}`,
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
    body: JSON.stringify({ ok: true }),
  };
};

function jsonResponse(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
