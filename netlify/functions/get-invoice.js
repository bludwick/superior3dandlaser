const { getStore } = require('@netlify/blobs');

function blobStore(name) {
  const opts = { name, consistency: 'strong' };
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;
  if (siteID && token) { opts.siteID = siteID; opts.token = token; }
  return getStore(opts);
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { job: jobId, token } = event.queryStringParameters || {};
  if (!jobId || !token) {
    return jsonResponse(400, { error: 'Missing job ID or token' });
  }

  try {
    const text = await blobStore('jobs').get(`job_${jobId}`);
    const job  = text ? JSON.parse(text) : null;

    if (!job) return jsonResponse(404, { error: 'Invoice not found' });
    if (job.invoiceToken !== token) return jsonResponse(403, { error: 'Invalid invoice token' });

    // Return public-safe view (strip internal token)
    const { invoiceToken, ...publicJob } = job;
    return jsonResponse(200, publicJob);
  } catch (err) {
    console.error('[get-invoice] error:', err.message);
    return jsonResponse(500, { error: 'Failed to load invoice' });
  }
};

function jsonResponse(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}
