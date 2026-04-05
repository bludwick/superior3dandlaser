const { getStore } = require('@netlify/blobs');

const SITE_URL = process.env.SITE_URL || 'https://superior3dandlaser.com';

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
    const store = getStore({ name: 'jobs', consistency: 'strong' });
    const { blobs } = await store.list();
    let job = null;
    for (const blob of blobs) {
      const j = await store.get(blob.key, { type: 'json' }).catch(() => null);
      if (j && j.id === jobId && j.invoiceToken === token) { job = j; break; }
    }
    if (!job) return jsonResponse(404, { error: 'Invoice not found or token invalid' });

    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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
