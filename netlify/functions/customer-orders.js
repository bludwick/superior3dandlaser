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
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

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

  // ── Get all orders for this customer ────────────────────────────────────────
  try {
    const bs = blobStore('orders');
    const { blobs } = await bs.list();

    const orders = [];
    for (const blob of blobs) {
      try {
        const text = await bs.get(blob.key);
        const order = text ? JSON.parse(text) : null;
        if (order && order.customerEmail.toLowerCase() === customerEmail.toLowerCase()) {
          orders.push(order);
        }
      } catch {
        // Skip invalid orders
      }
    }

    // Sort by createdAt descending
    orders.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    return jsonResponse(200, orders);
  } catch (err) {
    console.error('[customer-orders] Error:', err.message);
    return jsonResponse(500, { error: 'Failed to load orders' });
  }
};

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
