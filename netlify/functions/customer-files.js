const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const { getStore } = require('@netlify/blobs');

function blobStore(name) {
  const opts = { name, consistency: 'strong' };
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;
  if (siteID && token) { opts.siteID = siteID; opts.token = token; }
  return getStore(opts);
}

function supabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase not configured');
  }
  return createClient(supabaseUrl, supabaseKey);
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // ── Verify customer JWT from cookie ─────────────────────────────────────────
  const token = getCookie(event.headers['cookie'] || '', 'customer_token');
  if (!token) return authError();

  const jwtSecret = process.env.JWT_SECRET || '';
  let decoded;
  try {
    decoded = jwt.verify(token, jwtSecret);
  } catch {
    return authError();
  }

  const customerEmail = decoded.sub;
  if (!customerEmail) return authError();

  try {
    // Get all orders for this customer
    const bs = blobStore('orders');
    const { blobs } = await bs.list();

    const files = [];
    for (const blob of blobs) {
      try {
        const text = await bs.get(blob.key);
        const order = text ? JSON.parse(text) : null;
        if (order && order.customerEmail.toLowerCase() === customerEmail.toLowerCase()) {
          // Collect all files from this order
          if (order.stlFiles && Array.isArray(order.stlFiles)) {
            for (const file of order.stlFiles) {
              files.push({
                ...file,
                orderId: order.id,
                projectName: order.projectName,
                projectNumber: order.projectNumber,
              });
            }
          }
        }
      } catch {
        // Skip invalid orders
      }
    }

    // Generate signed URLs for each file
    const supabase = supabaseClient();
    const filesWithUrls = [];

    for (const file of files) {
      try {
        // Try both 'Uploads' and 'uploads' bucket names
        let signedUrl = null;
        try {
          const { data, error } = await supabase.storage
            .from('Uploads')
            .createSignedUrl(file.blobKey, 5 * 60); // 5-minute expiry
          if (!error && data) signedUrl = data.signedUrl;
        } catch {
          const { data, error } = await supabase.storage
            .from('uploads')
            .createSignedUrl(file.blobKey, 5 * 60);
          if (!error && data) signedUrl = data.signedUrl;
        }

        if (signedUrl) {
          filesWithUrls.push({
            ...file,
            downloadUrl: signedUrl,
          });
        }
      } catch (err) {
        console.error(`[customer-files] Failed to sign URL for ${file.fileName}:`, err.message);
      }
    }

    return jsonResponse(200, filesWithUrls);
  } catch (err) {
    console.error('[customer-files] Error:', err.message);
    return jsonResponse(500, { error: 'Failed to load files' });
  }
};

function getCookie(cookieHeader, name) {
  const match = cookieHeader.match(new RegExp(`(^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[2]) : null;
}

function authError() {
  return jsonResponse(401, { error: 'Unauthorized' });
}

function jsonResponse(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}
