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
      // ── Diagnostic: list buckets so we can verify the bucket name ────────
      const bucketsRes = await fetch(
        `${process.env.SUPABASE_URL}/storage/v1/bucket`,
        { headers: { 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }
      );
      const bucketsText = await bucketsRes.text();
      let availableBuckets = [];
      try { availableBuckets = JSON.parse(bucketsText).map(b => b.name); } catch { availableBuckets = [`(parse error) ${bucketsText.slice(0, 100)}`]; }
      console.log('[download-file] available buckets:', JSON.stringify(availableBuckets));

      // Use whichever bucket name casing Supabase actually has, defaulting to 'Uploads'
      const bucket = availableBuckets.find(n => n.toLowerCase() === 'uploads') || 'Uploads';

      const path = `${Date.now()}-${fileName}`;
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
          availableBuckets,
          bucketUsed:       bucket,
        });
      }

      const { url } = JSON.parse(signText);
      // url is the bucket/path?token=... portion; prefix with base storage URL
      const signedUrl = `${process.env.SUPABASE_URL}/storage/v1/object/upload/sign/${url}`;
      console.log('[download-file] signed upload URL created for path=%s', path);
      return jsonResp(200, { signedUrl, path });
    } catch (err) {
      console.error('[download-file] sign upload error:', err.message);
      return jsonResp(500, { error: 'Failed to create upload URL: ' + err.message });
    }
  }

  // ── GET: generate a short-lived signed download URL and redirect ────────────
  // This avoids streaming the entire file through the Netlify function
  const key = (event.queryStringParameters || {}).key;
  if (!key) return { statusCode: 400, body: 'Missing ?key parameter' };

  try {
    const originalName = key.replace(/^\d+-/, '');
    const signRes = await fetch(
      `${process.env.SUPABASE_URL}/storage/v1/object/sign/Uploads/${encodeURIComponent(key)}`,
      {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({ expiresIn: 300 }),  // 5-minute window
      }
    );

    if (!signRes.ok) {
      console.error('[download-file] sign download error:', key, signRes.status);
      return { statusCode: 404, body: 'File not found' };
    }

    const { signedURL } = await signRes.json();
    // Add &download= so Supabase sets Content-Disposition: attachment
    const redirectUrl = `${process.env.SUPABASE_URL}${signedURL}&download=${encodeURIComponent(originalName)}`;

    console.log('[download-file] redirecting to signed URL for key=%s', key);
    return {
      statusCode: 302,
      headers: { 'Location': redirectUrl, 'Cache-Control': 'no-store' },
      body: '',
    };
  } catch (err) {
    console.error('[download-file] Error:', err.message, err.stack);
    return { statusCode: 500, body: 'Internal server error' };
  }
};

function jsonResp(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}
