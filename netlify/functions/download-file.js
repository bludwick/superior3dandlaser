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
  if (!token) return new Response('Unauthorized', { status: 401 });
  try {
    jwt.verify(token, process.env.JWT_SECRET || '');
  } catch {
    return new Response('Unauthorized', { status: 401 });
  }

  const key = (event.queryStringParameters || {}).key;
  if (!key) return new Response('Missing ?key parameter', { status: 400 });

  try {
    const store  = blobStore('uploads');
    const result = await store.getWithMetadata(key, { type: 'arrayBuffer' });

    if (!result) return new Response('File not found', { status: 404 });

    const { data: buffer, metadata } = result;
    const originalName = metadata?.originalName || key.replace(/^\d+-/, '');
    const contentType  = metadata?.contentType  || mimeFromExtension(originalName) || 'application/octet-stream';

    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type':        contentType,
        'Content-Disposition': `attachment; filename="${originalName.replace(/"/g, '\\"')}"`,
        'Content-Length':      String(buffer.byteLength),
        'Cache-Control':       'no-store',
      },
    });
  } catch (err) {
    console.error('[download-file] Error:', err.message);
    return new Response('Internal server error', { status: 500 });
  }
};
