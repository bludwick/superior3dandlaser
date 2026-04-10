const jwt              = require('jsonwebtoken');
const busboy           = require('busboy');
const { createClient } = require('@supabase/supabase-js');

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
}

function getCookie(cookieHeader, name) {
  const match = (cookieHeader || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return match ? match.slice(name.length + 1) : null;
}

function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const files = [];
    const bb = busboy({ headers: event.headers });
    bb.on('file', (fieldName, stream, info) => {
      const { filename, mimeType } = info;
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => {
        if (chunks.length > 0) files.push({ fileName: filename, buffer: Buffer.concat(chunks), mimeType });
      });
    });
    bb.on('finish', () => resolve(files));
    bb.on('error', reject);
    const body = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
    bb.write(body);
    bb.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const token = getCookie(event.headers['cookie'] || '', 'admin_token');
  if (!token) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  try { jwt.verify(token, process.env.JWT_SECRET || ''); }
  catch { return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) }; }

  try {
    const files = await parseMultipart(event);
    if (!files.length) {
      return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'No files received' }) };
    }

    const supabase = getSupabase();
    const results  = [];

    for (const f of files) {
      const path = `${Date.now()}-${f.fileName}`;
      const { error } = await supabase.storage
        .from('Uploads')
        .upload(path, f.buffer, { contentType: f.mimeType, upsert: false });
      if (error) throw new Error(`Supabase upload failed: ${error.message}`);
      results.push({ blobKey: path, fileName: f.fileName });
      console.log('[upload-file] saved path=%s name=%s size=%d', path, f.fileName, f.buffer.length);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, files: results }),
    };
  } catch (err) {
    console.error('[upload-file] Error:', err.message, err.stack);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Upload failed: ' + err.message }),
    };
  }
};
