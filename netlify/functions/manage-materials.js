const jwt          = require('jsonwebtoken');
const { getStore } = require('@netlify/blobs');

const BLOB_KEY = 'materials-library';

function blobStore() {
  const opts = { name: 'materials', consistency: 'strong' };
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;
  if (siteID && token) { opts.siteID = siteID; opts.token = token; }
  return getStore(opts);
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,PUT', 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' };
  }

  // ── GET (public) ─────────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    try {
      const bs   = blobStore();
      const text = await bs.get(BLOB_KEY);
      if (!text) return jsonResponse(404, { error: 'No materials saved yet' });
      return jsonResponse(200, JSON.parse(text));
    } catch (err) {
      console.error('[manage-materials] GET error:', err.message);
      return jsonResponse(500, { error: 'Failed to load materials: ' + err.message });
    }
  }

  // ── PUT (admin-only) ──────────────────────────────────────────────────────────
  if (event.httpMethod === 'PUT') {
    const cookieHeader = event.headers['cookie'] || event.headers['Cookie'] || '';
    const token = (cookieHeader.match(/(?:^|;\s*)admin_token=([^;]+)/) || [])[1];
    if (!token) return jsonResponse(401, { error: 'Unauthorized' });
    try { jwt.verify(token, process.env.JWT_SECRET || ''); } catch { return jsonResponse(401, { error: 'Unauthorized' }); }

    try {
      const body = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : (event.body || '[]');
      const materials = JSON.parse(body);
      if (!Array.isArray(materials)) return jsonResponse(400, { error: 'Body must be a JSON array' });
      const bs = blobStore();
      await bs.set(BLOB_KEY, JSON.stringify(materials));
      return jsonResponse(200, { ok: true });
    } catch (err) {
      console.error('[manage-materials] PUT error:', err.message);
      return jsonResponse(500, { error: 'Failed to save materials: ' + err.message });
    }
  }

  return jsonResponse(405, { error: 'Method Not Allowed' });
};
