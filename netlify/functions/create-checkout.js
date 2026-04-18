const { getStore } = require('@netlify/blobs');

const SITE_URL = process.env.SITE_URL || 'https://superior3dandlaser.com';

function blobStore(name) {
  const opts = { name, consistency: 'strong' };
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;
  if (siteID && token) { opts.siteID = siteID; opts.token = token; }
  return getStore(opts);
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Return 503 immediately if Stripe is not configured
  if (!process.env.STRIPE_SECRET_KEY) {
    return jsonResponse(503, {
      error: 'Online payment is not yet configured. Please pay via bank transfer or contact us at sales@superior3dandlaser.com.',
    });
  }

  let jobId, token;
  try {
    ({ jobId, token } = JSON.parse(event.body || '{}'));
  } catch {
    return jsonResponse(400, { error: 'Invalid request body' });
  }

  if (!jobId || !token) {
    return jsonResponse(400, { error: 'Missing jobId or token' });
  }

  try {
    // Look up job and validate token
    const text = await blobStore('jobs').get(`job_${jobId}`);
    const job  = text ? JSON.parse(text) : null;
    if (!job || job.invoiceToken !== token) return jsonResponse(404, { error: 'Invoice not found or token invalid' });

    const { createStripeClient } = require('./stripe-client');
    const stripe = createStripeClient();

    const lineItems = job.items && job.items.length > 0
      ? job.items.map(it => ({
          price_data: {
            currency:     'usd',
            product_data: { name: it.partName || 'Print Job Part' },
            unit_amount:  Math.round((it.unitPrice || 0) * 100),
          },
          quantity: it.qty || 1,
        }))
      : [{
          price_data: {
            currency:     'usd',
            product_data: { name: `Print Job — Superior 3D and Laser` },
            unit_amount:  Math.round((job.total || 0) * 100),
          },
          quantity: 1,
        }];

    const invoiceUrl = `${SITE_URL}/invoice.html?job=${jobId}&token=${token}`;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items:     lineItems,
      mode:           'payment',
      success_url:    `${SITE_URL}/invoice.html?job=${jobId}&token=${token}&paid=1`,
      cancel_url:     invoiceUrl,
      customer_email: job.customerEmail || undefined,
      metadata:       { jobId },
    });

    // Best-effort: store session ID so webhook can correlate payment to this job
    try {
      const bsUp    = blobStore('jobs');
      const jobText = await bsUp.get(`job_${jobId}`);
      if (jobText) {
        const jobData         = JSON.parse(jobText);
        jobData.stripeSessionId = session.id;
        jobData.updatedAt       = new Date().toISOString();
        await bsUp.set(`job_${jobId}`, JSON.stringify(jobData));
      }
    } catch (e) {
      console.error('[create-checkout] stripeSessionId store error:', e.message);
    }

    return jsonResponse(200, { url: session.url });
  } catch (err) {
    console.error('[create-checkout] error:', err.message);
    return jsonResponse(500, { error: 'Failed to create payment session: ' + err.message });
  }
};

function jsonResponse(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}
