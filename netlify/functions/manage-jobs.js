const jwt          = require('jsonwebtoken');
const { getStore } = require('@netlify/blobs');

let _Resend;
try { _Resend = require('resend').Resend; } catch { _Resend = null; }

const STATUS_NEXT  = { confirmed: 'printing', printing: 'ready', ready: 'complete' };
const SITE_URL     = process.env.SITE_URL || 'https://superior3dandlaser.com';

// Build store options — auto-context first, explicit env vars as fallback
function blobStore(name) {
  const opts = { name, consistency: 'strong' };
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;
  if (siteID && token) { opts.siteID = siteID; opts.token = token; }
  return getStore(opts);
}

exports.handler = async function (event) {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const cookieHeader = event.headers['cookie'] || event.headers['Cookie'] || '';
  const token = getCookie(cookieHeader, 'admin_token');
  if (!token) return authError();
  const jwtSecret = process.env.JWT_SECRET || '';
  try { jwt.verify(token, jwtSecret); } catch { return authError(); }

  // ── Routes ──────────────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET')   return listJobs();
  if (event.httpMethod === 'POST')  return createJob(event.body, event.isBase64Encoded);
  if (event.httpMethod === 'PATCH') {
    const match = (event.path || '').match(/\/([^/]+)\/status$/);
    if (match) return advanceJobStatus(match[1]);
  }
  return { statusCode: 405, body: 'Method Not Allowed' };
};

// ── List all jobs ─────────────────────────────────────────────────────────────
async function listJobs() {
  try {
    const bs = blobStore('jobs');
    const { blobs } = await bs.list();
    console.log('[manage-jobs] listJobs: blob count =', blobs.length);

    const jobs = await Promise.all(
      blobs.map(async (b) => {
        try {
          const text = await bs.get(b.key);
          if (!text) return null;
          return JSON.parse(text);
        } catch (e) {
          console.error('[manage-jobs] get error key=' + b.key, e.message);
          return null;
        }
      })
    );

    const valid = jobs
      .filter(Boolean)
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    return jsonResponse(200, valid);
  } catch (err) {
    console.error('[manage-jobs] listJobs error:', err.message);
    return jsonResponse(500, { error: 'Failed to load jobs: ' + err.message });
  }
}

// ── Create a job ──────────────────────────────────────────────────────────────
async function createJob(rawBody, isBase64) {
  let bodyStr = rawBody || '{}';
  if (isBase64) {
    try { bodyStr = Buffer.from(rawBody, 'base64').toString('utf8'); }
    catch { bodyStr = '{}'; }
  }

  let data;
  try { data = JSON.parse(bodyStr); }
  catch (e) {
    console.error('[manage-jobs] JSON parse error:', e.message, 'body:', bodyStr.slice(0, 200));
    return jsonResponse(400, { error: 'Invalid JSON body: ' + e.message });
  }

  const id           = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const invoiceToken = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

  const job = {
    id,
    invoiceToken,
    source:        data.source        || 'manual',
    orderId:       data.orderId       || null,
    customerName:  data.customerName  || '',
    customerEmail: data.customerEmail || '',
    customerPhone: data.customerPhone || '',
    items:         Array.isArray(data.items) ? data.items : [],
    subtotal:      parseFloat(data.subtotal)  || 0,
    tax:           parseFloat(data.tax)       || 0,
    total:         parseFloat(data.total)     || 0,
    printer:       data.printer       || 'H2D-1',
    startTime:     data.startTime     || null,
    estEndTime:    data.estEndTime    || null,
    notes:         data.notes         || '',
    status:        'confirmed',
    createdAt:     new Date().toISOString(),
  };

  console.log('[manage-jobs] createJob id=' + id + ' customer=' + job.customerName + ' items=' + job.items.length);

  // Save to jobs store
  try {
    const bs = blobStore('jobs');
    await bs.set(`job_${id}`, JSON.stringify(job));
    console.log('[manage-jobs] job saved: job_' + id);
  } catch (err) {
    console.error('[manage-jobs] jobs store write error:', err.message);
    return jsonResponse(500, { error: 'Failed to save job: ' + err.message });
  }

  // Mirror as order with status 'quoted' (best-effort)
  try {
    const obs = blobStore('orders');
    await obs.set(`order_${id}`, JSON.stringify({
      id,
      customerName:  job.customerName,
      customerEmail: job.customerEmail,
      phone:         job.customerPhone,
      items: job.items.map(it => ({
        projectName: it.partName  || 'Part',
        material:    it.material  || '',
        color:       it.color     || '',
        qty:         it.qty       || 1,
        unitPrice:   it.unitPrice || 0,
        lineTotal:   it.lineTotal || 0,
      })),
      subtotal:     job.subtotal,
      tax:          job.tax,
      total:        job.total,
      notes:        job.notes,
      status:       'quoted',
      source:       'manual',
      invoiceToken: job.invoiceToken,
      jobId:        id,
      createdAt:    job.createdAt,
    }));
    console.log('[manage-jobs] order mirror saved: order_' + id);
  } catch (err) {
    console.error('[manage-jobs] orders mirror write error:', err.message);
  }

  // Build URLs
  const invoiceUrl = `${SITE_URL}/invoice.html?job=${id}&token=${invoiceToken}`;

  // Stripe payment link (only when STRIPE_SECRET_KEY is configured)
  let paymentUrl = null;
  if (process.env.STRIPE_SECRET_KEY) {
    try {
      const Stripe = require('stripe');
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const lineItems = job.items.length > 0
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
              product_data: { name: `Print Job — ${job.printer}` },
              unit_amount:  Math.round(job.total * 100),
            },
            quantity: 1,
          }];

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items:  lineItems,
        mode:        'payment',
        success_url: `${SITE_URL}/invoice.html?job=${id}&token=${invoiceToken}&paid=1`,
        cancel_url:  invoiceUrl,
        customer_email: job.customerEmail || undefined,
        metadata:    { jobId: id },
      });
      paymentUrl = session.url;
    } catch (err) {
      console.error('[manage-jobs] Stripe error:', err.message);
    }
  }

  // Send confirmation email (best-effort)
  if (job.customerEmail && _Resend) {
    try { await sendStatusEmail(job, 'confirmed', invoiceUrl, paymentUrl); }
    catch (err) { console.error('[manage-jobs] email error:', err.message); }
  }

  return jsonResponse(200, { id, invoiceToken, invoiceUrl });
}

// ── Advance job status ────────────────────────────────────────────────────────
async function advanceJobStatus(jobId) {
  try {
    const bs = blobStore('jobs');
    const { blobs } = await bs.list();

    let targetKey = null, job = null;
    for (const blob of blobs) {
      try {
        const text = await bs.get(blob.key);
        const j = text ? JSON.parse(text) : null;
        if (j && j.id === jobId) { targetKey = blob.key; job = j; break; }
      } catch { /* skip corrupt blob */ }
    }
    if (!targetKey) return jsonResponse(404, { error: 'Job not found' });
    if (job.status === 'complete') return jsonResponse(400, { error: 'Already complete' });

    const newStatus = STATUS_NEXT[job.status];
    if (!newStatus) return jsonResponse(400, { error: 'Cannot advance from: ' + job.status });

    job.status = newStatus;
    await bs.set(targetKey, JSON.stringify(job));

    if (newStatus === 'ready' && job.customerEmail && _Resend) {
      const invoiceUrl = `${SITE_URL}/invoice.html?job=${job.id}&token=${job.invoiceToken || ''}`;
      try { await sendStatusEmail(job, 'ready', invoiceUrl, null); }
      catch (err) { console.error('[manage-jobs] email error on advance:', err.message); }
    }

    return jsonResponse(200, { ok: true, status: newStatus });
  } catch (err) {
    console.error('[manage-jobs] advanceJobStatus error:', err.message);
    return jsonResponse(500, { error: 'Failed to update job: ' + err.message });
  }
}

// ── Email ─────────────────────────────────────────────────────────────────────
async function sendStatusEmail(job, status, invoiceUrl, paymentUrl) {
  const resend = new _Resend(process.env.RESEND_API_KEY);

  const itemLines = (job.items || []).map(it =>
    `  • ${it.partName || 'Part'} ×${it.qty || 1}  ${it.material || ''}  ${it.color || ''}  $${parseFloat(it.lineTotal || 0).toFixed(2)}`
  ).join('\n');

  let subject, body;

  if (status === 'confirmed') {
    subject = 'Your quote is confirmed — Superior 3D and Laser';
    body = [
      `Hi ${job.customerName || 'there'},`,
      '',
      `Your quote has been confirmed and is queued for printing on our ${job.printer || 'printer'}.`,
      '',
      job.estEndTime
        ? `Estimated completion: ${new Date(job.estEndTime).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`
        : null,
      '',
      'Order Summary:',
      itemLines || '  (Items to be determined)',
      '',
      `Subtotal: $${job.subtotal.toFixed(2)}`,
      `Tax:      $${job.tax.toFixed(2)}`,
      `Total:    $${job.total.toFixed(2)}`,
      '',
      paymentUrl ? `Pay online now: ${paymentUrl}` : null,
      `View your invoice: ${invoiceUrl}`,
      '',
      job.notes ? `Notes: ${job.notes}` : null,
      '',
      "We'll send another email when your order is ready for pickup.",
      '',
      'Thank you for choosing Superior 3D and Laser!',
    ].filter(l => l !== null).join('\n');

  } else if (status === 'ready') {
    subject = 'Your order is ready — Superior 3D and Laser';
    body = [
      `Hi ${job.customerName || 'there'},`,
      '',
      'Great news — your order is ready!',
      '',
      'Order Summary:',
      itemLines || '  (See invoice for details)',
      '',
      `Total: $${job.total.toFixed(2)}`,
      '',
      `View your invoice: ${invoiceUrl}`,
      '',
      'Reply to this email to arrange pickup or shipping.',
      '',
      'Thank you for choosing Superior 3D and Laser!',
    ].join('\n');

  } else {
    return;
  }

  await resend.emails.send({
    from:    'Superior 3D and Laser <sales@superiormetrology.com>',
    replyTo: 'sales@superior3dandlaser.com',
    to:      [job.customerEmail],
    subject,
    text: body,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getCookie(header, name) {
  const match = header.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return match ? match.slice(name.length + 1) : null;
}

function authError() {
  return {
    statusCode: 401,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ error: 'Unauthorized' }),
  };
}

function jsonResponse(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}
