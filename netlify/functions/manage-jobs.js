const jwt       = require('jsonwebtoken');
const { getStore } = require('@netlify/blobs');
const { Resend }   = require('resend');

const STATUS_NEXT = { confirmed: 'printing', printing: 'ready', ready: 'complete' };

exports.handler = async function (event) {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const token = getCookie(event.headers['cookie'] || '', 'admin_token');
  if (!token) return authError();
  const jwtSecret = process.env.JWT_SECRET || '';
  try { jwt.verify(token, jwtSecret); } catch { return authError(); }

  // ── Route: GET /api/admin/jobs ───────────────────────────────────────────
  if (event.httpMethod === 'GET') return listJobs();

  // ── Route: POST /api/admin/jobs ──────────────────────────────────────────
  if (event.httpMethod === 'POST') return createJob(event.body);

  // ── Route: PATCH /api/admin/jobs/{id}/status ─────────────────────────────
  if (event.httpMethod === 'PATCH') {
    const match = (event.path || '').match(/\/([^/]+)\/status$/);
    if (match) return advanceJobStatus(match[1]);
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};

// ── List all jobs ─────────────────────────────────────────────────────────────
async function listJobs() {
  try {
    const store = getStore('jobs');
    const { blobs } = await store.list();

    const jobs = await Promise.all(
      blobs.map(async (blob) => {
        try { return await store.get(blob.key, { type: 'json' }); }
        catch { return null; }
      })
    );

    const valid = jobs
      .filter(Boolean)
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    return jsonResponse(200, valid);
  } catch (err) {
    console.error('[manage-jobs] listJobs error:', err.message);
    return jsonResponse(500, { error: 'Failed to load jobs' });
  }
}

// ── Create a job ──────────────────────────────────────────────────────────────
async function createJob(body) {
  let data;
  try { data = JSON.parse(body || '{}'); } catch { return jsonResponse(400, { error: 'Invalid body' }); }

  const id  = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id,
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

  try {
    const store = getStore('jobs');
    await store.setJSON(`job_${id}`, job);
  } catch (err) {
    console.error('[manage-jobs] createJob store error:', err.message);
    return jsonResponse(500, { error: 'Failed to save job' });
  }

  // Send confirmation email to customer
  if (job.customerEmail) {
    try { await sendStatusEmail(job, 'confirmed'); } catch (err) {
      console.error('[manage-jobs] email error on create:', err.message);
    }
  }

  return jsonResponse(200, { id });
}

// ── Advance job status ────────────────────────────────────────────────────────
async function advanceJobStatus(jobId) {
  try {
    const store = getStore('jobs');
    const { blobs } = await store.list();

    let targetKey = null;
    let job       = null;
    for (const blob of blobs) {
      const j = await store.get(blob.key, { type: 'json' }).catch(() => null);
      if (j && j.id === jobId) { targetKey = blob.key; job = j; break; }
    }
    if (!targetKey) return jsonResponse(404, { error: 'Job not found' });
    if (job.status === 'complete') return jsonResponse(400, { error: 'Job is already complete' });

    const newStatus = STATUS_NEXT[job.status];
    if (!newStatus) return jsonResponse(400, { error: 'Cannot advance from status: ' + job.status });

    job.status = newStatus;
    await store.setJSON(targetKey, job);

    // Email customer on Ready
    if ((newStatus === 'ready') && job.customerEmail) {
      try { await sendStatusEmail(job, newStatus); } catch (err) {
        console.error('[manage-jobs] email error on advance:', err.message);
      }
    }

    return jsonResponse(200, { ok: true, status: newStatus });
  } catch (err) {
    console.error('[manage-jobs] advanceJobStatus error:', err.message);
    return jsonResponse(500, { error: 'Failed to update job' });
  }
}

// ── Email helpers ─────────────────────────────────────────────────────────────
async function sendStatusEmail(job, status) {
  const resend = new Resend(process.env.RESEND_API_KEY);

  const itemLines = (job.items || []).map(it =>
    `  • ${it.partName || 'Part'} ×${it.qty || 1}  ${it.material || ''}  ${it.color || ''}  $${parseFloat(it.lineTotal || 0).toFixed(2)}`
  ).join('\n');

  let subject, body;

  if (status === 'confirmed') {
    subject = 'Your order is confirmed — Superior 3D and Laser';
    body = `Hi ${job.customerName || 'there'},

Your order has been confirmed and is queued for printing on our ${job.printer || 'printer'}.

${job.estEndTime ? `Estimated completion: ${new Date(job.estEndTime).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}` : ''}

Order Summary:
${itemLines || '  (No items listed)'}

Subtotal: $${job.subtotal.toFixed(2)}
Tax:      $${job.tax.toFixed(2)}
Total:    $${job.total.toFixed(2)}

${job.notes ? `Notes: ${job.notes}\n` : ''}We'll email you again when your order is ready for pickup or shipment.

Thank you for choosing Superior 3D and Laser!
`.trim();

  } else if (status === 'ready') {
    subject = 'Your order is ready — Superior 3D and Laser';
    body = `Hi ${job.customerName || 'there'},

Great news — your order is ready!

Reply to this email to coordinate pickup or shipping.

Order Summary:
${itemLines || '  (No items listed)'}

Total: $${job.total.toFixed(2)}

Thank you for choosing Superior 3D and Laser!
`.trim();
  } else {
    return; // No email for other statuses
  }

  await resend.emails.send({
    from:     'Superior 3D and Laser <sales@superiormetrology.com>',
    reply_to: 'sales@superior3dandlaser.com',
    to:       [job.customerEmail],
    subject,
    text: body,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getCookie(cookieHeader, name) {
  const match = cookieHeader.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return match ? match.slice(name.length + 1) : null;
}

function authError() {
  return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Unauthorized' }) };
}

function jsonResponse(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
