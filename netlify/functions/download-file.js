const jwt          = require('jsonwebtoken');
const { getStore } = require('@netlify/blobs');

// Extension → MIME type fallback map
const MIME_MAP = {
  stl:    'model/stl',
  step:   'application/step',
  stp:    'application/step',
  f3d:    'application/octet-stream',
  sldprt: 'application/octet-stream',
  pdf:    'application/pdf',
  dxf:    'application/dxf',
  svg:    'image/svg+xml',
  ai:     'application/postscript',
};

function blobStore(name) {
  const opts = { name, consistency: 'strong' };
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;
  if (siteID && token) { opts.siteID = siteID; opts.token = token; }
  return getStore(opts);
}

function getCookie(cookieHeader, name) {
  const match = (cookieHeader || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return match ? match.slice(name.length + 1) : null;
}

function mimeFromExtension(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

exports.handler = async (event) => {
  // Admin-only: verify JWT cookie
  const token = getCookie(event.headers['cookie'] || '', 'admin_token');
  if (!token) return { statusCode: 401, body: 'Unauthorized' };
  try {
    jwt.verify(token, process.env.JWT_SECRET || '');
  } catch {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const key = (event.queryStringParameters || {}).key;
  if (!key) return { statusCode: 400, body: 'Missing ?key parameter' };

  try {
    const store  = blobStore('uploads');
    const result = await store.getWithMetadata(key, { type: 'arrayBuffer' });

    if (!result) {
      console.error('[download-file] Key not found in uploads store:', key);
      return { statusCode: 404, body: 'File not found' };
    }

    const { data: buffer, metadata } = result;

    // Blobs API may normalise metadata keys to lowercase in some versions
    const originalName = metadata?.originalName || metadata?.originalname
      || key.replace(/^\d+-/, '');
    const contentType  = metadata?.contentType  || metadata?.contenttype
      || mimeFromExtension(originalName)
      || 'application/octet-stream';

    console.log('[download-file] serving key=%s name=%s type=%s size=%d',
      key, originalName, contentType, buffer.byteLength);

    return {
      statusCode:      200,
      isBase64Encoded: true,
      headers: {
        'Content-Type':        contentType,
        'Content-Disposition': `attachment; filename="${originalName.replace(/"/g, '\\"')}"`,
        'Content-Length':      String(buffer.byteLength),
        'Cache-Control':       'no-store',
      },
      body: Buffer.from(buffer).toString('base64'),
    };
  } catch (err) {
    console.error('[download-file] Error:', err.message, err.stack);
    return { statusCode: 500, body: 'Internal server error' };
  }
};
