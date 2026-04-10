const jwt              = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

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

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
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
      const supabase = getSupabase();
      const path     = `${Date.now()}-${name}`;
      const buf      = Buffer.from(base64, 'base64');
      const { error } = await supabase.storage
        .from('Uploads')
        .upload(path, buf, { contentType: type || mimeFromExtension(name), upsert: false });
      if (error) throw new Error(error.message);
      console.log('[download-file] uploaded path=%s name=%s size=%d', path, name, buf.length);
      return jsonResp(200, { blobKey: path, fileName: name });
    } catch (err) {
      console.error('[download-file] upload error:', err.message);
      return jsonResp(500, { error: 'Upload failed: ' + err.message });
    }
  }

  // ── GET: download a file by blob key ───────────────────────────────────────
  const key = (event.queryStringParameters || {}).key;
  if (!key) return { statusCode: 400, body: 'Missing ?key parameter' };

  try {
    const supabase = getSupabase();
    const { data: blob, error } = await supabase.storage.from('Uploads').download(key);

    if (error || !blob) {
      console.error('[download-file] Key not found:', key, error?.message);
      return { statusCode: 404, body: 'File not found' };
    }

    const buffer       = Buffer.from(await blob.arrayBuffer());
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
