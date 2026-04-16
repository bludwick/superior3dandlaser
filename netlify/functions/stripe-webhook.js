const { getStore } = require('@netlify/blobs');
const nodemailer   = require('nodemailer');
const Stripe       = require('stripe');

const SITE_URL = process.env.SITE_URL || 'https://superior3dandlaser.com';

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

async function sendPaymentConfirmationEmail(job) {
  const FROM       = process.env.EMAIL_FROM || 'Superior 3D and Laser <sales@superior3dandlaser.com>';
  const invoiceUrl = `${SITE_URL}/invoice.html?job=${job.id}&token=${job.invoiceToken}`;

  const itemLines = (job.items || []).map(it =>
    `  • ${it.partName || 'Part'} ×${it.qty || 1}  ${it.material || ''}  ${it.color || ''}  $${parseFloat(it.lineTotal || 0).toFixed(2)}`
  ).join('\n');

  const paidDate = job.paidAt
    ? new Date(job.paidAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
    : new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

  const subject = 'Payment received — Superior 3D and Laser';

  const textBody = [
    `Hi ${job.customerName || 'there'},`,
    '',
    'We have received your payment. Thank you!',
    '',
    `Payment confirmed: ${paidDate}`,
    '',
    'Order Summary:',
    itemLines || '  (See invoice for details)',
    '',
    `Subtotal: $${parseFloat(job.subtotal || 0).toFixed(2)}`,
    `Tax:      $${parseFloat(job.tax || 0).toFixed(2)}`,
    `Total:    $${parseFloat(job.total || 0).toFixed(2)}`,
    '',
    `View your invoice: ${invoiceUrl}`,
    '',
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
    to:      job.customerEmail,
    subject,
    text:    textBody,
  });
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
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
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

  if (!jobId) {
    console.error('[stripe-webhook] no jobId in session metadata, sessionId=', session.id);
    return { statusCode: 200, body: 'No jobId in metadata' };
  }

  console.log('[stripe-webhook] checkout.session.completed jobId=' + jobId + ' sessionId=' + session.id);

  // Load job from Blobs
  const bs  = blobStore('jobs');
  const key = `job_${jobId}`;
  let jobText;
  try {
    jobText = await bs.get(key);
  } catch (err) {
    console.error('[stripe-webhook] blob get error:', err.message);
    return { statusCode: 500, body: 'Blob read error' };
  }

  if (!jobText) {
    console.error('[stripe-webhook] job not found:', key);
    return { statusCode: 200, body: 'Job not found' };
  }

  const job = JSON.parse(jobText);

  // Idempotency guard — Stripe retries on non-2xx; don't double-process
  if (job.paymentStatus === 'paid') {
    console.log('[stripe-webhook] already paid, skipping. jobId=' + jobId);
    return { statusCode: 200, body: 'Already paid' };
  }

  // Mark job as paid — do NOT auto-advance job.status
  job.paymentStatus   = 'paid';
  job.paidAt          = new Date().toISOString();
  job.stripeSessionId = session.id;
  job.updatedAt       = new Date().toISOString();

  try {
    await bs.set(key, JSON.stringify(job));
    console.log('[stripe-webhook] job marked paid:', key);
  } catch (err) {
    console.error('[stripe-webhook] blob write error:', err.message);
    return { statusCode: 500, body: 'Blob write error' };
  }

  // Send payment confirmation email (best-effort — never return 5xx on email failure)
  if (job.customerEmail) {
    try {
      await sendPaymentConfirmationEmail(job);
      console.log('[stripe-webhook] confirmation email sent to', job.customerEmail);
    } catch (err) {
      console.error('[stripe-webhook] email error:', err.message);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
