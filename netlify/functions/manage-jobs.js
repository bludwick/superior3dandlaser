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

  // Use rawUrl (original request URL) for path matching — event.path can
  // resolve to the function path when accessed via a Netlify rewrite rule.
  const reqPath = getReqPath(event);

  // ── Routes ──────────────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET')    return listJobs();
  if (event.httpMethod === 'POST')   return createJob(event.body, event.isBase64Encoded);
  if (event.httpMethod === 'PATCH') {
    const match = reqPath.match(/\/jobs\/([^/?]+)\/status/);
    if (match) return advanceJobStatus(match[1]);
  }
  if (event.httpMethod === 'PUT') {
    const match = reqPath.match(/\/jobs\/([^/?]+)(?:\/|$)/);
    if (match) return updateJob(match[1], event.body, event.isBase64Encoded);
  }
  if (event.httpMethod === 'DELETE') {
    const match = reqPath.match(/\/jobs\/([^/?]+)(?:\/|$)/);
    if (match) return deleteJob(match[1]);
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
    stlFiles:      Array.isArray(data.stlFiles) ? data.stlFiles : [],
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
      stlFiles:     job.stlFiles || [],
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

// ── Update a job ─────────────────────────────────────────────────────────────
async function updateJob(jobId, rawBody, isBase64) {
  let bodyStr = rawBody || '{}';
  if (isBase64) {
    try { bodyStr = Buffer.from(rawBody, 'base64').toString('utf8'); } catch { bodyStr = '{}'; }
  }
  let data;
  try { data = JSON.parse(bodyStr); }
  catch (e) { return jsonResponse(400, { error: 'Invalid JSON body' }); }

  try {
    const bs  = blobStore('jobs');
    const key = `job_${jobId}`;
    const existing = await bs.get(key);
    if (!existing) return jsonResponse(404, { error: 'Job not found' });
    const job = JSON.parse(existing);

    // Update mutable fields; preserve identity/audit fields
    job.customerName  = data.customerName  ?? job.customerName;
    job.customerEmail = data.customerEmail ?? job.customerEmail;
    job.customerPhone = data.customerPhone ?? job.customerPhone;
    job.items         = Array.isArray(data.items)    ? data.items    : job.items;
    job.stlFiles      = Array.isArray(data.stlFiles) ? data.stlFiles : (job.stlFiles || []);
    job.subtotal      = data.subtotal != null ? parseFloat(data.subtotal)  : job.subtotal;
    job.tax           = data.tax      != null ? parseFloat(data.tax)       : job.tax;
    job.total         = data.total    != null ? parseFloat(data.total)     : job.total;
    job.printer       = data.printer       ?? job.printer;
    job.startTime     = data.startTime     !== undefined ? (data.startTime || null)    : job.startTime;
    job.estEndTime    = data.estEndTime    !== undefined ? (data.estEndTime || null)   : job.estEndTime;
    job.notes         = data.notes         ?? job.notes;
    job.updatedAt     = new Date().toISOString();

    await bs.set(key, JSON.stringify(job));
    console.log('[manage-jobs] updated job_' + jobId);

    // Best-effort update order mirror
    try {
      const obs = blobStore('orders');
      const { blobs } = await obs.list();
      for (const blob of blobs) {
        const text = await obs.get(blob.key).catch(() => null);
        const order = text ? JSON.parse(text) : null;
        if (order && (order.jobId === jobId || order.id === jobId)) {
          order.customerName  = job.customerName;
          order.customerEmail = job.customerEmail;
          order.phone         = job.customerPhone;
          order.items         = job.items.map(it => ({
            projectName: it.partName  || 'Part',
            material:    it.material  || '',
            color:       it.color     || '',
            qty:         it.qty       || 1,
            unitPrice:   it.unitPrice || 0,
            lineTotal:   it.lineTotal || 0,
          }));
          order.stlFiles  = job.stlFiles || [];
          order.subtotal  = job.subtotal;
          order.tax       = job.tax;
          order.total     = job.total;
          order.notes     = job.notes;
          order.updatedAt = job.updatedAt;
          await obs.set(blob.key, JSON.stringify(order));
          break;
        }
      }
    } catch (err) {
      console.error('[manage-jobs] order mirror update error:', err.message);
    }

    return jsonResponse(200, { ok: true, id: jobId });
  } catch (err) {
    console.error('[manage-jobs] updateJob error:', err.message);
    return jsonResponse(500, { error: 'Failed to update job: ' + err.message });
  }
}

// ── Delete a job ─────────────────────────────────────────────────────────────
async function deleteJob(jobId) {
  try {
    const bs = blobStore('jobs');
    await bs.delete(`job_${jobId}`);
    console.log('[manage-jobs] deleted job_' + jobId);

    // Best-effort: remove matching order mirror
    try {
      const obs = blobStore('orders');
      const { blobs } = await obs.list();
      for (const blob of blobs) {
        const text = await obs.get(blob.key).catch(() => null);
        const order = text ? JSON.parse(text) : null;
        if (order && (order.jobId === jobId || order.id === jobId)) {
          await obs.delete(blob.key);
          console.log('[manage-jobs] deleted order mirror ' + blob.key);
          break;
        }
      }
    } catch (err) {
      console.error('[manage-jobs] order mirror delete error:', err.message);
    }

    return jsonResponse(200, { ok: true });
  } catch (err) {
    console.error('[manage-jobs] deleteJob error:', err.message);
    return jsonResponse(500, { error: 'Failed to delete job: ' + err.message });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Extract the pathname from rawUrl (the original request URL before any
// Netlify rewrite), falling back to event.path. Using rawUrl avoids the
// common gotcha where event.path resolves to the function path after a
// status=200 rewrite rule, causing path-based ID extraction to fail.
function getReqPath(event) {
  if (event.rawUrl) {
    try { return new URL(event.rawUrl).pathname; } catch { /* fall through */ }
  }
  return event.path || '';
}

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
