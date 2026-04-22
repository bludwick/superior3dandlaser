const { getStore } = require('@netlify/blobs');
const nodemailer   = require('nodemailer');
const { createStripeClient } = require('./stripe-client');

let _qb;
try { _qb = require('./_lib/qb-queue'); } catch { _qb = null; }

const SITE_URL = process.env.SITE_URL || 'https://superior3dandlaser.com';

async function enqueueQbForPaidJob(job) {
  if (!_qb) return;
  try {
    const settings = await _qb.getSettings();
    if (!settings || settings.autoSyncEnabled === false) return;

    // If an invoice was already synced for this job, record a Payment against it.
    // Otherwise (invoice still pending or never enqueued), cancel any pending
    // invoice task and create a SalesReceipt directly.
    const tasks = await _qb.listTasks();
    const invoiceTask = tasks.find(t => t.jobId === job.id && t.op === 'invoice');

    if (invoiceTask && invoiceTask.status === 'done') {
      await _qb.enqueueQbTask({ jobId: job.id, op: 'payment' });
    } else {
      if (invoiceTask && (invoiceTask.status === 'pending' || invoiceTask.status === 'failed')) {
        await _qb.cancelPendingTasksFor(job.id, 'invoice');
      }
      await _qb.enqueueQbTask({ jobId: job.id, op: 'sales_receipt' });
    }
  } catch (err) {
    console.error('[stripe-webhook] enqueueQbForPaidJob error:', err.message);
  }
}

function blobStore(name) {
  const opts = { name, consistency: 'strong' };
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;
  if (siteID && token) { opts.siteID = siteID; opts.token = token; }
  return getStore(opts);
}

function createTransport() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) throw new Error('SMTP not configured');
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

async function sendConfirmationEmail(record, hasInvoice) {
  const FROM = process.env.EMAIL_FROM || 'Superior 3D and Laser <sales@superior3dandlaser.com>';

  const itemLines = (record.items || []).map(it =>
    `  • ${it.partName || it.fileName || 'Part'} ×${it.qty || 1}  ${it.material || ''}  ${it.color || ''}  $${parseFloat(it.lineTotal || 0).toFixed(2)}`
  ).join('\n');

  const paidDate = record.paidAt
    ? new Date(record.paidAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
    : new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

  const invoiceLine = hasInvoice && record.invoiceToken
    ? [`View your invoice: ${SITE_URL}/invoice.html?job=${record.id}&token=${record.invoiceToken}`, '']
    : [];

  const textBody = [
    `Hi ${record.customerName || 'there'},`,
    '',
    'We have received your payment. Thank you!',
    '',
    `Payment confirmed: ${paidDate}`,
    '',
    'Order Summary:',
    itemLines || '  (See your order confirmation for details)',
    '',
    `Subtotal: $${parseFloat(record.subtotal || 0).toFixed(2)}`,
    `Tax:      $${parseFloat(record.tax || 0).toFixed(2)}`,
    `Total:    $${parseFloat(record.total || 0).toFixed(2)}`,
    '',
    ...invoiceLine,
    "We'll send another email when your order is ready for pickup.",
    '',
    'Thank you for choosing Superior 3D and Laser!',
    '',
    'Superior 3D and Laser',
    'sales@superior3dandlaser.com',
  ].join('\n');

  const transporter = createTransport();
  await transporter.sendMail({
    from:    FROM,
    to:      record.customerEmail,
    subject: 'Payment received — Superior 3D and Laser',
    text:    textBody,
  });
}

async function handleJobPayment(jobId, session) {
  const bs  = blobStore('jobs');
  const key = `job_${jobId}`;
  let jobText;
  try {
    jobText = await bs.get(key);
  } catch (err) {
    console.error('[stripe-webhook] blob get error (job):', err.message);
    return { statusCode: 500, body: 'Blob read error' };
  }

  if (!jobText) {
    console.error('[stripe-webhook] job not found:', key);
    return { statusCode: 200, body: 'Job not found' };
  }

  const job = JSON.parse(jobText);

  if (job.paymentStatus === 'paid') {
    console.log('[stripe-webhook] job already paid, skipping. jobId=' + jobId);
    return { statusCode: 200, body: 'Already paid' };
  }

  job.paymentStatus   = 'paid';
  job.paidAt          = new Date().toISOString();
  job.stripeSessionId = session.id;
  job.updatedAt       = new Date().toISOString();

  try {
    await bs.set(key, JSON.stringify(job));
    console.log('[stripe-webhook] job marked paid:', key);
  } catch (err) {
    console.error('[stripe-webhook] blob write error (job):', err.message);
    return { statusCode: 500, body: 'Blob write error' };
  }

  if (job.customerEmail) {
    try {
      await sendConfirmationEmail(job, true);
      console.log('[stripe-webhook] confirmation email sent to', job.customerEmail);
    } catch (err) {
      console.error('[stripe-webhook] email error (job):', err.message);
    }
  }

  await enqueueQbForPaidJob(job);

  // Upsert order mirror so paid job appears in Orders (even if it was still 'quoted')
  try {
    const obs = blobStore('orders');
    const orderKey = `order_${job.id}`;
    const existing = await obs.get(orderKey).catch(() => null);
    if (existing) {
      const order = JSON.parse(existing);
      order.paymentStatus = 'paid';
      order.updatedAt = job.updatedAt;
      await obs.set(orderKey, JSON.stringify(order));
    } else {
      await obs.set(orderKey, JSON.stringify({
        id:            job.id,
        customerName:  job.customerName,
        customerEmail: job.customerEmail,
        phone:         job.customerPhone || '',
        items:         (job.items || []).map(it => ({
          projectNumber: it.projectNumber || null,
          projectName:   it.partName  || 'Part',
          material:      it.material  || '',
          color:         it.color     || '',
          qty:           it.qty       || 1,
          unitPrice:     it.unitPrice || 0,
          lineTotal:     it.lineTotal || 0,
        })),
        subtotal:      job.subtotal || 0,
        tax:           job.tax      || 0,
        total:         job.total    || 0,
        notes:         job.notes    || '',
        stlFiles:      job.stlFiles || [],
        status:        'New',
        paymentStatus: 'paid',
        source:        'manual',
        invoiceToken:  job.invoiceToken,
        jobId:         job.id,
        createdAt:     job.createdAt,
        updatedAt:     job.updatedAt,
      }));
    }
    console.log('[stripe-webhook] order mirror upserted for paid job:', job.id);
  } catch (err) {
    console.error('[stripe-webhook] order mirror upsert error:', err.message);
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
}

async function handleOrderPayment(orderId, session) {
  const bs  = blobStore('orders');
  const key = `order_${orderId}`;
  let orderText;
  try {
    orderText = await bs.get(key);
  } catch (err) {
    console.error('[stripe-webhook] blob get error (order):', err.message);
    return { statusCode: 500, body: 'Blob read error' };
  }

  if (!orderText) {
    console.error('[stripe-webhook] order not found:', key);
    return { statusCode: 200, body: 'Order not found' };
  }

  const order = JSON.parse(orderText);

  if (order.paymentStatus === 'paid') {
    console.log('[stripe-webhook] order already paid, skipping. orderId=' + orderId);
    return { statusCode: 200, body: 'Already paid' };
  }

  order.paymentStatus   = 'paid';
  order.paidAt          = new Date().toISOString();
  order.stripeSessionId = session.id;
  order.updatedAt       = new Date().toISOString();

  try {
    await bs.set(key, JSON.stringify(order));
    console.log('[stripe-webhook] order marked paid:', key);
  } catch (err) {
    console.error('[stripe-webhook] blob write error (order):', err.message);
    return { statusCode: 500, body: 'Blob write error' };
  }

  if (order.customerEmail) {
    try {
      await sendConfirmationEmail(order, false);
      console.log('[stripe-webhook] confirmation email sent to', order.customerEmail);
    } catch (err) {
      console.error('[stripe-webhook] email error (order):', err.message);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET not set');
    return { statusCode: 500, body: 'Webhook secret not configured' };
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('[stripe-webhook] STRIPE_SECRET_KEY not set');
    return { statusCode: 500, body: 'Stripe not configured' };
  }

  const sig = event.headers['stripe-signature'];
  if (!sig) {
    return { statusCode: 400, body: 'Missing stripe-signature header' };
  }

  // Reconstruct raw body — must NOT JSON.parse before passing to constructEvent
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : event.body;

  let stripeEvent;
  try {
    const stripe = createStripeClient();
    stripeEvent  = stripe.webhooks.constructEvent(rawBody, sig, secret);
  } catch (err) {
    console.error('[stripe-webhook] signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  // Only handle checkout.session.completed
  if (stripeEvent.type !== 'checkout.session.completed') {
    console.log('[stripe-webhook] ignored event type:', stripeEvent.type);
    return { statusCode: 200, body: 'Ignored' };
  }

  const session = stripeEvent.data.object;
  const jobId   = session.metadata && session.metadata.jobId;
  const orderId = session.metadata && session.metadata.orderId;

  if (!jobId && !orderId) {
    console.error('[stripe-webhook] no jobId or orderId in session metadata, sessionId=', session.id);
    return { statusCode: 200, body: 'No jobId or orderId in metadata' };
  }

  if (jobId) {
    console.log('[stripe-webhook] checkout.session.completed jobId=' + jobId + ' sessionId=' + session.id);
    return handleJobPayment(jobId, session);
  }

  console.log('[stripe-webhook] checkout.session.completed orderId=' + orderId + ' sessionId=' + session.id);
  return handleOrderPayment(orderId, session);
};
