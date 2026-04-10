const jwt = require('jsonwebtoken');

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

function getCookie(cookieHeader, name) {
  const match = (cookieHeader || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return match ? match.slice(name.length + 1) : null;
}

function mimeFromExtension(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

// ── Supabase Storage via direct HTTP (no SDK) ─────────────────────────────────

function storagePath(key) {
  return `${process.env.SUPABASE_URL}/storage/v1/object/Uploads/${encodeURIComponent(key)}`;
}

async function supabaseUpload(key, buffer, contentType) {
  const res = await fetch(storagePath(key), {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type':  contentType,
      'x-upsert':      'false',
    },
    body: buffer,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase upload failed (${res.status}): ${text.slice(0, 300)}`);
  }
}

async function supabaseDownload(key) {
  const res = await fetch(storagePath(key), {
    headers: { 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

// ─────────────────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  // Admin-only: verify JWT cookie
  const token = getCookie(event.headers['cookie'] || '', 'admin_token');
  if (!token) return { statusCode: 401, body: 'Unauthorized' };
  try {
    jwt.verify(token, process.env.JWT_SECRET || '');
  } catch {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  // ── POST: upload a single file (base64 JSON) ──────────────────────────────
  if (event.httpMethod === 'POST') {
    let bodyStr = event.body || '{}';
    if (event.isBase64Encoded) {
      try { bodyStr = Buffer.from(event.body, 'base64').toString('utf8'); } catch { bodyStr = '{}'; }
    }
    let data;
    try { data = JSON.parse(bodyStr); } catch { return jsonResp(400, { error: 'Invalid JSON' }); }

    const { name, type, base64 } = data;
    if (!name || !base64) return jsonResp(400, { error: 'name and base64 required' });

    try {
      const key = `${Date.now()}-${name}`;
      const buf = Buffer.from(base64, 'base64');
      await supabaseUpload(key, buf, type || mimeFromExtension(name));
      console.log('[download-file] uploaded key=%s name=%s size=%d', key, name, buf.length);
      return jsonResp(200, { blobKey: key, fileName: name });
    } catch (err) {
      console.error('[download-file] upload error:', err.message);
      return jsonResp(500, { error: 'Upload failed: ' + err.message });
    }
  }

  // ── GET: download a file by blob key ───────────────────────────────────────
  const key = (event.queryStringParameters || {}).key;
  if (!key) return { statusCode: 400, body: 'Missing ?key parameter' };

  try {
    const buffer = await supabaseDownload(key);

    if (!buffer) {
      console.error('[download-file] Key not found:', key);
      return { statusCode: 404, body: 'File not found' };
    }

    const originalName = key.replace(/^\d+-/, '');
    const contentType  = mimeFromExtension(originalName) || 'application/octet-stream';

    console.log('[download-file] serving key=%s name=%s type=%s size=%d',
      key, originalName, contentType, buffer.length);

    return {
      statusCode:      200,
      isBase64Encoded: true,
      headers: {
        'Content-Type':        contentType,
        'Content-Disposition': `attachment; filename="${originalName.replace(/"/g, '\\"')}"`,
        'Content-Length':      String(buffer.length),
        'Cache-Control':       'no-store',
      },
      body: buffer.toString('base64'),
    };
  } catch (err) {
    console.error('[download-file] Error:', err.message, err.stack);
    return { statusCode: 500, body: 'Internal server error' };
  }
};

function jsonResp(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}
