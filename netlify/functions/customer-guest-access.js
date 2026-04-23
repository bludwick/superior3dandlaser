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

  // ── Parse body ─────────────────────────────────────────────────────────────
  let projectNumber, email;
  try {
    ({ projectNumber, email } = JSON.parse(event.body || '{}'));
  } catch {
    return jsonResponse(400, { error: 'Invalid request body' });
  }

  if (!projectNumber || !email) {
    return jsonResponse(400, { error: 'Project number and email are required' });
  }

  // ── Lookup order by projectNumber and verify email ─────────────────────────
  try {
    const bs = blobStore('orders');
    const { blobs } = await bs.list();

    let matchingOrder = null;
    for (const blob of blobs) {
      try {
        const text = await bs.get(blob.key);
        const order = text ? JSON.parse(text) : null;
        if (order && order.projectNumber === projectNumber && order.customerEmail.toLowerCase() === email.toLowerCase()) {
          matchingOrder = order;
          break;
        }
      } catch {
        // Skip invalid orders
      }
    }

    if (!matchingOrder) {
      return jsonResponse(404, { error: 'Order not found. Please verify your project number and email.' });
    }

    // Return order data for guest access (strip sensitive fields if needed)
    return jsonResponse(200, {
      order: matchingOrder,
      token: projectNumber + '_' + email.toLowerCase(),
    });
  } catch (err) {
    console.error('[customer-guest-access] Error:', err.message);
    return jsonResponse(500, { error: 'Failed to load order' });
  }
};

function jsonResponse(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}
