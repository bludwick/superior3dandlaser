// Public function: create a signed Supabase upload URL for large quote files.
// The browser uploads file bytes directly to Supabase, avoiding Netlify request-size limits.

// Cache resolved bucket name (Supabase buckets are case-sensitive).
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
      const match = buckets.map(b => b.name).find(n => n.toLowerCase() === 'uploads');
      _resolvedBucket = match || 'Uploads';
    } else {
      _resolvedBucket = 'Uploads';
    }
  } catch {
    _resolvedBucket = 'Uploads';
  }
  return _resolvedBucket;
}

function jsonResp(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body: JSON.stringify(body),
  };
}

function safeExt(fileName) {
  const name = String(fileName || '');
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return ext;
}

const ALLOWED_EXT = new Set(['step', 'stp', 'f3d', 'sldprt', 'stl', 'pdf', 'dxf', 'svg', 'ai']);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' };
  if (event.httpMethod !== 'POST') return jsonResp(405, { error: 'Method Not Allowed' });

  let bodyStr = event.body || '{}';
  if (event.isBase64Encoded) {
    try { bodyStr = Buffer.from(event.body, 'base64').toString('utf8'); } catch { bodyStr = '{}'; }
  }
  let data;
  try { data = JSON.parse(bodyStr); } catch { return jsonResp(400, { error: 'Invalid JSON' }); }

  const fileName = data.fileName;
  const contentType = data.contentType || 'application/octet-stream';
  const ext = safeExt(fileName);

  // Basic validation (no secrets, no auth). Prevent obvious misuse.
  if (!fileName || typeof fileName !== 'string') return jsonResp(400, { error: 'fileName required' });
  if (!ALLOWED_EXT.has(ext)) return jsonResp(400, { error: 'File type not allowed' });

  try {
    const bucket = await resolveUploadsBucket();
    // Include a small random component to avoid collisions.
    const rand = Math.random().toString(36).slice(2, 10);
    const path = `${Date.now()}-${rand}-${fileName}`;

    const signUrl = `${process.env.SUPABASE_URL}/storage/v1/object/upload/sign/${bucket}/${encodeURIComponent(path)}`;
    const signRes = await fetch(signUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    const signText = await signRes.text().catch(() => '');
    if (!signRes.ok) {
      return jsonResp(502, { error: 'Failed to create upload URL', supabaseStatus: signRes.status, supabaseResponse: signText.slice(0, 200) });
    }
    const parsed = JSON.parse(signText);
    const signedUrl = `${process.env.SUPABASE_URL}/storage/v1${parsed.url}`;

    // Provide bucket + path so we can sign a download URL later.
    return jsonResp(200, { ok: true, bucket, path, signedUrl, contentType });
  } catch (err) {
    return jsonResp(500, { error: 'Failed to create upload URL', detail: err?.message || String(err) });
  }
};

