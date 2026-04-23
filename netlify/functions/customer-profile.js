const jwt = require('jsonwebtoken');
const { getStore } = require('@netlify/blobs');

function blobStore(name) {
  const opts = { name, consistency: 'strong' };
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;
  if (siteID && token) { opts.siteID = siteID; opts.token = token; }
  return getStore(opts);
}

exports.handler = async function (event) {
  // ── Verify customer JWT from cookie ─────────────────────────────────────────
  const token = getCookie(event.headers['cookie'] || '', 'customer_token');
  if (!token) return authError();

  const jwtSecret = process.env.JWT_SECRET || '';
  let decoded;
  try {
    decoded = jwt.verify(token, jwtSecret);
  } catch {
    return authError();
  }

  const customerEmail = decoded.sub;
  if (!customerEmail) return authError();

  // ── Route: GET /api/customer/profile ────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    return getProfile(customerEmail);
  }

  // ── Route: PUT /api/customer/profile ────────────────────────────────────────
  if (event.httpMethod === 'PUT') {
    return updateProfile(customerEmail, event.body);
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};

async function getProfile(customerEmail) {
  try {
    const bs = blobStore('customer-auth');
    const stored = await bs.get(customerEmail.toLowerCase(), { type: 'json' });
    if (!stored) return jsonResponse(404, { error: 'Profile not found' });

    // Return profile without passwordHash
    const { passwordHash, ...profile } = stored;
    return jsonResponse(200, profile);
  } catch (err) {
    console.error('[customer-profile GET] Error:', err.message);
    return jsonResponse(500, { error: 'Failed to load profile' });
  }
}

async function updateProfile(customerEmail, body) {
  let updates;
  try {
    updates = JSON.parse(body || '{}');
  } catch {
    return jsonResponse(400, { error: 'Invalid request body' });
  }

  // Only allow updating name and phone
  const allowedFields = ['name', 'phone'];
  const filteredUpdates = {};
  for (const field of allowedFields) {
    if (field in updates) filteredUpdates[field] = updates[field];
  }

  try {
    const bs = blobStore('customer-auth');
    const stored = await bs.get(customerEmail.toLowerCase(), { type: 'json' });
    if (!stored) return jsonResponse(404, { error: 'Profile not found' });

    const updated = {
      ...stored,
      ...filteredUpdates,
      lastLogin: stored.lastLogin,
    };

    await bs.set(customerEmail.toLowerCase(), updated);
    const { passwordHash, ...profile } = updated;
    return jsonResponse(200, profile);
  } catch (err) {
    console.error('[customer-profile PUT] Error:', err.message);
    return jsonResponse(500, { error: 'Failed to update profile' });
  }
}

function getCookie(cookieHeader, name) {
  const match = cookieHeader.match(new RegExp(`(^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[2]) : null;
}

function authError() {
  return jsonResponse(401, { error: 'Unauthorized' });
}

function jsonResponse(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}
