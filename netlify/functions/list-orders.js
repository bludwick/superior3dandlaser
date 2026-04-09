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
  // Verify admin JWT from cookie
  const token = getCookie(event.headers['cookie'] || '', 'admin_token');
  if (!token) return authError();

  const jwtSecret = process.env.JWT_SECRET || '';
  try {
    jwt.verify(token, jwtSecret);
  } catch {
    return authError();
  }

  // ── Route: GET /api/admin/orders ─────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    return listOrders();
  }

  // ── Route: POST /api/admin/orders/{id}/status ────────────────────────────
  if (event.httpMethod === 'POST') {
    // path: /api/admin/orders/{id}/status
    const match = (event.path || '').match(/\/([^/]+)\/status$/);
    if (match) return updateStatus(match[1], event.body);
  }

  // ── Route: PATCH /api/admin/orders/{id}/files ────────────────────────────
  if (event.httpMethod === 'PATCH') {
    const match = (event.path || '').match(/\/([^/]+)\/files$/);
    if (match) return attachFiles(match[1], event.body);
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};

async function listOrders() {
  try {
    const bs = blobStore('orders');
    const { blobs } = await bs.list();

    const orders = await Promise.all(
      blobs.map(async (blob) => {
        try {
          const text = await bs.get(blob.key);
          return text ? JSON.parse(text) : null;
        } catch {
          return null;
        }
      })
    );

    const valid = orders
      .filter(Boolean)
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    return jsonResponse(200, valid);
  } catch (err) {
    console.error('[list-orders] Error:', err.message);
    return jsonResponse(500, { error: 'Failed to load orders' });
  }
}

async function updateStatus(orderId, body) {
  let status;
  try {
    ({ status } = JSON.parse(body || '{}'));
  } catch {
    return jsonResponse(400, { error: 'Invalid body' });
  }
  if (!['pending', 'confirmed'].includes(status)) {
    return jsonResponse(400, { error: 'Status must be "pending" or "confirmed"' });
  }

  try {
    const bs = blobStore('orders');
    const { blobs } = await bs.list();
    let targetKey = null;
    for (const blob of blobs) {
      const t = await bs.get(blob.key).catch(() => null);
      const order = t ? JSON.parse(t) : null;
      if (order && order.id === orderId) { targetKey = blob.key; break; }
    }
    if (!targetKey) return jsonResponse(404, { error: 'Order not found' });

    const raw = await bs.get(targetKey);
    const order = JSON.parse(raw);
    order.status = status;
    await bs.set(targetKey, JSON.stringify(order));
    return jsonResponse(200, { ok: true });
  } catch (err) {
    console.error('[list-orders] Update error:', err.message);
    return jsonResponse(500, { error: 'Failed to update order' });
  }
}

async function attachFiles(orderId, rawBody) {
  let stlFiles;
  try {
    ({ stlFiles } = JSON.parse(rawBody || '{}'));
  } catch {
    return jsonResponse(400, { error: 'Invalid body' });
  }
  if (!Array.isArray(stlFiles) || !stlFiles.length) {
    return jsonResponse(400, { error: 'stlFiles array required' });
  }

  try {
    const bs = blobStore('orders');
    const { blobs } = await bs.list();
    let targetKey = null, order = null;
    for (const blob of blobs) {
      const t = await bs.get(blob.key).catch(() => null);
      const o = t ? JSON.parse(t) : null;
      if (o && o.id === orderId) { targetKey = blob.key; order = o; break; }
    }
    if (!targetKey) return jsonResponse(404, { error: 'Order not found' });

    order.stlFiles = [...(order.stlFiles || []), ...stlFiles];
    await bs.set(targetKey, JSON.stringify(order));

    // Sync new files to the linked job if one exists
    if (order.jobId) {
      try {
        const jbs = blobStore('jobs');
        const jobKey = `job_${order.jobId}`;
        const jobText = await jbs.get(jobKey);
        if (jobText) {
          const job = JSON.parse(jobText);
          job.stlFiles = [...(job.stlFiles || []), ...stlFiles];
          job.updatedAt = new Date().toISOString();
          await jbs.set(jobKey, JSON.stringify(job));
        }
      } catch (err) {
        console.error('[list-orders] job sync error:', err.message);
      }
    }

    return jsonResponse(200, { ok: true, stlFiles: order.stlFiles });
  } catch (err) {
    console.error('[list-orders] attachFiles error:', err.message);
    return jsonResponse(500, { error: 'Failed to attach files' });
  }
}

function getCookie(cookieHeader, name) {
  const match = cookieHeader.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return match ? match.slice(name.length + 1) : null;
}

function authError() {
  return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Unauthorized' }) };
}

function jsonResponse(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
