const jwt = require('jsonwebtoken');

// ── Shared bucket resolver ─────────────────────────────────────────────────────
// The POST (sign-upload) handler already detects the real bucket name because
// Supabase bucket names are case-sensitive and the bucket may be "uploads" or
// "Uploads". Cache the result so we only list buckets once per function instance.
let _resolvedBucket = null;

async function resolveUploadsBucket() {
  if (_resolvedBucket) return _resolvedBucket;
  try {
    const res = await fetch(
      `${process.env.SUPABASE_URL}/storage/v1/bucket`,
      { headers: { 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    if (res.ok) {
      const buckets = await res.json();
      const match   = buckets.map(b => b.name).find(n => n.toLowerCase() === 'uploads');
      _resolvedBucket = match || 'Uploads';
    } else {
      _resolvedBucket = 'Uploads';
    }
  } catch {
    _resolvedBucket = 'Uploads';
  }
  console.log('[download-file] resolved bucket:', _resolvedBucket);
  return _resolvedBucket;
}

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

exports.handler = async (event) => {
  // Admin-only: verify JWT cookie
  const token = getCookie(event.headers['cookie'] || '', 'admin_token');
  if (!token) return { statusCode: 401, body: 'Unauthorized' };
  try {
    jwt.verify(token, process.env.JWT_SECRET || '');
  } catch {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  // ── POST: generate a signed upload URL for direct browser→Supabase upload ──
  // Body: { fileName, contentType }
  // Returns: { signedUrl, path }  (browser PUTs file to signedUrl, stores path as blobKey)
  if (event.httpMethod === 'POST') {
    let bodyStr = event.body || '{}';
    if (event.isBase64Encoded) {
      try { bodyStr = Buffer.from(event.body, 'base64').toString('utf8'); } catch { bodyStr = '{}'; }
    }
    let data;
    try { data = JSON.parse(bodyStr); } catch { return jsonResp(400, { error: 'Invalid JSON' }); }

    const { fileName, contentType } = data;
    if (!fileName) return jsonResp(400, { error: 'fileName required' });

    try {
      const bucket = await resolveUploadsBucket();
      const path   = `${Date.now()}-${fileName}`;
      const signUrl = `${process.env.SUPABASE_URL}/storage/v1/object/upload/sign/${bucket}/${path}`;
      console.log('[download-file] signing URL:', signUrl);

      const signRes = await fetch(signUrl, {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type':  'application/json',
        },
        body: '{}',
      });
      const signText = await signRes.text();
      console.log('[download-file] sign response:', signRes.status, signText.slice(0, 300));

      if (!signRes.ok) {
        return jsonResp(500, {
          error:            'Failed to create upload URL',
          supabaseStatus:   signRes.status,
          supabaseResponse: signText.slice(0, 200),
          bucketUsed:       bucket,
        });
      }

      const { url } = JSON.parse(signText);
      // url is already the full path e.g. /object/upload/sign/Uploads/...?token=...
      const signedUrl = `${process.env.SUPABASE_URL}/storage/v1${url}`;
      console.log('[download-file] signed upload URL created for path=%s', path);
      return jsonResp(200, { signedUrl, path });
    } catch (err) {
      console.error('[download-file] sign upload error:', err.message);
      return jsonResp(500, { error: 'Failed to create upload URL: ' + err.message });
    }
  }

  // ── GET: return a short-lived Supabase signed download URL as JSON ──────────
  // We cannot proxy large files through Netlify (6 MB Lambda response limit).
  // Instead we generate a signed URL with ?download=filename so the browser
  // fetches the file directly from Supabase with the correct Content-Disposition,
  // and we open it in a new tab from JS — bypassing cross-origin `download` attr
  // restrictions entirely.
  const key = (event.queryStringParameters || {}).key;
  if (!key) return { statusCode: 400, body: 'Missing ?key parameter', headers: { 'Content-Type': 'text/plain' } };

  try {
    const bucket       = await resolveUploadsBucket();
    const originalName = key.replace(/^\d+-/, '');

    const signRes = await fetch(
      `${process.env.SUPABASE_URL}/storage/v1/object/sign/${bucket}/${encodeURIComponent(key)}`,
      {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({ expiresIn: 300 }),
      }
    );

    if (!signRes.ok) {
      const errText = await signRes.text().catch(() => '');
      console.error('[download-file] sign error — key:', key, 'bucket:', bucket,
        'status:', signRes.status, 'body:', errText.slice(0, 200));
      return jsonResp(signRes.status === 404 ? 404 : 502,
        { error: signRes.status === 404 ? 'File not found' : 'Storage error' });
    }

    const { signedURL } = await signRes.json();
    const supabaseBase  = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
    // signedURL is a relative path like /object/sign/...?token=... (relative to /storage/v1)
    const signedPath    = signedURL.startsWith('/storage/') ? signedURL : `/storage/v1${signedURL}`;
    const downloadUrl   = `${supabaseBase}${signedPath}&download=${encodeURIComponent(originalName)}`;
    console.log('[download-file] signed download URL created for key=%s', key);

    return jsonResp(200, { url: downloadUrl });
  } catch (err) {
    console.error('[download-file] Error:', err.message, err.stack);
    return jsonResp(500, { error: 'Internal server error' });
  }
};

function jsonResp(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}
