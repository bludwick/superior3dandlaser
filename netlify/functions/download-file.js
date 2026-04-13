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

  // ── GET: proxy the file directly through this function ──────────────────────
  // Using a signed-URL redirect had too many silent failure modes:
  //   • browser cross-origin restrictions on the `download` attribute
  //   • SUPABASE_URL + relative signedURL path concatenation edge cases
  //   • no visibility into whether the redirect itself worked
  // Proxying with the service-role key is simpler, same-origin, and reliable.
  const key = (event.queryStringParameters || {}).key;
  if (!key) return { statusCode: 400, body: 'Missing ?key parameter', headers: { 'Content-Type': 'text/plain' } };

  try {
    const bucket       = await resolveUploadsBucket();
    const originalName = key.replace(/^\d+-/, '');
    const mime         = mimeFromExtension(originalName);

    const fileRes = await fetch(
      `${process.env.SUPABASE_URL}/storage/v1/object/${bucket}/${encodeURIComponent(key)}`,
      { headers: { 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }
    );

    if (!fileRes.ok) {
      const errText = await fileRes.text().catch(() => '');
      console.error('[download-file] fetch error — key:', key, 'bucket:', bucket,
        'status:', fileRes.status, 'body:', errText.slice(0, 200));
      return {
        statusCode: fileRes.status === 404 ? 404 : 502,
        body: fileRes.status === 404 ? 'File not found' : 'Storage error',
        headers: { 'Content-Type': 'text/plain' },
      };
    }

    const buffer = Buffer.from(await fileRes.arrayBuffer());
    console.log('[download-file] serving key=%s bucket=%s size=%d bytes', key, bucket, buffer.length);

    return {
      statusCode: 200,
      headers: {
        'Content-Type':        mime,
        'Content-Disposition': `attachment; filename="${originalName}"`,
        'Content-Length':      String(buffer.length),
        'Cache-Control':       'no-store',
      },
      body:            buffer.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error('[download-file] Error:', err.message, err.stack);
    return { statusCode: 500, body: 'Internal server error', headers: { 'Content-Type': 'text/plain' } };
  }
};

function jsonResp(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}
