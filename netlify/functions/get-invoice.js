const { getStore } = require('@netlify/blobs');

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { job: jobId, token } = event.queryStringParameters || {};
  if (!jobId || !token) {
    return jsonResponse(400, { error: 'Missing job ID or token' });
  }

  try {
    const store = getStore({ name: 'jobs', consistency: 'strong' });
    const { blobs } = await store.list();

    for (const blob of blobs) {
      const job = await store.get(blob.key, { type: 'json' }).catch(() => null);
      if (!job || job.id !== jobId) continue;

      if (job.invoiceToken !== token) {
        return jsonResponse(403, { error: 'Invalid invoice token' });
      }

      // Return public-safe view (strip internal token)
      const { invoiceToken, ...publicJob } = job;
      return jsonResponse(200, publicJob);
    }

    return jsonResponse(404, { error: 'Invoice not found' });
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
